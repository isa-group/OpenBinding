"""The one outbound HTTP policy of the gateway.

Every read OpenBinding makes on a user's or an operator's behalf goes through
this module: remote engines (``v1/remote.py``) and pricing sources (SPHERE, the
operator's registries and user-supplied Pricing2Yaml URLs). It owns the SSRF
rules, so there is one policy and not one per caller:

- the scheme is ``https`` (``http`` only for an operator's internal engine);
  no userinfo, no fragment;
- every DNS answer is resolved off the event loop and every address must be
  global, unless the caller is an operator-configured endpoint
  (``allow_internal``); multicast, unspecified and reserved addresses are always
  refused, and IPv6 forms that embed an IPv4 address (IPv4-mapped, 6to4, NAT64,
  Teredo) are judged by the address they embed;
- the connection is pinned to the checked address, with ``Host`` and the TLS
  SNI set to the name, so a second, attacker-controlled DNS answer is never
  used (DNS rebinding);
- no proxy environment and no netrc (``trust_env=False``); redirects are never
  followed by httpx: ``fetch`` follows at most ``max_redirects`` of them, each
  resolved, kept on ``https``, revalidated and re-pinned, and credentials are
  never carried across a hop;
- ``fetch`` asks for ``identity`` encoding and refuses an encoded answer instead
  of inflating it, and the body is streamed and capped.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import SplitResult, urljoin, urlsplit, urlunsplit

import httpx

logger = logging.getLogger(__name__)

#: Headers that carry a credential and are never sent across a redirect.
CREDENTIAL_HEADERS = frozenset({"authorization", "x-api-key", "cookie", "proxy-authorization"})

OUTBOUND_CODES = frozenset(
    {
        "outbound_scheme",
        "outbound_userinfo",
        "outbound_address",
        "outbound_dns",
        "outbound_redirect",
        "outbound_too_large",
        "outbound_timeout",
        "outbound_connect",
        "outbound_status",
    }
)


class OutboundError(Exception):
    """An outbound read was refused or failed. ``code`` is one of ``OUTBOUND_CODES``.

    The message is internal (it may name the host); callers map the code to their own public category.
    """

    def __init__(self, code: str, message: str = "") -> None:
        assert code in OUTBOUND_CODES, code
        super().__init__(message or code)
        self.code = code


@dataclass(frozen=True)
class OutboundPolicy:
    """What one kind of outbound read may do."""

    https_only: bool = True
    #: True only for operator-configured endpoints (internal engines, ``SPHERE_REGISTRIES`` aliases).
    allow_internal: bool = False
    max_bytes: int = 5 * 1024 * 1024
    connect_timeout_s: float = 3.0
    read_timeout_s: float = 5.0
    total_timeout_s: float = 10.0
    #: User-supplied URLs: 3, every hop revalidated; SPHERE: 0.
    max_redirects: int = 0


@dataclass(frozen=True)
class OutboundResponse:
    status: int
    headers: httpx.Headers
    body: bytes
    final_url: str
    redirects: tuple[str, ...] = field(default_factory=tuple)


def mask_url(url: str) -> str:
    """The URL for a log line: scheme, host, port and path, the query string masked."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return "<invalid url>"
    query = "?…" if parsed.query else ""
    return urlunsplit((parsed.scheme, parsed.netloc.rpartition("@")[2], parsed.path, "", "")) + query


# --- addresses ---------------------------------------------------------------------------------------------------

_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_NAT64_LOCAL = ipaddress.ip_network("64:ff9b:1::/48")


def _embedded_ipv4(address: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    if address.sixtofour is not None:
        return address.sixtofour
    if address.teredo is not None:
        return address.teredo[1]
    if address in _NAT64 or address in _NAT64_LOCAL:
        return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    return None


def address_class(value: str) -> str:
    """``global``, ``local`` (private, loopback, link-local, ULA) or ``forbidden`` (never reachable).

    An IPv6 address that embeds an IPv4 address is classified by the address it embeds. Shared address
    space (100.64/10), reserved, multicast and unspecified addresses are ``forbidden``.
    """
    try:
        address: ipaddress.IPv4Address | ipaddress.IPv6Address = ipaddress.ip_address(value)
    except ValueError:
        return "forbidden"
    if isinstance(address, ipaddress.IPv6Address):
        if address.scope_id:
            return "forbidden"
        embedded = _embedded_ipv4(address)
        if embedded is not None:
            return address_class(embedded.compressed)
    if address.is_multicast or address.is_unspecified or address.is_reserved:
        return "forbidden"
    if address.is_private or address.is_loopback or address.is_link_local:
        return "local"
    if address.is_global:
        return "global"
    return "forbidden"


def _permitted(value: str, *, internal_only: bool, allow_internal: bool) -> str:
    kind = address_class(value)
    if kind == "forbidden":
        raise OutboundError("outbound_address", "endpoint targets an address outside its permitted network class")
    if internal_only and kind != "local":
        raise OutboundError("outbound_address", "endpoint targets an address outside its permitted network class")
    if not internal_only and kind == "local" and not allow_internal:
        raise OutboundError("outbound_address", "endpoint targets an address outside its permitted network class")
    return ipaddress.ip_address(value).compressed


def _getaddrinfo(host: str, port: int) -> list:
    """The resolver, looked up through ``socket`` on every call so that a test may script it."""
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def validate_endpoint(
    endpoint: str, *, allow_internal_http: bool = False, allow_internal: bool = False
) -> tuple[str, ...]:
    """Validate ``endpoint`` and return the complete permitted DNS answer, sorted.

    Callers connect to one of the returned addresses instead of resolving the name again. ``http`` is
    accepted only with ``allow_internal_http`` and then only towards local addresses (an operator's
    in-cluster engine); ``https`` must reach global addresses unless ``allow_internal``. One forbidden
    address in the answer refuses the whole endpoint.
    """
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError as exc:
        raise OutboundError("outbound_scheme", "endpoint is not a valid URL") from exc
    scheme_ok = parsed.scheme == "https" or (allow_internal_http and parsed.scheme == "http")
    requirement = "HTTPS" if not allow_internal_http else "HTTPS or trusted internal HTTP"
    if not scheme_ok or not parsed.hostname:
        raise OutboundError("outbound_scheme", f"endpoint must use {requirement} without userinfo or fragments")
    if parsed.username or parsed.password or "@" in parsed.netloc or parsed.fragment:
        raise OutboundError("outbound_userinfo", f"endpoint must use {requirement} without userinfo or fragments")
    host = parsed.hostname
    internal_only = parsed.scheme == "http"
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        return (_permitted(literal.compressed, internal_only=internal_only, allow_internal=allow_internal),)
    try:
        answer = {item[4][0] for item in _getaddrinfo(host, port or (443 if parsed.scheme == "https" else 80))}
    except OSError as exc:
        raise OutboundError("outbound_dns", f"endpoint cannot be resolved: {host}") from exc
    if not answer:
        raise OutboundError("outbound_dns", f"endpoint cannot be resolved: {host}")
    return tuple(
        sorted(_permitted(value, internal_only=internal_only, allow_internal=allow_internal) for value in answer)
    )


async def avalidate_endpoint(
    endpoint: str, *, allow_internal_http: bool = False, allow_internal: bool = False
) -> tuple[str, ...]:
    """``validate_endpoint`` off the event loop (``getaddrinfo`` blocks)."""
    return await asyncio.to_thread(
        validate_endpoint, endpoint, allow_internal_http=allow_internal_http, allow_internal=allow_internal
    )


# --- pinning -----------------------------------------------------------------------------------------------------


def pinned_url(url: str, address: str) -> str:
    """``url`` with its host replaced by ``address`` (the port, path and query kept, no fragment)."""
    parsed: SplitResult = urlsplit(url)
    ip = ipaddress.ip_address(address)
    host = f"[{ip.compressed}]" if ip.version == 6 else ip.compressed
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, parsed.query, ""))


def host_header(parsed: SplitResult) -> str:
    host = parsed.hostname or ""
    try:
        if ipaddress.ip_address(host).version == 6:
            host = f"[{host}]"
    except ValueError:
        pass
    return f"{host}:{parsed.port}" if parsed.port is not None else host


def build_pinned_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    address: str | None,
    *,
    headers: Mapping[str, str] | None = None,
    content: bytes | str | None = None,
) -> httpx.Request:
    """A request for ``url`` sent to ``address``, with ``Host`` and the TLS SNI naming the original host."""
    original = urlsplit(url)
    sent_headers = dict(headers or {})
    target = url
    if address:
        target = pinned_url(url, address)
        sent_headers["host"] = host_header(original)
    request = client.build_request(method, target, headers=sent_headers, content=content)
    if address and original.hostname:
        request.extensions["sni_hostname"] = original.hostname
    return request


async def read_bounded(response: httpx.Response, *, limit: int) -> bytes:
    """The body of a streamed ``response``, refused (``outbound_too_large``) once it passes ``limit`` bytes.

    A declared ``Content-Length`` above the limit is refused before anything is read. ``fetch`` refuses
    any ``Content-Encoding`` before calling this, so what is counted is what came off the wire.
    """
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise OutboundError("outbound_too_large", "response exceeds the configured size limit")
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > limit:
            raise OutboundError("outbound_too_large", "response exceeds the configured size limit")
    return bytes(content)


def default_transport() -> httpx.AsyncBaseTransport | None:
    """The transport ``fetch`` uses when the caller gives none (``None``: httpx's own). Tests replace it."""
    return None


# --- fetch -------------------------------------------------------------------------------------------------------

_REDIRECTS = frozenset({301, 302, 303, 307, 308})


def _timeout_code(error: httpx.HTTPError) -> str:
    if isinstance(error, httpx.TimeoutException):
        return "outbound_timeout"
    return "outbound_connect"


async def fetch(
    url: str,
    *,
    policy: OutboundPolicy,
    headers: Mapping[str, str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> OutboundResponse:
    """GET ``url`` under ``policy``; any status is returned (the caller judges it), redirects aside.

    Raises ``OutboundError``. A redirect beyond ``policy.max_redirects``, to another scheme or to a refused
    address is ``outbound_redirect``/``outbound_address``; the ``Location`` of each hop is resolved against
    the current URL, revalidated and re-pinned, and no credential header is sent to a hop.
    """
    deadline = time.monotonic() + policy.total_timeout_s
    sent = {key.lower(): value for key, value in (headers or {}).items()}
    sent["accept-encoding"] = "identity"
    current = url
    hops: list[str] = []
    timeout = httpx.Timeout(policy.read_timeout_s, connect=policy.connect_timeout_s)
    chosen = transport if transport is not None else default_transport()
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=chosen, trust_env=False) as client:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OutboundError("outbound_timeout", f"total time exceeded reading {mask_url(url)}")
            try:
                addresses = await asyncio.wait_for(
                    avalidate_endpoint(
                        current,
                        allow_internal_http=not policy.https_only,
                        allow_internal=policy.allow_internal,
                    ),
                    timeout=remaining,
                )
            except TimeoutError as exc:
                raise OutboundError("outbound_timeout", f"DNS took too long for {mask_url(current)}") from exc
            address = addresses[0] if addresses else None
            request = build_pinned_request(client, "GET", current, address, headers=sent)
            try:
                status, response_headers, body = await asyncio.wait_for(
                    _send(client, request, policy.max_bytes), timeout=max(deadline - time.monotonic(), 0.001)
                )
            except TimeoutError as exc:
                raise OutboundError("outbound_timeout", f"total time exceeded reading {mask_url(current)}") from exc
            except httpx.HTTPError as exc:
                logger.info("outbound_failed url=%s error=%s", mask_url(current), type(exc).__name__)
                raise OutboundError(_timeout_code(exc), f"request to {mask_url(current)} failed") from exc
            if status in _REDIRECTS:
                location = response_headers.get("location")
                if not location or len(hops) >= policy.max_redirects:
                    raise OutboundError("outbound_redirect", f"redirect refused from {mask_url(current)}")
                target = urljoin(current, location)
                if urlsplit(target).scheme != urlsplit(current).scheme or urlsplit(target).scheme != "https":
                    raise OutboundError("outbound_redirect", f"redirect to another scheme from {mask_url(current)}")
                hops.append(target)
                sent = {key: value for key, value in sent.items() if key not in CREDENTIAL_HEADERS}
                current = target
                continue
            return OutboundResponse(status, response_headers, body, current, tuple(hops))


async def _send(client: httpx.AsyncClient, request: httpx.Request, limit: int) -> tuple[int, httpx.Headers, bytes]:
    response = await client.send(request, stream=True)
    try:
        if response.status_code in _REDIRECTS:
            return response.status_code, response.headers, b""
        encoding = response.headers.get("content-encoding", "").strip().lower()
        if encoding and encoding != "identity":
            raise OutboundError("outbound_status", f"encoded answer refused ({encoding})")
        body = await read_bounded(response, limit=limit)
        return response.status_code, response.headers, body
    finally:
        await response.aclose()

