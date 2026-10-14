#!/usr/bin/env python3
"""Read-only diagnosis of the instance snapshots that cannot be compiled again.

``recompile_stale_snapshots`` (run by ``seed_lab.py``) leaves a snapshot as it was when its stored package
does not compile again with the installed bim-toolchain, and only reports a code (``invalid_instance``). This
tool says why, without changing anything: for each stale snapshot that is not recompilable it prints one JSON
document with the ids, the organization and project that reach it through case revisions (slugs and ids, no
credential), the revision, the digests of the stored package, and the exact refusal of the installed compiler
(code, pointer, redacted message) together with whether the same source package compiles now and still reads
as the same package (docs/qa/SNAPSHOT_INVALID_INSTANCE.md).

It never commits: a rollback ends the session, and on PostgreSQL the transaction is declared ``READ ONLY``.
Nothing is deleted, hidden or repaired; a snapshot it lists stays as it is. It uses the gateway ``Settings``
only (``DATABASE_URL``, ``BIM_MODE`` and the rest of the existing configuration). Importing this module has
no side effects.

Usage (in the gateway image, as ``lab_compose seed`` runs it: ``DEMO_SEED_TOOL=diagnose_snapshots.py``):
    python tools/diagnose_snapshots.py [--snapshot ID ...] [--all] [--verbose]

By default it examines the stale snapshots (the stored IR is not the installed toolchain's) and lists those
that are not ``recompilable``. ``--snapshot`` examines exactly the given ids and lists them all; ``--all``
examines and lists every snapshot. Exit code 0 means the report was produced, whatever it found.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import uuid
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

# Importing this first makes ``openbinding_gateway`` importable when run as a script.
from _remote_common import EXIT_GUARD, EXIT_INTERNAL, EXIT_OK, Redactor  # isort: skip

from bim_core.canonical import digest_bytes
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from openbinding_gateway.db.models import BindingIRSnapshot, InstanceSnapshot, Job
from openbinding_gateway.db.platform_models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    Project,
)
from openbinding_gateway.integrations import bim
from openbinding_gateway.services.snapshots import SnapshotDiagnosis, diagnose_snapshot

logger = logging.getLogger("diagnose_snapshots")

#: Statuses that mean the snapshot is fine or fixable by the explicit recompilation: not listed by default.
HEALTHY = frozenset({"current", "recompilable"})
_SECRET_FIELD = re.compile(r"secret|token|password|api_?key|credential", re.IGNORECASE)


async def revision_references(session: AsyncSession, snapshot_id: uuid.UUID) -> list[dict[str, Any]]:
    """The case revisions that pin the snapshot, with their case, project and organization."""
    rows = (
        await session.execute(
            select(
                BindingCaseRevision.id, BindingCaseRevision.revision, BindingCaseRevision.digest,
                BindingCase.id, BindingCase.slug,
                Project.id, Project.slug,
                Organization.id, Organization.slug,
            )
            .join(BindingCase, BindingCase.id == BindingCaseRevision.binding_case_id)
            .join(Project, Project.id == BindingCase.project_id)
            .join(Organization, Organization.id == Project.organization_id)
            .where(BindingCaseRevision.source_snapshot_id == snapshot_id)
            .order_by(Organization.slug, Project.slug, BindingCase.slug, BindingCaseRevision.revision)
        )
    ).all()
    return [
        {
            "organizationId": str(organization_id), "organizationSlug": organization_slug,
            "projectId": str(project_id), "projectSlug": project_slug,
            "caseId": str(case_id), "caseSlug": case_slug,
            "revisionId": str(revision_id), "revision": revision, "revisionDigest": revision_digest,
        }
        for revision_id, revision, revision_digest, case_id, case_slug, project_id, project_slug,
        organization_id, organization_slug in rows
    ]


async def describe(session: AsyncSession, snapshot: InstanceSnapshot) -> dict[str, Any]:
    """The report entry of one snapshot: what is stored, who reaches it, and what the installed compiler says."""
    diagnosis: SnapshotDiagnosis = await diagnose_snapshot(session, snapshot)
    stored_ir = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))
    references = await revision_references(session, snapshot.id)
    jobs = int(await session.scalar(select(func.count()).select_from(Job).where(Job.instance_snapshot_id == snapshot.id)) or 0)
    return {
        "snapshotId": str(snapshot.id),
        "ownerId": str(snapshot.owner_id),
        "name": snapshot.name,
        "createdAt": snapshot.created_at.isoformat() if snapshot.created_at else None,
        "packageDigest": snapshot.package_digest,
        "instanceDigest": snapshot.instance_digest,
        "storedCompilationDigest": snapshot.compilation_digest,
        "storedIrDigest": stored_ir.ir_digest if stored_ir else None,
        "archiveBytes": len(snapshot.source_archive or b""),
        "archiveDigest": digest_bytes(snapshot.source_archive or b""),
        "pinnedBy": references,
        "jobsUsingIt": jobs,
        "status": diagnosis.status,
        "code": diagnosis.code,
        "storedIrIsInstalledToolchain": diagnosis.ir_installed,
        "compilesWithInstalledToolchain": diagnosis.compiles,
        "stillTheSamePackage": diagnosis.identity_matches,
        "currentPackageDigest": diagnosis.current_package_digest,
        "currentInstanceDigest": diagnosis.current_instance_digest,
        "registeredResources": list(diagnosis.registered_resources),
        "compilerError": diagnosis.refusal.as_dict() if diagnosis.refusal else None,
    }


async def _is_stale(session: AsyncSession, snapshot: InstanceSnapshot) -> bool:
    stored = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == snapshot.id))
    return stored is None or not bim.ir_is_installed(stored.document)


async def toolchain_facts() -> dict[str, Any]:
    """Which toolchain the diagnosis ran against; if it does not answer, say so (every verdict is then ``undetermined``)."""
    from openbinding_gateway.core.settings import get_settings

    facts: dict[str, Any] = {"mode": get_settings().bim_mode}
    try:
        facts["compilerDigest"] = await asyncio.to_thread(bim.toolchain_digest)
    except Exception as exc:  # noqa: BLE001 - the tool reports it and goes on
        facts["error"] = type(exc).__name__
    return facts


async def build_report(
    session: AsyncSession, *, snapshot_ids: Sequence[uuid.UUID] = (), include_all: bool = False
) -> dict[str, Any]:
    """The whole report. It reads only: no flush, no commit."""
    not_found: list[str] = []
    if snapshot_ids:
        examined: list[InstanceSnapshot] = []
        for identifier in dict.fromkeys(snapshot_ids):
            snapshot = await session.get(InstanceSnapshot, identifier)
            if snapshot is None:
                not_found.append(str(identifier))
            else:
                examined.append(snapshot)
        everything = True
    else:
        candidates = (
            await session.scalars(select(InstanceSnapshot).order_by(InstanceSnapshot.created_at, InstanceSnapshot.id))
        ).all()
        examined = list(candidates) if include_all else [item for item in candidates if await _is_stale(session, item)]
        everything = include_all
    entries = [await describe(session, snapshot) for snapshot in examined]
    listed = [item for item in entries if everything or item["status"] not in HEALTHY]
    return {
        "tool": "diagnose_snapshots",
        "readOnly": True,
        "toolchain": await toolchain_facts(),
        "examined": len(entries),
        "listed": len(listed),
        "byStatus": dict(sorted(Counter(item["status"] for item in entries).items())),
        "notFound": not_found,
        "snapshots": listed,
    }


def secrets_of(settings: Any) -> list[str]:
    """Every configured secret value of the existing ``Settings`` (and the database password), for redaction."""
    found: list[str] = []
    for name in type(settings).model_fields:
        value = getattr(settings, name, None)
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        if isinstance(value, str) and value and _SECRET_FIELD.search(name):
            found.append(value)
    url = getattr(settings, "database_url", None)
    if url:
        try:
            password = make_url(url).password
        except Exception:  # noqa: BLE001 - an unparsable URL is redacted whole
            password = url
        found.extend(item for item in (password, url) if item)
    return found


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only diagnosis of snapshots that cannot be compiled again.")
    parser.add_argument("--snapshot", action="append", default=[], metavar="ID", help="Examine and list exactly this snapshot id (repeatable).")
    parser.add_argument("--all", action="store_true", help="Examine and list every snapshot, current and recompilable ones too.")
    parser.add_argument("--verbose", action="store_true")
    return parser


async def _run(snapshot_ids: Sequence[uuid.UUID], include_all: bool) -> int:
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db import base as db_base

    settings = get_settings()
    if not settings.database_url:
        print("no DATABASE_URL configured", file=sys.stderr)
        return EXIT_GUARD
    redactor = Redactor(secrets_of(settings))
    db_base.init_engine(settings.database_url)
    try:
        async with db_base.session_factory()() as session:
            try:
                if session.get_bind().dialect.name == "postgresql":
                    await session.execute(text("SET TRANSACTION READ ONLY"))
                report = await build_report(session, snapshot_ids=snapshot_ids, include_all=include_all)
            finally:
                await session.rollback()  # never a commit: the transaction only ever read
    finally:
        await db_base.dispose_engine()
    emit_report(report, redactor)
    return EXIT_OK


def emit_report(report: Mapping[str, Any], redactor: Redactor, stream: Any = None) -> None:
    """Print the report as one JSON document with the configured secrets removed.

    Unlike ``emit_json`` it does not run the pattern redaction of free text over the values: the compiler's
    message must stay exactly what it said (``unexpected token: x`` is not a credential). The messages were
    already stripped of credential forms when the refusal was built (``services.snapshots.compile_refusal``).
    """
    document = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True, default=str)
    print(redactor.exact(document), file=stream or sys.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    try:
        snapshot_ids = [uuid.UUID(item) for item in args.snapshot]
    except ValueError as exc:
        print(f"--snapshot takes snapshot ids (UUIDs): {exc}", file=sys.stderr)
        return EXIT_GUARD
    if args.all and snapshot_ids:
        print("--all and --snapshot cannot be combined", file=sys.stderr)
        return EXIT_GUARD
    if "SCHEMAS_DIR" not in os.environ:
        for candidate in (Path("/app/schemas"), Path(__file__).resolve().parents[2] / "schemas"):
            if (candidate / "bim" / "v1").is_dir():
                os.environ["SCHEMAS_DIR"] = str(candidate)
                break
    try:
        return asyncio.run(_run(snapshot_ids, args.all))
    except Exception as exc:  # noqa: BLE001 - one redacted line, no traceback that could echo a credential
        print(Redactor().error(exc), file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
