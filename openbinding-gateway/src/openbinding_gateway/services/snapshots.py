"""Compile an Instance package and persist it as an immutable snapshot.

The compilation itself is the toolchain's (``integrations.bim``). What the platform keeps of one is a
``Compilation``: the package bytes, the IR as the plain document the toolchain returned, and the
identities and analysis that came with it. No language object crosses this module.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from functools import cached_property
from typing import Any, Mapping, NamedTuple

from bim_core import BimError, CompileError, PackageError
from bim_core.canonical import digest, digest_bytes
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.jsonio import strict_json_loads
from ..core.logging import redact
from ..domain.binding_space import BindingSpace, decimal_digits
from ..models.problem import split_detail
from ..db.models import (
    BindingIRSnapshot,
    InstanceResource,
    InstanceSnapshot,
    Job,
    RegisteredResourceRevision,
    User,
)
from ..integrations import bim, packages
from ..integrations.bim_host import dialect_type_matches


class RegisteredResource(NamedTuple):
    """The exact bytes of an approved registry resource that an Instance pins."""

    content: bytes
    media_type: str
    version_manifest: dict[str, Any] | None = None


RegisteredKey = tuple[str, str, str, str]

#: Registered resources uploaded to this process (no database), keyed by
#: (namespace, name, version, digest).  ``routes.v1`` shares this very dict.
CUSTOM_RESOURCES: dict[RegisteredKey, RegisteredResource] = {}


def ir_analysis(ir: Mapping[str, Any]) -> dict[str, Any]:
    """The size of the binding space of a stored IR, in the shape of ``CompileResult.analysis``.

    A fresh compilation brings its own analysis; this is for a snapshot read back from the
    database, where only the IR document is kept. It reads the eligibility matrix of the IR
    (a published interchange format) and nothing else; ``tests/test_bim_port_integration.py``
    checks it against the toolchain's.
    """
    spec = ir.get("spec", {}) if isinstance(ir, Mapping) else {}
    tasks = spec.get("application", {}).get("tasks", {})
    eligibility = spec.get("eligibility", {})
    breakdown = (
        {
            task_id: len(eligibility.get(task_id, []))
            for task_id, task in sorted(tasks.items())
            if isinstance(task, dict) and task.get("kind") == "service"
        }
        if isinstance(tasks, dict) and isinstance(eligibility, dict)
        else {}
    )
    cardinality = 1
    for count in breakdown.values():
        cardinality *= count
    log10 = 0.0 if not breakdown or 0 in breakdown.values() else float(sum(math.log10(c) for c in breakdown.values()))
    catalogs = spec.get("candidates", {})
    candidates = sum(
        len(catalog.get("candidates", {}))
        for catalog in catalogs.values()
        if isinstance(catalog, dict) and isinstance(catalog.get("candidates"), dict)
    ) if isinstance(catalogs, dict) else 0
    return {
        "bindingSpaceLog10": log10,
        "bindingSpaceCardinality": decimal_digits(cardinality),
        "bindingSpaceBreakdown": breakdown,
        "serviceTasks": len(breakdown),
        "candidates": candidates,
    }


def package_file_digests(instance: Mapping[str, Any] | None, ir: Mapping[str, Any]) -> dict[str, str]:
    """Digest of every file of a package: ``instance.json`` and each resource stored at a path.

    The toolchain refuses an entry the Instance does not declare, so these are all the files.
    """
    resources = ir.get("spec", {}).get("instance", {}).get("resources", {})
    digests = {
        item["path"]: item["digest"]
        for item in (resources.values() if isinstance(resources, dict) else ())
        if isinstance(item, dict) and isinstance(item.get("path"), str) and isinstance(item.get("digest"), str)
    }
    if instance is not None:
        digests["instance.json"] = digest(instance)
    return dict(sorted(digests.items()))


@dataclass(frozen=True)
class Compilation:
    """One compilation, as the platform keeps it: the package and what the toolchain said about it."""

    archive: bytes
    ir: dict[str, Any]
    ir_digest: str
    instance_digest: str | None
    package_digest: str
    compilation_digest: str
    source_map: dict[str, Any]
    analysis: dict[str, Any]
    toolchain: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_result(cls, archive: bytes, result: Mapping[str, Any]) -> "Compilation":
        ir = result["ir"]
        return cls(
            archive=archive,
            ir=ir,
            ir_digest=result["irDigest"],
            instance_digest=result.get("instanceDigest"),
            package_digest=result["packageDigest"],
            compilation_digest=result["compilationDigest"],
            source_map=result.get("sourceMap") or {},
            analysis=result.get("analysis") or ir_analysis(ir),
            toolchain=dict(result.get("toolchain") or {}),
        )

    @property
    def spec(self) -> dict[str, Any]:
        return self.ir["spec"]

    @property
    def binding_space_log10(self) -> float:
        return float(self.analysis["bindingSpaceLog10"])

    @property
    def binding_space_cardinality(self) -> int:
        return int(self.analysis["bindingSpaceCardinality"])

    @property
    def binding_space(self) -> BindingSpace:
        """The estimated size of the binding space as limits read it: exact digits, no exception for odd input."""
        return BindingSpace.from_analysis(self.analysis)

    @property
    def binding_space_text(self) -> str:
        """``bindingSpaceCardinality`` as the decimal string it is on the wire (``"0"`` when unreadable)."""
        return self.binding_space.cardinality or "0"

    @cached_property
    def instance(self) -> dict[str, Any]:
        """The root index (``instance.json``) of the package."""
        document = packages.instance_document(self.archive)
        if document is None:
            raise RuntimeError("compiled package has no readable instance.json")
        return document

    @cached_property
    def file_digests(self) -> dict[str, str]:
        return package_file_digests(self.instance, self.ir)

    @cached_property
    def resource_digests(self) -> dict[str, str]:
        return source_resource_digests(self)


def registered_specs(resources: Mapping[RegisteredKey, RegisteredResource]) -> list[dict[str, Any]]:
    """The registered resources in the shape the port takes."""
    return [
        {
            "namespace": key[0],
            "name": key[1],
            "version": key[2],
            "digest": key[3],
            "mediaType": resource.media_type,
            "content": resource.content,
            **({"versionManifest": resource.version_manifest} if resource.version_manifest else {}),
        }
        for key, resource in resources.items()
    ]


async def compile_package(
    archive: bytes,
    registered_resources: Mapping[RegisteredKey, RegisteredResource] | None = None,
) -> Compilation:
    """Compile ``archive`` with the toolchain; a refused source is ``422 invalid_instance``."""
    try:
        result = await bim.abim().compile(archive, registered_specs(registered_resources or {}))
    except CompileError as exc:
        raise bim.http_exception_for(exc) from exc
    return Compilation.from_result(archive, result)


async def archive_matches_digest(archive: bytes, package_digest: str | None) -> bool:
    """Whether ``archive`` is the package whose ``packageDigest`` is ``package_digest``.

    An archive in the toolchain's canonical form is its own digest. Any other archive of the same
    package is judged by the toolchain, which reads it and reports the digest of its canonical form
    (``PackageError`` if it cannot be read).
    """
    if digest_bytes(archive) == package_digest:
        return True
    return (await bim.abim().validate(archive))["packageDigest"] == package_digest


def registered_keys(instance: Mapping[str, Any] | None) -> set[RegisteredKey]:
    """The registry resources an Instance pins by ``namespace/name/version/digest``."""
    resources = instance.get("spec", {}).get("resources", {}) if isinstance(instance, Mapping) else {}
    if not isinstance(resources, dict):
        return set()
    keys: set[RegisteredKey] = set()
    for group in resources.values():
        if not isinstance(group, dict):
            continue
        for target in group.values():
            if isinstance(target, dict) and all(
                isinstance(target.get(key), str)
                for key in ("namespace", "name", "version", "digest")
            ):
                keys.add((target["namespace"], target["name"], target["version"], target["digest"]))
    return keys


async def installed_registered_resources(
    archive: bytes,
    session: AsyncSession | None,
    caller: User | None = None,
) -> dict[RegisteredKey, RegisteredResource]:
    instance = packages.instance_document(archive)
    library_resources: dict[RegisteredKey, RegisteredResource] = {}
    if session is not None:
        from ..artifacts import resolve_version, version_content
        from ..models.artifacts import ArtifactRef
        resources = instance.get("spec", {}).get("resources", {}) if instance is not None else {}
        for group in resources.values() if isinstance(resources, dict) else ():
            for target in group.values() if isinstance(group, dict) else []:
                if isinstance(target, dict) and "versionDigest" in target:
                    _, version = await resolve_version(session, ArtifactRef.model_validate(target), caller)
                    content, media_type = await version_content(session, version)
                    key = tuple(target[field] for field in ("namespace", "name", "version", "versionDigest"))
                    library_resources[key] = RegisteredResource(content, media_type, version.manifest)
    keys = registered_keys(instance)
    resolved = {**library_resources, **{key: value for key, value in CUSTOM_RESOURCES.items() if key in keys}}
    if not keys or session is None:
        return resolved
    digests = {key[3] for key in keys}
    rows = (
        await session.execute(
            select(RegisteredResourceRevision).where(
                RegisteredResourceRevision.state == "published",
                RegisteredResourceRevision.digest.in_(digests),
            )
        )
    ).scalars().all()
    for row in rows:
        key = (row.namespace, row.name, row.version, row.digest)
        if key in keys:
            resolved[key] = RegisteredResource(row.content, row.media_type)
    return resolved


async def compile_resolved(
    archive: bytes,
    session: AsyncSession | None,
    caller: User | None = None,
) -> Compilation:
    return await compile_package(archive, await installed_registered_resources(archive, session, caller))


def source_resource_digests(compilation: Compilation | Mapping[str, Any]) -> dict[str, str]:
    ir = compilation.ir if isinstance(compilation, Compilation) else compilation
    resources = ir.get("spec", {}).get("instance", {}).get("resources", {})
    return {
        resource_id: descriptor["digest"]
        for resource_id, descriptor in sorted(resources.items())
        if isinstance(descriptor, dict) and isinstance(descriptor.get("digest"), str)
    }


def snapshot_resource_contract(
    ir: Mapping[str, Any],
    descriptor: Mapping[str, Any],
    role: str,
    media_type: str,
) -> tuple[str, str, str]:
    """Resolve the exact installed-and-pinned Dialect for one IR resource."""
    api_version = descriptor.get("apiVersion")
    kind = descriptor.get("kind")
    if not isinstance(api_version, str) or not api_version:
        raise RuntimeError("compiled resource is missing apiVersion")
    if not isinstance(kind, str) or not kind:
        raise RuntimeError("compiled resource is missing kind")
    if descriptor.get("role") != role:
        raise RuntimeError("compiled resource role does not match the Instance index")

    pinned_dialects = {
        item.get("id"): item
        for item in ir.get("spec", {}).get("dialects", [])
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    matches = [
        entry["descriptor"]["id"]
        for entry in bim.dialect_entries()
        for _, resource_type in dialect_type_matches([entry["manifest"]], api_version, kind, media_type)
        if role in resource_type.get("roles", [])
        and pinned_dialects.get(entry["descriptor"]["id"]) == entry["descriptor"]
    ]
    if len(matches) != 1:
        raise RuntimeError(
            "compiled resource does not resolve to exactly one installed and pinned Dialect"
        )
    return api_version, kind, matches[0]


async def persist_snapshot(
    compilation: Compilation,
    caller: User | None,
    session: AsyncSession | None,
) -> str | None:
    """Persist a source snapshot and its canonical IR when accounts are enabled."""
    if session is None:
        return None
    archive = compilation.archive
    instance = compilation.instance
    instance_hash = compilation.instance_digest
    package_hash = compilation.package_digest
    compilation_hash = compilation.compilation_digest
    owner_id = caller.id if caller else None
    query = select(InstanceSnapshot).where(
        InstanceSnapshot.package_digest == package_hash,
        InstanceSnapshot.compilation_digest == compilation_hash,
        InstanceSnapshot.owner_id == owner_id,
    )
    existing = (await session.execute(query)).scalars().first()
    if existing is not None:
        return str(existing.id)

    snapshot = InstanceSnapshot(
        owner_id=owner_id,
        name=instance.get("metadata", {}).get("name", "instance"),
        instance_digest=instance_hash,
        package_digest=package_hash,
        root_document=instance,
        resource_digests=source_resource_digests(compilation),
        source_archive=archive,
        compilation_digest=compilation_hash,
    )
    try:
        async with session.begin_nested():
            session.add(snapshot)
            await session.flush()
    except IntegrityError:
        existing = await session.scalar(query)
        if existing is not None:
            return str(existing.id)
        raise


    files = packages.read_files(archive)
    resources = instance.get("spec", {}).get("resources", {})
    manifest = compilation.spec.get("instance", {}).get("resources", {})
    installed_registered = await installed_registered_resources(archive, session, caller)
    for role, group in resources.items() if isinstance(resources, dict) else []:
        if not isinstance(group, dict):
            continue
        for resource_id, target in group.items():
            path = target if isinstance(target, str) else None
            registered = target if isinstance(target, dict) else None
            descriptor = manifest.get(resource_id, {}) if isinstance(manifest, dict) else {}
            if isinstance(path, str):
                content = files[path]
                document = None
                if path.lower().endswith(".json"):
                    try:
                        document = strict_json_loads(content)
                    except ValueError:
                        document = None
                    if not isinstance(document, dict):
                        document = None
                media_type = (
                    "application/json"
                    if path.lower().endswith(".json")
                    else "application/xml" if path.lower().endswith(".xml") else "application/vnd.omg.bpmn+xml"
                )
                resource_digest = descriptor["digest"]
            elif registered is not None:
                key = tuple(
                    registered.get(field, "")
                    for field in ("namespace", "name", "version", "versionDigest" if "versionDigest" in registered else "digest")
                )
                resolved = installed_registered.get(key)
                if resolved is None:
                    raise RuntimeError("compiled registered resource is no longer published locally")
                content = resolved.content
                media_type = resolved.media_type
                resource_digest = resolved.version_manifest["contentDigest"] if resolved.version_manifest else registered["digest"]
                document = None
                if media_type == "application/json":
                    parsed = strict_json_loads(content)
                    document = parsed if isinstance(parsed, dict) else None
            else:
                continue
            api_version, kind, dialect_id = snapshot_resource_contract(
                compilation.ir, descriptor, role, media_type
            )
            session.add(
                InstanceResource(
                    snapshot_id=snapshot.id,
                    resource_id=resource_id,
                    role=role,
                    api_version=api_version,
                    kind=kind,
                    dialect_id=dialect_id,
                    path=path,
                    digest=resource_digest,
                    registered_namespace=registered.get("namespace") if registered else None,
                    registered_name=registered.get("name") if registered else None,
                    registered_version=registered.get("version") if registered else None,
                    registered_digest=registered.get("versionDigest", registered.get("digest")) if registered else None,
                    media_type=media_type,
                    document=document,
                    content=content,
                )
            )
    session.add(
        BindingIRSnapshot(
            snapshot_id=snapshot.id,
            ir_digest=compilation.ir_digest,
            document=compilation.ir,
            source_map=compilation.source_map,
            compiler_version="bim-compiler/v1",
        )
    )
    await session.flush()
    return str(snapshot.id)


async def snapshot_ir(snapshot: InstanceSnapshot, session: AsyncSession) -> Compilation:
    """A snapshot is already compiled. Never reinterpret it using current sources.

    The IR comes back exactly as stored. Its digest is not re-derived here: every operation of the
    toolchain that receives an IR recomputes it (``ir_digest_mismatch``), so an altered IR is refused
    by the first thing done with it. What is checked here is that the IR was compiled by the installed
    toolchain, because the answer to that is a stable ``422 contract_not_installed`` that says to
    recompile (``recompile_stale_snapshots``), not whatever the operation that meets it first reports.
    When the stored package itself is what the installed toolchain refuses, recompiling cannot help and
    saying so would mislead: that snapshot answers ``422 snapshot_not_recompilable`` instead, with the
    compiler's own finding (``diagnose_snapshot``). Nothing is written either way.
    """
    ir = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))
    if ir is None:
        raise HTTPException(409, detail={"code": "snapshot_ir_missing", "message": "Snapshot IR is unavailable"})
    if ir.document.get('apiVersion') != 'bim/v1' or ir.document.get('kind') != 'BindingProblem':
        raise HTTPException(422, detail={"code": "execution_capability_unavailable", "message": "This output has no installed execution evaluator"})
    if not bim.ir_is_installed(ir.document):
        diagnosis = await diagnose_snapshot(session, snapshot)
        if diagnosis.status == "not_recompilable":
            raise HTTPException(422, detail=not_recompilable_detail(diagnosis))
        raise HTTPException(422, detail={"code": "contract_not_installed", "message": bim.STALE_IR_MESSAGE})
    return Compilation(
        archive=snapshot.source_archive,
        ir=ir.document,
        ir_digest=ir.ir_digest,
        instance_digest=snapshot.instance_digest,
        package_digest=snapshot.package_digest,
        compilation_digest=snapshot.compilation_digest,
        source_map=ir.source_map or {},
        analysis=ir_analysis(ir.document),
    )


class _RecompileRefused(RuntimeError):
    """A snapshot that cannot be recompiled in place; ``code`` says why."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _failure_code(exc: Exception) -> str:
    if isinstance(exc, HTTPException) and isinstance(exc.detail, dict) and isinstance(exc.detail.get("code"), str):
        return exc.detail["code"]
    if isinstance(exc, SQLAlchemyError):
        return "database_error"
    return getattr(exc, "code", None) or type(exc).__name__


async def _is_referenced(session: AsyncSession, snapshot_id: uuid.UUID) -> bool:
    """Whether a case revision or a job points at the snapshot."""
    from ..db.models import BindingCaseRevision

    for column, model in ((BindingCaseRevision.source_snapshot_id, BindingCaseRevision), (Job.instance_snapshot_id, Job)):
        if await session.scalar(select(model.id).where(column == snapshot_id).limit(1)) is not None:
            return True
    return False


# -- Why a snapshot cannot be compiled again ---------------------------------------------------------

#: Stable code of a snapshot whose stored package the installed toolchain does not accept (or accepts as
#: another package): compiling it again cannot work, so the snapshot is kept as evidence and cannot run.
NOT_RECOMPILABLE = "snapshot_not_recompilable"
NOT_RECOMPILABLE_MESSAGE = (
    "This snapshot was compiled by another bim-toolchain release, and the installed one does not accept its "
    "stored package, so it cannot be recompiled or run. The package and the case revisions that pin it are kept "
    "unchanged as evidence; correct the source and upload it again to get a snapshot that can run."
)
#: What ``reason`` says when the toolchain accepts the package but not as the package the snapshot recorded.
_REASON_MESSAGES = {
    "snapshot_identity_changed": "The installed toolchain reads the stored package as a different package or Instance.",
    "recompile_unchanged": "Compiling the stored package again does not produce an IR of the installed toolchain.",
}
#: Verdicts of a refused compilation that are about the package itself, as opposed to the toolchain or the
#: database being unavailable (which says nothing about the package).
_PACKAGE_VERDICTS = frozenset({"invalid_package", "unreadable_package", "refused"})
_MAX_DIAGNOSTICS = 5
_MAX_TEXT = 300


def _clip(value: Any, limit: int = _MAX_TEXT) -> str:
    """One line of text without credential forms, no longer than ``limit``."""
    text = redact(" ".join(str(value).split()))
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _clean_diagnostic(item: Any) -> dict[str, str]:
    if hasattr(item, "as_dict"):
        item = item.as_dict()
    item = item if isinstance(item, Mapping) else {"message": item}
    cleaned = {"code": _clip(item.get("code", ""), 80)}
    for key in ("resource", "pointer", "irPath", "bpmnElement"):
        if item.get(key):
            cleaned[key] = _clip(item[key], 200)
    cleaned["message"] = _clip(item.get("message", ""))
    return cleaned


@dataclass(frozen=True)
class CompileRefusal:
    """A refused compilation in stable, redacted terms: the toolchain's code, its findings and a verdict.

    ``verdict`` is ``invalid_package`` (the compiler's diagnostics), ``unreadable_package`` (not a package
    the toolchain can read), ``refused`` (another refusal of the input), ``unavailable`` (the toolchain or the
    database could not answer: no verdict on the package) or ``error`` (unexpected; only its type is named).
    """

    verdict: str
    code: str
    message: str
    diagnostics: tuple[dict[str, str], ...] = ()
    diagnostic_count: int = 0

    @property
    def about_the_package(self) -> bool:
        return self.verdict in _PACKAGE_VERDICTS

    def as_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "code": self.code,
            "message": self.message,
            "diagnostics": [dict(item) for item in self.diagnostics],
            "diagnosticCount": self.diagnostic_count,
        }


def compile_refusal(exc: BaseException) -> CompileRefusal:
    """The refusal ``exc`` stands for. Nothing but the toolchain's own findings is echoed."""
    if isinstance(exc, BimError):
        status, code, message, diagnostics, _, _ = bim.problem_for(exc)
        if isinstance(exc, CompileError):
            verdict = "invalid_package"
        elif isinstance(exc, PackageError):
            verdict = "unreadable_package"
        else:
            verdict = "unavailable" if status >= 500 else "refused"
    elif isinstance(exc, HTTPException):
        code, message, diagnostics, _ = split_detail(exc.detail, "request_invalid")
        if exc.status_code >= 500:
            verdict = "unavailable"
        else:
            verdict = "invalid_package" if code == "invalid_instance" else "refused"
    elif isinstance(exc, SQLAlchemyError):
        return CompileRefusal("unavailable", "database_error", "The database could not be read.")
    else:
        return CompileRefusal("error", type(exc).__name__, "The compilation failed unexpectedly.")
    cleaned = tuple(_clean_diagnostic(item) for item in list(diagnostics)[:_MAX_DIAGNOSTICS])
    return CompileRefusal(verdict, _clip(code, 80), _clip(message), cleaned, len(diagnostics))


@dataclass(frozen=True)
class SnapshotDiagnosis:
    """What compiling the stored package of one snapshot with the installed toolchain says. Read only.

    ``status``: ``current`` (its IR is the installed toolchain's), ``recompilable``, ``blocked`` (it would
    compile, but a copy that a revision or a job uses holds the identity it needs: ``snapshot_conflict``),
    ``not_recompilable`` (the package is refused or read as another one), ``undetermined`` (the toolchain
    or the database did not answer) or ``ir_missing``.
    """

    snapshot_id: str
    status: str
    code: str | None = None
    ir_installed: bool | None = None
    compiles: bool | None = None
    identity_matches: bool | None = None
    refusal: CompileRefusal | None = None
    current_package_digest: str | None = None
    current_instance_digest: str | None = None
    #: ``namespace/name/version`` of the registry resources the stored package pins
    registered_resources: tuple[str, ...] = ()


async def _twin_of(session: AsyncSession, stale: InstanceSnapshot, compilation: Compilation) -> InstanceSnapshot | None:
    """The snapshot of the same owner and package that already has the identity ``compilation`` would give ``stale``."""
    return await session.scalar(
        select(InstanceSnapshot).where(
            InstanceSnapshot.owner_id == stale.owner_id,
            InstanceSnapshot.package_digest == stale.package_digest,
            InstanceSnapshot.compilation_digest == compilation.compilation_digest,
            InstanceSnapshot.id != stale.id,
        )
    )


async def diagnose_snapshot(session: AsyncSession, snapshot: InstanceSnapshot) -> SnapshotDiagnosis:
    """Compile the stored package of ``snapshot`` with the installed toolchain and say what happened.

    It reads and writes nothing: no flush, no commit, and the compilation is thrown away. It is what the
    launch of a stale snapshot consults, and what ``tools/diagnose_snapshots.py`` prints.
    """
    identifier = str(snapshot.id)
    stored = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))
    if stored is None:
        return SnapshotDiagnosis(identifier, "ir_missing", "snapshot_ir_missing")
    installed = bim.ir_is_installed(stored.document)
    pinned = (
        await session.execute(
            select(InstanceResource.registered_namespace, InstanceResource.registered_name, InstanceResource.registered_version)
            .where(InstanceResource.snapshot_id == snapshot.id, InstanceResource.registered_namespace.is_not(None))
            .order_by(InstanceResource.registered_namespace, InstanceResource.registered_name, InstanceResource.registered_version)
        )
    ).all()
    registered = tuple("/".join(str(part) for part in row) for row in pinned)
    try:
        owner = await session.get(User, snapshot.owner_id)
        compilation = await compile_resolved(snapshot.source_archive, session, owner)
    except Exception as exc:  # noqa: BLE001 - a corrupt package must be a diagnosis, never a crash of the tool
        refusal = compile_refusal(exc)
        status = "not_recompilable" if refusal.about_the_package else "undetermined"
        return SnapshotDiagnosis(
            identifier, "current" if installed else status, refusal.code if not installed else None, installed,
            False if refusal.about_the_package else None, None, refusal, registered_resources=registered,
        )
    same = (compilation.package_digest, compilation.instance_digest) == (snapshot.package_digest, snapshot.instance_digest)
    facts = dict(
        ir_installed=installed, compiles=True, identity_matches=same,
        current_package_digest=compilation.package_digest, current_instance_digest=compilation.instance_digest,
        registered_resources=registered,
    )
    if installed:
        return SnapshotDiagnosis(identifier, "current", **facts)
    if not same:
        return SnapshotDiagnosis(identifier, "not_recompilable", "snapshot_identity_changed", **facts)
    if not bim.ir_is_installed(compilation.ir):
        return SnapshotDiagnosis(identifier, "not_recompilable", "recompile_unchanged", **facts)
    twin = await _twin_of(session, snapshot, compilation)
    if twin is not None and await _is_referenced(session, twin.id):
        return SnapshotDiagnosis(identifier, "blocked", "snapshot_conflict", **facts)
    return SnapshotDiagnosis(identifier, "recompilable", **facts)


def not_recompilable_detail(diagnosis: SnapshotDiagnosis) -> dict[str, Any]:
    """The ``HTTPException`` detail of ``snapshot_not_recompilable``: a fixed message and the stable reason."""
    reason: dict[str, Any] = {"code": diagnosis.code}
    if diagnosis.refusal is not None:
        reason.update(
            message=diagnosis.refusal.message,
            diagnostics=[dict(item) for item in diagnosis.refusal.diagnostics],
            diagnosticCount=diagnosis.refusal.diagnostic_count,
        )
    elif diagnosis.code in _REASON_MESSAGES:
        reason["message"] = _REASON_MESSAGES[diagnosis.code]
    return {"code": NOT_RECOMPILABLE, "message": NOT_RECOMPILABLE_MESSAGE, "reason": reason}


@dataclass(frozen=True)
class RecompileFailure:
    """A snapshot ``recompile_stale_snapshots`` left as it was: ``code`` says why, ``refusal`` has the compiler's words."""

    snapshot_id: str
    code: str
    refusal: CompileRefusal | None = None


@dataclass(frozen=True)
class RecompileReport:
    """What ``recompile_stale_snapshots`` did: ids, codes and the compiler's own findings, nothing else stored."""

    #: ``(snapshot id, ids of the case revisions that pin it)``
    recompiled: tuple[tuple[str, tuple[str, ...]], ...] = ()
    #: left as they were, so a launch still answers a stable 422 (``contract_not_installed`` or ``snapshot_not_recompilable``)
    failures: tuple[RecompileFailure, ...] = ()

    @property
    def failed(self) -> tuple[tuple[str, str], ...]:
        """``(snapshot id, error code)`` of every failure."""
        return tuple((item.snapshot_id, item.code) for item in self.failures)

    @property
    def changed(self) -> bool:
        return bool(self.recompiled)


async def recompile_stale_snapshots(session: AsyncSession) -> RecompileReport:
    """Compile again, with the installed toolchain, the package of every snapshot a case revision pins that it did not compile.

    A snapshot keeps the package it was compiled from, so a toolchain release that changes the IR (a new
    ``compilerDigest``) does not need the stored IR to be migrated: the package is compiled again for the
    same owner and the *derived* data of the snapshot, its IR row and its compilation digest, is replaced.
    Case revisions are sealed (a trigger rejects any UPDATE or DELETE), so it is the snapshot they pin that
    is regenerated and every id stays: snapshot, revisions, cases, projects, owners and the jobs that ran on
    it (their stored IR is history and keeps its own digest). The package, the instance index and their
    digests are not touched, and the toolchain must agree with them: a package that compiles to other
    ``packageDigest`` or ``instanceDigest`` is refused.

    A copy of the same package that the installed toolchain compiled for the same owner (a snapshot made
    by an upload or by an earlier seed after the release) holds the identity the regenerated snapshot needs.
    It is removed when nothing points at it; when a revision or a job does, the snapshot is left stale and
    reported as ``snapshot_conflict``. A package that cannot be compiled again is reported, with the
    toolchain's code and findings (``RecompileFailure.refusal``), and left alone: never deleted or hidden, its
    launches answer ``snapshot_not_recompilable`` (``snapshot_ir``). Nothing is committed here. A second call finds nothing to do.
    """
    from ..db.models import BindingCaseRevision

    pinned = (
        await session.scalars(
            select(InstanceSnapshot)
            .where(
                InstanceSnapshot.id.in_(
                    select(BindingCaseRevision.source_snapshot_id).where(BindingCaseRevision.source_snapshot_id.is_not(None))
                )
            )
            .order_by(InstanceSnapshot.created_at, InstanceSnapshot.id)
        )
    ).all()
    recompiled: list[tuple[str, tuple[str, ...]]] = []
    failures: list[RecompileFailure] = []
    for stale in pinned:
        stored = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == stale.id))
        if stored is None or bim.ir_is_installed(stored.document):
            continue
        try:
            async with session.begin_nested():
                owner = await session.get(User, stale.owner_id)
                compilation = await compile_resolved(stale.source_archive, session, owner)
                if (compilation.package_digest, compilation.instance_digest) != (stale.package_digest, stale.instance_digest):
                    raise _RecompileRefused("snapshot_identity_changed")
                if not bim.ir_is_installed(compilation.ir):
                    raise _RecompileRefused("recompile_unchanged")
                twin = await _twin_of(session, stale, compilation)
                if twin is not None:
                    if await _is_referenced(session, twin.id):
                        raise _RecompileRefused("snapshot_conflict")
                    # The database cascades these; SQLite without foreign keys does not.
                    await session.execute(delete(InstanceResource).where(InstanceResource.snapshot_id == twin.id))
                    await session.execute(delete(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == twin.id))
                    await session.delete(twin)
                    await session.flush()
                stale.compilation_digest = compilation.compilation_digest
                stored.ir_digest = compilation.ir_digest
                stored.document = compilation.ir
                stored.source_map = compilation.source_map
                await session.flush()
                revisions = (
                    await session.scalars(
                        select(BindingCaseRevision.id)
                        .where(BindingCaseRevision.source_snapshot_id == stale.id)
                        .order_by(BindingCaseRevision.created_at, BindingCaseRevision.id)
                    )
                ).all()
        except _RecompileRefused as exc:
            failures.append(RecompileFailure(str(stale.id), exc.code))
            continue
        except (HTTPException, BimError, RuntimeError, SQLAlchemyError) as exc:
            failures.append(RecompileFailure(str(stale.id), _failure_code(exc), compile_refusal(exc)))
            continue
        recompiled.append((str(stale.id), tuple(str(revision) for revision in revisions)))
    return RecompileReport(tuple(recompiled), tuple(failures))


async def owned_snapshot(snapshot_id: str, caller: User | None, session: AsyncSession | None):
    if session is None or caller is None:
        return None
    try:
        parsed = uuid.UUID(str(snapshot_id))
    except ValueError:
        return None
    snapshot = await session.get(InstanceSnapshot, parsed)
    if snapshot is None or snapshot.owner_id == caller.id:
        return snapshot
    # Sharing a case grants organization members access to its fixed inputs.
    # Project visibility alone never exposes private resource dependencies.
    from ..db.models import BindingCase, BindingCaseRevision, Project
    from ..collaboration import effective_role
    organizations = (await session.scalars(select(Project.organization_id).join(
        BindingCase, BindingCase.project_id == Project.id).join(
        BindingCaseRevision, BindingCaseRevision.binding_case_id == BindingCase.id).where(
        BindingCaseRevision.source_snapshot_id == snapshot.id).distinct())).all()
    for organization_id in organizations:
        if await effective_role(session, organization_id, caller):
            return snapshot
    return None
