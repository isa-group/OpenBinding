"""Pinned, bounded transport for registered v1 engines.

The gateway never gives a remote engine the source package.  Only the
canonical BindingProblem envelope crosses this boundary, and the response is
validated before it is allowed into the normal reevaluation path.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import socket
from dataclasses import dataclass
from urllib.parse import SplitResult, urljoin, urlparse, urlsplit, urlunsplit

import httpx

from .package import PackageError, strict_json_loads


class RemoteEngineError(RuntimeError):
    pass


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
        raise RemoteEngineError(f"engine endpoint resolved to an invalid address: {value}") from exc
    if address.is_multicast or address.is_unspecified or address.is_reserved:
        raise RemoteEngineError("engine endpoint targets an address outside its permitted network class")
    local = address.is_private or address.is_loopback or address.is_link_local
    if (internal and not local) or (not internal and not address.is_global):
        raise RemoteEngineError("engine endpoint targets an address outside its permitted network class")
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
        raise RemoteEngineError(f"engine endpoint must use {requirement} without userinfo or fragments")
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
            raise RemoteEngineError(f"engine endpoint cannot be resolved: {host}") from exc
        if not resolved:
            raise RemoteEngineError(f"engine endpoint cannot be resolved: {host}") from None
        return tuple(sorted(_permitted_address(value, internal=internal) for value in resolved))
    return (_permitted_address(address.compressed, internal=internal),)


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
        raise RemoteEngineError("engine mapping must be an absolute path on the registered origin")
    result = urljoin(base.rstrip("/") + "/", str(value).lstrip("/"))
    expected, actual = urlparse(base), urlparse(result)
    if (actual.scheme, actual.hostname, actual.port) != (expected.scheme, expected.hostname, expected.port):
        raise RemoteEngineError("engine mapping must remain on the registered origin")
    return result


def _headers(registration: RemoteRegistration) -> dict[str, str]:
    headers = {"content-type": "application/json", "accept": "application/json"}
    if registration.auth_scheme == "bearer":
        if not registration.credential:
            raise RemoteEngineError("registration requires a bearer credential")
        headers["authorization"] = f"Bearer {registration.credential}"
    elif registration.auth_scheme == "basic":
        if not registration.credential:
            raise RemoteEngineError("registration requires a basic credential")
        encoded = base64.b64encode(registration.credential.encode("utf-8")).decode("ascii")
        headers["authorization"] = f"Basic {encoded}"
    elif registration.auth_scheme == "mtls":
        raise RemoteEngineError("mTLS registrations require a credential-bundle contract not available in BIM v1")
    elif registration.auth_scheme != "none":
        raise RemoteEngineError(f"unsupported registration auth scheme: {registration.auth_scheme}")
    return headers


def _validate_result(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise RemoteEngineError("engine response must be an object")
    termination = payload.get("termination")
    if termination not in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"}:
        raise RemoteEngineError("engine response has an invalid termination")
    solutions = payload.get("solutions")
    if not isinstance(solutions, list):
        raise RemoteEngineError("engine response must contain a solutions array")

    def number(value: object) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool)

    def valid_ref(value: object) -> bool:
        return (
            isinstance(value, dict)
            and isinstance(value.get("resource"), str)
            and bool(value.get("resource"))
            and isinstance(value.get("id"), str)
            and bool(value.get("id"))
            and set(value) == {"resource", "id"}
        )

    for solution in solutions:
        decision = solution.get("decision") if isinstance(solution, dict) else None
        binding = decision.get("binding") if isinstance(decision, dict) else None
        if (
            not isinstance(solution, dict)
            or set(solution)
            != {"decision", "metrics", "objectives", "penalties", "violations"}
            or not isinstance(decision, dict)
            or set(decision) != {"kind", "binding"}
            or decision.get("kind") != "binding"
            or not isinstance(binding, dict)
            or any(not isinstance(key, str) or not valid_ref(value) for key, value in binding.items())
        ):
            raise RemoteEngineError("every engine solution must contain a canonical binding decision")
        metrics = solution["metrics"]
        if (
            not isinstance(metrics, dict)
            or any(not isinstance(key, str) or not number(value) for key, value in metrics.items())
        ):
            raise RemoteEngineError("every engine solution must contain numeric metrics")
        objectives = solution["objectives"]
        if (
            not isinstance(objectives, dict)
            or set(objectives) != {"mode", "components", "penalty", "score"}
            or objectives.get("mode") not in {"satisfy", "weighted", "lexicographic", "pareto"}
            or not isinstance(objectives.get("components"), list)
            or not number(objectives.get("penalty"))
            or objectives["penalty"] < 0
            or not (
                number(objectives.get("score"))
                or (
                    isinstance(objectives.get("score"), list)
                    and all(number(value) for value in objectives["score"])
                )
            )
        ):
            raise RemoteEngineError("every engine solution must contain a canonical objective evaluation")
        for component in objectives["components"]:
            if (
                not isinstance(component, dict)
                or set(component) != {"metric", "value", "loss", "weight"}
                or not valid_ref(component.get("metric"))
                or not number(component.get("value"))
                or not number(component.get("loss"))
                or not number(component.get("weight"))
                or component["weight"] <= 0
            ):
                raise RemoteEngineError("engine objective components must satisfy bim-engine/v1")
        penalties = solution["penalties"]
        if (
            not isinstance(penalties, list)
            or any(not number(value) or value < 0 for value in penalties)
        ):
            raise RemoteEngineError("engine penalties must be non-negative numbers")
        violations = solution["violations"]
        if not isinstance(violations, list):
            raise RemoteEngineError("engine violations must be an array")
        for violation in violations:
            if (
                not isinstance(violation, dict)
                or not {"constraint", "enforcement", "penalty"} <= set(violation)
                or not set(violation) <= {"constraint", "enforcement", "penalty", "message"}
                or not valid_ref(violation.get("constraint"))
                or violation.get("enforcement") not in {"hard", "soft"}
                or not number(violation.get("penalty"))
                or violation["penalty"] < 0
                or ("message" in violation and not isinstance(violation["message"], str))
            ):
                raise RemoteEngineError("engine violations must satisfy bim-engine/v1")
    if not set(payload) <= {"termination", "solutions", "provenance"}:
        raise RemoteEngineError("engine response contains fields outside bim-engine/v1")
    if "provenance" in payload and not isinstance(payload["provenance"], dict):
        raise RemoteEngineError("engine provenance must be an object")
    return payload


def _validate_job_receipt(payload: object) -> str:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"id", "status"}
        or not isinstance(payload.get("id"), str)
        or not payload["id"]
        or payload.get("status") != "queued"
    ):
        raise RemoteEngineError("engine acceptance receipt must satisfy EngineJobAccepted")
    return payload["id"]


def _validate_job(payload: object, expected_id: str) -> dict | None:
    if not isinstance(payload, dict):
        raise RemoteEngineError("engine polling returned a non-object response")
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
        raise RemoteEngineError("engine polling response must satisfy EngineJob")
    if state in {"queued", "running"}:
        if set(payload) != {"id", "status", "created_at"}:
            raise RemoteEngineError("engine polling response must satisfy EngineJob")
        return None
    if state == "failed":
        if set(payload) != {"id", "status", "created_at", "error"} or not isinstance(
            payload.get("error"), str
        ):
            raise RemoteEngineError("engine polling response must satisfy EngineJob")
        raise RemoteEngineError(payload["error"] or "remote engine failed")
    if set(payload) != {"id", "status", "created_at", "result"}:
        raise RemoteEngineError("engine polling response must satisfy EngineJob")
    return _validate_result(payload["result"])


async def _bounded_bytes(response: httpx.Response, *, limit: int | None = None) -> bytes:
    if limit is None:
        limit = MAX_REMOTE_RESPONSE
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise RemoteEngineError("engine response exceeds the configured size limit")
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > limit:
            raise RemoteEngineError("engine response exceeds the configured size limit")
    return bytes(content)


async def _bounded_json(response: httpx.Response) -> object:
    try:
        return strict_json_loads(await _bounded_bytes(response))
    except PackageError as exc:
        raise RemoteEngineError("engine returned invalid JSON") from exc


async def fetch_remote_document(
    registration: RemoteRegistration,
    path: str,
    *,
    timeout_s: float = 10.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Fetch a bounded JSON deployment document over the pinned origin."""

    addresses = validate_endpoint(registration.endpoint, allow_internal_http=registration.allow_internal_http)
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
            raise RemoteEngineError(f"engine document request failed: {exc}") from exc
        if response.status_code != 200:
            await response.aclose()
            raise RemoteEngineError(f"engine document request failed ({response.status_code})")
        try:
            raw = await _bounded_bytes(response)
        finally:
            await response.aclose()
    try:
        document = strict_json_loads(raw)
    except PackageError as exc:
        raise RemoteEngineError("engine returned an invalid JSON document") from exc
    if not isinstance(document, dict):
        raise RemoteEngineError("engine document must be an object")
    return document


async def solve_remote(
    registration: RemoteRegistration,
    problem: dict,
    options: dict,
    *,
    timeout_s: float = 30.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    addresses = validate_endpoint(registration.endpoint, allow_internal_http=registration.allow_internal_http)
    mappings = registration.mappings or {}
    request_url = _path(registration.endpoint, mappings.get("request"), "/internal/v1/binding-problems")
    poll_template = mappings.get("job", "/internal/v1/jobs/{id}")
    body = {"apiVersion": "bim/v1", "kind": "BindingProblemRequest", "protocol": "bim-engine/v1", "problem": problem, "options": options}
    headers = _headers(registration)
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
            request = client.build_request("POST", request_url, headers=headers, content=json.dumps(body, separators=(",", ":")))
            if pinned_address and original.hostname:
                request.extensions["sni_hostname"] = original.hostname
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise RemoteEngineError(f"engine request failed: {exc}") from exc
        if response.status_code == 200:
            try:
                return _validate_result(await _bounded_json(response))
            finally:
                await response.aclose()
        if response.status_code != 202:
            await response.aclose()
            raise RemoteEngineError(f"engine rejected BindingProblem ({response.status_code})")
        try:
            receipt = await _bounded_json(response)
        finally:
            await response.aclose()
        job_id = _validate_job_receipt(receipt)
        deadline = asyncio.get_running_loop().time() + timeout_s
        while asyncio.get_running_loop().time() < deadline:
            poll_url = _path(registration.endpoint, str(poll_template).replace("{id}", job_id), "/internal/v1/jobs/{id}")
            if pinned_address:
                poll_url = _pinned_url(poll_url, pinned_address)
            try:
                poll_request = client.build_request("GET", poll_url, headers=headers)
                if pinned_address and original.hostname:
                    poll_request.extensions["sni_hostname"] = original.hostname
                polled = await client.send(poll_request, stream=True)
            except httpx.HTTPError as exc:
                raise RemoteEngineError(f"engine polling failed: {exc}") from exc
            if polled.status_code == 404:
                await polled.aclose()
                raise RemoteEngineError("engine job disappeared while polling")
            if polled.status_code >= 400:
                await polled.aclose()
                raise RemoteEngineError(f"engine polling failed ({polled.status_code})")
            try:
                payload = await _bounded_json(polled)
            finally:
                await polled.aclose()
            result = _validate_job(payload, job_id)
            if result is None:
                await asyncio.sleep(0.05)
                continue
            return result
        raise RemoteEngineError("remote engine timed out")
