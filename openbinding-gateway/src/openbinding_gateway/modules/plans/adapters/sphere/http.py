"""``SphereHttpSource``: the default SPHERE and every ``SPHERE_REGISTRIES`` alias, over ``core.outbound``.

Every request goes through ``core.outbound.fetch`` (no client of its own): https only, no redirects, identity
encoding, a decoded-size cap of ``SPHERE_MAX_BYTES``, the connection pinned to a checked address. The default
SPHERE must be on a global address; a registry alias, configured by the operator, may be on a private one. With
``SPHERE_REQUIRE_HTTPS=false`` (refused in production) the default SPHERE may also be plain http, then only towards a
local or private address (``outbound.validate_endpoint(allow_internal_http=True)``): the lab's SPHERE stand-in.
Registries and Pricing2Yaml URLs (``UrlSource``) stay https. "Open in SPHERE" links (``permanent_url``) to the default
SPHERE are built on ``SPHERE_PUBLIC_URL`` when it is set.

- **Ids first.** Pricing, version and organization ids must be SPHERE ids before a URL is built, and every
  path segment is percent-quoted; anything else is ``PricingNotFound`` with no request.
- **Keys.** The default SPHERE carries no key of OpenBinding's own: only an organization's ``Credential``,
  never sent to a registry or a URL. A registry carries its operator key.
- **Cache.** Only anonymous answers (manifests, discovery, family identities, organizations) are cached, for
  ``SPHERE_CACHE_TTL_S`` and then revalidated with ``If-None-Match`` (304 extends the entry), in an LRU of 1 024
  entries. An answer obtained with a key is never cached: SPHERE marks it ``private, no-store`` because it may
  list private versions. Version YAML is never cached here: a stored snapshot is reused instead.
- **Back-off, keyed as SPHERE keys its limit** (per user for a key, per address anonymously), per base URL
  and bucket (``org:<id>``, ``registry:<alias>``, ``anonymous``): a 429 opens a window for that bucket only
  (``Retry-After`` capped at ``SPHERE_BACKOFF_MAX_S``); ``RateLimit-Remaining`` at 10 % of ``RateLimit-Limit``
  closes the bucket until ``RateLimit-Reset``; a 404 or 503 on one path is a 60 s negative-cache entry for
  that path and bucket (what one caller may not read another may); connect errors and timeouts back the host off exponentially, 5 to 60 s.
- **Revalidation on request.** ``manifest(..., revalidate=True)`` (the upstream watcher) skips the fresh-entry
  shortcut and the negative cache and always sends a conditional request; the windows and the host back-off
  still apply. A 304 refreshes the entry's age; a 404 still refreshes the negative entry for other readers.
- **401 with a key**: the credential's ``on_rejected`` is awaited (the connection is marked invalid) and the
  call is retried anonymously, so a stale key never blocks a public pricing.
- **Integrity.** The SHA-256 of a version's bytes must equal its quoted ``ETag``; otherwise the read fails.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from .....core import outbound
from .....core.outbound import OutboundError, OutboundPolicy, OutboundResponse
from .....core.settings import Settings
from ...application.pricing_source import (
    CredentialRejected,
    PricingNotFound,
    PricingSourceBusy,
    PricingSourceUnavailable,
)
from ...domain.sources import (
    Credential,
    FamilyIdentity,
    FetchedYaml,
    Manifest,
    NotModified,
    SearchPage,
    SearchQuery,
    SourceShapeError,
    SphereEndpoint,
    SphereOrganization,
    SphereUser,
    is_sphere_id,
    parse_manifest,
    parse_organization,
    parse_permalink,
    parse_public_organizations,
    parse_search,
    parse_user,
)
from ..url import UrlSource

logger = logging.getLogger(__name__)

API = "/api/v1"
USER_AGENT = "openbinding-gateway"
CACHE_ENTRIES = 1024
NEGATIVE_TTL_S = 60.0
HOST_BACKOFF_MIN_S = 5.0
RESERVE = 0.10


@dataclass
class _CacheEntry:
    body: Any
    etag: str | None
    expires: float


@dataclass(frozen=True)
class _Target:
    base: str
    key: str | None
    allow_internal: bool
    registry: str | None
    #: False only for the default SPHERE with ``SPHERE_REQUIRE_HTTPS=false``: http towards a local address.
    https_only: bool = True


@dataclass(frozen=True)
class _Answer:
    status: int
    headers: httpx.Headers
    body: bytes


class SphereHttpSource:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        url_source: UrlSource | None = None,
    ) -> None:
        self.settings = settings
        self.transport = transport
        self.clock = clock
        self.url_source = url_source or UrlSource(settings, transport=transport)
        self._cache: OrderedDict[tuple[str, str], _CacheEntry] = OrderedDict()
        self._windows: dict[tuple[str, str], float] = {}
        self._negative: dict[tuple[str, str, str], tuple[float, str]] = {}
        self._host_backoff: dict[str, tuple[float, float]] = {}

    # -- configuration -----------------------------------------------------------------------------------------------

    def registries(self) -> tuple[str, ...]:
        return tuple(sorted(self.settings.sphere_registries))

    def _target(self, where: SphereEndpoint) -> _Target:
        if where.registry is None:
            if not self.settings.sphere_enabled:
                raise PricingSourceUnavailable("disabled", "the default SPHERE is switched off (SPHERE_ENABLED)")
            relaxed = not self.settings.sphere_require_https
            return _Target(self.settings.sphere_url.rstrip("/"), None, relaxed, None, https_only=not relaxed)
        registry = self.settings.sphere_registries.get(where.registry)
        if registry is None:
            raise PricingSourceUnavailable("registry_unknown", f"no SPHERE registry is configured as {where.registry}")
        key = registry.api_key.get_secret_value() if registry.api_key else None
        return _Target(str(registry.url).rstrip("/"), key, True, where.registry)

    def _policy(self, target: _Target) -> OutboundPolicy:
        timeout = float(self.settings.sphere_timeout_s)
        return OutboundPolicy(
            https_only=target.https_only,
            allow_internal=target.allow_internal,
            max_bytes=int(self.settings.sphere_max_bytes),
            connect_timeout_s=min(3.0, timeout),
            read_timeout_s=min(5.0, timeout),
            total_timeout_s=timeout,
            max_redirects=0,
        )

    def permanent_url(self, where: SphereEndpoint, pricing_id: str, version_id: str | None = None) -> str:
        if where.registry is None:
            base = self.settings.sphere_link_base.rstrip("/")
        else:
            registry = self.settings.sphere_registries.get(where.registry)
            base = str(registry.url).rstrip("/") if registry else ""
        link = f"{base}/p/{quote(pricing_id, safe='')}"
        return link + (f"?version={quote(version_id, safe='')}" if version_id else "")

    def state(self) -> str:
        """``configured``, ``disabled`` or ``backing-off`` (the default SPHERE's host or anonymous bucket)."""
        if not self.settings.sphere_enabled:
            return "disabled"
        now = self.clock()
        base = self.settings.sphere_url.rstrip("/")
        if self._host_backoff.get(base, (0.0, 0.0))[0] > now or self._windows.get((base, "anonymous"), 0.0) > now:
            return "backing-off"
        return "configured"

    # -- the one request path -----------------------------------------------------------------------------------------

    def _bucket(self, target: _Target, credential: Credential | None) -> str:
        if credential is not None:
            return credential.bucket
        if target.key is not None:
            return f"registry:{target.registry}"
        return "anonymous"

    def _before(self, target: _Target, bucket: str, path_key: str, *, revalidate: bool = False) -> None:
        now = self.clock()
        until, _ = self._host_backoff.get(target.base, (0.0, 0.0))
        if until > now:
            raise PricingSourceUnavailable("unavailable", "the pricing source is backing off after transport failures")
        window = self._windows.get((target.base, bucket), 0.0)
        if window > now:
            raise PricingSourceBusy(int(window - now) + 1)
        negative = None if revalidate else self._negative.get((target.base, bucket, path_key))
        if negative is not None and negative[0] > now:
            if negative[1] == "not_found":
                raise PricingNotFound("not found (recently)")
            raise PricingSourceUnavailable("unavailable", "the pricing source failed on this path recently")

    def _after(self, target: _Target, bucket: str, answer: _Answer) -> None:
        headers = answer.headers
        try:
            limit = int(headers.get("ratelimit-limit", ""))
            remaining = int(headers.get("ratelimit-remaining", ""))
            reset = float(headers.get("ratelimit-reset", ""))
        except ValueError:
            return
        if limit > 0 and remaining <= limit * RESERVE:
            hold = min(max(reset, 1.0), float(self.settings.sphere_backoff_max_s))
            self._windows[(target.base, bucket)] = self.clock() + hold
            logger.info("sphere_reserve_reached base=%s bucket=%s hold=%.0f", target.base, bucket, hold)

    def _headers(self, target: _Target, credential: Credential | None, accept: str) -> dict[str, str]:
        headers = {"accept": accept, "user-agent": USER_AGENT}
        if credential is not None and target.registry is None:
            headers["x-api-key"] = credential.api_key
        elif target.key is not None:
            headers["x-api-key"] = target.key
        return headers

    async def _fetch(self, target: _Target, path: str, query: dict[str, str] | None, headers: dict[str, str]) -> _Answer:
        url = target.base + path + ("?" + urlencode(sorted(query.items())) if query else "")
        try:
            response: OutboundResponse = await outbound.fetch(
                url, policy=self._policy(target), headers=headers, transport=self.transport
            )
        except OutboundError as exc:
            if exc.code in {"outbound_timeout", "outbound_connect", "outbound_dns"}:
                self._back_off_host(target.base)
                raise PricingSourceUnavailable("timeout" if exc.code == "outbound_timeout" else "transport") from exc
            if exc.code == "outbound_too_large":
                raise PricingSourceUnavailable("too_large", "the answer is larger than SPHERE_MAX_BYTES") from exc
            if exc.code == "outbound_redirect":
                raise PricingSourceUnavailable("redirect", "SPHERE answered with a redirect") from exc
            if exc.code == "outbound_status":
                raise PricingSourceUnavailable("encoding", "SPHERE answered with an encoded body") from exc
            raise PricingSourceUnavailable("transport") from exc
        self._host_backoff.pop(target.base, None)
        return _Answer(response.status, response.headers, response.body)

    def _back_off_host(self, base: str) -> None:
        _, previous = self._host_backoff.get(base, (0.0, 0.0))
        delay = min(max(HOST_BACKOFF_MIN_S, previous * 2), float(self.settings.sphere_backoff_max_s))
        self._host_backoff[base] = (self.clock() + delay, delay)
        logger.info("sphere_host_backoff base=%s delay=%.0f", base, delay)

    async def _get(
        self,
        where: SphereEndpoint,
        path: str,
        query: dict[str, str] | None = None,
        credential: Credential | None = None,
        *,
        cacheable: bool = True,
        accept: str = "application/json",
        if_none_match: str | None = None,
        revalidate: bool = False,
    ) -> _Answer | NotModified:
        target = self._target(where)
        if target.registry is not None:
            credential = None  # an organization's key goes to the default SPHERE only
        bucket = self._bucket(target, credential)
        path_key = path + ("?" + urlencode(sorted(query.items())) if query else "")
        cache_key = (target.base, path_key)
        anonymous = credential is None and target.key is None
        use_cache = cacheable and anonymous
        now = self.clock()
        if use_cache and not revalidate:
            entry = self._cache.get(cache_key)
            if entry is not None and entry.expires > now:
                self._cache.move_to_end(cache_key)
                if if_none_match and entry.etag == if_none_match:
                    return NotModified(entry.etag)
                return _Answer(200, httpx.Headers({"etag": entry.etag or ""}), entry.body)
        self._before(target, bucket, path_key, revalidate=revalidate)
        headers = self._headers(target, credential, accept)
        cached = self._cache.get(cache_key) if use_cache else None
        if revalidate and if_none_match:
            # The caller's tag decides; the cached entry is reused only when it is the same answer.
            headers["if-none-match"] = if_none_match
            if cached is not None and cached.etag != if_none_match:
                cached = None
        elif cached is not None and cached.etag:
            headers["if-none-match"] = cached.etag
        elif if_none_match:
            headers["if-none-match"] = if_none_match
        answer = await self._fetch(target, path, query, headers)
        self._after(target, bucket, answer)
        if answer.status == 304:
            if cached is not None:
                cached.expires = now + float(self.settings.sphere_cache_ttl_s)
                self._cache.move_to_end(cache_key)
                if if_none_match and cached.etag == if_none_match:
                    return NotModified(cached.etag)
                return _Answer(200, httpx.Headers({"etag": cached.etag or ""}), cached.body)
            return NotModified(answer.headers.get("etag"))
        if answer.status == 401 and credential is not None:
            logger.info("sphere_key_rejected organization=%s", credential.organization_id)
            if credential.on_rejected is not None:
                callback: Callable[[], Awaitable[None]] = credential.on_rejected
                await callback()
            return await self._get(
                where, path, query, None, cacheable=cacheable, accept=accept, if_none_match=if_none_match,
                revalidate=revalidate,
            )
        if answer.status == 429:
            retry = _retry_after(answer.headers.get("retry-after"))
            hold = min(retry, float(self.settings.sphere_backoff_max_s))
            self._windows[(target.base, bucket)] = self.clock() + hold
            logger.info("sphere_rate_limited base=%s bucket=%s retry_after=%.0f", target.base, bucket, hold)
            raise PricingSourceBusy(int(hold))
        if answer.status in {401, 403, 404}:
            if answer.status == 404:
                self._negative[(target.base, bucket, path_key)] = (self.clock() + NEGATIVE_TTL_S, "not_found")
            raise PricingNotFound(f"{path} is not readable")
        if answer.status >= 500:
            if answer.status == 503:
                self._negative[(target.base, bucket, path_key)] = (self.clock() + NEGATIVE_TTL_S, "unavailable")
            raise PricingSourceUnavailable("unavailable", f"SPHERE answered {answer.status}")
        if answer.status != 200:
            raise PricingSourceUnavailable("unavailable", f"SPHERE answered {answer.status}")
        if use_cache:
            self._cache[cache_key] = _CacheEntry(
                answer.body, answer.headers.get("etag"), now + float(self.settings.sphere_cache_ttl_s)
            )
            self._cache.move_to_end(cache_key)
            while len(self._cache) > CACHE_ENTRIES:
                self._cache.popitem(last=False)
        return answer

    async def _json(self, *args: Any, **kwargs: Any) -> tuple[Any, str | None]:
        answer = await self._get(*args, **kwargs)
        if isinstance(answer, NotModified):
            return answer, answer.etag
        try:
            return json.loads(answer.body), answer.headers.get("etag")
        except ValueError as exc:
            raise PricingSourceUnavailable("unavailable", "SPHERE answered something that is not JSON") from exc

    # -- reads --------------------------------------------------------------------------------------------------------

    async def search(self, where: SphereEndpoint, query: SearchQuery, credential: Credential | None) -> SearchPage:
        organizations = tuple(o for o in query.organizations if is_sphere_id(o))
        params = SearchQuery(
            query.name, query.collection, organizations, query.sort_by, query.sort, query.min_price,
            query.limit, query.offset,
        ).params()
        data, _ = await self._json(where, f"{API}/pricings", params, credential)
        return _shape(parse_search, data)

    async def organization_pricings(
        self, where: SphereEndpoint, sphere_org_id: str, credential: Credential | None, *, offset: int = 0
    ) -> SearchPage:
        if not is_sphere_id(sphere_org_id):
            raise PricingNotFound("not a SPHERE organization id")
        data, _ = await self._json(
            where, f"{API}/pricings/{quote(sphere_org_id, safe='')}", {"limit": "24", "offset": str(max(0, offset))},
            credential,
        )
        return _shape(parse_search, data)

    async def manifest(
        self,
        where: SphereEndpoint,
        pricing_id: str,
        credential: Credential | None,
        *,
        if_none_match: str | None = None,
        revalidate: bool = False,
    ) -> Manifest | NotModified:
        if not is_sphere_id(pricing_id):
            raise PricingNotFound("not a SPHERE pricing id")
        data, etag = await self._json(
            where, f"{API}/public/pricings/{quote(pricing_id, safe='')}", None, credential,
            if_none_match=if_none_match, revalidate=revalidate,
        )
        if isinstance(data, NotModified):
            return data
        return _shape(lambda d: parse_manifest(d, etag=etag), data)

    async def version_yaml(
        self, where: SphereEndpoint, pricing_id: str, version_id: str, credential: Credential | None
    ) -> FetchedYaml:
        if not is_sphere_id(pricing_id) or not is_sphere_id(version_id):
            raise PricingNotFound("not a SPHERE pricing or version id")
        path = f"{API}/public/pricings/{quote(pricing_id, safe='')}/versions/{quote(version_id, safe='')}/yaml"
        answer = await self._get(where, path, None, credential, cacheable=False, accept="application/yaml")
        assert not isinstance(answer, NotModified)
        digest = hashlib.sha256(answer.body).hexdigest()
        etag = answer.headers.get("etag")
        if not etag or etag.strip().removeprefix("W/").strip('"') != digest:
            logger.warning("sphere_integrity pricing=%s version=%s", pricing_id, version_id)
            raise PricingSourceUnavailable("integrity", "the version's bytes do not match its ETag")
        target = self._target(where)
        return FetchedYaml(answer.body, digest, etag, answer.headers.get("last-modified"), target.base + path)

    async def family(self, where: SphereEndpoint, pricing_id: str) -> FamilyIdentity:
        if not is_sphere_id(pricing_id):
            raise PricingNotFound("not a SPHERE pricing id")
        data, _ = await self._json(where, f"{API}/permalinks/pricing/{quote(pricing_id, safe='')}")
        organization_id, slug, collection = _shape(parse_permalink, data)
        organization = await self.organization(where, organization_id)
        return FamilyIdentity(pricing_id, organization_id, slug, organization.name, collection)

    async def organization(self, where: SphereEndpoint, organization_id: str) -> SphereOrganization:
        if not is_sphere_id(organization_id):
            raise PricingNotFound("not a SPHERE organization id")
        data, _ = await self._json(where, f"{API}/orgs/{quote(organization_id, safe='')}")
        return _shape(parse_organization, data)

    async def public_organizations(self, where: SphereEndpoint, q: str) -> list[SphereOrganization]:
        data, _ = await self._json(where, f"{API}/orgs/public", {"q": q[:100]})
        return _shape(parse_public_organizations, data)

    async def whoami(self, where: SphereEndpoint, credential: Credential) -> SphereUser:
        target = self._target(where)
        headers = self._headers(target, credential, "application/json")
        self._before(target, credential.bucket, f"{API}/users/me")
        answer = await self._fetch(target, f"{API}/users/me", None, headers)
        self._after(target, credential.bucket, answer)
        if answer.status == 401:
            raise CredentialRejected("SPHERE refused the key")
        if answer.status == 429:
            raise PricingSourceBusy(int(_retry_after(answer.headers.get("retry-after"))))
        if answer.status != 200:
            raise PricingSourceUnavailable("unavailable", f"SPHERE answered {answer.status}")
        try:
            return _shape(parse_user, json.loads(answer.body))
        except ValueError as exc:
            raise PricingSourceUnavailable("unavailable", "SPHERE answered something that is not JSON") from exc

    async def url_yaml(
        self, url: str, *, if_none_match: str | None = None, if_modified_since: str | None = None
    ) -> FetchedYaml | NotModified:
        return await self.url_source.url_yaml(url, if_none_match=if_none_match, if_modified_since=if_modified_since)


def _retry_after(value: str | None) -> float:
    try:
        return max(1.0, float(value or "1"))
    except ValueError:
        return 1.0


def _shape(parser: Callable[[Any], Any], data: Any) -> Any:
    try:
        return parser(data)
    except (SourceShapeError, KeyError, TypeError, AttributeError) as exc:
        raise PricingSourceUnavailable("unavailable", "SPHERE answered in an unexpected shape") from exc
