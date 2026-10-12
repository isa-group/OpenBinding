"""``HttpBim``: the BIM port implemented over HTTP against a ``bim-service``.

Inputs go through the same checks as in ``InProcessBim`` (``bim_client.wire``) before anything is sent, so an
invalid input fails identically in both.  A response with a status >= 400 is a problem document
(``application/problem+json``) and becomes the exception it stands for: the ``bim_core`` error class with its
``code`` and ``diagnostics`` for errors about the input, :class:`~bim_client.errors.BimServiceError` for the rest
(authentication, size, load, time, an unreachable service).

The bearer token comes from ``token`` or from the first line of ``token_file`` (read again when the file
changes, which is how a rotation reaches a running client).  It is never logged, never in ``repr`` and, unless
``allow_insecure_http`` is set, never sent over plain ``http`` to a host that is not the loopback.
"""

from __future__ import annotations

import base64
import os
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import quote, urlsplit

import httpx

from . import wire
from .errors import BimServiceError, exception_from_problem
from .types import (
    Capabilities,
    CompatibilityResult,
    CompileResult,
    EvaluationOutcome,
    OptimizationResolution,
    RegisteredResourceSpec,
    ResultValidation,
    ValidationResult,
)

API_PREFIX = "/bim/v1"
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


class HttpBim:
    """BIM behind HTTP.

    ``base_url`` is the service root (``https://bim.internal``).  ``timeout`` and ``connect_timeout`` (seconds)
    configure the ``httpx.Client`` created here.  ``client`` replaces that client (tests mount the service with
    ``starlette.testclient.TestClient``); it keeps its own timeouts and is not closed by :meth:`close`.  ``tenant``
    is sent as ``X-BIM-Tenant`` (opaque, for the service's logs and fair sharing; it never changes a result) and
    ``traceparent`` is called per request for a W3C trace context.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        token: str | None = None,
        token_file: str | os.PathLike[str] | None = None,
        tenant: str | None = None,
        traceparent: Callable[[], str | None] | None = None,
        timeout: float = 30.0,
        connect_timeout: float = 5.0,
        client: httpx.Client | None = None,
        allow_insecure_http: bool = False,
    ) -> None:
        if token is not None and token_file is not None:
            raise ValueError("give either token or token_file, not both")
        if token is not None and not token.strip():
            raise ValueError("token is empty")
        if client is None and not base_url:
            raise ValueError("base_url is required unless a client is given")
        if client is None and (token is not None or token_file is not None) and not allow_insecure_http:
            parts = urlsplit(base_url or "")
            if parts.scheme != "https" and (parts.hostname or "") not in _LOOPBACK:
                raise ValueError(
                    "refusing to send a bearer token over plain http to a non-loopback host "
                    "(use https, or allow_insecure_http=True on a trusted network)"
                )
        self._token_value = token.strip() if token is not None else None
        self._token_file = os.fspath(token_file) if token_file is not None else None
        self._token_stamp: tuple[int, int] | None = None
        self._tenant = tenant
        self._traceparent = traceparent
        self._owns_client = client is None
        # The timeouts configure the client created here; a client you pass keeps its own.
        self._client = (
            client
            if client is not None
            else httpx.Client(
                base_url=(base_url or "").rstrip("/"), timeout=httpx.Timeout(timeout, connect=connect_timeout)
            )
        )

    def __enter__(self) -> HttpBim:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __repr__(self) -> str:
        return f"HttpBim(base_url={str(self._client.base_url)!r})"

    # --- transport -----------------------------------------------------------------------------

    def _token(self) -> str | None:
        if self._token_file is None:
            return self._token_value
        try:
            status = os.stat(self._token_file)
            stamp = (status.st_mtime_ns, status.st_size)
            if stamp != self._token_stamp:
                with open(self._token_file, encoding="utf-8") as handle:
                    lines = [line.strip() for line in handle.read().splitlines() if line.strip()]
                if not lines:
                    raise ValueError("empty")
                self._token_value, self._token_stamp = lines[0], stamp
        except (OSError, ValueError) as exc:
            raise BimServiceError("token_unavailable", "the token file cannot be read or is empty") from exc
        return self._token_value

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json, application/problem+json"}
        token = self._token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if self._tenant:
            headers["X-BIM-Tenant"] = self._tenant
        if self._traceparent is not None:
            context = self._traceparent()
            if context:
                headers["traceparent"] = context
        return headers

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        try:
            response = self._client.request(method, API_PREFIX + path, json=body, headers=self._headers())
        except httpx.TimeoutException as exc:
            raise BimServiceError("service_timeout", f"the service did not answer in time ({type(exc).__name__})") from exc
        except httpx.HTTPError as exc:
            raise BimServiceError("service_unavailable", f"the service could not be reached ({type(exc).__name__})") from exc
        if response.is_success:
            try:
                return response.json()
            except ValueError as exc:
                raise BimServiceError("bad_response", "the service answered 2xx with a body that is not JSON", status=response.status_code) from exc
        raise self._error(response)

    @staticmethod
    def _error(response: httpx.Response) -> Exception:
        retry_after: float | None
        try:
            retry_after = float(response.headers["Retry-After"])
        except (KeyError, ValueError):
            retry_after = None
        try:
            problem = response.json()
        except ValueError:
            problem = None
        if isinstance(problem, dict) and isinstance(problem.get("code"), str):
            return exception_from_problem(problem, status=response.status_code, retry_after=retry_after)
        return BimServiceError(
            f"http_{response.status_code}",
            f"the service answered HTTP {response.status_code} without a problem document",
            status=response.status_code,
            retry_after=retry_after,
        )

    # --- descriptors ---------------------------------------------------------------------------

    @wire.normalized
    def capabilities(self) -> Capabilities:
        return self._call("GET", "/capabilities")

    @wire.normalized
    def profiles(self) -> list[dict[str, Any]]:
        return self._call("GET", "/profiles")["profiles"]

    @wire.normalized
    def dialects(self) -> list[dict[str, Any]]:
        return self._call("GET", "/dialects")["dialects"]

    @wire.normalized
    def schema(self, kind: str) -> dict[str, Any]:
        return self._call("GET", f"/schemas/{quote(str(kind), safe='')}")

    @wire.normalized
    def protocol(self) -> dict[str, Any]:
        return self._call("GET", "/protocol")

    # --- compile and validate ------------------------------------------------------------------

    @staticmethod
    def _package_body(package: bytes, registered_resources: Sequence[RegisteredResourceSpec]) -> dict[str, Any]:
        data = wire.package_bytes(package)
        registered = wire.registered_resources(registered_resources)
        return {
            "package": base64.b64encode(data).decode("ascii"),
            "registeredResources": [
                {
                    "namespace": item.namespace,
                    "name": item.name,
                    "version": item.version,
                    "digest": item.digest,
                    "mediaType": item.media_type,
                    "contentBase64": base64.b64encode(item.content).decode("ascii"),
                    "versionManifest": item.version_manifest,
                }
                for item in registered
            ],
        }

    @wire.normalized
    def compile(
        self, package: bytes, registered_resources: Sequence[RegisteredResourceSpec] = ()
    ) -> CompileResult:
        return self._call("POST", "/compile", self._package_body(package, registered_resources))

    @wire.normalized
    def validate(
        self, package: bytes, registered_resources: Sequence[RegisteredResourceSpec] = ()
    ) -> ValidationResult:
        return self._call("POST", "/validate", self._package_body(package, registered_resources))

    # --- engine compatibility and optimization -------------------------------------------------

    @wire.normalized
    def compatibility(
        self,
        ir: Mapping[str, Any],
        manifest: Mapping[str, Any],
        *,
        mode: str | None = None,
        options: Mapping[str, Any] | None = None,
    ) -> CompatibilityResult:
        body = {
            "ir": wire.ir_document(ir),
            "manifest": wire.require_object(manifest, "manifest"),
            "mode": wire.optional_text(mode, "mode"),
            "options": wire.optional_object(options, "options"),
        }
        return self._call("POST", "/compatibility", body)

    @wire.normalized
    def resolve_optimization(
        self,
        ir: Mapping[str, Any],
        manifest: Mapping[str, Any],
        requested: Any,
        *,
        mode: str | None = None,
    ) -> OptimizationResolution:
        body = {
            "ir": wire.ir_document(ir),
            "manifest": wire.require_object(manifest, "manifest"),
            "mode": wire.optional_text(mode, "mode"),
            "optimization": wire.strict_json(requested, "optimization"),
        }
        return self._call("POST", "/optimization/resolve", body)

    # --- evaluation ----------------------------------------------------------------------------

    @wire.normalized
    def evaluate(
        self, ir: Mapping[str, Any], binding: Mapping[str, Any], execution: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        body = {
            "ir": wire.ir_document(ir),
            "bindings": [wire.strict_json(binding, "binding")],
            "execution": wire.optional_object(execution, "execution"),
            "onError": "raise",
        }
        return self._call("POST", "/evaluate", body)["results"][0]["evaluation"]

    @wire.normalized
    def evaluate_many(
        self,
        ir: Mapping[str, Any],
        bindings: Sequence[Mapping[str, Any]],
        execution: Mapping[str, Any] | None = None,
        *,
        on_error: str = "raise",
    ) -> list[EvaluationOutcome]:
        selections = wire.strict_json(list(bindings), "bindings")
        if not selections:
            raise wire.request_invalid("bindings must hold at least one binding", "/bindings")
        body = {
            "ir": wire.ir_document(ir),
            "bindings": selections,
            "execution": wire.optional_object(execution, "execution"),
            "onError": wire.choice(on_error, "on_error", ("raise", "collect")),
        }
        return self._call("POST", "/evaluate", body)["results"]

    @wire.normalized
    def reevaluate(
        self,
        ir: Mapping[str, Any],
        result: Mapping[str, Any],
        execution: Mapping[str, Any] | None = None,
        allowed_terminations: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        body = {
            "ir": wire.ir_document(ir),
            "result": wire.require_object(result, "result"),
            "execution": wire.optional_object(execution, "execution"),
            "allowedTerminations": None
            if allowed_terminations is None
            else wire.strict_json(list(allowed_terminations), "allowed_terminations"),
        }
        return self._call("POST", "/reevaluate", body)

    @wire.normalized
    def validate_result(self, payload: Any) -> ResultValidation:
        return self._call("POST", "/validate-result", {"result": wire.strict_json(payload, "payload")})

    @wire.normalized
    def neighborhood(
        self,
        ir: Mapping[str, Any],
        binding: Mapping[str, Any],
        *,
        task: str | None = None,
        limit: int = 64,
        seconds: float = 2.0,
        execution: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = {
            "ir": wire.ir_document(ir),
            "binding": wire.strict_json(binding, "binding"),
            "task": wire.optional_text(task, "task"),
            "limit": wire.integer(limit, "limit"),
            "seconds": wire.positive_number(seconds, "seconds"),
            "execution": wire.optional_object(execution, "execution"),
        }
        return self._call("POST", "/neighborhood", body)
