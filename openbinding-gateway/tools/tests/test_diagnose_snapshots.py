"""diagnose_snapshots: a read-only report of the snapshots that cannot be compiled again.

Synthetic snapshots on SQLite: one whose stored package the installed compiler accepts, one it reads and
refuses, one it cannot read. The report must carry the exact refusal, say who reaches the snapshot, stay
identical from run to run, and change nothing (no write statement, no commit, the database file byte for byte).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import diagnose_snapshots as tool
from bim_core.package import InstancePackage, load_package
from openbinding_gateway.db.base import Base
from openbinding_gateway.db.models import BindingIRSnapshot, InstanceSnapshot, Job, JobState, User, UserRole
from openbinding_gateway.db.platform_models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    Project,
    Visibility,
)
from openbinding_gateway.services.snapshots import compile_resolved, persist_snapshot

REPO_ROOT = Path(os.environ.get("OPENBINDING_REPO_ROOT", Path(__file__).resolve().parents[3]))
SIMPLE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
NOT_A_PACKAGE = b"this is not a package"


def refused_package() -> bytes:
    """Readable, and refused by the compiler: the last task of the workflow is not declared."""
    files = dict(load_package(SIMPLE).files)
    application = json.loads(files["application.json"])
    application["spec"]["workflow"]["sequence"][2]["task"]["id"] = "undeclared"
    files["application.json"] = json.dumps(application).encode()
    return InstancePackage(files).to_zip()


def make_user() -> User:
    return User(
        username=f"user{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash", role=UserRole.USER, plan_cache="BASIC",
    )


async def stale_snapshot(session, owner: User, archive: bytes | None = None) -> str:
    """A snapshot of the simple package as a previous release stored it, with ``archive`` as its stored package."""
    compilation = await compile_resolved(load_package(SIMPLE).to_zip(), session, owner)
    stored = uuid.UUID(await persist_snapshot(compilation, owner, session))
    ir = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == stored))
    old = json.loads(json.dumps(ir.document))
    old["spec"]["profile"]["version"] = "1.0.0+previous-release"
    ir.document = old
    snapshot = await session.get(InstanceSnapshot, stored)
    snapshot.compilation_digest = "sha256-" + uuid.uuid4().hex * 2  # each aged snapshot is its own identity
    if archive is not None:
        snapshot.source_archive = archive
    await session.commit()
    return str(stored)


async def pin(session, owner: User, snapshot_id: str, slug: str = "cutover") -> BindingCaseRevision:
    organization = Organization(
        slug=slug, name=slug.title(), parent_id=None, billing_sponsor_user_id=owner.id, created_by_id=owner.id
    )
    session.add(organization)
    await session.flush()
    project = Project(
        organization_id=organization.id, slug="project-a", name="A", description="", visibility=Visibility.PRIVATE,
        created_by_id=owner.id,
    )
    session.add(project)
    await session.flush()
    case = BindingCase(project_id=project.id, slug="case-a", name="C", description="", created_by_id=owner.id)
    session.add(case)
    await session.flush()
    revision = BindingCaseRevision(
        binding_case_id=case.id, revision=3, digest="sha256-" + "1" * 64, document={},
        source_snapshot_id=uuid.UUID(snapshot_id), created_by_id=owner.id,
    )
    session.add(revision)
    await session.commit()
    return revision


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    account = make_user()
    db_session.add(account)
    await db_session.commit()
    return account


def by_id(report: dict) -> dict[str, dict]:
    return {item["snapshotId"]: item for item in report["snapshots"]}


# -- what the report says -------------------------------------------------------------------------


async def test_a_package_that_compiles_is_recompilable_and_not_listed_by_default(db_session, owner):
    good = await stale_snapshot(db_session, owner)
    await pin(db_session, owner, good)

    report = await tool.build_report(db_session)

    assert (report["examined"], report["listed"], report["snapshots"]) == (1, 0, [])
    assert report["byStatus"] == {"recompilable": 1}
    asked = by_id(await tool.build_report(db_session, snapshot_ids=[uuid.UUID(good)]))[good]
    assert (asked["status"], asked["code"], asked["compilesWithInstalledToolchain"], asked["stillTheSamePackage"]) == (
        "recompilable", None, True, True
    )
    assert asked["storedIrIsInstalledToolchain"] is False and asked["compilerError"] is None
    assert asked["currentPackageDigest"] == asked["packageDigest"]


async def test_a_refused_package_is_listed_with_the_exact_error_and_who_reaches_it(db_session, owner):
    refused = await stale_snapshot(db_session, owner, refused_package())
    revision = await pin(db_session, owner, refused)
    db_session.add(Job(
        owner_id=owner.id, engine_id="x", engine_job_id="x", service_url="https://example.invalid",
        state=JobState.COMPLETED, instance_snapshot_id=uuid.UUID(refused),
    ))
    await db_session.commit()

    report = await tool.build_report(db_session)

    assert (report["tool"], report["readOnly"], report["examined"], report["listed"]) == ("diagnose_snapshots", True, 1, 1)
    assert report["byStatus"] == {"not_recompilable": 1} and report["notFound"] == []
    [entry] = report["snapshots"]
    assert entry["snapshotId"] == refused and entry["ownerId"] == str(owner.id)
    assert (entry["status"], entry["code"]) == ("not_recompilable", "invalid_instance")
    assert (entry["compilesWithInstalledToolchain"], entry["stillTheSamePackage"]) == (False, None)
    error = entry["compilerError"]
    assert (error["verdict"], error["code"]) == ("invalid_package", "invalid_instance")
    assert error["diagnosticCount"] == len(error["diagnostics"]) >= 1
    assert all(item["code"] and item["message"] for item in error["diagnostics"])
    [reference] = entry["pinnedBy"]
    assert (reference["organizationSlug"], reference["projectSlug"], reference["caseSlug"], reference["revision"]) == (
        "cutover", "project-a", "case-a", 3
    )
    assert reference["revisionId"] == str(revision.id) and reference["revisionDigest"] == revision.digest
    assert entry["jobsUsingIt"] == 1
    stored = await db_session.get(InstanceSnapshot, uuid.UUID(refused))
    assert entry["packageDigest"] == stored.package_digest and entry["instanceDigest"] == stored.instance_digest
    assert entry["storedCompilationDigest"] == stored.compilation_digest
    assert entry["archiveBytes"] > 0 and entry["archiveDigest"].startswith("sha256-")
    assert "password" not in json.dumps(report).lower()


async def test_a_corrupt_package_is_unreadable_not_invalid(db_session, owner):
    corrupt = await stale_snapshot(db_session, owner, NOT_A_PACKAGE)

    [entry] = (await tool.build_report(db_session))["snapshots"]

    assert entry["snapshotId"] == corrupt and entry["status"] == "not_recompilable"
    assert entry["compilerError"]["verdict"] == "unreadable_package"
    assert entry["code"] == entry["compilerError"]["code"] != "invalid_instance"
    assert NOT_A_PACKAGE.decode() not in json.dumps(entry)
    assert entry["pinnedBy"] == [] and entry["jobsUsingIt"] == 0


async def test_the_three_kinds_together_list_only_the_two_that_are_not_recompilable_in_a_stable_order(db_session, owner):
    good = await stale_snapshot(db_session, owner)
    refused = await stale_snapshot(db_session, owner, refused_package())
    corrupt = await stale_snapshot(db_session, owner, NOT_A_PACKAGE)

    first = await tool.build_report(db_session)
    second = await tool.build_report(db_session)

    assert first == second  # the same document, run after run
    assert first["byStatus"] == {"not_recompilable": 2, "recompilable": 1} and first["examined"] == 3
    assert {item["snapshotId"] for item in first["snapshots"]} == {refused, corrupt} and good not in by_id(first)


async def test_all_lists_every_snapshot_and_an_unknown_id_is_reported(db_session, owner):
    good = await stale_snapshot(db_session, owner)
    missing = uuid.uuid4()

    everything = await tool.build_report(db_session, include_all=True)
    asked = await tool.build_report(db_session, snapshot_ids=[uuid.UUID(good), missing, uuid.UUID(good)])

    assert [item["snapshotId"] for item in everything["snapshots"]] == [good]
    assert asked["notFound"] == [str(missing)] and asked["examined"] == 1 and list(by_id(asked)) == [good]


async def test_a_snapshot_the_installed_toolchain_compiled_is_not_examined_by_default(db_session, owner):
    compilation = await compile_resolved(load_package(SIMPLE).to_zip(), db_session, owner)
    current = await persist_snapshot(compilation, owner, db_session)
    await db_session.commit()

    assert (await tool.build_report(db_session))["examined"] == 0
    [entry] = (await tool.build_report(db_session, include_all=True))["snapshots"]
    assert (entry["snapshotId"], entry["status"], entry["storedIrIsInstalledToolchain"]) == (current, "current", True)


# -- it changes nothing -----------------------------------------------------------------------------


async def test_building_the_report_writes_nothing_and_commits_nothing(db_session, owner):
    refused = await stale_snapshot(db_session, owner, refused_package())
    await pin(db_session, owner, refused)
    await stale_snapshot(db_session, owner)
    corrupt = await stale_snapshot(db_session, owner, NOT_A_PACKAGE)
    engine = db_session.bind.sync_engine
    writes: list[str] = []
    commits: list[str] = []

    def watch(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().split(None, 1)[0].upper() in {"INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER"}:
            writes.append(statement)

    event.listen(engine, "before_cursor_execute", watch)
    event.listen(engine, "commit", lambda conn: commits.append("commit"))
    try:
        await tool.build_report(db_session, include_all=True)
        await tool.build_report(db_session, snapshot_ids=[uuid.UUID(corrupt)])
        assert not (db_session.new or db_session.dirty or db_session.deleted)
        await db_session.rollback()
    finally:
        event.remove(engine, "before_cursor_execute", watch)

    assert writes == [] and commits == []


def test_the_command_reads_the_database_and_leaves_the_file_untouched(tmp_path, monkeypatch, capsys):
    from openbinding_gateway.core.settings import get_settings

    url = f"sqlite+aiosqlite:///{tmp_path / 'lab.db'}"

    async def populate() -> tuple[str, str]:
        engine = create_async_engine(url)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            account = make_user()
            session.add(account)
            await session.commit()
            refused = await stale_snapshot(session, account, refused_package())
            await pin(session, account, refused)
            good = await stale_snapshot(session, account)
        await engine.dispose()
        return refused, good

    refused, good = asyncio.run(populate())
    database = tmp_path / "lab.db"
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    monkeypatch.setattr(get_settings(), "database_url", url)

    assert tool.main([]) == 0
    default = json.loads(capsys.readouterr().out)
    assert tool.main(["--snapshot", good, "--snapshot", refused]) == 0
    asked = json.loads(capsys.readouterr().out)

    assert [item["snapshotId"] for item in default["snapshots"]] == [refused]
    assert sorted(by_id(asked)) == sorted([good, refused])
    assert default["toolchain"]["mode"] and "compilerDigest" in default["toolchain"]
    assert hashlib.sha256(database.read_bytes()).hexdigest() == before


def test_the_command_refuses_bad_arguments_and_a_missing_database(monkeypatch, capsys):
    from openbinding_gateway.core.settings import get_settings

    assert tool.main(["--snapshot", "not-a-uuid"]) == 2
    assert tool.main(["--all", "--snapshot", str(uuid.uuid4())]) == 2
    monkeypatch.setattr(get_settings(), "database_url", None)
    assert tool.main([]) == 2
    assert "DATABASE_URL" in capsys.readouterr().err


def test_the_secrets_of_the_settings_are_removed_from_the_output(capsys):
    from openbinding_gateway.core.settings import Settings

    jwt = "jwt-secret-value-" + "456" * 12  # the settings insist on 32 characters at least
    settings = Settings(database_url="postgresql+asyncpg://lab:pw-in-the-url-123@db:5432/lab", gateway_jwt_secret=jwt)
    secrets = tool.secrets_of(settings)
    assert "pw-in-the-url-123" in secrets and jwt in secrets

    tool.emit_report(
        {"message": f"failed at postgresql+asyncpg://lab:pw-in-the-url-123@db:5432/lab with {jwt}",
         "compiler": "unexpected token: x"},
        tool.Redactor(secrets),
    )
    out = capsys.readouterr().out
    assert "pw-in-the-url-123" not in out and jwt not in out
    assert "unexpected token: x" in out  # the compiler's own words are not mangled
