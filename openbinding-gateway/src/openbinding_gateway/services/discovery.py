"""What the platform offers, read-only: profiles, Dialects, examples and Engines.

``routes.v1`` authenticates the caller and turns the outcome into a response; this module builds the documents.
Nothing here writes. The Dialects are always the ones installed in this process, so the list can never promise a
stale deployment. A refusal is a ``DiscoveryProblem``; the route renders it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, NamedTuple

from bim_core import PackageError
from bim_core.canonical import digest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import EngineRegistrationRevision, EngineRevision, User, utcnow
from ..integrations import bim, packages
from ..security.apikeys import allows_engine
from .engines import (
    MANIFEST_DIR,
    available_engine_documents,
    engine_ref,
    protocol_digest,
    registration_summary,
)


class DiscoveryProblem(Exception):
    """A refusal the HTTP layer renders as ``application/problem+json``."""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


class ExamplePackage(NamedTuple):
    """An example directory as a ``.bim.zip`` the toolchain has read."""

    archive: bytes
    name: str


def profiles_document() -> dict[str, Any]:
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


def builtin_dialects() -> list[dict[str, Any]]:
    return bim.dialect_manifests()


def dialects_document(installed: list[dict[str, Any]]) -> dict[str, Any]:
    return {"dialects": [{**item, "digest": digest(item)} for item in installed]}


def _examples_root() -> Path:
    return MANIFEST_DIR.parents[3] / "examples"


def example_paths() -> list[str]:
    """The directories under ``examples/`` that hold a ``bim/v1`` Instance."""
    root = _examples_root()
    paths = []
    for path in root.rglob("instance.json"):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(document, dict) and document.get("apiVersion") == "bim/v1" and document.get("kind") == "Instance":
            paths.append(path.parent.relative_to(root).as_posix())
    paths.sort()
    return paths


async def example_package(example_path: str) -> ExamplePackage:
    """One example as a package; never a path outside ``examples/``."""
    root = _examples_root().resolve()
    requested = (root / example_path).resolve()
    try:
        requested.relative_to(root)
    except ValueError as exc:
        raise DiscoveryProblem(404, "not_found", "Example not found") from exc
    if requested.name == "instance.json":
        requested = requested.parent
    if not requested.is_dir() or not (requested / "instance.json").is_file():
        raise DiscoveryProblem(404, "not_found", "Example not found")
    archive = packages.zip_directory(requested)
    try:
        # The toolchain reads the archive (without keeping anything): an example it cannot load is refused.
        await bim.abim().validate(archive)
    except PackageError as exc:
        raise DiscoveryProblem(422, "invalid_example", str(exc)) from exc
    return ExamplePackage(archive, requested.name.replace('"', "") or "example")


async def engines_document(session: AsyncSession | None, caller: User | None) -> dict[str, Any]:
    """The Engines the caller may use."""
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


async def engine_revisions_document(session: AsyncSession | None, caller: User | None) -> dict[str, Any]:
    """Every stored Engine revision with its registration; the built-in Engines when nothing is stored."""
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


async def engine_revision_document(
    namespace: str,
    name: str,
    version: str,
    session: AsyncSession | None,
    *,
    manifest: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """One Engine revision; ``manifest`` reads a built-in one when nothing is stored."""
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
            doc = manifest(name, namespace=namespace, version=version)
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
        except HTTPException as exc:
            raise DiscoveryProblem(404, "not_found", "Engine revision not found") from exc

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
