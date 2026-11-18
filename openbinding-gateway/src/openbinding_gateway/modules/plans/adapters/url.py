"""``UrlSource``: Pricing2Yaml files at user-supplied https URLs, through ``core.outbound``.

User input, so the strictest policy: https only, global addresses only (``allow_internal=False``), at most
``OFFERING_URL_MAX_REDIRECTS`` https redirects, each resolved, revalidated and re-pinned, no credential ever
sent, ``SPHERE_MAX_BYTES`` and the SPHERE timeouts. Conditional on ``ETag`` and ``Last-Modified``.
"""

from __future__ import annotations

import hashlib
import logging

import httpx

from ....core import outbound
from ....core.outbound import OutboundError, OutboundPolicy
from ....core.settings import Settings
from ..application.pricing_source import PricingNotFound, PricingSourceBusy, PricingSourceUnavailable
from ..domain.sources import FetchedYaml, NotModified

logger = logging.getLogger(__name__)


class UrlSource:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings = settings
        self.transport = transport

    def _policy(self) -> OutboundPolicy:
        timeout = float(self.settings.sphere_timeout_s)
        return OutboundPolicy(
            https_only=True,
            allow_internal=False,
            max_bytes=int(self.settings.sphere_max_bytes),
            connect_timeout_s=min(3.0, timeout),
            read_timeout_s=min(5.0, timeout),
            total_timeout_s=timeout,
            max_redirects=int(self.settings.offering_url_max_redirects),
        )

    async def url_yaml(
        self, url: str, *, if_none_match: str | None = None, if_modified_since: str | None = None
    ) -> FetchedYaml | NotModified:
        headers = {"accept": "application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.1", "user-agent": "openbinding-gateway"}
        if if_none_match:
            headers["if-none-match"] = if_none_match
        if if_modified_since:
            headers["if-modified-since"] = if_modified_since
        try:
            answer = await outbound.fetch(url, policy=self._policy(), headers=headers, transport=self.transport)
        except OutboundError as exc:
            reason = {"outbound_status": "encoding"}.get(exc.code, exc.code.removeprefix("outbound_"))
            logger.info("pricing_url_unreadable url=%s reason=%s", outbound.mask_url(url), reason)
            raise PricingSourceUnavailable(reason, f"the URL cannot be read ({reason})") from exc
        if answer.status == 304:
            return NotModified(answer.headers.get("etag") or if_none_match)
        if answer.status in {401, 403, 404, 410}:
            raise PricingNotFound("the URL answered that there is nothing to read")
        if answer.status == 429:
            try:
                retry = int(float(answer.headers.get("retry-after") or "60"))
            except ValueError:
                retry = 60
            raise PricingSourceBusy(min(retry, int(self.settings.sphere_backoff_max_s)))
        if answer.status != 200:
            raise PricingSourceUnavailable("unavailable", f"the URL answered {answer.status}")
        return FetchedYaml(
            body=answer.body,
            sha256=hashlib.sha256(answer.body).hexdigest(),
            etag=answer.headers.get("etag"),
            last_modified=answer.headers.get("last-modified"),
            url=answer.final_url,
        )
