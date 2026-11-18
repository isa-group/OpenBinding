"""``RecordedSphere``: SPHERE as the tests see it, served from the recorded answers in ``fixtures/sphere``.

An ``httpx.MockTransport`` that answers the requests ``tools/record_sphere_fixtures.py`` recorded
(``routes.json``: path and sorted query) with their recorded bodies and headers, answers ``If-None-Match``
with 304 on an exact ``ETag`` match, and raises ``UnrecordedRequest`` for anything else, so a test can never
reach the network by accident. It also resolves its host names (``getaddrinfo``), because every request
goes through ``core.outbound`` and is pinned to a checked address.

Each test may script failures and extra answers: ``rate_limited``, ``unavailable``, ``not_found``,
``unauthorized``, ``oversize``, ``encoded``, ``slow``, ``redirect``, ``wrong_etag``, ``private``,
``rate_limit_headers`` and ``serve``. Every request is logged with its headers in ``requests``, so a test can
assert what was (and was not) sent.
"""

from __future__ import annotations

import asyncio
import json
import socket
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

SFX = Path(__file__).resolve().parent / "fixtures" / "sphere"
SPHERE_HOST = "sphere.score.us.es"
#: A global address the recorded host resolves to (nothing ever connects to it).
SPHERE_ADDRESS = "193.147.175.105"


class NetworkForbidden(AssertionError):
    """A test tried to reach the network: every outbound read must be scripted (``tests/conftest.py``)."""


class UnrecordedRequest(AssertionError):
    """A request no recording and no script answers."""


def route_key(path: str, query: str) -> str:
    pairs = sorted(urllib.parse.parse_qsl(query, keep_blank_values=True))
    return path + ("?" + urllib.parse.urlencode(pairs) if pairs else "")


def sfx_bytes(relative: str) -> bytes:
    return (SFX / relative).read_bytes()


def sfx_json(relative: str) -> Any:
    return json.loads(sfx_bytes(relative))


@dataclass
class _Script:
    match: Callable[[httpx.Request, str], bool]
    answer: Callable[[httpx.Request], httpx.Response | None]
    times: int | None = None


@dataclass
class RecordedSphere:
    root: Path = SFX
    hosts: dict[str, str] = field(default_factory=lambda: {SPHERE_HOST: SPHERE_ADDRESS})
    requests: list[httpx.Request] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.routes: dict[str, dict[str, str]] = json.loads((self.root / "routes.json").read_text())
        self.extra: dict[tuple[str, str], tuple[bytes, dict[str, str], int]] = {}
        self.scripts: list[_Script] = []
        self.ratelimit: dict[str, str] | None = None
        self.private_versions: list[dict[str, Any]] = []

    # -- plumbing -------------------------------------------------------------------------------------------------

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def getaddrinfo(self, host: str, port: int, *args: Any, **kwargs: Any) -> list:
        address = self.hosts.get(host)
        if address is None:
            raise socket.gaierror(f"RecordedSphere does not know the host {host}")
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (address, port))]

    def add_host(self, host: str, address: str) -> None:
        """Another host (a registry) serving the same recorded files."""
        self.hosts[host] = address

    def sent(self, path_prefix: str = "") -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.startswith(path_prefix)]

    @staticmethod
    def host_of(request: httpx.Request) -> str:
        return request.headers.get("host", request.url.host).split(":")[0]

    # -- scripts --------------------------------------------------------------------------------------------------

    def _script(self, match, answer, times: int | None = None) -> None:
        self.scripts.insert(0, _Script(match, answer, times))

    def _for(self, path: str | None, credential: str | None = None, host: str | None = None):
        def match(request: httpx.Request, key: str) -> bool:
            if path is not None and not key.startswith(path):
                return False
            if credential is not None and request.headers.get("x-api-key") != credential:
                return False
            if host is not None and self.host_of(request) != host:
                return False
            return True

        return match

    def rate_limited(
        self, retry_after: int = 7, *, credential: str | None = None, anonymous: bool = False, path: str | None = None,
        times: int | None = None,
    ) -> None:
        base = self._for(path, credential)

        def match(request: httpx.Request, key: str) -> bool:
            if anonymous and "x-api-key" in request.headers:
                return False
            return base(request, key)

        self._script(match, lambda r: httpx.Response(429, headers={"retry-after": str(retry_after)}, json={"error": "rate"}), times)

    def unavailable(self, path: str | None = None, *, status: int = 503, times: int | None = None, host: str | None = None) -> None:
        self._script(self._for(path, host=host), lambda r: httpx.Response(status, json={"error": "unavailable"}), times)

    def not_found(self, path: str, *, times: int | None = None) -> None:
        self._script(self._for(path), lambda r: httpx.Response(404, json={"error": "NOT FOUND"}), times)

    def unauthorized(self, credential: str | None = None, *, times: int | None = None) -> None:
        def match(request: httpx.Request, key: str) -> bool:
            sent = request.headers.get("x-api-key")
            return sent is not None and (credential is None or sent == credential)

        self._script(match, lambda r: httpx.Response(401, json={"error": "UNAUTHORIZED"}), times)

    def oversize(self, path: str, size: int, *, declared: bool = False) -> None:
        body = b"a: " + b"x" * size + b"\n"
        headers = {"content-type": "application/yaml"}
        if not declared:
            class Chunked(httpx.AsyncByteStream):
                async def __aiter__(self):
                    for i in range(0, len(body), 65536):
                        yield body[i : i + 65536]

            self._script(self._for(path), lambda r: httpx.Response(200, headers=headers, stream=Chunked()))
        else:
            self._script(self._for(path), lambda r: httpx.Response(200, headers=headers, content=body))

    def encoded(self, path: str, encoding: str = "gzip") -> None:
        import gzip

        self._script(
            self._for(path),
            lambda r: httpx.Response(200, headers={"content-encoding": encoding}, content=gzip.compress(b"a: 1\n")),
        )

    def slow(self, path: str | None = None, seconds: float = 30.0) -> None:
        async def answer(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(seconds)
            return httpx.Response(200, content=b"")

        self._script(self._for(path), answer)

    def connect_error(self, path: str | None = None, *, host: str | None = None, times: int | None = None) -> None:
        def answer(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("scripted connect timeout", request=request)

        self._script(self._for(path, host=host), answer, times)

    def redirect(self, path: str, location: str) -> None:
        self._script(self._for(path), lambda r: httpx.Response(302, headers={"location": location}))

    def wrong_etag(self, path: str) -> None:
        def answer(request: httpx.Request) -> httpx.Response:
            response = self._recorded(request, route_key(request.url.path, request.url.query.decode()))
            assert response is not None
            headers = dict(response.headers)
            headers["etag"] = '"' + "0" * 64 + '"'
            return httpx.Response(response.status_code, headers=headers, content=response.content)

        self._script(self._for(path), answer)

    def rate_limit_headers(self, *, limit: int = 300, remaining: int, reset: int = 9) -> None:
        self.ratelimit = {"ratelimit-limit": str(limit), "ratelimit-remaining": str(remaining), "ratelimit-reset": str(reset)}

    def serve(
        self, path: str, body: bytes, headers: dict[str, str] | None = None, *, query: str = "", status: int = 200
    ) -> None:
        """An extra answer for ``path`` (and ``query``), e.g. a derived version."""
        sent_headers = {"content-type": "application/octet-stream"} | dict(headers or {})
        self.extra[(path, route_key("", query))] = (body, sent_headers, status)

    def private(
        self, pricing_id: str, version_id: str, yaml: bytes, *, credential: str, label: str = "private-1",
        created_at: str = "2030-01-01T00:00:00.000Z", content_hash: str | None = None,
    ) -> None:
        """A private version of ``pricing_id``: listed in the manifest and served only with ``credential``."""
        import hashlib

        from openbinding_gateway.modules.plans.domain.content_hash import functional_hash

        self.private_versions.append(
            {
                "pricing_id": pricing_id,
                "credential": credential,
                "entry": {
                    "versionId": version_id,
                    "version": label,
                    "createdAt": created_at,
                    "contentHash": content_hash or functional_hash(yaml),
                    "private": True,
                },
                "yaml": yaml,
                "etag": '"' + hashlib.sha256(yaml).hexdigest() + '"',
            }
        )

    # -- answering ------------------------------------------------------------------------------------------------

    def _recorded(self, request: httpx.Request, key: str) -> httpx.Response | None:
        path = request.url.path
        query = route_key("", request.url.query.decode())
        if (path, query) in self.extra:
            body, headers, status = self.extra[(path, query)]
            return httpx.Response(status, headers=headers, content=body)
        entry = self.routes.get(key)
        if entry is None:
            return None
        headers = json.loads((self.root / entry["headers"]).read_text())
        return httpx.Response(200, headers=headers, content=(self.root / entry["file"]).read_bytes())

    def _private_answer(self, request: httpx.Request) -> httpx.Response | None:
        sent = request.headers.get("x-api-key")
        for item in self.private_versions:
            manifest_path = f"/api/v1/public/pricings/{item['pricing_id']}"
            yaml_path = f"{manifest_path}/versions/{item['entry']['versionId']}/yaml"
            if request.url.path == yaml_path:
                if sent != item["credential"]:
                    return httpx.Response(404, json={"error": "NOT FOUND"})
                return httpx.Response(
                    200, headers={"content-type": "application/yaml", "etag": item["etag"],
                                  "cache-control": "private, no-store", "vary": "Authorization, x-api-key"},
                    content=item["yaml"],
                )
        return None

    def _with_private(self, request: httpx.Request, response: httpx.Response) -> httpx.Response:
        sent = request.headers.get("x-api-key")
        extra = [
            item["entry"]
            for item in self.private_versions
            if request.url.path == f"/api/v1/public/pricings/{item['pricing_id']}" and sent == item["credential"]
        ]
        if not extra:
            return response
        manifest = json.loads(response.content)
        manifest["versions"] = list(manifest["versions"]) + extra
        headers = {"content-type": "application/json", "cache-control": "private, no-store",
                   "vary": "Authorization, x-api-key"}
        return httpx.Response(200, headers=headers, content=json.dumps(manifest).encode())

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.host_of(request) not in self.hosts:
            raise UnrecordedRequest(f"unknown host {self.host_of(request)}")
        key = route_key(request.url.path, request.url.query.decode())
        for script in list(self.scripts):
            if script.match(request, key):
                if script.times is not None:
                    script.times -= 1
                    if script.times <= 0:
                        self.scripts.remove(script)
                answer = script.answer(request)
                if asyncio.iscoroutine(answer):
                    answer = await answer
                if answer is not None:
                    return self._decorate(answer)
        private = self._private_answer(request)
        if private is not None:
            return self._decorate(private)
        response = self._recorded(request, key)
        if response is None:
            raise UnrecordedRequest(f"no recording for GET {key}")
        response = self._with_private(request, response)
        etag = response.headers.get("etag")
        if etag and request.headers.get("if-none-match") == etag:
            return self._decorate(httpx.Response(304, headers={"etag": etag}))
        return self._decorate(response)

    def _decorate(self, response: httpx.Response) -> httpx.Response:
        if self.ratelimit is None:
            return response
        try:
            content = response.content
        except httpx.ResponseNotRead:
            return response
        return httpx.Response(response.status_code, headers=dict(response.headers) | self.ratelimit, content=content)
