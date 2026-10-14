"""The gateway's one door to the BIM toolchain.

BIM (compiling packages, evaluating bindings, judging engine results) is computed by
``bim-toolchain``; the gateway reaches it only through ``bim_client.BimPort``, whose two
implementations are interchangeable: ``InProcessBim`` calls the installed ``bim-core`` in this
process and ``HttpBim`` calls a ``bim-service``. ``BIM_MODE`` picks one, here and nowhere else.

* ``get_bim()`` is the process-wide port (built on first use, closed by ``close_bim()``; tests
  replace it with ``set_bim`` / ``bim_override``).
* ``abim()`` wraps it for coroutines: the port is synchronous (a compile is CPU, an HTTP call
  blocks), so every call runs in a worker thread and never stalls the event loop.
* ``problem_for`` / ``http_exception_for`` translate the toolchain's errors into the platform's
  problem document, once, for every route.
* ``startup_check`` refuses to start when the service is unreachable or runs another toolchain
  (a different ``compilerDigest``): an IR is only valid on the toolchain that produced it.
* ``ir_is_installed`` says whether a stored IR was compiled by the installed toolchain.
* ``toolchain_digest``, ``protocol_info``, ``package_limits``, ``profile_manifests``,
  ``dialect_manifests`` and ``schema_document`` are static descriptors, asked once per port and
  cached, so synchronous code can read them without a round trip per call.

Nothing in this module imports routes, services, jobs, domain or the database.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import threading
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Mapping, Sequence
from urllib.parse import urlsplit

from bim_client import BimPort, BimServiceError, HttpBim, InProcessBim
from bim_core import BimError, CompileError, ContractError, Limits
from bim_core.canonical import digest

from ..core.settings import Settings, get_settings
from ..models.problem import PROBLEM_MEDIA_TYPE, problem_response, summarize

logger = logging.getLogger(__name__)

#: ``ContractError`` codes that say the installation is wrong, not the request.
_INSTALLATION_CODES = frozenset({"protocol_document_invalid", "invalid_limit"})

#: ``BimServiceError`` codes that mean "not now, try again": the service is busy, slow or away.
_UNAVAILABLE_CODES = frozenset(
    {"service_unavailable", "service_timeout", "operation_timeout", "service_busy", "rate_limited", "not_ready"}
)


class BimStartupError(RuntimeError):
    """The configured BIM toolchain cannot be used: unreachable, or not the one this gateway expects."""


# --------------------------------------------------------------------------- the process-wide port


class _Holder:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.port: BimPort | None = None
        self.owned = False
        self.cache: dict[str, Any] = {}


_HOLDER = _Holder()


_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_INSECURE_WARNED = False


def _warn_insecure_http(url: str | None) -> None:
    """Warn once that the token may travel over plain http to a non-loopback host (trusted network)."""
    global _INSECURE_WARNED
    parts = urlsplit(url or "")
    if parts.scheme == "https" or (parts.hostname or "") in _LOOPBACK_HOSTS or _INSECURE_WARNED:
        return
    _INSECURE_WARNED = True
    logger.warning(
        "BIM_SERVICE_ALLOW_INSECURE_HTTP is on: the BIM bearer token is sent over plain http to %s; "
        "this is only acceptable on a trusted private network (use https otherwise)",
        parts.hostname or url,
    )


def build_bim(settings: Settings | None = None) -> BimPort:
    """The port that ``BIM_MODE`` asks for (not cached; ``get_bim`` caches it)."""
    settings = settings or get_settings()
    if settings.bim_mode == "http":
        if settings.bim_service_allow_insecure_http:
            _warn_insecure_http(settings.bim_service_url)
        # An empty variable is an unset one (compose passes ``BIM_TENANT=`` for a blank).
        return HttpBim(
            settings.bim_service_url,
            token_file=settings.bim_service_token_file or None,
            tenant=settings.bim_tenant or None,
            timeout=settings.bim_service_timeout_s,
            allow_insecure_http=settings.bim_service_allow_insecure_http,
        )
    # The former BIM_MAX_* variables still size the packages this process accepts.
    return InProcessBim(limits=Limits.from_env(os.environ))


def get_bim() -> BimPort:
    """The port of this process."""
    port = _HOLDER.port
    if port is not None:
        return port
    with _HOLDER.lock:
        if _HOLDER.port is None:
            _HOLDER.port = build_bim()
            _HOLDER.owned = True
            _HOLDER.cache.clear()
        return _HOLDER.port


def set_bim(port: BimPort | None) -> None:
    """Replace the port (tests); ``None`` forgets it so the next ``get_bim`` builds a fresh one.

    A port built here is closed when it is replaced; one that was handed in belongs to the caller.
    """
    with _HOLDER.lock:
        previous, owned = _HOLDER.port, _HOLDER.owned
        _HOLDER.port, _HOLDER.owned = port, False
        _HOLDER.cache.clear()
    if previous is not None and owned and previous is not port:
        previous.close()


def close_bim() -> None:
    """Release the connections of the port this module built (the lifespan calls it); a port handed to ``set_bim`` is left alone."""
    with _HOLDER.lock:
        owned = _HOLDER.owned
    if owned:
        set_bim(None)


@contextmanager
def bim_override(port: BimPort) -> Iterator[BimPort]:
    """Use ``port`` inside the block and restore the previous one after it."""
    with _HOLDER.lock:
        previous, owned = _HOLDER.port, _HOLDER.owned
        _HOLDER.port, _HOLDER.owned = port, False
        _HOLDER.cache.clear()
    try:
        yield port
    finally:
        with _HOLDER.lock:
            _HOLDER.port, _HOLDER.owned = previous, owned
            _HOLDER.cache.clear()


# ------------------------------------------------------------------------------ async face


class AsyncBim:
    """``BimPort`` for coroutines: each call runs in a worker thread (the port is synchronous)."""

    def __init__(self, port: BimPort) -> None:
        self._port = port

    async def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(getattr(self._port, name), *args, **kwargs)

    async def capabilities(self) -> dict[str, Any]:
        return await self._call("capabilities")

    async def profiles(self) -> list[dict[str, Any]]:
        return await self._call("profiles")

    async def dialects(self) -> list[dict[str, Any]]:
        return await self._call("dialects")

    async def schema(self, kind: str) -> dict[str, Any]:
        return await self._call("schema", kind)

    async def protocol(self) -> dict[str, Any]:
        return await self._call("protocol")

    async def compile(self, package: bytes, registered_resources: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
        return await self._call("compile", package, registered_resources)

    async def validate(self, package: bytes, registered_resources: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
        return await self._call("validate", package, registered_resources)

    async def compatibility(
        self,
        ir: Mapping[str, Any],
        manifest: Mapping[str, Any],
        *,
        mode: str | None = None,
        options: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._call("compatibility", ir, manifest, mode=mode, options=options)

    async def resolve_optimization(
        self, ir: Mapping[str, Any], manifest: Mapping[str, Any], requested: Any, *, mode: str | None = None
    ) -> dict[str, Any]:
        return await self._call("resolve_optimization", ir, manifest, requested, mode=mode)

    async def evaluate(
        self, ir: Mapping[str, Any], binding: Mapping[str, Any], execution: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        return await self._call("evaluate", ir, binding, execution)

    async def evaluate_many(
        self,
        ir: Mapping[str, Any],
        bindings: Sequence[Mapping[str, Any]],
        execution: Mapping[str, Any] | None = None,
        *,
        on_error: str = "raise",
    ) -> list[dict[str, Any]]:
        return await self._call("evaluate_many", ir, bindings, execution, on_error=on_error)

    async def reevaluate(
        self,
        ir: Mapping[str, Any],
        result: Mapping[str, Any],
        execution: Mapping[str, Any] | None = None,
        allowed_terminations: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        return await self._call("reevaluate", ir, result, execution, allowed_terminations)

    async def validate_result(self, payload: Any) -> dict[str, Any]:
        return await self._call("validate_result", payload)

    async def neighborhood(
        self,
        ir: Mapping[str, Any],
        binding: Mapping[str, Any],
        *,
        task: str | None = None,
        limit: int = 64,
        seconds: float = 2.0,
        execution: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self._call(
            "neighborhood", ir, binding, task=task, limit=limit, seconds=seconds, execution=execution
        )


def abim() -> AsyncBim:
    """The port of this process, for coroutines."""
    return AsyncBim(get_bim())


# --------------------------------------------------------------------------- static descriptors


def _cached(key: str, load: Callable[[BimPort], Any]) -> Any:
    port = get_bim()
    cache = _HOLDER.cache
    if key not in cache:
        value = load(port)
        # A port replaced while we were asking would be given the old answer; do not store it.
        if _HOLDER.port is port:
            cache[key] = value
        return value
    return cache[key]


def capabilities() -> dict[str, Any]:
    return copy.deepcopy(_cached("capabilities", lambda port: port.capabilities()))


def toolchain_digest() -> str:
    """``compilerDigest`` of the toolchain that answers (the pin of every IR it produces)."""
    return _cached("capabilities", lambda port: port.capabilities())["compilerDigest"]


def package_limits() -> dict[str, int]:
    """The limits the toolchain applies to a package (``max_compressed_bytes``, ``max_expanded_bytes``, ...)."""
    return dict(_cached("capabilities", lambda port: port.capabilities())["limits"]["package"])


def protocol_info() -> dict[str, Any]:
    """``{id, digest, document}`` of the ``bim-engine/v1`` contract."""
    return copy.deepcopy(_cached("protocol", lambda port: port.protocol()))


def protocol_document() -> dict[str, Any]:
    return protocol_info()["document"]


def protocol_digest() -> str:
    return _cached("protocol", lambda port: port.protocol())["digest"]


def profile_entries() -> list[dict[str, Any]]:
    """The installed Profiles: ``{reference, descriptor, manifest}`` each."""
    return copy.deepcopy(_cached("profiles", lambda port: port.profiles()))


def dialect_entries() -> list[dict[str, Any]]:
    """The installed Dialects: ``{reference, descriptor, manifest}`` each."""
    return copy.deepcopy(_cached("dialects", lambda port: port.dialects()))


def profile_manifests() -> list[dict[str, Any]]:
    """The manifests of the installed Profiles."""
    return [item["manifest"] for item in profile_entries()]


def dialect_manifests() -> list[dict[str, Any]]:
    """The manifests of the installed Dialects."""
    return [item["manifest"] for item in dialect_entries()]


def manifest_id(manifest: Mapping[str, Any]) -> str:
    """The public id (``name/v<major>``) the toolchain gives an installed Profile or Dialect manifest."""
    wanted = digest(manifest)
    for entry in (*profile_entries(), *dialect_entries()):
        if entry["descriptor"]["digest"] == wanted:
            return entry["descriptor"]["id"]
    raise KeyError("manifest is not an installed Profile or Dialect")


def schema_document(kind: str) -> dict[str, Any]:
    """The JSON Schema of a document kind (``ContractError`` ``schema_not_found`` if unknown)."""
    return copy.deepcopy(_cached(f"schema:{kind}", lambda port: port.schema(kind)))


#: What a caller is told about an IR that another toolchain compiled. Fixed text: it names nothing stored.
STALE_IR_MESSAGE = (
    "This snapshot was compiled by another bim-toolchain release than the installed one and must be "
    "recompiled before it can be used: upload the package again or ask an operator to run the IR cut-over."
)


def ir_is_installed(ir: Mapping[str, Any]) -> bool:
    """Whether the Profile and the Dialects a stored IR pins are exactly the installed ones.

    ``BindingProblem.from_document`` requires the same before any operation on an IR. Both descriptors
    carry the ``compilerDigest`` of the toolchain that built them, so an IR compiled by another release
    fails here. A document that has no ``spec`` is not judged: the toolchain reports it as malformed.
    """
    spec = ir.get("spec") if isinstance(ir, Mapping) else None
    if not isinstance(spec, Mapping):
        return True
    if spec.get("profile") not in [item["descriptor"] for item in _cached("profiles", lambda port: port.profiles())]:
        return False
    pinned = spec.get("dialects", [])
    if not isinstance(pinned, list):
        return True
    available = [item["descriptor"] for item in _cached("dialects", lambda port: port.dialects())]
    return all(item in available for item in pinned)


# ------------------------------------------------------------------------------------- startup


def _local_compiler_digest() -> str:
    """``compilerDigest`` of the ``bim-core`` installed beside the gateway."""
    return InProcessBim().capabilities()["compilerDigest"]


async def startup_check() -> dict[str, str]:
    """Make sure the configured toolchain answers and is the one this gateway was built with.

    In ``inproc`` mode the toolchain is the installed ``bim-core`` and there is nothing to
    compare. In ``http`` mode ``/capabilities`` must answer and its ``compilerDigest`` must equal
    the one of the installed ``bim-core``: the gateway keeps that package for the document kinds
    it validates itself and for the error classes, and an IR compiled by one toolchain is refused
    by another (``contract_not_installed``). Both digests are logged. The descriptors are read
    once here so that nothing blocks the event loop for them later.
    """
    settings = get_settings()
    expected = _local_compiler_digest()
    try:
        port = get_bim()
    except ValueError as exc:
        raise BimStartupError(
            f"the BIM client is misconfigured: {exc}; for a trusted private network set "
            "BIM_SERVICE_ALLOW_INSECURE_HTTP=true"
        ) from exc
    try:
        reported = (await AsyncBim(port).capabilities())["compilerDigest"]
        await asyncio.to_thread(protocol_digest)
        await asyncio.to_thread(package_limits)
    except BimError as exc:
        raise BimStartupError(
            f"the BIM toolchain ({settings.bim_mode}) cannot be reached: {exc.code}: {exc.message}"
        ) from exc
    logger.info("BIM toolchain mode=%s compilerDigest=%s expected=%s", settings.bim_mode, reported, expected)
    if reported != expected:
        raise BimStartupError(
            f"the BIM service runs another toolchain: compilerDigest {reported} but the installed "
            f"bim-core is {expected}; deploy the same bim-toolchain release on both sides"
        )
    return {"mode": settings.bim_mode, "compilerDigest": reported, "expected": expected}


# ------------------------------------------------------------------------------ error translation


def _diagnostics(error: BimError) -> list[dict[str, Any]]:
    return [item.as_dict() if hasattr(item, "as_dict") else dict(item) for item in error.diagnostics]


def problem_for(error: BimError) -> tuple[int, str, str, list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    """``(status, code, detail, diagnostics, headers, extra)`` of the platform's problem for ``error``.

    * ``CompileError``: 422 ``invalid_instance`` with the compiler's diagnostics, as the platform
      always answered a refused BIM source;
    * any other ``BimError`` about the input: ``error.http_status`` or 422, with its own ``code``,
      message and diagnostics;
    * ``BimServiceError`` (the service, not the input): 503 ``bim_unavailable`` when it is busy,
      slow or away (``Retry-After`` when it said how long), 413 for a body it refuses as too large,
      422 for a request over its limits, 502 ``bim_service_error`` for anything else. ``bimCode``
      carries the original code.
    """
    if isinstance(error, BimServiceError):
        extra: dict[str, Any] = {"bimCode": error.code}
        headers: dict[str, str] = {}
        if error.retry_after is not None:
            headers["Retry-After"] = str(max(1, int(round(error.retry_after))))
        if error.code == "payload_too_large":
            return 413, "payload_too_large", "The BIM service refused the package as too large", [], headers, extra
        if error.code == "limit_exceeded":
            return 422, "bim_limit_exceeded", error.message, _diagnostics(error), headers, extra
        if error.code in _UNAVAILABLE_CODES or error.status in (429, 503, 504):
            return 503, "bim_unavailable", "The BIM toolchain is unavailable; retry shortly", [], headers, extra
        return 502, "bim_service_error", "The BIM toolchain answered unexpectedly", [], headers, extra
    diagnostics = _diagnostics(error)
    if isinstance(error, CompileError):
        return (
            422,
            "invalid_instance",
            summarize(diagnostics, prefix="The BIM source was refused"),
            diagnostics,
            {},
            {},
        )
    status = getattr(error, "http_status", None) if isinstance(error, ContractError) else None
    if status is None:
        status = 500 if error.code in _INSTALLATION_CODES else 422
    return int(status), error.code, error.message or error.code, diagnostics, {}, {}


def problem_response_for(error: BimError, *, media_type: str = PROBLEM_MEDIA_TYPE):
    """The platform's problem document for ``error``."""
    status, code, detail, diagnostics, headers, extra = problem_for(error)
    return problem_response(
        status, code, detail, diagnostics, headers=headers or None, extra=extra or None, media_type=media_type
    )


def http_exception_for(error: BimError):
    """``HTTPException`` carrying the platform's problem for ``error``, for code that raises.

    A rejection of the caller's options or optimization keeps the shape the platform always
    answered with: ``{"code", "diagnostics"}`` when the toolchain lists findings (the message is then
    their summary) and ``{"code", "message"}`` when it does not.
    """
    from fastapi import HTTPException

    status, code, detail, diagnostics, headers, extra = problem_for(error)
    body: dict[str, Any] = {"code": code, **extra}
    if isinstance(error, ContractError) and diagnostics:
        body["diagnostics"] = diagnostics
    elif isinstance(error, CompileError):
        body["diagnostics"] = diagnostics
    else:
        body["message"] = detail
        if diagnostics:
            body["diagnostics"] = diagnostics
    return HTTPException(status_code=status, detail=body, headers=headers or None)
