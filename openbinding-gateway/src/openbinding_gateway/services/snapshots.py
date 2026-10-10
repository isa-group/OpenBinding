"""Compile an Instance package and persist it as an immutable snapshot."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    BindingIRSnapshot,
    InstanceResource,
    InstanceSnapshot,
    RegisteredResourceRevision,
    User,
)
from ..v1.canonical import digest, digest_bytes
from ..v1.compiler import (
    BindingProblem,
    CompileError,
    RegisteredResource,
    compile_instance,
    _dialect_descriptor,
    _profile_descriptor,
    _dialect_type_matches,
    installed_dialect_manifests,
    installed_profile_manifests,
    instance_digest,
    manifest_id,
)
from ..v1.package import InstancePackage, PackageError, load_package, strict_json_loads

#: Registered resources uploaded to this process (no database), keyed by
#: (namespace, name, version, digest).  ``routes.v1`` shares this very dict.
CUSTOM_RESOURCES: dict[tuple[str, str, str, str], RegisteredResource] = {}


def instance_identity(package: InstancePackage) -> str:
    """Identity of the strict root index plus every package resource."""
    portable = load_package(package.to_zip())
    return instance_digest(portable.instance(), portable.resource_digests)


def compile_package(
    package: InstancePackage,
    registered_resources: Mapping[tuple[str, str, str, str], RegisteredResource] | None = None,
) -> BindingProblem:
    try:
        return compile_instance(package, registered_resources)
    except CompileError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_instance", "diagnostics": [item.as_dict() for item in exc.diagnostics]}) from exc


def registered_keys(package: InstancePackage) -> set[tuple[str, str, str, str]]:
    instance = package.instance()
    resources = instance.get("spec", {}).get("resources", {})
    if not isinstance(resources, dict):
        return set()
    keys: set[tuple[str, str, str, str]] = set()
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
    package: InstancePackage,
    session: AsyncSession | None,
    caller: User | None = None,
) -> dict[tuple[str, str, str, str], RegisteredResource]:
    library_resources = {}
    if session is not None:
        from ..artifacts import resolve_version, version_content
        from ..models.artifacts import ArtifactRef
        for group in package.instance().get("spec", {}).get("resources", {}).values():
            for target in group.values() if isinstance(group, dict) else []:
                if isinstance(target, dict) and "versionDigest" in target:
                    _, version = await resolve_version(session, ArtifactRef.model_validate(target), caller)
                    content, media_type = await version_content(session, version)
                    key = tuple(target[field] for field in ("namespace", "name", "version", "versionDigest"))
                    library_resources[key] = RegisteredResource(content, media_type, version.manifest)
    keys = registered_keys(package)
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
    package: InstancePackage,
    session: AsyncSession | None,
    caller: User | None = None,
) -> BindingProblem:
    return compile_package(package, await installed_registered_resources(package, session, caller))


def snapshot_payload(package: InstancePackage, problem: BindingProblem) -> dict[str, Any]:
    portable = load_package(package.to_zip())
    return {
        "package": portable,
        "problem": problem,
        "digest": instance_identity(portable),
        "packageDigest": portable.package_digest,
        "fileDigests": portable.resource_digests,
        "resourceDigests": source_resource_digests(problem),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def source_resource_digests(problem: BindingProblem) -> dict[str, str]:
    resources = problem.document.get("spec", {}).get("instance", {}).get("resources", {})
    return {
        resource_id: descriptor["digest"]
        for resource_id, descriptor in sorted(resources.items())
        if isinstance(descriptor, dict) and isinstance(descriptor.get("digest"), str)
    }


def snapshot_resource_contract(
    problem: BindingProblem,
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
        for item in problem.document.get("spec", {}).get("dialects", [])
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    matches = [
        manifest_id(dialect)
        for dialect, resource_type in _dialect_type_matches(
            installed_dialect_manifests(), api_version, kind, media_type
        )
        if role in resource_type.get("roles", [])
        and pinned_dialects.get(manifest_id(dialect)) == _dialect_descriptor(dialect)
    ]
    if len(matches) != 1:
        raise RuntimeError(
            "compiled resource does not resolve to exactly one installed and pinned Dialect"
        )
    return api_version, kind, matches[0]


async def persist_snapshot(
    package: InstancePackage,
    problem: BindingProblem,
    caller: User | None,
    session: AsyncSession | None,
) -> str | None:
    """Persist a source snapshot and its canonical IR when accounts are enabled."""
    if session is None:
        return None
    archive = package.to_zip()
    portable = load_package(archive)
    instance = portable.instance()
    instance_hash = instance_identity(package)
    package_hash = digest_bytes(archive)
    from ..v1.compiler import compiler_bundle_digest
    compilation_hash = digest({"packageDigest": package_hash,
        "profile": problem.document.get("spec", {}).get("profile"),
        "dialects": problem.document.get("spec", {}).get("dialects", []),
        "compilerDigest": compiler_bundle_digest()})
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
        root_document=portable.json("instance.json"),
        resource_digests=source_resource_digests(problem),
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


    resources = instance.get("spec", {}).get("resources", {})
    manifest = problem.document.get("spec", {}).get("instance", {}).get("resources", {})
    installed_registered = await installed_registered_resources(portable, session, caller)
    for role, group in resources.items() if isinstance(resources, dict) else []:
        if not isinstance(group, dict):
            continue
        for resource_id, target in group.items():
            path = target if isinstance(target, str) else None
            registered = target if isinstance(target, dict) else None
            descriptor = manifest.get(resource_id, {}) if isinstance(manifest, dict) else {}
            if isinstance(path, str):
                content = portable.bytes(path)
                document = None
                if path.lower().endswith(".json"):
                    try:
                        document = portable.json(path)
                    except PackageError:
                        document = None
                media_type = (
                    "application/json"
                    if path.lower().endswith(".json")
                    else "application/xml" if path.lower().endswith(".xml") else "application/vnd.omg.bpmn+xml"
                )
                resource_digest = portable.digest(path)
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
                problem, descriptor, role, media_type
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
            ir_digest=problem.digest,
            document=problem.document,
            source_map=problem.source_map,
            compiler_version="bim-compiler/v1",
        )
    )
    await session.flush()
    return str(snapshot.id)


async def snapshot_problem(snapshot: InstanceSnapshot, session: AsyncSession) -> BindingProblem:
    """A snapshot is already compiled. Never reinterpret it using current sources."""
    ir = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))
    if ir is None:
        raise HTTPException(409, detail={"code": "snapshot_ir_missing", "message": "Snapshot IR is unavailable"})
    if ir.document.get('apiVersion') != 'bim/v1' or ir.document.get('kind') != 'BindingProblem':
        raise HTTPException(422, detail={"code": "execution_capability_unavailable", "message": "This output has no installed execution evaluator"})
    semantic = json.loads(json.dumps(ir.document))
    semantic.pop('metadata', None)
    for key in ('instance', 'dialects', 'sourceMap'):
        semantic.get('spec', {}).pop(key, None)
    if digest(semantic) != ir.ir_digest:
        raise HTTPException(409, detail={"code": "snapshot_ir_integrity", "message": "Stored IR does not match its semantic digest"})
    spec = ir.document.get("spec", {})
    profile = spec.get("profile", {})
    if profile not in [_profile_descriptor(item) for item in installed_profile_manifests()]:
        raise HTTPException(409, detail={"code": "contract_not_installed", "message": "The exact snapshot Profile is not installed"})
    available = [_dialect_descriptor(item) for item in installed_dialect_manifests()]
    if any(item not in available for item in spec.get("dialects", [])):
        raise HTTPException(409, detail={"code": "contract_not_installed", "message": "An exact snapshot Dialect is not installed"})
    return BindingProblem(document=ir.document, digest=ir.ir_digest, source_map=ir.source_map)


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
