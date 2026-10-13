"""Engine manifests, registrations and the compatibility of a problem with an Engine mode.

Whether an Engine mode can run an IR, and which options and optimization it accepts, is decided by
the toolchain (``integrations.bim``: ``compatibility`` and ``resolve_optimization``). What stays here is
the platform's own: the catalog of manifests, who may see and run which revision, registrations and
the contract persisted with a job.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any, Mapping, NamedTuple

import jsonschema
from bim_core import ContractError
from bim_core.canonical import digest
from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import get_settings
from ..db.models import EngineRegistrationRevision, EngineRevision, Job, User
from ..integrations import bim
from ..integrations.bim_host import engine_contract_diagnostics  # noqa: F401 - the platform's name for it
from ..security.apikeys import allows_engine
from ..v1.remote import RemoteEngineError, RemoteRegistration
from .probe import probe_ir


def schema_root() -> Path:
    """``schemas/bim/v1`` of this deployment: the Engine manifests of the catalog live under it."""
    configured = os.environ.get("SCHEMAS_DIR")
    if configured:
        return Path(configured) / "bim" / "v1"
    return Path(__file__).parents[4] / "schemas" / "bim" / "v1"


#: Built-in registrations installed in this process.  ``routes.v1`` shares this very dict.
BUILTIN_REGISTRATIONS: dict[tuple[str, str, str, str], dict[str, Any]] = {}
#: The catalog of built-in Engine manifests (the language's schemas are the toolchain's, not read from here).
MANIFEST_DIR = schema_root() / "manifests"


def protocol_document() -> dict[str, Any]:
    """The ``bim-engine/v1`` OpenAPI contract, as the toolchain serves it."""
    return bim.protocol_document()


def protocol_digest() -> str:
    """Identity of the ``bim-engine/v1`` contract (the OpenAPI plus the IR schema it points at)."""
    return bim.protocol_digest()


BUILTIN_ENGINE_MAPPINGS = {
    "request": "/internal/v1/binding-problems",
    "job": "/internal/v1/jobs/{id}",
    "health": "/health",
    "openapi": "/openapi.json",
}


def builtin_engine_registration(
    manifest: dict[str, Any],
    endpoint: str,
) -> dict[str, Any]:
    """Install the immutable deployment contract for one bundled Engine.

    Bundled engines are deployments too.  Their registration is generated
    from the exact Engine revision and process configuration, so an endpoint
    or protocol change creates a new immutable reference instead of silently
    changing the meaning of an existing job.  The returned runtime marker is
    deliberately outside the public document: only this installer can grant
    access to trusted internal HTTP endpoints.
    """

    engine_reference = engine_ref(manifest, "bim.builtin")
    installation = {
        "engine": engine_reference,
        "endpoint": endpoint,
        "protocol": {
            "id": "bim-engine/v1",
            "mediaType": "application/json",
            "digest": protocol_digest(),
        },
        "mappings": dict(BUILTIN_ENGINE_MAPPINGS),
        "auth": {"scheme": "none"},
        "openapi": {
            **protocol_document(),
            "x-bim-protocol": "bim-engine/v1",
            "x-bim-protocol-digest": protocol_digest(),
        },
    }
    installation_digest = digest(installation).removeprefix("sha256-")
    engine_version = str(engine_reference["version"]).split("+", 1)[0]
    document = {
        "apiVersion": "bim/v1",
        "kind": "EngineRegistration",
        "metadata": {
            "namespace": "bim.builtin",
            "name": f"{engine_reference['name']}-deployment",
            "version": f"{engine_version}+builtin.{installation_digest}",
        },
        "spec": installation,
    }
    registration_ref = {
        "namespace": document["metadata"]["namespace"],
        "name": document["metadata"]["name"],
        "version": document["metadata"]["version"],
        "digest": digest(document),
    }
    key = tuple(registration_ref[field] for field in ("namespace", "name", "version", "digest"))
    installed = {
        **registration_ref,
        "document": document,
        "publicationStatus": "published",
        "active": True,
        "installedBuiltin": True,
        "allowInternalHttp": True,
    }
    existing = BUILTIN_REGISTRATIONS.get(key)
    if existing is not None:
        if existing != installed:
            raise RuntimeError("built-in EngineRegistration identity is immutable")
        return existing
    BUILTIN_REGISTRATIONS[key] = installed
    return installed


def installed_builtin_registration(
    manifest: dict[str, Any],
    endpoint: str | None,
    registration_ref: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Resolve an exact installed bundled registration, never user input."""

    if not isinstance(endpoint, str) or not endpoint:
        return None
    metadata = manifest.get("metadata", {})
    name = metadata.get("name")
    if not isinstance(name, str):
        return None
    path = MANIFEST_DIR / f"{name}.json"
    try:
        installed_manifest = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    if digest(installed_manifest) != digest(manifest):
        return None
    installed = builtin_engine_registration(installed_manifest, endpoint)
    if registration_ref is not None and any(
        registration_ref.get(field) != installed[field]
        for field in ("namespace", "name", "version", "digest")
    ):
        return None
    return installed


def manifest(
    name: str,
    *,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
) -> dict[str, Any]:
    candidates = []
    path = MANIFEST_DIR / f"{name}.json"
    try:
        builtin = json.loads(path.read_text(encoding="utf-8"))
        builtin_namespace = builtin.get("metadata", {}).get("namespace")
        builtin_version = builtin.get("metadata", {}).get("version")
        if (
            (namespace is None or builtin_namespace == namespace)
            and (version is None or builtin_version == version)
            and (manifest_digest is None or digest(builtin) == manifest_digest)
        ):
            candidates.append(builtin)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    if not candidates:
        raise HTTPException(status_code=404, detail=f"Unknown v1 engine: {name}")
    if len(candidates) > 1:
        raise HTTPException(status_code=409, detail=f"Engine identity is ambiguous; pin namespace, version, and digest: {name}")
    return candidates[0]


async def manifest_async(
    name: str,
    session: AsyncSession | None = None,
    *,
    caller: User | None = None,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
) -> dict[str, Any]:
    """Resolve a built-in, public, or caller-owned private Engine revision."""
    try:
        document = manifest(
            name,
            namespace=namespace,
            version=version,
            manifest_digest=manifest_digest,
        )
        document_namespace = document.get("metadata", {}).get("namespace") or "bim.builtin"
        if namespace and document_namespace != namespace:
            raise HTTPException(status_code=404, detail=f"Unknown Engine namespace: {namespace}")
        if version and document.get("metadata", {}).get("version") != version:
            raise HTTPException(status_code=404, detail=f"Unknown Engine revision: {name}@{version}")
        if manifest_digest and digest(document) != manifest_digest:
            raise HTTPException(status_code=404, detail=f"Unknown Engine digest: {manifest_digest}")
        return document
    except HTTPException:
        if session is not None:
            query = select(EngineRevision).where(EngineRevision.name == name)
            if caller is None:
                query = query.where(EngineRevision.state == "published")
            else:
                query = query.where(
                    or_(
                        EngineRevision.state == "published",
                        EngineRevision.owner_id == caller.id,
                    )
                )
            if namespace:
                query = query.where(EngineRevision.namespace == namespace)
            if version:
                query = query.where(EngineRevision.version == version)
            if manifest_digest:
                query = query.where(EngineRevision.digest == manifest_digest)
            revision = (await session.execute(query.order_by(EngineRevision.created_at.desc()))).scalars().first()
            if revision is not None:
                return revision.document
        raise


#: The document kinds whose shape the platform checks itself (before anything is compiled).
SCHEMA_KINDS = (
    "Instance",
    "Profile",
    "Application",
    "CandidateCatalog",
    "ConstraintSet",
    "Optimization",
    "RoutingOverlay",
    "Placement",
    "Engine",
    "Dialect",
    "EngineRegistration",
)


def schema_diagnostics(document: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    if kind not in SCHEMA_KINDS:
        return []
    try:
        schema = bim.schema_document(kind)
    except ContractError as exc:
        return [{"code": "schema_unavailable", "message": exc.message}]
    validator = jsonschema.Draft202012Validator(schema)
    return [{"code": "schema", "message": error.message, "pointer": "/" + "/".join(str(part) for part in error.path)} for error in validator.iter_errors(document)]


def embedded_secret_paths(value: Any, pointer: str = "") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = "".join(character for character in str(key).casefold() if character.isalnum())
            child_pointer = f"{pointer}/{key}"
            # OpenAPI documents routinely describe fields named token,
            # password or apiKey. Those are schema names, not embedded values.
            if child_pointer == "/spec/openapi":
                continue
            if any(marker in normalized for marker in ("secret", "password", "token", "credential", "apikey")):
                paths.append(child_pointer)
            paths.extend(embedded_secret_paths(child, child_pointer))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(embedded_secret_paths(child, f"{pointer}/{index}"))
    return paths


class EngineSelection(NamedTuple):
    """An Engine revision, the mode chosen on it and what the toolchain said about running an IR with it."""

    manifest: dict[str, Any]
    mode: dict[str, Any]
    options: dict[str, Any]
    #: ``None`` when no IR was given: the question was only about the options.
    compatible: bool | None
    diagnostics: list[dict[str, Any]]


async def select_engine(
    name: str,
    requested: str | None,
    supplied: Any,
    session: AsyncSession | None = None,
    *,
    caller: User | None = None,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
    ir: Mapping[str, Any] | None = None,
) -> EngineSelection:
    """Find an Engine revision and ask the toolchain to resolve a mode and its options on it.

    The toolchain rejects, as ``422`` with a code of its own, a manifest whose declarations its
    Profile does not accept (``engine_contract_invalid``), a mode the Engine does not have
    (``engine_mode_incompatible``) and options that are unknown, mistyped, out of range or above a
    limit of the mode (``invalid_option``, ``unknown_option``, ``option_limit``). With ``ir`` it also
    says whether the mode can run that IR; without one the options are resolved against a built-in
    probe IR and ``compatible`` is ``None``.
    """
    engine_document = await manifest_async(
        name,
        session,
        caller=caller,
        namespace=namespace,
        version=version,
        manifest_digest=manifest_digest,
    )
    subject = ir if ir is not None else await probe_ir()
    object_options = isinstance(supplied, dict)
    try:
        answer = await bim.abim().compatibility(
            subject, engine_document, mode=requested, options=supplied if object_options else None
        )
    except ContractError as exc:
        raise bim.http_exception_for(exc) from exc
    if not object_options:
        # The toolchain takes options as an object or not at all: anything else is refused here, after
        # the Engine and its mode, as the platform always did.
        message = "engine options must be a JSON object"
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_option",
                "diagnostics": [{"code": "option_type", "message": message, "pointer": "/options"}],
            },
        )
    modes = engine_document.get("spec", {}).get("modes", [])
    mode = next(item for item in modes if item.get("id") == answer["mode"]["id"])
    if ir is None:
        return EngineSelection(engine_document, mode, answer["options"], None, [])
    return EngineSelection(engine_document, mode, answer["options"], answer["compatible"], answer["diagnostics"])


async def engine_mode(
    name: str,
    requested: str | None,
    supplied: Any,
    session: AsyncSession | None = None,
    *,
    caller: User | None = None,
    namespace: str | None = None,
    version: str | None = None,
    manifest_digest: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """``(manifest, mode, effective options)`` of an Engine mode, without an IR to run."""
    selection = await select_engine(
        name,
        requested,
        supplied,
        session,
        caller=caller,
        namespace=namespace,
        version=version,
        manifest_digest=manifest_digest,
    )
    return selection.manifest, selection.mode, selection.options


async def validate_engine_result(payload: object) -> None:
    """Refuse an engine answer that is not shaped like a ``bim-engine/v1`` result (``RemoteEngineError``).

    The shape is the toolchain's to judge; the transport (``v1.remote``) only carries the answer
    and calls this before it hands the answer on.
    """
    check = await bim.abim().validate_result(payload)
    if not check["valid"]:
        raise RemoteEngineError(check["error"]["message"])


def engine_ref(document: dict[str, Any], namespace: str | None = None) -> dict[str, str]:
    metadata = document.get("metadata", {})
    resolved_namespace = namespace or metadata.get("namespace") or "bim.builtin"
    return {
        "namespace": resolved_namespace,
        "name": metadata["name"],
        "version": metadata.get("version", "1.0.0"),
        "digest": digest(document),
    }


async def available_engine_documents(
    session: AsyncSession | None,
    caller: User | None = None,
) -> list[tuple[dict[str, Any], str | None]]:
    documents: list[tuple[dict[str, Any], str | None]] = []
    for path in sorted(MANIFEST_DIR.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        documents.append((doc, "bim.builtin"))
    if session is not None:
        query = select(EngineRevision)
        if caller is None:
            query = query.where(EngineRevision.state == "published")
        else:
            query = query.where(
                or_(
                    EngineRevision.state == "published",
                    EngineRevision.owner_id == caller.id,
                )
            )
        revisions = (
            await session.execute(
                query.order_by(EngineRevision.name, EngineRevision.created_at.desc())
            )
        ).scalars().all()
        documents.extend((revision.document, revision.namespace) for revision in revisions)
    unique: dict[tuple[str, str, str, str], tuple[dict[str, Any], str | None]] = {}
    for document, namespace in documents:
        reference = engine_ref(document, namespace)
        key = (reference["namespace"], reference["name"], reference["version"], reference["digest"])
        unique[key] = (document, namespace)
    return list(unique.values())


def registration_engine_reference(
    registration: EngineRegistrationRevision | Mapping[str, Any],
) -> dict[str, str] | None:
    document = (
        registration.document
        if isinstance(registration, EngineRegistrationRevision)
        else registration.get("document")
    )
    if not isinstance(document, Mapping):
        return None
    engine = document.get("spec", {}).get("engine")
    if (
        not isinstance(engine, Mapping)
        or set(engine) != {"namespace", "name", "version", "digest"}
        or not all(isinstance(engine.get(field), str) and engine.get(field) for field in engine)
    ):
        return None
    return {field: str(engine[field]) for field in ("namespace", "name", "version", "digest")}


async def engine_document_for_registration(
    registration: EngineRegistrationRevision | Mapping[str, Any],
    session: AsyncSession | None,
) -> dict[str, Any]:
    """The Engine revision a registration pins: a bundled manifest or a stored revision its owner may use.

    ``HTTPException`` (409 for a malformed registration, 404 when the revision is gone) otherwise.
    """
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
        return manifest(
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


async def visible_engine_registrations(
    engine_reference: dict[str, str],
    engine_document: dict[str, Any],
    caller: User | None,
    session: AsyncSession | None,
) -> list[EngineRegistrationRevision | dict[str, Any]]:
    """Return only installed deployments the caller can execute exactly.

    Compatibility is an execution claim, not merely an IR feature match.  A
    mode therefore becomes selectable only through an active registration
    whose immutable Engine reference is byte-for-byte the analyzed revision.
    Multiple deployments stay as separate choices instead of being collapsed
    into an ambiguous engine/mode pair.
    """

    if caller is not None and not allows_engine(caller, engine_reference):
        return []

    candidates: list[EngineRegistrationRevision | dict[str, Any]] = []
    if caller is not None:
        installed_builtin = installed_builtin_registration(
            engine_document,
            get_settings().engine_urls.get(engine_reference["name"]),
        )
        if installed_builtin is not None:
            candidates.append(installed_builtin)

    if session is not None:
        if caller is not None:
            query = select(EngineRegistrationRevision).where(
                EngineRegistrationRevision.engine_digest == engine_reference["digest"],
                or_(
                    (
                        (EngineRegistrationRevision.owner_id == caller.id)
                        & EngineRegistrationRevision.is_active.is_(True)
                    ),
                    (
                        (EngineRegistrationRevision.owner_id != caller.id)
                        & (
                            EngineRegistrationRevision.publication_status
                            == "published"
                        )
                    ),
                ),
            )
            candidates.extend((await session.execute(query)).scalars().all())

    exact: dict[
        tuple[str, str, str, str],
        EngineRegistrationRevision | dict[str, Any],
    ] = {}
    for registration in candidates:
        if registration_engine_reference(registration) != engine_reference:
            continue
        reference = registration_reference(registration)
        key = tuple(reference[field] for field in ("namespace", "name", "version", "digest"))
        exact[key] = registration
    return [exact[key] for key in sorted(exact)]


async def mode_diagnostics(
    ir: Mapping[str, Any], document: Mapping[str, Any], mode_id: str
) -> list[dict[str, Any]]:
    """Why ``mode_id`` of an Engine revision cannot run ``ir`` (``[]`` if it can), as the toolchain says."""
    try:
        answer = await bim.abim().compatibility(ir, document, mode=mode_id)
    except ContractError as exc:
        return exc.diagnostics or [{"code": exc.code, "message": exc.message}]
    return answer["diagnostics"]


async def compatible_modes(
    ir: Mapping[str, Any],
    caller: User | None,
    session: AsyncSession | None,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for document, namespace in await available_engine_documents(session, caller):
        reference = engine_ref(document, namespace)
        registrations = await visible_engine_registrations(
            reference,
            document,
            caller,
            session,
        )
        if not registrations:
            continue
        for mode in document.get("spec", {}).get("modes", []):
            if not isinstance(mode, dict) or not isinstance(mode.get("id"), str):
                continue
            diagnostics = await mode_diagnostics(ir, document, mode["id"])
            for registration in registrations:
                result.append(
                    {
                        "engine": reference,
                        "registration": registration_reference(registration),
                        "mode": mode["id"],
                        "compatible": not diagnostics,
                        "diagnostics": diagnostics,
                    }
                )
    return sorted(
        result,
        key=lambda item: (
            item["engine"]["namespace"],
            item["engine"]["name"],
            item["engine"]["version"],
            item["mode"],
            item["registration"]["namespace"],
            item["registration"]["name"],
            item["registration"]["version"],
            item["registration"]["digest"],
        ),
    )


async def owned_job(job_id: str, caller: User | None, session: AsyncSession | None):
    if session is None:
        return None
    try:
        parsed = uuid.UUID(job_id)
    except ValueError:
        return None
    if caller is None:
        return None
    job = (
        await session.execute(
            select(Job).where(Job.id == parsed, Job.owner_id == caller.id)
        )
    ).scalars().first()
    if job is None:
        return None
    provenance = job.provenance if isinstance(job.provenance, dict) else {}
    if not allows_engine(caller, provenance.get("engine", {})):
        return None
    return job


async def registration_for_engine(
    namespace: str | None,
    name: str | None,
    version: str | None,
    manifest_digest: str | None,
    caller: User | None,
    session: AsyncSession | None,
) -> EngineRegistrationRevision | dict[str, Any] | None:
    if name is None:
        return None
    if not all(
        isinstance(value, str) and value
        for value in (namespace, name, version, manifest_digest)
    ):
        return None
    if session is not None and caller is not None:
        query = select(EngineRegistrationRevision).where(
            EngineRegistrationRevision.namespace == namespace,
            EngineRegistrationRevision.name == name,
            EngineRegistrationRevision.version == version,
            EngineRegistrationRevision.manifest_digest == manifest_digest,
            or_(
                (
                    (EngineRegistrationRevision.owner_id == caller.id)
                    & EngineRegistrationRevision.is_active.is_(True)
                ),
                (
                    (EngineRegistrationRevision.owner_id != caller.id)
                    & (
                        EngineRegistrationRevision.publication_status == "published"
                    )
                ),
            ),
        )
        return (await session.execute(query)).scalars().first()
    return None


def registration_reference(registration: Mapping[str, Any]) -> dict[str, str]:
    if isinstance(registration, EngineRegistrationRevision):
        return {
            "namespace": registration.namespace,
            "name": registration.name,
            "version": registration.version,
            "digest": registration.manifest_digest,
        }
    document = registration.get("document", {})
    metadata = document.get("metadata", {}) if isinstance(document, Mapping) else {}
    return {
        "namespace": str(registration.get("namespace", metadata.get("namespace"))),
        "name": str(registration.get("name", metadata.get("name"))),
        "version": str(registration.get("version", metadata.get("version"))),
        "digest": str(registration.get("digest")),
    }


def registration_summary(
    registration: EngineRegistrationRevision | Mapping[str, Any],
) -> dict[str, Any]:
    reference = registration_reference(registration)
    if isinstance(registration, EngineRegistrationRevision):
        publication_status = registration.publication_status
        active = registration.is_active
    else:
        publication_status = str(
            registration.get("publicationStatus", registration.get("state", "private"))
        )
        active = bool(registration.get("active", False))
    return {
        **reference,
        "status": publication_status,
        "active": active,
    }


def is_installed_builtin_registration(registration: Mapping[str, Any]) -> bool:
    reference = registration_reference(registration)
    key = tuple(reference[field] for field in ("namespace", "name", "version", "digest"))
    installed = BUILTIN_REGISTRATIONS.get(key)
    return bool(
        installed is not None
        and installed.get("installedBuiltin") is True
        and installed.get("document") == registration.get("document")
    )


def registration_transport(
    registration: Mapping[str, Any],
    credential: str | None = None,
) -> RemoteRegistration:
    document = registration.get("document")
    if not isinstance(document, Mapping):
        raise RemoteEngineError("installed EngineRegistration document is missing")
    spec = document.get("spec")
    if not isinstance(spec, Mapping):
        raise RemoteEngineError("installed EngineRegistration spec is missing")
    endpoint = spec.get("endpoint")
    if not isinstance(endpoint, str):
        raise RemoteEngineError("installed EngineRegistration endpoint is missing")
    return RemoteRegistration(
        endpoint=endpoint,
        mappings=dict(spec.get("mappings", {})),
        auth_scheme=spec.get("auth", {}).get("scheme", "none"),
        credential=credential,
        allow_internal_http=(
            is_installed_builtin_registration(registration)
            or not get_settings().federation_require_https
        ),
    )


def mode_execution_contract(mode: Mapping[str, Any]) -> dict[str, Any]:
    guarantees = mode.get("guarantees", {})
    terminations = guarantees.get("termination", []) if isinstance(guarantees, Mapping) else []
    return {
        "id": mode.get("id"),
        "terminationGuarantees": list(terminations) if isinstance(terminations, list) else [],
    }


def persisted_mode_contract(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or set(value) != {"id", "terminationGuarantees"}:
        return None
    mode_id = value.get("id")
    terminations = value.get("terminationGuarantees")
    if (
        not isinstance(mode_id, str)
        or not mode_id
        or not isinstance(terminations, list)
        or not terminations
        or any(
            item not in {"OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"}
            for item in terminations
        )
        or len(set(terminations)) != len(terminations)
    ):
        return None
    return {"id": mode_id, "terminationGuarantees": list(terminations)}


async def persisted_engine_contract(
    engine_name: str,
    reference: Any,
    mode: dict[str, Any],
    session: AsyncSession,
    owner_id: uuid.UUID | None = None,
) -> dict[str, Any] | None:
    """Resolve the pinned Engine and re-authorize its stored mode guarantees."""

    if (
        not isinstance(reference, dict)
        or set(reference) != {"namespace", "name", "version", "digest"}
        or reference.get("name") != engine_name
        or not all(isinstance(value, str) and value for value in reference.values())
    ):
        return None
    engine_document: dict[str, Any] | None
    try:
        engine_document = manifest(
            engine_name,
            namespace=reference["namespace"],
            version=reference["version"],
            manifest_digest=reference["digest"],
        )
    except HTTPException:
        revision = (
            await session.execute(
                select(EngineRevision).where(
                    EngineRevision.namespace == reference["namespace"],
                    EngineRevision.name == reference["name"],
                    EngineRevision.version == reference["version"],
                    EngineRevision.digest == reference["digest"],
                    or_(
                        EngineRevision.state == "published",
                        EngineRevision.owner_id == owner_id,
                    ),
                )
            )
        ).scalars().first()
        engine_document = revision.document if revision is not None else None
    if engine_document is None or digest(engine_document) != reference["digest"]:
        return None
    selected = next(
        (
            item
            for item in engine_document.get("spec", {}).get("modes", [])
            if isinstance(item, Mapping) and item.get("id") == mode["id"]
        ),
        None,
    )
    if selected is None or mode_execution_contract(selected) != mode:
        return None
    return engine_document
