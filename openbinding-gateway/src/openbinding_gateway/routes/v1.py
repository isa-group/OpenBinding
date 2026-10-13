"""The public BIM v1 API exposed by the OpenBinding platform.

This router intentionally deals in snapshots and canonical IR. It never passes
a source ZIP to an engine: engines receive only the compiled BindingProblem.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
import uuid
from email.parser import BytesParser
from email.policy import default as email_policy
from typing import Any, Mapping

from ..models.analysis import NeighborhoodResponse
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import optional_session, require_v1_admin, solve_caller
from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import (
    BindingIRSnapshot,
    DialectRevision,
    EngineCredential,
    EngineRegistrationRevision,
    EngineRevision,
    InstanceSnapshot,
    ManifestPublication,
    Notification,
    RegisteredResourceRevision,
    User,
    UserRole,
    utcnow,
)
from ..job_dispatch import dispatch_persisted_job
from ..models.problem import PROBLEM_MEDIA_TYPE, VALIDATION_ERROR, problem_response, split_detail
from ..security.apikeys import allows_engine
from bim_core import ContractError, PackageError
from bim_core.canonical import canonical_json, digest, digest_bytes
from ..core.jsonio import strict_json_loads
from ..integrations import bim, packages
from ..integrations.bim_host import (
    XmlResource,
    dialect_type_matches,
    dialect_xml_type_matches,
    engine_contract_diagnostics,
    resource_schema_diagnostics,
)
from ..v1.remote import (
    RemoteEngineError,
    RemoteRegistration,
    avalidate_endpoint,
    fetch_remote_document,
    solve_remote,
    validate_endpoint,
)
from ..services.engines import (
    MANIFEST_DIR,
    available_engine_documents,
    compatible_modes,
    embedded_secret_paths,
    engine_ref,
    owned_job,
    protocol_digest,
    protocol_document,
    registration_engine_reference,
    registration_summary,
    schema_diagnostics,
    validate_engine_result,
)
from ..services.engines import manifest as _manifest
from ..services.engines import manifest_async
from ..services.entitlements import EntitlementsUnavailable, entitlement_service
from ..services.job_submission import (
    STUDY_CELL_KEY_PREFIX,
    JobSubmission,
    JobSubmissionInput,
    JobSubmissionResult,
)

# Re-exported for ``study_jobs`` and the tests that read the pending launches through this module.
from ..services.job_submission import discard_pending_launches as discard_pending_launches
from ..services.job_submission import pending_launches as pending_launches
from ..services.probe import probe_ir
from ..services.snapshots import (
    CUSTOM_RESOURCES,
    Compilation,
    RegisteredResource,
    compile_resolved,
    owned_snapshot,
    package_file_digests,
    persist_snapshot,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["BIM v1"])

_CUSTOM_RESOURCE_RECORDS: dict[tuple[str, str, str, str], dict[str, Any]] = {}
_BIM_ZIP_TYPES = {"application/zip", "application/octet-stream", "application/vnd.bim+zip", "application/x-bim+zip"}


def _max_expanded() -> int:
    """Largest JSON document or registered resource the gateway reads: the toolchain's expanded-package limit."""
    return bim.package_limits()["max_expanded_bytes"]


def _max_compressed() -> int:
    """Largest ``.bim.zip`` upload: the toolchain's compressed-package limit."""
    return bim.package_limits()["max_compressed_bytes"]


def _problem(
    status_code: int,
    code: str,
    detail: str,
    diagnostics: list[dict[str, Any]] | None = None,
    extra: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return problem_response(status_code, code, detail, diagnostics, headers=headers, extra=extra)


_SCHEMA_ANNOTATIONS = {"title", "description", "$comment", "examples", "deprecated", "readOnly", "writeOnly"}
_BINDING_PROBLEM_SCHEMA_REF = "./bim/v1/binding-problem.schema.json"


def _pointer(document: dict[str, Any], reference: str) -> Any:
    if not reference.startswith("#/"):
        raise RemoteEngineError(f"deployment OpenAPI uses a non-local schema reference: {reference}")
    value: Any = document
    for raw in reference[2:].split("/"):
        token = raw.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or token not in value:
            raise RemoteEngineError(f"deployment OpenAPI has an unresolved schema reference: {reference}")
        value = value[token]
    return value


def _schema_semantics(document: dict[str, Any], value: Any, trail: tuple[str, ...] = ()) -> Any:
    """Dereference a bounded OpenAPI schema into a comparable closed form."""
    if isinstance(value, list):
        return [_schema_semantics(document, item, trail) for item in value]
    if not isinstance(value, dict):
        return value
    reference = value.get("$ref")
    if isinstance(reference, str):
        siblings = set(value) - {"$ref"} - _SCHEMA_ANNOTATIONS
        if siblings:
            raise RemoteEngineError("deployment OpenAPI schema references cannot have semantic siblings")
        if reference == _BINDING_PROBLEM_SCHEMA_REF:
            return {"$ref": "bim-binding-problem/v1"}
        if not reference.startswith("#/"):
            raise RemoteEngineError(f"deployment OpenAPI uses an unapproved schema reference: {reference}")
        if reference in trail:
            raise RemoteEngineError(f"deployment OpenAPI contains a recursive schema reference: {reference}")
        return _schema_semantics(document, _pointer(document, reference), (*trail, reference))
    return {
        key: _schema_semantics(document, child, trail)
        for key, child in value.items()
        if key not in _SCHEMA_ANNOTATIONS
    }


def _operation_schema(operation: Any, *, request: bool = False, response: str | None = None) -> dict[str, Any]:
    try:
        if request:
            schema = operation["requestBody"]["content"]["application/json"]["schema"]
        else:
            schema = operation["responses"][response]["content"]["application/json"]["schema"]
    except (KeyError, TypeError) as exc:
        location = "request" if request else f"response {response}"
        raise RemoteEngineError(f"deployment OpenAPI is missing the application/json {location} schema") from exc
    if not isinstance(schema, dict):
        raise RemoteEngineError("deployment OpenAPI operation schema must be an object")
    return schema


def _assert_operation_auth(
    document: Mapping[str, Any],
    operation: Mapping[str, Any],
    expected: str,
    label: str,
) -> None:
    """Ensure the submitted OpenAPI matches the registration transport auth."""

    security = operation.get("security", document.get("security", []))
    if not isinstance(security, list):
        raise RemoteEngineError(f"deployment OpenAPI {label} security must be an array")
    if any(not isinstance(requirement, Mapping) for requirement in security):
        raise RemoteEngineError(
            f"deployment OpenAPI {label} security requirements must be objects"
        )
    if expected == "none":
        if security and not any(not requirement for requirement in security):
            raise RemoteEngineError(
                f"deployment OpenAPI {label} requires authentication but registration auth is none"
            )
        return

    if not security or any(not requirement for requirement in security):
        raise RemoteEngineError(
            f"deployment OpenAPI {label} permits anonymous access but registration auth is {expected}"
        )

    schemes = document.get("components", {}).get("securitySchemes", {})
    if not isinstance(schemes, Mapping):
        raise RemoteEngineError("deployment OpenAPI has no securitySchemes object")
    matching_names = {
        name
        for name, declaration in schemes.items()
        if isinstance(name, str)
        and isinstance(declaration, Mapping)
        and declaration.get("type") == "http"
        and str(declaration.get("scheme", "")).casefold() == expected
    }
    if not any(
        isinstance(requirement, Mapping)
        and len(requirement) == 1
        and next(iter(requirement), None) in matching_names
        for requirement in security
    ):
        raise RemoteEngineError(
            f"deployment OpenAPI {label} does not offer the registered {expected} authentication"
        )


def _assert_protocol_schema(
    label: str,
    deployed_document: dict[str, Any],
    deployed_schema: dict[str, Any],
    canonical_document: dict[str, Any],
    canonical_schema: dict[str, Any],
) -> None:
    deployed = _schema_semantics(deployed_document, deployed_schema)
    canonical = _schema_semantics(canonical_document, canonical_schema)
    if digest(deployed) != digest(canonical):
        raise RemoteEngineError(f"deployment OpenAPI {label} schema is not equivalent to bim-engine/v1")


def _conformance_shape(mode: Mapping[str, Any]) -> tuple[str, str, int]:
    scalarizations = mode.get("capabilities", {}).get("scalarizations", {})
    descriptors = scalarizations.get("values", []) if isinstance(scalarizations, Mapping) else []
    limits = mode.get("limits", {})
    minimum = limits.get("minObjectives", 0) if isinstance(limits, Mapping) else 0
    maximum = limits.get("maxObjectives") if isinstance(limits, Mapping) else None
    minimum = minimum if isinstance(minimum, int) else 0
    maximum = maximum if isinstance(maximum, int) else None
    for descriptor in descriptors:
        if not isinstance(descriptor, Mapping):
            continue
        scalarization = descriptor.get("id")
        for objective_type in descriptor.get("objectiveTypes", []):
            if not isinstance(scalarization, str) or objective_type not in {"SINGLE", "MULTI", "MANY"}:
                continue
            if scalarization == "feasibility" and objective_type == "SINGLE" and minimum == 0:
                return scalarization, objective_type, 0
            objective_count = max(minimum, {"SINGLE": 1, "MULTI": 2, "MANY": 3}[objective_type])
            if objective_type == "MULTI" and objective_count > 3:
                continue
            if maximum is not None and objective_count > maximum:
                continue
            return scalarization, objective_type, objective_count
    raise RemoteEngineError("Engine has no mode shape suitable for a deterministic conformance probe")


def _conformance_mode(engine: Mapping[str, Any]) -> Mapping[str, Any]:
    modes = engine.get("spec", {}).get("modes", [])
    for mode in modes if isinstance(modes, list) else []:
        if not isinstance(mode, Mapping):
            continue
        try:
            _conformance_shape(mode)
            return mode
        except RemoteEngineError:
            continue
    raise RemoteEngineError("Engine has no published mode suitable for a deterministic conformance probe")


def _conformance_options(mode: Mapping[str, Any]) -> dict[str, Any]:
    properties = mode.get("optionsSchema", {}).get("properties", {})
    if not isinstance(properties, Mapping):
        return {}
    return {
        name: copy.deepcopy(option["default"])
        for name, option in properties.items()
        if isinstance(name, str) and isinstance(option, Mapping) and "default" in option
    }


def _conformance_optimization(mode: Mapping[str, Any]) -> dict[str, Any]:
    _, objective_type, objective_count = _conformance_shape(mode)
    scalarization, _, _ = _conformance_shape(mode)
    return {
        "type": objective_type,
        "scalarization": scalarization,
        "weights": [
            {"criteria": f"probe-objective-{index + 1}", "value": 1.0 / objective_count}
            for index in range(objective_count)
        ],
    }


async def _verify_registration(
    document: dict[str, Any],
    credential: str | None,
    engine: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """Fetch the pinned OpenAPI and execute a deterministic response probe."""

    spec = document["spec"]
    transport = RemoteRegistration(
        endpoint=spec["endpoint"],
        mappings=spec.get("mappings", {}),
        auth_scheme=spec.get("auth", {}).get("scheme", "none"),
        credential=credential,
        allow_internal_http=not get_settings().federation_require_https,
    )
    expected_digest = spec["protocol"]["digest"]
    checks: list[dict[str, Any]] = []
    submitted_openapi = spec.get("openapi")
    openapi_document: dict[str, Any] | None = (
        submitted_openapi if isinstance(submitted_openapi, dict) else None
    )
    openapi_digest: str | None = (
        digest(openapi_document) if openapi_document is not None else None
    )
    started = time.monotonic()
    try:
        openapi_path = spec.get("mappings", {}).get("openapi", "/openapi.json")
        if openapi_document is None:
            raise RemoteEngineError("registration must include the deployment OpenAPI document")
        live_openapi = await fetch_remote_document(transport, openapi_path)
        if digest(live_openapi) != openapi_digest:
            raise RemoteEngineError(
                "served OpenAPI differs from the immutable document submitted for review"
            )
        if openapi_document.get("openapi") != "3.1.0":
            raise RemoteEngineError("served OpenAPI must declare version 3.1.0")
        if openapi_document.get("x-bim-protocol") != "bim-engine/v1":
            raise RemoteEngineError("deployment OpenAPI must declare x-bim-protocol: bim-engine/v1")
        if openapi_document.get("x-bim-protocol-digest") != expected_digest:
            raise RemoteEngineError("deployment OpenAPI does not pin the canonical bim-engine/v1 digest")

        canonical_document = protocol_document()
        if expected_digest != protocol_digest():
            raise RemoteEngineError("registration does not pin the installed bim-engine/v1 contract")
        request_path = spec.get("mappings", {}).get("request", "/internal/v1/binding-problems")
        operation = openapi_document.get("paths", {}).get(request_path, {}).get("post")
        if not isinstance(operation, dict):
            raise RemoteEngineError("deployment OpenAPI does not describe the mapped solve operation")
        _assert_operation_auth(
            openapi_document,
            operation,
            spec.get("auth", {}).get("scheme", "none"),
            "solve operation",
        )
        canonical_operation = canonical_document["paths"]["/internal/v1/binding-problems"]["post"]
        _assert_protocol_schema(
            "solve request",
            openapi_document,
            _operation_schema(operation, request=True),
            canonical_document,
            _operation_schema(canonical_operation, request=True),
        )
        responses = operation.get("responses", {})
        if not isinstance(responses, dict) or not ({"200", "202"} & set(responses)):
            raise RemoteEngineError("deployment OpenAPI does not describe a synchronous or asynchronous result")
        response_modes: list[str] = []
        if "200" in responses:
            _assert_protocol_schema(
                "synchronous result",
                openapi_document,
                _operation_schema(operation, response="200"),
                canonical_document,
                _operation_schema(canonical_operation, response="200"),
            )
            response_modes.append("synchronous")
        if "202" in responses:
            _assert_protocol_schema(
                "asynchronous receipt",
                openapi_document,
                _operation_schema(operation, response="202"),
                canonical_document,
                _operation_schema(canonical_operation, response="202"),
            )
            job_path = spec.get("mappings", {}).get("job")
            if not isinstance(job_path, str) or "{id}" not in job_path:
                raise RemoteEngineError("an asynchronous deployment requires a mapped job path containing {id}")
            job_operation = openapi_document.get("paths", {}).get(job_path, {}).get("get")
            if not isinstance(job_operation, dict):
                raise RemoteEngineError("deployment OpenAPI does not describe the mapped async job operation")
            _assert_operation_auth(
                openapi_document,
                job_operation,
                spec.get("auth", {}).get("scheme", "none"),
                "asynchronous job operation",
            )
            canonical_job = canonical_document["paths"]["/internal/v1/jobs/{id}"]["get"]
            _assert_protocol_schema(
                "asynchronous job",
                openapi_document,
                _operation_schema(job_operation, response="200"),
                canonical_document,
                _operation_schema(canonical_job, response="200"),
            )
            response_modes.append("asynchronous")
        checks.append(
            {
                "id": "openapi",
                "status": "passed",
                "deploymentDigest": openapi_digest,
                "protocolDigest": expected_digest,
                "requestPath": request_path,
                "responseModes": response_modes,
            }
        )

        health_path = spec.get("mappings", {}).get("health", "/health")
        health_operation = openapi_document.get("paths", {}).get(health_path, {}).get("get")
        if not isinstance(health_operation, dict) or "200" not in health_operation.get("responses", {}):
            raise RemoteEngineError(
                "deployment OpenAPI must describe the mapped GET health operation and its 200 response"
            )
        _assert_operation_auth(
            openapi_document,
            health_operation,
            spec.get("auth", {}).get("scheme", "none"),
            "health operation",
        )
        await fetch_remote_document(transport, health_path)
        checks.append({"id": "health", "status": "passed"})

        conformance_mode = _conformance_mode(engine)
        result = await solve_remote(
            transport,
            await probe_ir(_conformance_shape(conformance_mode)[2]),
            _conformance_options(conformance_mode),
            _conformance_optimization(conformance_mode),
            timeout_s=10.0,
            validate_result=validate_engine_result,
        )
        expected_binding = {"probe-task": {"resource": "probe-catalog", "id": "probe-candidate"}}
        bindings = [
            item.get("decision", {}).get("binding")
            for item in result.get("solutions", [])
            if isinstance(item, dict)
        ]
        if result.get("termination") not in {"OPTIMAL", "FEASIBLE"} or expected_binding not in bindings:
            raise RemoteEngineError("engine did not solve the deterministic conformance problem")
        checks.append({"id": "binding-result", "status": "passed", "termination": result["termination"]})
    except (RemoteEngineError, KeyError, TypeError, ValueError) as exc:
        checks.append({"id": "conformance", "status": "failed", "message": str(exc)})
        return (
            {
                "protocol": "bim-engine/v1",
                "protocolDigest": expected_digest,
                "status": "failed",
                "checks": checks,
                "durationMs": round((time.monotonic() - started) * 1000, 3),
            },
            openapi_document,
            openapi_digest,
        )
    return (
        {
            "protocol": "bim-engine/v1",
            "protocolDigest": expected_digest,
            "status": "verified",
            "checks": checks,
            "durationMs": round((time.monotonic() - started) * 1000, 3),
        },
        openapi_document,
        openapi_digest,
    )


async def _read_package(request: Request) -> bytes:
    """The body of a ``.bim.zip`` upload, within the package size limit (the toolchain judges its content)."""
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
    if content_type not in _BIM_ZIP_TYPES:
        raise HTTPException(
            status_code=415,
            detail="BIM source uploads must use a .bim.zip media type",
        )
    ceiling = _max_compressed()
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > ceiling:
        raise HTTPException(status_code=413, detail=f"request body exceeds {ceiling} bytes")
    body = await request.body()
    if len(body) > ceiling:
        raise HTTPException(status_code=413, detail=f"request body exceeds {ceiling} bytes")
    return body


async def _compile_upload(archive: bytes, session: AsyncSession | None, caller: User | None = None) -> Compilation:
    """Compile an upload; a package the toolchain cannot read is ``422`` with its message."""
    try:
        return await compile_resolved(archive, session, caller)
    except PackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _multipart_zip(body: bytes, content_type: str) -> bytes:
    """Parse one bounded MIME file part without trusting its supplied name."""
    if "\r" in content_type or "\n" in content_type or len(content_type) > 4096:
        raise PackageError("invalid multipart Content-Type")
    try:
        envelope = (
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii")
            + body
        )
    except UnicodeEncodeError as exc:
        raise PackageError("multipart Content-Type must be ASCII") from exc
    message = BytesParser(policy=email_policy).parsebytes(envelope)
    if not message.is_multipart():
        raise PackageError("multipart/form-data requires a valid boundary")
    files: list[bytes] = []
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data" or part.get_filename() is None:
            continue
        transfer_encoding = (part.get("Content-Transfer-Encoding") or "binary").casefold()
        if transfer_encoding not in {"binary", "8bit"}:
            raise PackageError("multipart ZIP must use binary transfer encoding")
        content = part.get_payload(decode=True)
        if not isinstance(content, bytes) or not content:
            raise PackageError("multipart ZIP part is empty")
        if len(content) > _max_compressed():
            raise PackageError(f"compressed package exceeds {_max_compressed()} bytes")
        files.append(content)
    if len(files) != 1:
        raise PackageError("multipart request must contain exactly one ZIP file part")
    return files[0]


def _error_from_http(exc: HTTPException) -> JSONResponse:
    """The same document the central HTTPException handler would produce (main.py)."""
    default_code = VALIDATION_ERROR if exc.status_code == 422 else "request_invalid"
    code, message, diagnostics, extra = split_detail(exc.detail, default_code)
    return _problem(exc.status_code, code, message, diagnostics, extra=extra, headers=exc.headers)


@router.get("/profiles")
async def list_profiles() -> dict[str, Any]:
    return {
        "profiles": [
            {
                **entry["manifest"],
                "id": entry["descriptor"]["id"],
                "digest": entry["descriptor"]["digest"],
                "output": entry["manifest"]["spec"]["output"],
                "protocol": entry["manifest"]["spec"]["output"]["engineProtocol"],
                "protocolDigest": protocol_digest(),
            }
            for entry in bim.profile_entries()
        ]
    }


def _builtin_profiles() -> list[dict[str, Any]]:
    return bim.profile_manifests()


def _builtin_dialects() -> list[dict[str, Any]]:
    return bim.dialect_manifests()


def _installed_dialect_contract(document: Mapping[str, Any]) -> bool:
    """Whether a manifest exactly describes a locally installed adapter ABI."""

    metadata = document.get("metadata")
    spec = document.get("spec")
    if not isinstance(metadata, Mapping) or not isinstance(spec, Mapping):
        return False
    for installed in _builtin_dialects():
        if digest(document) == digest(installed):
            return True
    return False


@router.get("/dialects")
async def list_dialects(session: AsyncSession | None = Depends(optional_session, scope="function")) -> dict[str, Any]:
    # Publication records are audit state, not an installation mechanism.
    # Expose only contracts backed by the adapter/schema registry active in
    # this process, so the catalog can never promise a stale deployment.
    del session
    return {
        "dialects": [
            {**item, "digest": digest(item)} for item in _builtin_dialects()
        ]
    }


SYSTEM_NAMESPACES = frozenset({"system", "openbinding"})


@router.post("/dialects", status_code=status.HTTP_201_CREATED)
async def publish_dialect(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        document = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_dialect", str(exc))
    diagnostics = (
        schema_diagnostics(document, "Dialect")
        if isinstance(document, dict)
        else [{"code": "document", "message": "Dialect must be an object"}]
    )
    secret_paths = embedded_secret_paths(document)
    diagnostics.extend(
        {"code": "secret_in_document", "pointer": path, "message": "secret-like field is forbidden"}
        for path in secret_paths
    )
    if diagnostics:
        return _problem(422, "invalid_dialect", "Dialect manifest does not satisfy bim/v1", diagnostics)
    name = document["metadata"]["name"]
    version = document["metadata"]["version"]
    revision_digest = digest(document)
    adapter_digest = document["spec"]["adapter"]["binaryDigest"]
    if session is not None:
        if caller is None:
            return _problem(401, "unauthorized", "Publishing a Dialect requires an account")
        namespace = document["metadata"]["namespace"]
        if caller.is_admin:
            if namespace != caller.username and namespace not in SYSTEM_NAMESPACES:
                return _problem(403, "forbidden", "Dialect namespace must match the caller or an official system namespace")
        elif namespace != caller.username:
            return _problem(403, "forbidden", "Dialect namespace must match the caller")
        existing = (
            await session.execute(
                select(DialectRevision).where(
                    DialectRevision.namespace == namespace,
                    DialectRevision.name == name,
                    DialectRevision.version == version,
                )
            )
        ).scalars().first()
        if existing is not None:
            if existing.digest != revision_digest:
                return _problem(409, "immutable_dialect", "Dialect revisions are immutable; publish a new version")
            return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": existing.state}
        state = "published" if (caller.is_admin and namespace in SYSTEM_NAMESPACES) else "pending_review"
        row = DialectRevision(
            owner_id=caller.id,
            namespace=namespace,
            name=name,
            version=version,
            digest=revision_digest,
            adapter_digest=adapter_digest,
            document=document,
            state=state,
        )
        try:
            async with session.begin_nested():
                session.add(row)
                if state == "published":
                    publication = (
                        await session.execute(
                            select(ManifestPublication).where(
                                ManifestPublication.resource_kind == "Dialect",
                                ManifestPublication.resource_digest == revision_digest,
                            )
                        )
                    ).scalars().first()
                    if publication is None:
                        session.add(
                            ManifestPublication(
                                resource_kind="Dialect",
                                resource_digest=revision_digest,
                                publisher_id=caller.id,
                                state="public",
                            )
                        )
                await session.flush()
        except IntegrityError:
            return _problem(409, "immutable_dialect", "Dialect identity already exists with different content")
        return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": state}
    if not _installed_dialect_contract(document):
        return _problem(409, "adapter_not_installed", "Dialect does not match an installed adapter and schema contract")
    namespace = document["metadata"]["namespace"]
    return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": "published"}


@router.post("/dialects/{name}/approve")
async def approve_dialect(
    name: str,
    namespace: str,
    version: str,
    revision: str,
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is None or caller is None:
        return _problem(404, "not_found", "Dialect revision not found")
    if not caller.is_admin:
        return _problem(403, "forbidden", "Only an administrator may approve Dialects")
    row = (
        await session.execute(
            select(DialectRevision).where(
                DialectRevision.namespace == namespace,
                DialectRevision.name == name,
                DialectRevision.version == version,
                DialectRevision.digest == revision,
            )
        )
    ).scalars().first()
    if row is None:
        return _problem(404, "not_found", "Dialect revision not found")
    if not _installed_dialect_contract(row.document):
        return _problem(409, "adapter_not_installed", "Dialect does not match an installed adapter and schema contract")
    row.state = "published"
    publication = (
        await session.execute(
            select(ManifestPublication).where(
                ManifestPublication.resource_kind == "Dialect",
                ManifestPublication.resource_digest == row.digest,
            )
        )
    ).scalars().first()
    if publication is None:
        session.add(
            ManifestPublication(
                resource_kind="Dialect",
                resource_digest=row.digest,
                publisher_id=caller.id,
                state="public",
            )
        )
    await session.flush()
    return {"namespace": namespace, "name": name, "version": version, "digest": revision, "status": "published"}


@router.post("/resources", status_code=status.HTTP_201_CREATED)
async def register_bim_resource(
    request: Request,
    namespace: str = Query(min_length=1, max_length=128),
    name: str = Query(min_length=1, max_length=128),
    version: str = Query(min_length=1, max_length=64),
    role: str = Query(),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Store an immutable BIM source resource; no executable adapter is accepted."""
    if session is not None and caller is None:
        return _problem(401, "unauthorized", "Registering a BIM resource requires an account")
    if caller is not None:
        if caller.is_admin:
            if namespace != caller.username and namespace not in SYSTEM_NAMESPACES:
                return _problem(403, "forbidden", "Resource namespace must match the caller or an official system namespace")
        elif namespace != caller.username:
            return _problem(403, "forbidden", "Resource namespace must match the caller")
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].casefold()
    body = await request.body()
    if len(body) > _max_expanded():
        return _problem(413, "payload_too_large", f"resource exceeds {_max_expanded()} bytes")
    document: dict[str, Any] | None = None
    dialects = bim.dialect_manifests()
    dialect_id: str
    api_version: str
    if content_type == "application/json":
        try:
            parsed = strict_json_loads(body)
        except PackageError as exc:
            return _problem(422, "invalid_resource", str(exc))
        if not isinstance(parsed, dict):
            return _problem(422, "invalid_resource", "registered JSON resource must be an object")
        document = parsed
        kind = document.get("kind")
        api_version = document.get("apiVersion")
        if not isinstance(api_version, str) or not isinstance(kind, str):
            return _problem(422, "invalid_resource_identity", "resource requires string apiVersion and kind")
        matches = [
            pair for pair in dialect_type_matches(dialects, api_version, kind, content_type)
            if role in pair[1].get("roles", [])
        ]
        if not matches:
            return _problem(
                422,
                "invalid_resource_contract",
                f"no installed Dialect permits {api_version!r} {kind!r} in role {role!r}",
            )
        if len(matches) != 1:
            return _problem(409, "ambiguous_resource_contract", "more than one installed Dialect claims this resource identity")
        dialect, resource_type = matches[0]
        dialect_id = bim.manifest_id(dialect)
        diagnostics = resource_schema_diagnostics(document, api_version, kind, content_type, "resource")
        if diagnostics:
            return _problem(422, "invalid_resource", "resource does not satisfy its installed Dialect schema", [item.as_dict() for item in diagnostics])
        metadata = document.get("metadata", {})
        if metadata.get("name") != name or metadata.get("version") != version:
            return _problem(
                422,
                "resource_identity",
                "registered JSON metadata.name/version must match the requested identity",
            )
        content = canonical_json(document)
        media_type = "application/json"
    elif content_type in {"application/vnd.omg.bpmn+xml", "application/xml", "text/xml"} or content_type.endswith("+xml"):
        content = body.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        try:
            source_package = XmlResource(content)
            xml_root = source_package.root()
        except PackageError as exc:
            return _problem(422, "invalid_resource", str(exc))
        if isinstance(xml_root.tag, str) and xml_root.tag.startswith("{") and "}" in xml_root.tag:
            xml_namespace, local_name = xml_root.tag[1:].split("}", 1)
        else:
            xml_namespace, local_name = "", str(xml_root.tag)
        matches = [
            pair for pair in dialect_xml_type_matches(dialects, xml_namespace, local_name, content_type)
            if role in pair[1].get("roles", [])
        ]
        if not matches:
            return _problem(
                422,
                "invalid_resource_contract",
                f"no installed Dialect permits XML {{{xml_namespace}}}{local_name} ({content_type}) in role {role!r}",
            )
        if len(matches) != 1:
            return _problem(409, "ambiguous_resource_contract", "more than one installed Dialect claims this XML resource")
        dialect, resource_type = matches[0]
        if dialect.get("spec", {}).get("adapter", {}).get("id") == "bim-bpmn":
            try:
                source_package.validate_bpmn()
            except PackageError as exc:
                return _problem(422, "invalid_resource", str(exc))
        else:
            return _problem(409, "adapter_not_installed", "the XML Dialect has no deployed validator adapter")
        dialect_id = bim.manifest_id(dialect)
        api_version = str(resource_type["apiVersion"])
        kind = str(resource_type["kind"])
        media_type = content_type
    else:
        return _problem(
            415,
            "unsupported_media_type",
            "BIM resources use application/json or application/vnd.omg.bpmn+xml",
        )
    # ``content`` is already in the form the package contract digests: canonical JSON, or LF-normalised XML.
    revision_digest = digest_bytes(content)
    key = (namespace, name, version, revision_digest)
    state = "published" if (caller is None or (caller.is_admin and namespace in SYSTEM_NAMESPACES)) else "pending_review"
    if session is not None:
        existing = (
            await session.execute(
                select(RegisteredResourceRevision).where(
                    RegisteredResourceRevision.namespace == namespace,
                    RegisteredResourceRevision.name == name,
                    RegisteredResourceRevision.version == version,
                )
            )
        ).scalars().first()
        if existing is not None:
            if existing.digest != revision_digest:
                return _problem(409, "immutable_resource", "resource revisions are immutable; register a new version")
            return {
                "namespace": namespace,
                "name": name,
                "version": version,
                "digest": revision_digest,
                "status": existing.state,
            }
        row = RegisteredResourceRevision(
            owner_id=caller.id,
            namespace=namespace,
            name=name,
            version=version,
            digest=revision_digest,
            role=role,
            api_version=api_version,
            kind=str(kind),
            dialect_id=dialect_id,
            media_type=media_type,
            document=document,
            content=content,
            state=state,
        )
        try:
            async with session.begin_nested():
                session.add(row)
                if state == "published":
                    publication = (
                        await session.execute(
                            select(ManifestPublication).where(
                                ManifestPublication.resource_kind == "RegisteredResource",
                                ManifestPublication.resource_digest == revision_digest,
                            )
                        )
                    ).scalars().first()
                    if publication is None:
                        session.add(
                            ManifestPublication(
                                resource_kind="RegisteredResource",
                                resource_digest=revision_digest,
                                publisher_id=caller.id,
                                state="public",
                            )
                        )
                await session.flush()
        except IntegrityError:
            return _problem(409, "immutable_resource", "resource identity already exists")
    else:
        conflicting = next(
            (
                record
                for record_key, record in _CUSTOM_RESOURCE_RECORDS.items()
                if record_key[:3] == key[:3] and record_key != key
            ),
            None,
        )
        if conflicting is not None:
            return _problem(409, "immutable_resource", "resource revisions are immutable; register a new version")
        CUSTOM_RESOURCES[key] = RegisteredResource(content, media_type)
        _CUSTOM_RESOURCE_RECORDS[key] = {
            "namespace": namespace,
            "name": name,
            "version": version,
            "digest": revision_digest,
            "role": role,
            "apiVersion": api_version,
            "kind": kind,
            "dialect": dialect_id,
            "mediaType": media_type,
            "status": "published",
        }
        state = "published"
    return {
        "namespace": namespace,
        "name": name,
        "version": version,
        "digest": revision_digest,
        "status": state,
    }


@router.get("/resources")
async def list_registered_bim_resources(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    resources = list(_CUSTOM_RESOURCE_RECORDS.values())
    if session is not None:
        rows = (
            await session.execute(
                select(RegisteredResourceRevision)
                .where(RegisteredResourceRevision.state == "published")
                .order_by(
                    RegisteredResourceRevision.namespace,
                    RegisteredResourceRevision.name,
                    RegisteredResourceRevision.version,
                )
            )
        ).scalars().all()
        resources.extend({
            "namespace": row.namespace,
            "name": row.name,
            "version": row.version,
            "digest": row.digest,
            "role": row.role,
            "apiVersion": row.api_version,
            "kind": row.kind,
            "dialect": row.dialect_id,
            "mediaType": row.media_type,
            "status": row.state,
        } for row in rows)
    unique = {
        (item["namespace"], item["name"], item["version"], item["digest"]): item
        for item in resources
        if item.get("status") == "published"
    }
    return {"resources": [unique[key] for key in sorted(unique)]}


@router.get("/resources/{name}")
async def get_registered_bim_resource(
    name: str,
    namespace: str,
    version: str,
    revision: str,
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    key = (namespace, name, version, revision)
    local = CUSTOM_RESOURCES.get(key)
    if local is not None:
        return Response(
            local.content,
            media_type=local.media_type,
            headers={"Digest": f"sha-256={revision.removeprefix('sha256-')}"},
        )
    if session is not None:
        row = (
            await session.execute(
                select(RegisteredResourceRevision).where(
                    RegisteredResourceRevision.namespace == namespace,
                    RegisteredResourceRevision.name == name,
                    RegisteredResourceRevision.version == version,
                    RegisteredResourceRevision.digest == revision,
                    RegisteredResourceRevision.state == "published",
                )
            )
        ).scalars().first()
        if row is not None:
            return Response(
                row.content,
                media_type=row.media_type,
                headers={"Digest": f"sha-256={row.digest.removeprefix('sha256-')}"},
            )
    return _problem(404, "not_found", "Registered BIM resource not found")


@router.post("/resources/{name}/approve")
async def approve_registered_bim_resource(
    name: str,
    namespace: str,
    version: str,
    revision: str,
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is None or caller is None:
        return _problem(404, "not_found", "Registered BIM resource not found")
    if not caller.is_admin:
        return _problem(403, "forbidden", "Only an administrator may approve BIM resources")
    row = (
        await session.execute(
            select(RegisteredResourceRevision).where(
                RegisteredResourceRevision.namespace == namespace,
                RegisteredResourceRevision.name == name,
                RegisteredResourceRevision.version == version,
                RegisteredResourceRevision.digest == revision,
            )
        )
    ).scalars().first()
    if row is None:
        return _problem(404, "not_found", "Registered BIM resource not found")
    row.state = "published"
    publication = (
        await session.execute(
            select(ManifestPublication).where(
                ManifestPublication.resource_kind == "RegisteredResource",
                ManifestPublication.resource_digest == row.digest,
            )
        )
    ).scalars().first()
    if publication is None:
        session.add(ManifestPublication(
            resource_kind="RegisteredResource",
            resource_digest=row.digest,
            publisher_id=caller.id,
            state="public",
        ))
    await session.flush()
    return {
        "namespace": namespace,
        "name": name,
        "version": version,
        "digest": revision,
        "status": "published",
    }


@router.get("/catalog")
async def get_catalog(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    return {
        "apiVersion": "bim/v1",
        **(await list_profiles()),
        **(await list_dialects(session=session)),
        **(await list_registered_bim_resources(session=session)),
        **(await list_examples()),
        **(await list_v1_engines(session=session, caller=caller)),
    }


@router.get("/schemas/{kind}")
async def get_v1_schema(kind: str):
    if kind in {"engine-contract", "bim-engine-v1"}:
        return {
            "protocol": "bim-engine/v1",
            "digest": protocol_digest(),
            "openapi": protocol_document(),
        }
    try:
        return await asyncio.to_thread(bim.schema_document, kind)
    except ContractError:
        return _problem(404, "not_found", "Unknown v1 kind")


@router.get("/examples")
async def list_examples() -> dict[str, Any]:
    root = MANIFEST_DIR.parents[3] / "examples"
    paths = []
    for path in root.rglob("instance.json"):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(document, dict) and document.get("apiVersion") == "bim/v1" and document.get("kind") == "Instance":
            paths.append(path.parent.relative_to(root).as_posix())
    paths.sort()
    return {"examples": paths}


@router.get("/examples/{example_path:path}")
async def get_example_package(example_path: str):
    root = (MANIFEST_DIR.parents[3] / "examples").resolve()
    requested = (root / example_path).resolve()
    try:
        requested.relative_to(root)
    except ValueError:
        return _problem(404, "not_found", "Example not found")
    if requested.name == "instance.json":
        requested = requested.parent
    if not requested.is_dir() or not (requested / "instance.json").is_file():
        return _problem(404, "not_found", "Example not found")
    archive = packages.zip_directory(requested)
    try:
        # The toolchain reads the archive (without keeping anything): an example it cannot load is refused.
        await bim.abim().validate(archive)
    except PackageError as exc:
        return _problem(422, "invalid_example", str(exc))
    safe_name = requested.name.replace('"', "") or "example"
    return Response(
        archive,
        media_type="application/vnd.bim+zip",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}.bim.zip"',
            "Digest": f"sha-256={digest_bytes(archive).removeprefix('sha256-')}",
        },
    )


@router.get("/engines")
async def list_v1_engines(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    engines = []
    for document, namespace in await available_engine_documents(session, caller):
        reference = engine_ref(document, namespace)
        if not allows_engine(caller, reference):
            continue
        engines.append(
            {
                "id": reference["name"],
                "name": reference["name"],
                "namespace": reference["namespace"],
                "version": reference["version"],
                "digest": reference["digest"],
                "ref": reference,
                "modes": document.get("spec", {}).get("modes", []),
            }
        )
    return {"engines": engines}


@router.get("/engines/revisions")
async def list_engine_revisions(
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    revisions: list[dict[str, Any]] = []
    if session is not None:
        db_revs = (await session.execute(
            select(EngineRevision).order_by(EngineRevision.namespace, EngineRevision.name, EngineRevision.version.desc())
        )).scalars().all()
        reg_rows = (await session.execute(
            select(EngineRegistrationRevision)
        )).scalars().all()
        reg_by_engine_digest = {r.engine_digest: r for r in reg_rows}
        reg_by_name = {(r.namespace, r.name, r.version): r for r in reg_rows}

        for rev in db_revs:
            reg = reg_by_engine_digest.get(rev.digest) or reg_by_name.get((rev.namespace, rev.name, rev.version))
            revisions.append({
                "id": str(rev.id),
                "namespace": rev.namespace,
                "name": rev.name,
                "version": rev.version,
                "digest": rev.digest,
                "state": rev.state,
                "createdAt": rev.created_at.isoformat() if rev.created_at else None,
                "document": rev.document,
                "registration": registration_summary(reg) if reg else None,
            })

    if not revisions:
        for doc, ns in await available_engine_documents(session, caller):
            ref = engine_ref(doc, ns)
            revisions.append({
                "id": f"{ref['namespace']}:{ref['name']}:{ref['version']}",
                "namespace": ref["namespace"],
                "name": ref["name"],
                "version": ref["version"],
                "digest": ref["digest"],
                "state": "published",
                "createdAt": utcnow().isoformat(),
                "document": doc,
                "registration": None,
            })

    return {"revisions": revisions}


@router.get("/engines/{name}")
async def get_v1_engine(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    if not allows_engine(
        caller,
        {
            "namespace": namespace,
            "name": name,
            "version": version,
            "digest": manifest_digest,
        },
    ):
        return _problem(404, "not_found", "Engine revision not found")
    try:
        return await manifest_async(
            name,
            session,
            caller=caller,
            namespace=namespace,
            version=version,
            manifest_digest=manifest_digest,
        )
    except HTTPException as exc:
        return _problem(exc.status_code, "not_found", str(exc.detail))


@router.get("/engines/{namespace}/{name}/revisions/{version}")
async def get_engine_revision_detail(
    namespace: str,
    name: str,
    version: str,
    session: AsyncSession | None = Depends(optional_session, scope="function"),
    caller: User = Depends(solve_caller),
) -> dict[str, Any]:
    rev = None
    reg = None
    if session is not None:
        rev = (await session.execute(
            select(EngineRevision).where(
                EngineRevision.namespace == namespace,
                EngineRevision.name == name,
                EngineRevision.version == version,
            )
        )).scalars().first()

        reg = (await session.execute(
            select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.namespace == namespace,
                EngineRegistrationRevision.name == name,
                EngineRegistrationRevision.version == version,
            )
        )).scalars().first()

    if rev is None:
        try:
            doc = _manifest(name, namespace=namespace, version=version)
            rev_digest = digest(doc)
            return {
                "namespace": namespace,
                "name": name,
                "version": version,
                "digest": rev_digest,
                "document": doc,
                "state": "published",
                "registration": None,
            }
        except HTTPException:
            return _problem(404, "not_found", "Engine revision not found")

    return {
        "id": str(rev.id),
        "namespace": rev.namespace,
        "name": rev.name,
        "version": rev.version,
        "digest": rev.digest,
        "state": rev.state,
        "createdAt": rev.created_at.isoformat() if rev.created_at else None,
        "document": rev.document,
        "registration": {
            "id": str(reg.id),
            "manifestDigest": reg.manifest_digest,
            "endpoint": reg.endpoint,
            "protocolDigest": reg.protocol_digest,
            "openapiDigest": reg.openapi_digest,
            "openapiDocument": reg.openapi_document,
            "verificationReport": reg.verification_report,
            "verifiedAt": reg.verified_at.isoformat() if reg.verified_at else None,
            "publicationStatus": reg.publication_status,
            "isActive": reg.is_active,
        } if reg else None,
    }


@router.get("/snapshots/{snapshot_id}")
async def get_snapshot_detail(
    snapshot_id: uuid.UUID,
    caller: User = Depends(solve_caller),
    session: AsyncSession = Depends(optional_session, scope="function"),
) -> dict[str, Any]:
    if session is None:
        return _problem(503, "database_unavailable", "Snapshots require database")
    snapshot = await owned_snapshot(str(snapshot_id), caller, session)
    if snapshot is None:
        return _problem(404, "not_found", "Snapshot not found")
    ir = (await session.execute(
        select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id)
    )).scalars().first()
    return {
        "id": str(snapshot.id),
        "ownerId": str(snapshot.owner_id) if snapshot.owner_id else None,
        "instanceDigest": snapshot.instance_digest,
        "packageDigest": snapshot.package_digest,
        "archiveSize": len(snapshot.source_archive) if snapshot.source_archive else 0,
        "createdAt": snapshot.created_at.isoformat() if snapshot.created_at else None,
        "ir": {
            "id": str(ir.id),
            "digest": ir.ir_digest,
            "document": ir.document,
            "sourceMap": ir.source_map,
            "compilerVersion": ir.compiler_version,
            "createdAt": ir.created_at.isoformat() if ir.created_at else None,
        } if ir else None,
    }


@router.get(
    "/snapshots/{snapshot_id}/archive",
    operation_id="downloadSnapshotArchive",
    response_class=Response,
    responses={200: {"content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def download_snapshot_archive(
    snapshot_id: uuid.UUID,
    caller: User = Depends(solve_caller),
    session: AsyncSession = Depends(optional_session, scope="function"),
) -> Response:
    if session is None:
        return _problem(503, "database_unavailable", "Snapshots require database")
    snapshot = await owned_snapshot(str(snapshot_id), caller, session)
    if snapshot is None or not snapshot.source_archive:
        return _problem(404, "not_found", "Snapshot archive not found")
    return Response(
        content=snapshot.source_archive,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="snapshot-{snapshot.id}.bim.zip"',
            "ETag": f'"{snapshot.package_digest}"',
            "Cache-Control": "no-store",
        },
    )


@router.post(
    "/engines",
    status_code=status.HTTP_201_CREATED,
    operation_id="createEngine",
)
async def create_engine(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        document = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_engine", str(exc))
    diagnostics = schema_diagnostics(document, "Engine") if isinstance(document, dict) else [{"code": "document", "message": "Engine must be an object"}]
    if isinstance(document, Mapping):
        diagnostics.extend(engine_contract_diagnostics(document))
    if diagnostics:
        return _problem(422, "invalid_engine", "Engine manifest does not satisfy bim/v1", diagnostics)
    name = document["metadata"]["name"]
    version = document["metadata"].get("version", "1.0.0")
    revision_digest = digest(document)
    target_reference = {
        "namespace": document["metadata"]["namespace"],
        "name": name,
        "version": version,
        "digest": revision_digest,
    }
    if not allows_engine(caller, target_reference):
        return _problem(
            403,
            "engine_not_granted",
            "This API key does not grant this exact Engine revision; use an all-Engines key to create new revisions",
        )
    if session is not None:
        namespace = document["metadata"]["namespace"]
        if namespace != caller.username:
            return _problem(403, "forbidden", "Engine namespace must match the caller")
        existing = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == namespace,
                    EngineRevision.name == name,
                    EngineRevision.version == version,
                )
            )
        ).scalars().first()
        if existing is not None:
            if existing.digest != revision_digest:
                return _problem(409, "immutable_engine", "Engine revisions are immutable; create a new version")
            return {"namespace": namespace, "name": name, "version": version, "digest": existing.digest, "status": existing.state}
        row = EngineRevision(
                owner_id=caller.id,
                namespace=namespace,
                name=name,
                version=version,
                digest=revision_digest,
                document=document,
                state="private",
            )
        try:
            async with session.begin_nested():
                session.add(row)
                await session.flush()
        except IntegrityError:
            return _problem(409, "immutable_engine", "Engine identity already exists with different content")
        return {"namespace": namespace, "name": name, "version": version, "digest": revision_digest, "status": "private"}
    return _problem(503, "accounts_unavailable", "Registering an Engine requires the accounts database")


@router.post("/engine-registrations", status_code=status.HTTP_201_CREATED)
async def register_engine(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        document = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_registration", str(exc))
    diagnostics = schema_diagnostics(document, "EngineRegistration") if isinstance(document, dict) else [{"code": "document", "message": "EngineRegistration must be an object"}]
    if diagnostics:
        return _problem(422, "invalid_registration", "registration must satisfy bim/v1", diagnostics)
    spec = document.get("spec", {})
    endpoint = spec.get("endpoint")
    if not isinstance(endpoint, str):
        return _problem(422, "invalid_registration", "registration endpoint must be a URI")
    allow_internal_http = not get_settings().federation_require_https
    try:
        await avalidate_endpoint(
            endpoint, allow_internal_http=allow_internal_http, validate=validate_endpoint
        )
    except RemoteEngineError as exc:
        return _problem(422, "invalid_registration", str(exc))
    secret_paths = embedded_secret_paths(document)
    if secret_paths:
        return _problem(
            422,
            "secret_in_document",
            "credentials must be supplied through the secret store",
            [{"code": "secret_in_document", "pointer": path, "message": "secret-like field is forbidden"} for path in secret_paths],
        )
    if spec.get("auth", {}).get("scheme") == "mtls":
        return _problem(
            422,
            "unsupported_auth",
            "mTLS needs a versioned certificate-bundle credential contract and is not available in BIM v1",
        )
    name = document.get("metadata", {}).get("name")
    if not isinstance(name, str) or not name:
        return _problem(422, "invalid_registration", "metadata.name is required")
    namespace = document["metadata"]["namespace"]
    if namespace != caller.username:
        return _problem(403, "forbidden", "EngineRegistration namespace must match the caller")
    version = document["metadata"]["version"]
    revision = digest(document)
    submitted_digest = spec.get("protocol", {}).get("digest")
    protocol_id = spec.get("protocol", {}).get("id", "bim-engine/v1")
    if protocol_id != "bim-engine/v1":
        return _problem(409, "protocol_mismatch", "registration must use bim-engine/v1")
    if submitted_digest != protocol_digest():
        return _problem(409, "protocol_digest_mismatch", "registration must pin the exact bim-engine/v1 OpenAPI digest")
    submitted_openapi = spec.get("openapi")
    if (
        not isinstance(submitted_openapi, dict)
        or submitted_openapi.get("x-bim-protocol-digest") != submitted_digest
    ):
        return _problem(
            409,
            "openapi_protocol_mismatch",
            "submitted OpenAPI must pin the same bim-engine/v1 digest as the registration",
        )
    engine_ref = spec.get("engine", {})
    engine_name = engine_ref.get("name") if isinstance(engine_ref, dict) else None
    if not allows_engine(caller, engine_ref if isinstance(engine_ref, Mapping) else {}):
        return _problem(404, "not_found", "Engine revision not found")
    try:
        engine_document = await manifest_async(
            engine_name,
            session,
            caller=caller,
            namespace=engine_ref.get("namespace"),
            version=engine_ref.get("version"),
            manifest_digest=engine_ref.get("digest"),
        )
    except HTTPException:
        return _problem(422, "unknown_engine", "registration references an unknown Engine revision")
    if digest(engine_document) != engine_ref.get("digest"):
        return _problem(409, "engine_digest_mismatch", "registration must pin the exact Engine revision digest")
    if session is not None:
        existing = (
            await session.execute(
                select(EngineRegistrationRevision).where(
                    EngineRegistrationRevision.namespace == namespace,
                    EngineRegistrationRevision.name == name,
                    EngineRegistrationRevision.version == version,
                )
            )
        ).scalars().first()
        if existing is not None:
            if existing.manifest_digest != revision:
                return _problem(409, "immutable_registration", "Registration revisions are immutable; use a new version")
            return registration_summary(existing)
        registration = EngineRegistrationRevision(
            owner_id=caller.id,
            namespace=namespace,
            name=name,
            version=version,
            manifest_digest=revision,
            engine_digest=engine_ref["digest"],
            document=document,
            endpoint=endpoint,
            protocol_digest=submitted_digest,
            openapi_document=submitted_openapi,
            openapi_digest=digest(submitted_openapi),
            mappings=spec.get("mappings", {}),
            auth_scheme=spec.get("auth", {}).get("scheme", "none"),
            verification_report={"protocol": "bim-engine/v1", "protocolDigest": submitted_digest, "status": "pending", "checks": []},
            publication_status="private",
            is_active=False,
        )
        try:
            async with session.begin_nested():
                session.add(registration)
                await session.flush()
        except IntegrityError:
            return _problem(409, "immutable_registration", "Registration identity already exists with different content")
        return registration_summary(registration)
    return _problem(503, "accounts_unavailable", "Registering an engine requires the accounts database")


@router.get("/engine-registrations")
async def list_engine_registrations(
    review: bool = Query(
        False,
        description="Administrators may request only registrations explicitly submitted for review.",
    ),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        if review:
            if not caller.is_admin:
                return _problem(403, "forbidden", "Only an administrator may read publication requests")
            query = select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.publication_status == "pending_review"
            )
        else:
            query = select(EngineRegistrationRevision).where(
                or_(
                    EngineRegistrationRevision.owner_id == caller.id,
                    EngineRegistrationRevision.publication_status == "published",
                )
            )
        rows = (await session.execute(query.order_by(EngineRegistrationRevision.namespace, EngineRegistrationRevision.name, EngineRegistrationRevision.version))).scalars().all()
        return {
            "registrations": [
                registration_summary(row)
                for row in rows
                if allows_engine(caller, registration_engine_reference(row) or {})
            ]
        }
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


@router.get("/engine-registrations/{name}")
async def get_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
        )
        visible = [
            EngineRegistrationRevision.owner_id == caller.id,
            EngineRegistrationRevision.publication_status == "published",
        ]
        if caller.is_admin:
            visible.append(
                EngineRegistrationRevision.publication_status == "pending_review"
            )
        query = query.where(or_(*visible))
        row = (await session.execute(query)).scalars().first()
        if row is None or not allows_engine(
            caller, registration_engine_reference(row) or {}
        ):
            return _problem(404, "not_found", "Engine registration not found")
        return row.document
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


async def _engine_document_for_registration(
    registration: EngineRegistrationRevision | Mapping[str, Any],
    session: AsyncSession | None,
) -> dict[str, Any]:
    document = (
        registration.document
        if isinstance(registration, EngineRegistrationRevision)
        else registration.get("document", {})
    )
    if not isinstance(document, Mapping):
        raise HTTPException(status_code=409, detail="EngineRegistration document is missing")
    engine = document.get("spec", {}).get("engine", {})
    if not isinstance(engine, Mapping):
        raise HTTPException(status_code=409, detail="EngineRegistration has no immutable Engine reference")
    try:
        return _manifest(
            str(engine.get("name", "")),
            namespace=str(engine.get("namespace", "")),
            version=str(engine.get("version", "")),
            manifest_digest=str(engine.get("digest", "")),
        )
    except HTTPException:
        pass
    if session is not None and isinstance(registration, EngineRegistrationRevision):
        revision = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == engine.get("namespace"),
                    EngineRevision.name == engine.get("name"),
                    EngineRevision.version == engine.get("version"),
                    EngineRevision.digest == engine.get("digest"),
                    or_(
                        EngineRevision.state == "published",
                        EngineRevision.owner_id == registration.owner_id,
                    ),
                )
            )
        ).scalars().first()
        if revision is not None:
            return revision.document
    raise HTTPException(status_code=404, detail="Engine revision not found")


async def _verify_registration_row(
    registration: EngineRegistrationRevision,
    session: AsyncSession,
) -> JSONResponse | None:
    if registration.protocol_digest != protocol_digest():
        return _problem(
            409,
            "protocol_digest_mismatch",
            "Registration protocol is no longer the pinned bim-engine/v1 contract",
        )
    try:
        engine_document = await _engine_document_for_registration(registration, session)
    except HTTPException:
        return _problem(409, "engine_revision_unavailable", "Registration Engine revision is unavailable")

    credential_value = None
    credential_row = (
        await session.execute(
            select(EngineCredential).where(
                EngineCredential.registration_id == registration.id
            )
        )
    ).scalars().first()
    if credential_row is not None:
        from ..security.secrets import CredentialStore, SecretsUnavailable

        try:
            credential_value = CredentialStore.from_settings(get_settings()).decrypt(
                credential_row.credential_encrypted
            )
        except SecretsUnavailable as exc:
            return _problem(503, "credential_store_unavailable", str(exc))

    report, openapi_document, openapi_digest = await _verify_registration(
        registration.document,
        credential_value,
        engine_document,
    )
    registration.verification_report = report
    registration.openapi_document = openapi_document
    registration.openapi_digest = openapi_digest
    if report["status"] != "verified":
        registration.is_active = False
        await session.flush()
        return _problem(
            409,
            "conformance_failed",
            "Engine registration failed its OpenAPI and response-contract checks",
            report["checks"],
        )
    registration.verified_at = utcnow()
    registration.verification_report = {
        **report,
        "verifiedAt": registration.verified_at.isoformat(),
    }
    return None


async def _notify_admins_of_engine_event(
    session: AsyncSession,
    kind: str,
    subject: str,
    body: str,
    payload: dict[str, Any],
) -> None:
    admins = (
        await session.execute(
            select(User).where(User.role == UserRole.ADMIN, User.is_active.is_(True))
        )
    ).scalars().all()
    for admin in admins:
        session.add(
            Notification(
                user_id=admin.id,
                kind=kind,
                subject=subject,
                body=body,
                payload=payload,
            )
        )


async def _change_registration(
    namespace: str,
    name: str,
    version: str,
    manifest_digest: str,
    caller: User,
    session: AsyncSession | None,
    *,
    action: str,
):
    if session is None:
        return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")
    admin_action = action in {"approve", "reject"}
    if admin_action and not caller.is_admin:
        return _problem(403, "forbidden", "Only an administrator may review publication requests")
    query = select(EngineRegistrationRevision).where(
        EngineRegistrationRevision.namespace == namespace,
        EngineRegistrationRevision.name == name,
        EngineRegistrationRevision.version == version,
        EngineRegistrationRevision.manifest_digest == manifest_digest,
    )
    if admin_action:
        query = query.where(
            EngineRegistrationRevision.publication_status == "pending_review"
        )
    else:
        query = query.where(EngineRegistrationRevision.owner_id == caller.id)
    registration = (await session.execute(query)).scalars().first()
    if registration is None:
        return _problem(404, "not_found", "Engine registration not found")
    if not allows_engine(caller, registration_engine_reference(registration) or {}):
        return _problem(404, "not_found", "Engine registration not found")

    if action == "activate":
        failure = await _verify_registration_row(registration, session)
        if failure is not None:
            return failure
        registration.is_active = True
    elif action == "deactivate":
        was_published = registration.publication_status == "published"
        registration.is_active = False
        if was_published:
            await _notify_admins_of_engine_event(
                session,
                kind="engine.deactivated",
                subject=f"Published engine paused: {registration.namespace}/{registration.name}",
                body=f"The published federated engine {registration.namespace}/{registration.name}@{registration.version} has been paused by {caller.username}.",
                payload={
                    "namespace": registration.namespace,
                    "name": registration.name,
                    "version": registration.version,
                    "digest": registration.manifest_digest,
                    "actor": caller.username,
                },
            )
    elif action == "request_publication":
        if registration.publication_status == "published":
            return registration_summary(registration)
        if not registration.is_active:
            return _problem(
                409,
                "registration_inactive",
                "Activate and verify the private registration before requesting publication",
            )
        failure = await _verify_registration_row(registration, session)
        if failure is not None:
            return failure
        registration.publication_status = "pending_review"
        await _notify_admins_of_engine_event(
            session,
            kind="engine.publication_requested",
            subject=f"Engine publication requested: {registration.namespace}/{registration.name}",
            body=f"User {caller.username} has requested publication for engine registration {registration.namespace}/{registration.name}@{registration.version}.",
            payload={
                "namespace": registration.namespace,
                "name": registration.name,
                "version": registration.version,
                "digest": registration.manifest_digest,
                "actor": caller.username,
            },
        )
    elif action == "reject":
        registration.publication_status = "rejected"
    elif action == "approve":
        failure = await _verify_registration_row(registration, session)
        if failure is not None:
            return failure
        registration.publication_status = "published"
        registration.published_at = utcnow()
        engine_ref = registration.document.get("spec", {}).get("engine", {})
        engine_revision = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == engine_ref.get("namespace"),
                    EngineRevision.name == engine_ref.get("name"),
                    EngineRevision.version == engine_ref.get("version"),
                    EngineRevision.digest == engine_ref.get("digest"),
                )
            )
        ).scalars().first()
        publications = [
            ("EngineRegistration", registration.manifest_digest),
        ]
        if engine_revision is not None:
            engine_revision.state = "published"
            publications.append(("Engine", engine_revision.digest))
        for resource_kind, resource_digest in publications:
            publication = (
                await session.execute(
                    select(ManifestPublication).where(
                        ManifestPublication.resource_kind == resource_kind,
                        ManifestPublication.resource_digest == resource_digest,
                    )
                )
            ).scalars().first()
            if publication is None:
                session.add(
                    ManifestPublication(
                        resource_kind=resource_kind,
                        resource_digest=resource_digest,
                        publisher_id=caller.id,
                        state="public",
                    )
                )
            else:
                publication.state = "public"
    else:
        raise AssertionError(f"unknown EngineRegistration action: {action}")
    await session.flush()
    return registration_summary(registration)


@router.post("/engine-registrations/{name}/approve")
async def approve_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="approve")


@router.post("/engine-registrations/{name}/reject")
async def reject_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(require_v1_admin),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="reject")


@router.post("/engine-registrations/{name}/activate")
async def activate_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="activate")


@router.post("/engine-registrations/{name}/deactivate")
async def deactivate_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="deactivate")


@router.post("/engine-registrations/{name}/publication-request")
async def request_engine_registration_publication(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Make a private registration visible to administrators for moderation."""
    return await _change_registration(namespace, name, version, manifest_digest, caller, session, action="request_publication")


@router.delete("/engine-registrations/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is None:
        return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")
    query = select(EngineRegistrationRevision).where(
        EngineRegistrationRevision.namespace == namespace,
        EngineRegistrationRevision.name == name,
        EngineRegistrationRevision.version == version,
        EngineRegistrationRevision.manifest_digest == manifest_digest,
    )
    if not caller.is_admin:
        query = query.where(EngineRegistrationRevision.owner_id == caller.id)
    registration = (await session.execute(query)).scalars().first()
    if registration is None:
        return _problem(404, "not_found", "Engine registration not found")

    was_published = registration.publication_status == "published"

    publication = (
        await session.execute(
            select(ManifestPublication).where(
                ManifestPublication.resource_kind == "EngineRegistration",
                ManifestPublication.resource_digest == registration.manifest_digest,
            )
        )
    ).scalars().first()
    if publication is not None:
        await session.delete(publication)

    if was_published:
        await _notify_admins_of_engine_event(
            session,
            kind="engine.deregistered",
            subject=f"Published engine deregistered: {registration.namespace}/{registration.name}",
            body=f"The published federated engine {registration.namespace}/{registration.name}@{registration.version} has been deregistered by {caller.username}.",
            payload={
                "namespace": registration.namespace,
                "name": registration.name,
                "version": registration.version,
                "digest": registration.manifest_digest,
                "actor": caller.username,
            },
        )

    await session.execute(
        delete(EngineCredential).where(
            EngineCredential.registration_id == registration.id
        )
    )
    await session.delete(registration)
    await session.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)



@router.get("/engine-registrations/{name}/report")
async def get_engine_registration_report(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    if session is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
        )
        visible = [
            EngineRegistrationRevision.owner_id == caller.id,
            EngineRegistrationRevision.publication_status == "published",
        ]
        if caller.is_admin:
            visible.append(
                EngineRegistrationRevision.publication_status == "pending_review"
            )
        query = query.where(or_(*visible))
        row = (await session.execute(query)).scalars().first()
        if row is None or not allows_engine(
            caller, registration_engine_reference(row) or {}
        ):
            return _problem(404, "not_found", "Engine registration not found")
        try:
            engine_document = await _engine_document_for_registration(row, session)
        except HTTPException:
            engine_document = None
        return {
            **registration_summary(row),
            "openapiDigest": row.openapi_digest,
            "openapi": row.openapi_document,
            "engine": engine_document,
            "report": row.verification_report,
        }
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


@router.put("/engine-registrations/{name}/credential")
async def set_engine_registration_credential(
    name: str,
    request: Request,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    """Replace a deployment credential without ever placing it in a manifest."""
    try:
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        payload = strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, "invalid_credential", str(exc))
    secret = payload.get("secret") if isinstance(payload, dict) else None
    if not isinstance(secret, str) or not secret:
        return _problem(422, "invalid_credential", "credential payload requires a non-empty secret")
    from ..security.secrets import CredentialStore, SecretsUnavailable

    if session is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
        )
        query = query.where(EngineRegistrationRevision.owner_id == caller.id)
        row = (await session.execute(query)).scalars().first()
        if row is None or not allows_engine(
            caller, registration_engine_reference(row) or {}
        ):
            return _problem(404, "not_found", "Engine registration not found")
        if row.publication_status == "published":
            return _problem(
                409,
                "immutable_published_registration",
                "A published registration cannot change credentials; create a new revision",
            )
        try:
            encrypted = CredentialStore.from_settings(get_settings()).encrypt(secret)
        except SecretsUnavailable as exc:
            return _problem(503, "credential_store_unavailable", str(exc))
        credential = (
            await session.execute(
                select(EngineCredential).where(EngineCredential.registration_id == row.id)
            )
        ).scalars().first()
        if credential is None:
            credential = EngineCredential(
                registration_id=row.id,
                credential_ref=f"registration:{row.manifest_digest}",
                credential_encrypted=encrypted,
            )
            session.add(credential)
        else:
            credential.credential_encrypted = encrypted
            credential.updated_at = utcnow()
        # Credentials are deployment material.  Replacing one does not mutate
        # the immutable manifest, but any previous live conformance result is no
        # longer evidence for the new authentication context.
        row.is_active = False
        row.publication_status = "private"
        row.verified_at = None
        row.published_at = None
        row.verification_report = {
            "protocol": "bim-engine/v1",
            "protocolDigest": row.protocol_digest,
            "status": "pending",
            "checks": [],
        }
        row.openapi_document = row.document["spec"]["openapi"]
        row.openapi_digest = digest(row.openapi_document)
        await session.flush()
        return registration_summary(row)
    return _problem(503, "accounts_unavailable", "Engine registrations require the accounts database")


@router.post("/instances/validate")
async def validate_legacy_instance(
    request: Request,
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        compilation = await _compile_upload(await _read_package(request), session)
    except HTTPException as exc:
        return _error_from_http(exc)
    return {
        "valid": True,
        "instanceDigest": compilation.instance_digest,
        "packageDigest": compilation.package_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
        "irDigest": compilation.ir_digest,
        "diagnostics": [],
    }


@router.post(
    "/validate",
    operation_id="validateInstance",
    summary="Validate a BIM package and find compatible engines",
)
async def validate_instance(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
        if content_type in _BIM_ZIP_TYPES:
            archive = await _read_package(request)
        else:
            body = await request.body()
            if len(body) > _max_expanded():
                return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
            payload = strict_json_loads(body)
            snapshot_id = payload.get("snapshot") if isinstance(payload, dict) else None
            if not isinstance(payload, dict) or set(payload) != {"snapshot"} or not isinstance(snapshot_id, str) or not snapshot_id:
                return _problem(
                    422,
                    "snapshot_or_package_required",
                    "BIM validation accepts an exact snapshot reference or a .bim.zip upload",
                )
            snapshot = await owned_snapshot(snapshot_id, caller, session)
            if snapshot is None:
                return _problem(404, "not_found", "Snapshot not found")
            archive = snapshot.source_archive
        compilation = await _compile_upload(archive, session, caller)
    except PackageError as exc:
        return _problem(422, "invalid_request", str(exc))
    except HTTPException as exc:
        return _error_from_http(exc)
    if caller is not None:
        try:
            caps = await entitlement_service.caps_for(caller.id)
        except EntitlementsUnavailable as exc:
            return _problem(exc.status, exc.code, str(exc))
        if entitlement_service.complexity_too_large(compilation.binding_space_log10, caps):
            return _problem(
                402,
                "instance_complexity_too_large",
                "instance binding space exceeds the caller plan limit",
            )
    spec = compilation.spec
    return {
        "valid": True,
        "instanceDigest": compilation.instance_digest,
        "packageDigest": compilation.package_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
        "irDigest": compilation.ir_digest,
        "analysis": {
            "tasks": len(spec.get("application", {}).get("tasks", [])),
            "candidates": compilation.analysis["candidates"],
            "constraints": len(spec.get("constraints", [])),
            "placement": bool(spec.get("placement")),
            "bindingSpace": str(compilation.binding_space_cardinality),
        },
        "compatibleModes": await compatible_modes(compilation.ir, caller, session),
        "diagnostics": [],
    }


@router.post("/instances", status_code=status.HTTP_201_CREATED)
async def create_snapshot(
    request: Request,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        compilation = await _compile_upload(await _read_package(request), session, caller)
    except HTTPException as exc:
        return _error_from_http(exc)
    snapshot_id = await persist_snapshot(compilation, caller, session)
    if snapshot_id is None:
        return _problem(503, "database_unavailable", "Snapshots require database")
    return {
        "id": snapshot_id,
        "kind": "InstanceSnapshot",
        "instanceDigest": compilation.instance_digest,
        "packageDigest": compilation.package_digest,
        "irDigest": compilation.ir_digest,
        "fileDigests": compilation.file_digests,
        "resourceDigests": compilation.resource_digests,
    }


@router.get("/instances/{snapshot_id}")
async def get_snapshot(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    snapshot = await owned_snapshot(snapshot_id, caller, session)
    if snapshot is None:
        return _problem(404, "not_found", "Snapshot not found")
    ir = (await session.execute(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))).scalars().first()
    return {
        "id": snapshot_id,
        "kind": "InstanceSnapshot",
        "instanceDigest": snapshot.instance_digest,
        "packageDigest": snapshot.package_digest,
        "irDigest": ir.ir_digest if ir else None,
        "fileDigests": package_file_digests(snapshot.root_document, ir.document if ir else {}),
        "resourceDigests": snapshot.resource_digests,
        "instance": snapshot.root_document,
        "createdAt": snapshot.created_at.isoformat(),
    }


@router.get("/instances/{snapshot_id}/source")
async def get_snapshot_source(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    snapshot = await owned_snapshot(snapshot_id, caller, session)
    if snapshot is None:
        return _problem(404, "not_found", "Snapshot not found")
    archive = snapshot.source_archive
    return Response(
        archive,
        media_type="application/vnd.bim+zip",
        headers={"Content-Disposition": f'attachment; filename="{snapshot_id}.bim.zip"', "Digest": f"sha-256={digest_bytes(archive).removeprefix('sha256-')}"},
    )


@router.get("/instances/{snapshot_id}/ir")
async def get_snapshot_ir(
    snapshot_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    snapshot = await owned_snapshot(snapshot_id, caller, session)
    if snapshot is None:
        return _problem(404, "not_found", "Snapshot not found")
    ir = (await session.execute(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))).scalars().first()
    if ir is None:
        return _problem(404, "not_found", "IR not found")
    return ir.document


@router.post("/jobs", status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    request: Request,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    key = request.headers.get("Idempotency-Key")
    if key is not None and key.startswith(STUDY_CELL_KEY_PREFIX):
        return _problem(
            422,
            "reserved_idempotency_key",
            f"Idempotency-Key cannot start with {STUDY_CELL_KEY_PREFIX!r}; the gateway reserves that prefix",
        )
    return await _create_job_core(request, caller, session)


async def _create_job_core(
    request: Request,
    caller: User | None,
    session: AsyncSession | None,
    *,
    commit: bool = True,
    dispatch: bool = True,
    study_cell_id: uuid.UUID | None = None,
):
    """Read, submit and dispatch a job; ``create_job`` is its HTTP face.

    The submission itself (validation, idempotency, limits, persistence) is
    ``services.job_submission``. ``commit`` and ``dispatch`` say whether to
    commit and queue the job here. Without them the job stays in the caller's
    transaction and its reservation is recorded in ``pending_launches``.
    ``study_cell_id`` is written in the job's own INSERT, so the cell and the
    job cannot be seen apart; losing the race for a cell returns the job that
    won it.
    """

    if dispatch and not commit:
        raise ValueError("a job cannot be dispatched before it is committed")
    idempotency_key = request.headers.get("Idempotency-Key")
    if idempotency_key is not None and not (1 <= len(idempotency_key) <= 255):
        return _problem(
            422,
            "invalid_idempotency_key",
            "Idempotency-Key must contain between 1 and 255 characters",
        )
    submission = await _read_job_request(request, idempotency_key)
    if isinstance(submission, JSONResponse):
        return submission
    result = await JobSubmission(
        session,
        caller,
        commit=commit,
        study_cell_id=study_cell_id,
        snapshot_persister=persist_snapshot,
    ).submit(submission)
    if dispatch and result.kind == "created":
        await dispatch_persisted_job(result.body["id"], None if db_base.is_configured() else session)
    return _job_response(result)


async def _read_job_request(request: Request, idempotency_key: str | None) -> JobSubmissionInput | JSONResponse:
    """The job request as the service takes it, or the problem that stops it at the transport."""
    try:
        content_type = (request.headers.get("content-type") or "").split(";", 1)[0].lower()
        if content_type.startswith("multipart/form-data"):
            body = await request.body()
            if len(body) > _max_compressed() + 1024 * 1024:
                return _problem(413, "payload_too_large", "multipart BIM package is too large")
            archive = _multipart_zip(body, request.headers.get("content-type", ""))
            return JobSubmissionInput({}, len(body), idempotency_key, archive=archive)
        if content_type in _BIM_ZIP_TYPES:
            archive = await _read_package(request)
            body_size = int(request.headers.get("content-length", "0") or 0)
            return JobSubmissionInput({}, body_size, idempotency_key, archive=archive)
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        payload = strict_json_loads(body)
        snapshot_id = payload.get("snapshot") if isinstance(payload, dict) else None
        if not snapshot_id:
            return _problem(
                422,
                "snapshot_or_package_required",
                "BIM v1 jobs accept an existing snapshot or a ZIP package upload",
            )
        allowed_fields = {"snapshot", "engine", "registration", "mode", "options", "optimization", "configuration"}
        if set(payload) - allowed_fields:
            return _problem(
                422,
                "invalid_request_fields",
                "job request contains fields outside the BIM v1 job contract",
            )
        return JobSubmissionInput(payload, len(body), idempotency_key, snapshot_id=snapshot_id)
    except PackageError as exc:
        return _problem(422, "invalid_request", str(exc))
    except HTTPException as exc:
        return _error_from_http(exc)


def _job_response(result: JobSubmissionResult) -> dict[str, Any] | JSONResponse:
    """A new job answers with its document (202 by the route); a replay or a problem is a response of its own."""
    if result.kind == "created":
        return result.body
    if result.kind == "replay":
        return JSONResponse(result.body, status_code=result.status, headers=result.headers or None)
    return JSONResponse(
        result.body, status_code=result.status, media_type=PROBLEM_MEDIA_TYPE, headers=result.headers or None
    )


@router.get("/jobs/{job_id}")
async def get_v1_job(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    result = {"id": job_id, "status": job.state.value, "provenance": dict(job.provenance or {})}
    if job.result is not None:
        result["result"] = job.result
        if isinstance(job.result, dict) and "error" in job.result:
            result["error"] = job.result["error"]
    return result


# A per-process bound protects the evaluator pool. No Engine or solver job is dispatched.
_ANALYSIS_SLOTS = asyncio.Semaphore(2)


@router.get(
    "/jobs/{job_id}/analysis/neighborhood",
    response_model=NeighborhoodResponse,
    summary="Evaluate bounded one-task binding alternatives",
    description="Owner-scoped counterfactual evaluation against the pinned job IR. "
                "At most 128 eligible substitutions, with a cooperative two-second budget between evaluations. "
                "Does not invoke an Engine, mutate the job, or claim global optimality.",
)
async def get_v1_job_neighborhood(
    job_id: str,
    solution_index: int = Query(0, ge=0),
    task: str | None = Query(None, max_length=256),
    limit: int = Query(64, ge=1, le=128),
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    solutions = (job.result or {}).get("solutions", [])
    if not isinstance(solutions, list) or solution_index >= len(solutions):
        return _problem(422, "invalid_solution", "Selected returned solution does not exist")
    decision = solutions[solution_index].get("decision", {})
    if decision.get("kind") != "binding" or not isinstance(decision.get("binding"), dict):
        return _problem(422, "unsupported_decision", "Analysis requires a canonical binding decision")
    document = (job.original_request or {}).get("bindingProblem")
    ir_digest = (job.provenance or {}).get("irDigest")
    if not isinstance(document, dict) and job.instance_snapshot_id is not None:
        ir = (await session.execute(select(BindingIRSnapshot).where(
            BindingIRSnapshot.snapshot_id == job.instance_snapshot_id
        ))).scalars().first()
        if ir is not None:
            if ir_digest and ir_digest != ir.ir_digest:
                return _problem(409, "analysis_unavailable", "Job and snapshot IR identities disagree")
            document = ir.document
    if not isinstance(document, dict) or document.get("kind") != "BindingProblem":
        return _problem(409, "analysis_unavailable", "The pinned BindingProblem is unavailable")
    if _ANALYSIS_SLOTS.locked():
        return _problem(429, "analysis_busy", "The analysis evaluator is busy; retry shortly")
    # Compare under the job's execution optimization, as the gateway re-evaluation did.
    execution = (job.original_request or {}).get("optimization") or (job.provenance or {}).get("optimization")
    if not isinstance(execution, dict):
        execution = None
    async with _ANALYSIS_SLOTS:
        try:
            result = await bim.abim().neighborhood(
                document, decision["binding"], task=task, limit=limit, execution=execution
            )
        except (ValueError, ArithmeticError) as exc:
            return _problem(422, "analysis_invalid", str(exc)[:300])
    return {"jobId": job_id, "solutionIndex": solution_index, **result}


@router.get("/jobs/{job_id}/ir")
async def get_v1_job_ir(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    document = (job.original_request or {}).get("bindingProblem")
    if not isinstance(document, dict) and job.instance_snapshot_id is not None:
        ir = (await session.execute(select(BindingIRSnapshot).where(
            BindingIRSnapshot.snapshot_id == job.instance_snapshot_id
        ))).scalars().first()
        if ir is not None:
            if (job.provenance or {}).get("irDigest") not in (None, ir.ir_digest):
                return _problem(409, "analysis_unavailable", "Job and snapshot IR identities disagree")
            document = ir.document
    if not isinstance(document, dict):
        return _problem(404, "not_found", "BindingProblem not found")
    return document


@router.get("/jobs/{job_id}/instance")
async def get_v1_job_instance(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    if job.instance_snapshot_id is None:
        return _problem(404, "not_found", "Instance snapshot not found")
    snapshot = (
        await session.execute(
            select(InstanceSnapshot).where(
                InstanceSnapshot.id == job.instance_snapshot_id,
                InstanceSnapshot.owner_id == caller.id,
            )
        )
    ).scalars().first()
    if snapshot is None:
        return _problem(404, "not_found", "Instance snapshot not found")
    ir = (await session.execute(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))).scalars().first()
    return {
        "id": str(snapshot.id),
        "instanceDigest": snapshot.instance_digest,
        "packageDigest": snapshot.package_digest,
        "fileDigests": package_file_digests(snapshot.root_document, ir.document if ir else {}),
        "resourceDigests": snapshot.resource_digests,
        "instance": snapshot.root_document,
    }


@router.get("/jobs/{job_id}/report")
async def get_v1_job_report(
    job_id: str,
    caller: User | None = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    job = await owned_job(job_id, caller, session)
    if job is None:
        return _problem(404, "not_found", "Job not found")
    result = job.result or {}
    provenance = job.provenance or {}
    return {
        "id": job_id,
        "gatewayEvaluation": {
            "termination": result.get("termination"),
            "solutions": result.get("solutions", []),
        },
        "remote": result.get("provenance", {}).get("engineReported", {}),
        "provenance": provenance,
    }
