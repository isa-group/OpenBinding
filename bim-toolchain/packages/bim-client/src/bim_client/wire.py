"""What both implementations do to an input before using it, and to a result before returning it.

Keeping this in one place is what lets ``InProcessBim`` and ``HttpBim`` agree: an input that is not strict JSON
fails the same way in both (``ContractError("request_invalid")``) and a result is, in both, the structure that
``json`` makes of it (no tuples, no shared references, no NaN).
"""

from __future__ import annotations

import functools
import json
import math
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence, TypeVar

from bim_core import BimError, CompileError, ContractError

API_VERSION = "bim-service/v1"

F = TypeVar("F", bound=Callable[..., Any])


def request_invalid(message: str, pointer: str | None = None) -> ContractError:
    diagnostic: dict[str, Any] = {"code": "request_invalid", "message": message}
    if pointer:
        diagnostic["pointer"] = pointer
    return ContractError("request_invalid", message, [diagnostic], http_status=422)


def _mapping_as_dict(value: Any) -> Any:
    """``json`` hook: a mapping that is not a ``dict`` (a read-only view, say) is an object."""
    if isinstance(value, Mapping):
        return dict(value)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def strict_json(value: Any, name: str) -> Any:
    """A deep copy of ``value`` as JSON makes it, or ``request_invalid`` if it is not strict JSON."""
    try:
        return json.loads(json.dumps(value, allow_nan=False, default=_mapping_as_dict))
    except (TypeError, ValueError, RecursionError) as exc:
        raise request_invalid(f"{name} is not strict JSON (no NaN, infinity or non-JSON types)", f"/{name}") from exc


def output(value: Any) -> Any:
    """The JSON image of a result (what an HTTP response would carry)."""
    return json.loads(json.dumps(value, allow_nan=False))


def require_object(value: Any, name: str) -> dict[str, Any]:
    """``value`` as a JSON object (``dict``), or ``request_invalid``."""
    document = strict_json(value, name)
    if not isinstance(document, dict):
        raise request_invalid(f"{name} must be a JSON object", f"/{name}")
    return document


def optional_object(value: Any, name: str) -> dict[str, Any] | None:
    return None if value is None else require_object(value, name)


def ir_document(ir: Any) -> dict[str, Any]:
    """The IR document of ``ir``: a mapping, or an object with a ``document`` attribute."""
    return require_object(getattr(ir, "document", ir), "ir")


def optional_text(value: Any, name: str) -> str | None:
    if value is not None and not isinstance(value, str):
        raise request_invalid(f"{name} must be a string", f"/{name}")
    return value


def integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise request_invalid(f"{name} must be an integer", f"/{name}")
    return value


def positive_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise request_invalid(f"{name} must be a positive finite number", f"/{name}")
    return float(value)


def choice(value: Any, name: str, allowed: tuple[str, ...]) -> str:
    if value not in allowed:
        raise request_invalid(f"{name} must be one of {', '.join(allowed)}", f"/{name}")
    return value


def package_bytes(value: Any) -> bytes:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise request_invalid("package must be bytes", "/package")
    return bytes(value)


@dataclass(frozen=True)
class Registered:
    """A validated registered resource (the member names of the wire format are in :func:`encode_registered`)."""

    namespace: str
    name: str
    version: str
    digest: str
    media_type: str
    content: bytes
    version_manifest: dict[str, Any] | None

    @property
    def key(self) -> tuple[str, str, str, str]:
        return (self.namespace, self.name, self.version, self.digest)


def registered_resources(items: Sequence[Mapping[str, Any]] | None) -> list[Registered]:
    """Validate ``registered_resources`` as the service does: the same members, the same refusals."""
    if items is None:
        return []
    if isinstance(items, (str, bytes, Mapping)):
        raise request_invalid("registered_resources must be a sequence of mappings", "/registeredResources")
    result: list[Registered] = []
    seen: set[tuple[str, str, str, str]] = set()
    allowed = {"namespace", "name", "version", "digest", "mediaType", "content", "versionManifest"}
    for index, item in enumerate(items):
        pointer = f"/registeredResources/{index}"
        if not isinstance(item, Mapping) or not set(item) <= allowed:
            raise request_invalid("a registered resource must be a mapping with the documented members", pointer)
        texts = {}
        for field in ("namespace", "name", "version", "digest", "mediaType"):
            value = item.get(field)
            if not isinstance(value, str) or not 1 <= len(value) <= 255:
                raise request_invalid(f"{field} must be a non-empty string of at most 255 characters", f"{pointer}/{field}")
            texts[field] = value
        content = item.get("content")
        if not isinstance(content, (bytes, bytearray, memoryview)):
            raise request_invalid("content must be bytes", f"{pointer}/content")
        manifest = item.get("versionManifest")
        entry = Registered(
            texts["namespace"],
            texts["name"],
            texts["version"],
            texts["digest"],
            texts["mediaType"],
            bytes(content),
            None if manifest is None else require_object(manifest, "versionManifest"),
        )
        if entry.key in seen:
            raise request_invalid("a registered resource is listed twice", pointer)
        seen.add(entry.key)
        result.append(entry)
    return result


def normalize_error(error: BimError) -> None:
    """Give ``error`` the diagnostics an HTTP round trip would: plain JSON dictionaries.

    ``CompileError`` keeps its ``CompileDiagnostic`` objects (``HttpBim`` rebuilds them from the wire).
    """
    if isinstance(error, CompileError):
        return
    error.diagnostics = output([item.as_dict() if hasattr(item, "as_dict") else item for item in error.diagnostics])


def normalized(method: F) -> F:
    """Decorator: a ``BimError`` leaves the method with normalized diagnostics (see :func:`normalize_error`)."""

    @functools.wraps(method)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return method(*args, **kwargs)
        except BimError as exc:
            normalize_error(exc)
            raise

    return wrapper  # type: ignore[return-value]
