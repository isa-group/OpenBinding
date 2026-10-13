"""Decoding of the request body of ``/compile`` and ``/validate`` (JSON with base64, or multipart)."""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from typing import Any

from bim_core import ContractError
from pydantic import TypeAdapter, ValidationError

from .models import PackageRequest, RegisteredResourceModel
from .problems import ServiceProblem
from .settings import BimServiceSettings

_REGISTERED_LIST = TypeAdapter(list[RegisteredResourceModel])
_NAME = re.compile(rb'(?:^|[;\s])name="([^"]*)"', re.IGNORECASE)
_BOUNDARY = re.compile(r'boundary="?([^";]+)"?', re.IGNORECASE)


@dataclass(frozen=True)
class RegisteredSpec:
    """A decoded registered resource: what ``bim_core.compiler.RegisteredResource`` needs plus its key."""

    namespace: str
    name: str
    version: str
    digest: str
    media_type: str
    content: bytes
    version_manifest: dict[str, Any] | None = None

    @property
    def key(self) -> tuple[str, str, str, str]:
        return (self.namespace, self.name, self.version, self.digest)


def request_invalid(message: str, diagnostics: list[dict[str, Any]] | None = None) -> ContractError:
    """The one error for an input that does not match the contract (422, ``request_invalid``)."""
    return ContractError("request_invalid", message, diagnostics or [], http_status=422)


def validation_diagnostics(error: ValidationError, prefix: str = "") -> list[dict[str, Any]]:
    """Locations and messages of a pydantic error; the offending values are never copied."""
    return [
        {
            "code": "request_invalid",
            "pointer": prefix + "".join(f"/{part}" for part in item["loc"]),
            "message": item["msg"],
        }
        for item in error.errors()[:20]
    ]


def decode_base64(value: str, pointer: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise request_invalid(
            "a base64 member is not valid base64",
            [{"code": "request_invalid", "pointer": pointer, "message": "not valid base64"}],
        ) from exc


def registered_specs(models: list[RegisteredResourceModel], settings: BimServiceSettings) -> list[RegisteredSpec]:
    if len(models) > settings.max_registered_resources:
        raise ServiceProblem(
            422,
            "limit_exceeded",
            f"at most {settings.max_registered_resources} registered resources per request",
        )
    specs: list[RegisteredSpec] = []
    seen: set[tuple[str, str, str, str]] = set()
    for index, model in enumerate(models):
        spec = RegisteredSpec(
            namespace=model.namespace,
            name=model.name,
            version=model.version,
            digest=model.digest,
            media_type=model.mediaType,
            content=decode_base64(model.contentBase64, f"/registeredResources/{index}/contentBase64"),
            version_manifest=model.versionManifest,
        )
        if spec.key in seen:
            raise request_invalid(
                "a registered resource is listed twice",
                [{"code": "request_invalid", "pointer": f"/registeredResources/{index}", "message": "duplicate"}],
            )
        seen.add(spec.key)
        specs.append(spec)
    return specs


def parse_multipart(content_type: str, body: bytes) -> dict[str, bytes]:
    """The parts of a ``multipart/form-data`` body by field name (a small, strict reader: no nesting, no encodings)."""
    found = _BOUNDARY.search(content_type)
    if found is None:
        raise request_invalid("the multipart content type has no boundary")
    delimiter = b"--" + found.group(1).encode("latin-1", "replace")
    parts: dict[str, bytes] = {}
    for chunk in body.split(delimiter)[1:]:
        if chunk.startswith(b"--"):
            break
        head, separator, content = chunk.removeprefix(b"\r\n").partition(b"\r\n\r\n")
        if not separator:
            raise request_invalid("a multipart part has no header block")
        field = _NAME.search(head)
        if field is None:
            raise request_invalid("a multipart part has no field name")
        name = field.group(1).decode("utf-8", "replace")
        if name in parts:
            raise request_invalid(f"the multipart field {name!r} appears twice")
        parts[name] = content.removesuffix(b"\r\n")
    return parts


def decode_package_request(
    content_type: str, body: bytes, settings: BimServiceSettings
) -> tuple[bytes, list[RegisteredSpec]]:
    """``(package bytes, registered resources)`` of a ``/compile`` or ``/validate`` request body."""
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type == "application/json" or media_type.endswith("+json"):
        try:
            document = json.loads(body)
        except (ValueError, RecursionError) as exc:  # RecursionError: nesting deeper than the parser allows
            raise request_invalid("the request body is not valid JSON") from exc
        try:
            model = PackageRequest.model_validate(document)
        except ValidationError as exc:
            raise request_invalid("the request body does not match the contract", validation_diagnostics(exc)) from exc
        return decode_base64(model.package, "/package"), registered_specs(model.registeredResources, settings)
    if media_type == "multipart/form-data":
        parts = parse_multipart(content_type, body)
        unknown = sorted(set(parts) - {"package", "registeredResources"})
        if "package" not in parts or unknown:
            raise request_invalid(
                "a multipart request has the parts `package` and, optionally, `registeredResources`",
                [{"code": "request_invalid", "message": f"unexpected part {name!r}"} for name in unknown],
            )
        models: list[RegisteredResourceModel] = []
        if "registeredResources" in parts:
            try:
                models = _REGISTERED_LIST.validate_json(parts["registeredResources"])
            except ValidationError as exc:
                raise request_invalid(
                    "`registeredResources` does not match the contract", validation_diagnostics(exc, "/registeredResources")
                ) from exc
        return parts["package"], registered_specs(models, settings)
    raise ServiceProblem(
        415, "unsupported_media_type", "send application/json (base64 package) or multipart/form-data"
    )
