"""The public BIM v1 API exposed by the OpenBinding platform.

This router intentionally deals in snapshots and canonical IR. It never passes
a source ZIP to an engine: engines receive only the compiled BindingProblem.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from email.parser import BytesParser
from email.policy import default as email_policy
from typing import Any, Mapping

from ..models.analysis import NeighborhoodResponse
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import optional_session, require_v1_admin, solve_caller
from ..core.settings import get_settings
from ..db import base as db_base
from ..db.models import (
    BindingIRSnapshot,
    DialectRevision,
    EngineRegistrationRevision,
    EngineRevision,
    InstanceSnapshot,
    ManifestPublication,
    RegisteredResourceRevision,
    User,
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
    resource_schema_diagnostics,
)
from ..v1.remote import fetch_remote_document, solve_remote, validate_endpoint

from ..v1.remote import RemoteEngineError as RemoteEngineError  # re-exported for the tests
from ..services import engine_registry
from ..services.engine_registry import RegistrationKey
from ..services.engines import (
    MANIFEST_DIR,
    available_engine_documents,
    compatible_modes,
    embedded_secret_paths,
    engine_ref,
    owned_job,
    protocol_digest,
    protocol_document,
    registration_summary,
    schema_diagnostics,
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


# The conformance helpers live in ``services.engine_registry``; the tests reach them through this module.
_assert_operation_auth = engine_registry.assert_operation_auth
_assert_protocol_schema = engine_registry.assert_protocol_schema
_conformance_optimization = engine_registry.conformance_optimization
_conformance_shape = engine_registry.conformance_shape
_operation_schema = engine_registry.operation_schema


async def _verify_registration(
    document: dict[str, Any],
    credential: str | None,
    engine: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
    """``engine_registry.verify_registration`` over this module's transport and settings.

    The names are looked up here on every call, so replacing ``fetch_remote_document``, ``solve_remote`` or
    ``get_settings`` on this module (as the tests do) keeps working.
    """
    return await engine_registry.verify_registration(
        document,
        credential,
        engine,
        settings=get_settings(),
        fetch=fetch_remote_document,
        solve=solve_remote,
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


async def _read_json_body(request: Request, invalid_code: str) -> Any | JSONResponse:
    """The JSON body of a registry request, within the expanded-document limit, or the problem to answer."""
    try:
        body = await request.body()
        if len(body) > _max_expanded():
            return _problem(413, "payload_too_large", f"request body exceeds {_max_expanded()} bytes")
        return strict_json_loads(body)
    except PackageError as exc:
        return _problem(422, invalid_code, str(exc))


def _registry_problem(exc: engine_registry.RegistryProblem) -> JSONResponse:
    return _problem(exc.status, exc.code, exc.detail, exc.diagnostics)


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
    document = await _read_json_body(request, "invalid_engine")
    if isinstance(document, JSONResponse):
        return document
    try:
        return await engine_registry.create_engine_revision(document, caller, session)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


@router.post("/engine-registrations", status_code=status.HTTP_201_CREATED)
async def register_engine(
    request: Request,
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    document = await _read_json_body(request, "invalid_registration")
    if isinstance(document, JSONResponse):
        return document
    try:
        return await engine_registry.register_engine(
            document, caller, session, settings=get_settings(), validate=validate_endpoint
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


@router.get("/engine-registrations")
async def list_engine_registrations(
    review: bool = Query(
        False,
        description="Administrators may request only registrations explicitly submitted for review.",
    ),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    try:
        return await engine_registry.list_registrations(caller, session, review=review)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


@router.get("/engine-registrations/{name}")
async def get_engine_registration(
    name: str,
    namespace: str = Query(...),
    version: str = Query(...),
    manifest_digest: str = Query(..., alias="digest"),
    caller: User = Depends(solve_caller),
    session: AsyncSession | None = Depends(optional_session, scope="function"),
):
    key = RegistrationKey(namespace, name, version, manifest_digest)
    try:
        return await engine_registry.read_registration(key, caller, session)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


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
    try:
        return await engine_registry.change_registration(
            RegistrationKey(namespace, name, version, manifest_digest),
            caller,
            session,
            action=action,
            settings=get_settings(),
            verify=_verify_registration,
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


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
    try:
        await engine_registry.delete_registration(
            RegistrationKey(namespace, name, version, manifest_digest), caller, session
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)
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
    key = RegistrationKey(namespace, name, version, manifest_digest)
    try:
        return await engine_registry.registration_report(key, caller, session)
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


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
    payload = await _read_json_body(request, "invalid_credential")
    if isinstance(payload, JSONResponse):
        return payload
    secret = payload.get("secret") if isinstance(payload, dict) else None
    if not isinstance(secret, str) or not secret:
        return _problem(422, "invalid_credential", "credential payload requires a non-empty secret")
    try:
        return await engine_registry.set_credential(
            RegistrationKey(namespace, name, version, manifest_digest),
            secret,
            caller,
            session,
            settings=get_settings(),
        )
    except engine_registry.RegistryProblem as exc:
        return _registry_problem(exc)


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
