"""Pinned, bounded transport for registered v1 engines.

The gateway never gives a remote engine the source package.  Only the
canonical BindingProblem envelope crosses this boundary.  This module only
carries bytes: it checks the endpoint policy, the size of what comes back, and
the envelope of an asynchronous job (receipt, status).  Whether an answer is
shaped like a ``bim-engine/v1`` result is the toolchain's to judge, and the
caller says how through ``validate_result`` (``services.engines.validate_engine_result``)
before the answer is allowed into the normal reevaluation path.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import SplitResult, quote, urljoin, urlparse, urlsplit, urlunsplit

import httpx
from bim_core import PackageError

from ..core.jsonio import strict_json_loads
from ..core.public_errors import DEFAULT_ENGINE_FAILURE, bounded


class RemoteEngineError(RuntimeError):
    """A remote engine could not be used.

    The message is internal: it may name the endpoint or quote what the engine
    wrote, and it goes to the log only. ``code`` is the stable category from
    ``core.public_errors.JOB_FAILURES`` that a job shows in its place.
    """

    def __init__(self, message: str = "", code: str = DEFAULT_ENGINE_FAILURE) -> None:
        super().__init__(message)
        self.code = code


#: Longest text of an engine's own ``error`` that is kept, even in the message.
MAX_ENGINE_ERROR_TEXT = 1024


def _transport_code(error: httpx.HTTPError) -> str:
    return "engine_timeout" if isinstance(error, httpx.TimeoutException) else "engine_unreachable"


#: Judges a decoded engine answer and raises ``RemoteEngineError`` if it is not a valid result.
ResultValidator = Callable[[object], Awaitable[None]]


@dataclass(frozen=True)
class RemoteRegistration:
    endpoint: str
    mappings: dict
    auth_scheme: str = "none"
    credential: str | None = None
    allow_internal_http: bool = False


MAX_REMOTE_RESPONSE = 4 * 1024 * 1024


def _permitted_address(value: str, *, internal: bool) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise RemoteEngineError(
            f"engine endpoint resolved to an invalid address: {value}", code="engine_endpoint_invalid"
        ) from exc
    if address.is_multicast or address.is_unspecified or address.is_reserved:
        raise RemoteEngineError(
            "engine endpoint targets an address outside its permitted network class",
            code="engine_endpoint_invalid",
        )
    local = address.is_private or address.is_loopback or address.is_link_local
    if (internal and not local) or (not internal and not address.is_global):
        raise RemoteEngineError(
            "engine endpoint targets an address outside its permitted network class",
            code="engine_endpoint_invalid",
        )
    return address.compressed


def validate_endpoint(endpoint: str, *, allow_internal_http: bool = False) -> tuple[str, ...]:
    """Validate an endpoint and return the complete permitted DNS answer.

    Callers must connect to one of the returned addresses instead of resolving
    the hostname again.  This closes the DNS-rebinding gap between policy
    validation and the actual TCP connection.
    """

    parsed = urlparse(endpoint)
    allowed_scheme = parsed.scheme == "https" or (allow_internal_http and parsed.scheme == "http")
    if not allowed_scheme or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        requirement = "HTTPS" if not allow_internal_http else "HTTPS or trusted internal HTTP"
        raise RemoteEngineError(
            f"engine endpoint must use {requirement} without userinfo or fragments",
            code="engine_endpoint_invalid",
        )
    host = parsed.hostname
    internal = parsed.scheme == "http"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            resolved = {
                item[4][0]
                for item in socket.getaddrinfo(
                    host,
                    parsed.port or (443 if parsed.scheme == "https" else 80),
                    type=socket.SOCK_STREAM,
                )
            }
        except OSError as exc:
            raise RemoteEngineError(
                f"engine endpoint cannot be resolved: {host}", code="engine_unreachable"
            ) from exc
        if not resolved:
            raise RemoteEngineError(
                f"engine endpoint cannot be resolved: {host}", code="engine_unreachable"
            ) from None
        return tuple(sorted(_permitted_address(value, internal=internal) for value in resolved))
    return (_permitted_address(address.compressed, internal=internal),)


async def avalidate_endpoint(
    endpoint: str,
    *,
    allow_internal_http: bool = False,
    validate: Callable[..., tuple[str, ...]] | None = None,
) -> tuple[str, ...]:
    """``validate_endpoint`` without blocking the event loop.

    The DNS lookup inside ``validate_endpoint`` is a blocking ``getaddrinfo``;
    run on the loop it would stall everything that shares it - heartbeats and
    lease renewals included - for as long as a resolver takes to answer or time
    out. The whole policy check therefore runs in the default executor, which
    is where ``loop.getaddrinfo`` itself would run the lookup, and the
    resolved answer is still pinned by the caller. Looked up through the module
    on every call so that a test (or a deployment shim) replacing
    ``validate_endpoint`` keeps replacing it. A caller that imports the
    validator under its own module name may pass it as ``validate`` for the
    same reason.
    """
    return await asyncio.to_thread(
        validate or validate_endpoint, endpoint, allow_internal_http=allow_internal_http
    )


def _pinned_url(url: str, address: str) -> str:
    parsed: SplitResult = urlsplit(url)
    ip = ipaddress.ip_address(address)
    host = f"[{ip.compressed}]" if ip.version == 6 else ip.compressed
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, parsed.query, ""))


def _host_header(parsed: SplitResult) -> str:
    host = parsed.hostname or ""
    try:
        if ipaddress.ip_address(host).version == 6:
            host = f"[{host}]"
    except ValueError:
        pass
    return f"{host}:{parsed.port}" if parsed.port is not None else host


def _path(base: str, value: object, default: str) -> str:
    if not isinstance(value, str) or not value:
        value = default
    supplied = urlparse(str(value))
    if supplied.scheme or supplied.netloc or supplied.fragment or not str(value).startswith("/"):
        raise RemoteEngineError(
            "engine mapping must be an absolute path on the registered origin", code="engine_endpoint_invalid"
        )
    result = urljoin(base.rstrip("/") + "/", str(value).lstrip("/"))
    expected, actual = urlparse(base), urlparse(result)
    if (actual.scheme, actual.hostname, actual.port) != (expected.scheme, expected.hostname, expected.port):
        raise RemoteEngineError(
            "engine mapping must remain on the registered origin", code="engine_endpoint_invalid"
        )
    return result


def _headers(registration: RemoteRegistration) -> dict[str, str]:
    headers = {"content-type": "application/json", "accept": "application/json"}
    if registration.auth_scheme == "bearer":
        if not registration.credential:
            raise RemoteEngineError("registration requires a bearer credential", code="credential_unavailable")
        headers["authorization"] = f"Bearer {registration.credential}"
    elif registration.auth_scheme == "basic":
        if not registration.credential:
            raise RemoteEngineError("registration requires a basic credential", code="credential_unavailable")
        encoded = base64.b64encode(registration.credential.encode("utf-8")).decode("ascii")
        headers["authorization"] = f"Basic {encoded}"
    elif registration.auth_scheme == "mtls":
        raise RemoteEngineError(
            "mTLS registrations require a credential-bundle contract not available in BIM v1",
            code="credential_unavailable",
        )
    elif registration.auth_scheme != "none":
        raise RemoteEngineError(
            f"unsupported registration auth scheme: {registration.auth_scheme}", code="credential_unavailable"
        )
    return headers


def _validate_job_receipt(payload: object) -> str:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"id", "status"}
        or not isinstance(payload.get("id"), str)
        or not payload["id"]
        or payload.get("status") != "queued"
    ):
        raise RemoteEngineError(
            "engine acceptance receipt must satisfy EngineJobAccepted", code="engine_protocol_error"
        )
    return payload["id"]


def _validate_job(payload: object, expected_id: str) -> object | None:
    """The result carried by a finished job (still to be judged by the caller), ``None`` while it runs."""
    if not isinstance(payload, dict):
        raise RemoteEngineError("engine polling returned a non-object response", code="engine_protocol_error")
    job_id = payload.get("id")
    state = payload.get("status")
    created_at = payload.get("created_at")
    if (
        job_id != expected_id
        or not isinstance(job_id, str)
        or not isinstance(created_at, int)
        or isinstance(created_at, bool)
        or created_at < 0
        or state not in {"queued", "running", "completed", "failed"}
    ):
        raise RemoteEngineError("engine polling response must satisfy EngineJob", code="engine_protocol_error")
    if state in {"queued", "running"}:
        if set(payload) != {"id", "status", "created_at"}:
            raise RemoteEngineError(
                "engine polling response must satisfy EngineJob", code="engine_protocol_error"
            )
        return None
    if state == "failed":
        if set(payload) != {"id", "status", "created_at", "error"} or not isinstance(
            payload.get("error"), str
        ):
            raise RemoteEngineError(
                "engine polling response must satisfy EngineJob", code="engine_protocol_error"
            )
        # What the engine wrote is bounded here and only ever reaches the log.
        raise RemoteEngineError(
            bounded(payload["error"] or "remote engine failed", MAX_ENGINE_ERROR_TEXT), code="engine_failed"
        )
    if set(payload) != {"id", "status", "created_at", "result"}:
        raise RemoteEngineError("engine polling response must satisfy EngineJob", code="engine_protocol_error")
    return payload["result"]


async def _judge(validate_result: ResultValidator | None, answer: object) -> None:
    """Let the caller judge ``answer``; a verdict that names no category is a protocol error."""
    if validate_result is None:
        return
    try:
        await validate_result(answer)
    except RemoteEngineError as exc:
        if exc.code == DEFAULT_ENGINE_FAILURE:
            exc.code = "engine_protocol_error"
        raise


async def _bounded_bytes(response: httpx.Response, *, limit: int | None = None) -> bytes:
    if limit is None:
        limit = MAX_REMOTE_RESPONSE
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise RemoteEngineError("engine response exceeds the configured size limit", code="engine_protocol_error")
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > limit:
            raise RemoteEngineError(
                "engine response exceeds the configured size limit", code="engine_protocol_error"
            )
    return bytes(content)


async def _bounded_json(response: httpx.Response) -> object:
    try:
        return strict_json_loads(await _bounded_bytes(response))
    except PackageError as exc:
        raise RemoteEngineError("engine returned invalid JSON", code="engine_protocol_error") from exc


async def fetch_remote_document(
    registration: RemoteRegistration,
    path: str,
    *,
    timeout_s: float = 10.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Fetch a bounded JSON deployment document over the pinned origin."""

    addresses = await avalidate_endpoint(
        registration.endpoint, allow_internal_http=registration.allow_internal_http
    )
    url = _path(registration.endpoint, path, path)
    headers = _headers(registration)
    headers["accept"] = "application/json"
    pinned_address = addresses[0] if addresses else None
    original = urlsplit(registration.endpoint)
    if pinned_address:
        url = _pinned_url(url, pinned_address)
        headers["host"] = _host_header(original)
    timeout = httpx.Timeout(timeout_s, connect=min(timeout_s, 5.0))
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport, trust_env=False) as client:
        try:
            request = client.build_request("GET", url, headers=headers)
            if pinned_address and original.hostname:
                request.extensions["sni_hostname"] = original.hostname
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise RemoteEngineError(f"engine document request failed: {exc}", code=_transport_code(exc)) from exc
        if response.status_code != 200:
            await response.aclose()
            raise RemoteEngineError(
                f"engine document request failed ({response.status_code})", code="engine_rejected"
            )
        try:
            raw = await _bounded_bytes(response)
        finally:
            await response.aclose()
    try:
        document = strict_json_loads(raw)
    except PackageError as exc:
        raise RemoteEngineError("engine returned an invalid JSON document", code="engine_protocol_error") from exc
    if not isinstance(document, dict):
        raise RemoteEngineError("engine document must be an object", code="engine_protocol_error")
    return document


#: Hints sent with every request to an engine so that it can recognise a repeated
#: submission of the same gateway job (a redelivered message, a second attempt).
#: They are documented hints, not part of ``bim-engine/v1``: an engine may ignore
#: them, and one that does cannot be protected from running the work twice.
JOB_ID_HEADER = "X-Openbinding-Job-Id"
ATTEMPT_HEADER = "X-Openbinding-Attempt"


async def solve_remote(
    registration: RemoteRegistration,
    problem: dict,
    options: dict,
    optimization: dict,
    *,
    timeout_s: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
    job_id: str | None = None,
    attempt: int | None = None,
    on_remote_id: Callable[[str], Awaitable[None]] | None = None,
    validate_result: ResultValidator | None = None,
) -> dict:
    """Submit a BindingProblem and wait for its result.

    ``job_id`` and ``attempt`` travel as ``X-Openbinding-Job-Id`` and
    ``X-Openbinding-Attempt``. ``on_remote_id`` is awaited with the engine's own
    job id as soon as the engine has accepted the work and before the first poll,
    so the caller can make that id durable before it waits. ``validate_result`` is
    awaited with the decoded answer (synchronous or from a finished job) and
    raises ``RemoteEngineError`` for one that is not a ``bim-engine/v1`` result;
    without it the answer is returned as received.
    """
    addresses = await avalidate_endpoint(
        registration.endpoint, allow_internal_http=registration.allow_internal_http
    )
    mappings = registration.mappings or {}
    request_url = _path(registration.endpoint, mappings.get("request"), "/internal/v1/binding-problems")
    poll_template = mappings.get("job", "/internal/v1/jobs/{id}")
    body = {"apiVersion": "bim/v1", "kind": "BindingProblemRequest", "protocol": "bim-engine/v1", "problem": problem, "optimization": optimization, "options": options}
    try:
        # Open range ends travel as JSON null; a NaN/Infinity must never be
        # emitted because it is not JSON and a conforming Engine would reject it.
        content = json.dumps(body, separators=(",", ":"), allow_nan=False)
    except ValueError as exc:
        raise RemoteEngineError(f"BindingProblem request is not valid JSON: {exc}", code="job_input_invalid") from exc
    headers = _headers(registration)
    if job_id is not None:
        headers[JOB_ID_HEADER] = job_id
    if attempt is not None:
        headers[ATTEMPT_HEADER] = str(attempt)
    timeout = httpx.Timeout(timeout_s, connect=min(timeout_s, 5.0))
    # The policy-checked address is frozen for the complete request/poll cycle;
    # httpx therefore never performs a second, attacker-controlled DNS lookup.
    # A test transport may deliberately bypass resolution by monkeypatching the
    # validator to return None.
    pinned_address = addresses[0] if addresses else None
    original = urlsplit(registration.endpoint)
    if pinned_address:
        request_url = _pinned_url(request_url, pinned_address)
        headers["host"] = _host_header(original)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport, trust_env=False) as client:
        try:
            request = client.build_request("POST", request_url, headers=headers, content=content)
            if pinned_address and original.hostname:
                request.extensions["sni_hostname"] = original.hostname
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise RemoteEngineError(f"engine request failed: {exc}", code=_transport_code(exc)) from exc
        if response.status_code == 200:
            try:
                answer = await _bounded_json(response)
            finally:
                await response.aclose()
            await _judge(validate_result, answer)
            return answer  # type: ignore[return-value]
        if response.status_code != 202:
            await response.aclose()
            raise RemoteEngineError(
                f"engine rejected BindingProblem ({response.status_code})", code="engine_rejected"
            )
        try:
            receipt = await _bounded_json(response)
        finally:
            await response.aclose()
        engine_job_id = _validate_job_receipt(receipt)
        if on_remote_id is not None:
            await on_remote_id(engine_job_id)
        deadline = asyncio.get_running_loop().time() + timeout_s
        while asyncio.get_running_loop().time() < deadline:
            poll_url = _path(
                registration.endpoint, str(poll_template).replace("{id}", engine_job_id), "/internal/v1/jobs/{id}"
            )
            if pinned_address:
                poll_url = _pinned_url(poll_url, pinned_address)
            try:
                poll_request = client.build_request("GET", poll_url, headers=headers)
                if pinned_address and original.hostname:
                    poll_request.extensions["sni_hostname"] = original.hostname
                polled = await client.send(poll_request, stream=True)
            except httpx.HTTPError as exc:
                raise RemoteEngineError(f"engine polling failed: {exc}", code=_transport_code(exc)) from exc
            if polled.status_code == 404:
                await polled.aclose()
                raise RemoteEngineError("engine job disappeared while polling", code="engine_error")
            if polled.status_code >= 400:
                await polled.aclose()
                raise RemoteEngineError(f"engine polling failed ({polled.status_code})", code="engine_error")
            try:
                payload = await _bounded_json(polled)
            finally:
                await polled.aclose()
            result = _validate_job(payload, engine_job_id)
            if result is None:
                await asyncio.sleep(0.05)
                continue
            await _judge(validate_result, result)
            return result  # type: ignore[return-value]
        raise RemoteEngineError("remote engine timed out", code="engine_timeout")


async def cancel_remote(
    registration: RemoteRegistration,
    engine_job_id: str,
    *,
    timeout_s: float = 3.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bool:
    """Ask an engine to stop one of its jobs. Best effort: it never raises.

    ``bim-engine/v1`` has no cancellation operation, so this is a ``DELETE`` on
    the engine's job resource (the ``job`` mapping), which an engine may honour
    or answer with 404/405. The result is whether the engine acknowledged it;
    every failure, a timeout included, is swallowed because the caller has
    already decided what happens to the gateway's job.
    """

    async def attempt() -> bool:
        addresses = await avalidate_endpoint(
            registration.endpoint, allow_internal_http=registration.allow_internal_http
        )
        poll_template = (registration.mappings or {}).get("job", "/internal/v1/jobs/{id}")
        url = _path(
            registration.endpoint,
            str(poll_template).replace("{id}", quote(engine_job_id, safe="")),
            "/internal/v1/jobs/{id}",
        )
        headers = _headers(registration)
        pinned_address = addresses[0] if addresses else None
        original = urlsplit(registration.endpoint)
        if pinned_address:
            url = _pinned_url(url, pinned_address)
            headers["host"] = _host_header(original)
        timeout = httpx.Timeout(timeout_s, connect=min(timeout_s, 2.0))
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=False, transport=transport, trust_env=False
        ) as client:
            request = client.build_request("DELETE", url, headers=headers)
            if pinned_address and original.hostname:
                request.extensions["sni_hostname"] = original.hostname
            response = await client.send(request, stream=True)
            await response.aclose()
            return response.status_code in (200, 202, 204)

    try:
        return await asyncio.wait_for(attempt(), timeout=timeout_s + 2.0)
    except Exception:  # noqa: BLE001 - best effort by contract
        return False
