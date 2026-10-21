"""``recompile_stale_snapshots`` as a service: its report, its isolation between snapshots and owners, its transaction.

``test_ir_cutover.py`` pins what a deployment sees (the 422, the regenerated IR, the seed). These pin the contract of
the function itself: a snapshot that fails is reported with the compiler's words and does not undo another one that
succeeded, the copy a regenerated snapshot replaces is the same owner's and nobody else's, and nothing is committed
here (the caller does). SQLite; the isolation is repeated, and the rollback only shown, on PostgreSQL in
``test_duplicate_copy_purge_pg.py``.
"""

from __future__ import annotations

import json
import uuid

import pytest_asyncio

from bim_core.package import InstancePackage, load_package
from openbinding_gateway.db.models import BindingIRSnapshot, InstanceSnapshot, User, UserRole
from openbinding_gateway.db.platform_models import (
    BindingCase,
    BindingCaseRevision,
    Organization,
    Project,
    Visibility,
)
from openbinding_gateway.integrations import bim
from openbinding_gateway.services.snapshots import (
    RecompileFailure,
    compile_resolved,
    persist_snapshot,
    recompile_stale_snapshots,
)
from _pricing import pricing_catalog
from test_ir_cutover import SIMPLE, age_snapshot, count, snapshot_ir_problem, stored_ir


def refused_package() -> bytes:
    files = dict(load_package(SIMPLE).files)
    application = json.loads(files["application.json"])
    application["spec"]["workflow"]["sequence"][2]["task"]["id"] = "undeclared"
    files["application.json"] = json.dumps(application).encode()
    return InstancePackage(files).to_zip()


async def make_user(session) -> User:
    account = User(
        username=f"user{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash", role=UserRole.USER, plan_cache=pricing_catalog().default_plan,
    )
    session.add(account)
    await session.commit()
    return account


async def stale_pinned(session, owner: User, *, archive: bytes | None = None) -> str:
    """A snapshot of the simple package that a previous release compiled, pinned by a case revision of ``owner``."""
    stored = await persist_snapshot(await compile_resolved(load_package(SIMPLE).to_zip(), session, owner), owner, session)
    await session.commit()
    await age_snapshot(session, stored)
    if archive is not None:
        (await session.get(InstanceSnapshot, uuid.UUID(stored))).source_archive = archive
    slug = f"org-{uuid.uuid4().hex[:8]}"
    organization = Organization(slug=slug, name=slug, parent_id=None, billing_sponsor_user_id=owner.id, created_by_id=owner.id)
    session.add(organization)
    await session.flush()
    project = Project(
        organization_id=organization.id, slug="p", name="P", description="", visibility=Visibility.PRIVATE,
        created_by_id=owner.id,
    )
    session.add(project)
    await session.flush()
    case = BindingCase(project_id=project.id, slug="c", name="C", description="", created_by_id=owner.id)
    session.add(case)
    await session.flush()
    session.add(BindingCaseRevision(
        binding_case_id=case.id, revision=1, digest="sha256-" + uuid.uuid4().hex * 2, document={},
        source_snapshot_id=uuid.UUID(stored), created_by_id=owner.id,
    ))
    await session.commit()
    return stored


@pytest_asyncio.fixture
async def alice(db_session) -> User:
    return await make_user(db_session)


@pytest_asyncio.fixture
async def bob(db_session) -> User:
    return await make_user(db_session)


async def test_the_failed_pairs_are_the_failures_without_the_findings(db_session, alice):
    refused = await stale_pinned(db_session, alice, archive=refused_package())

    report = await recompile_stale_snapshots(db_session)

    [failure] = report.failures
    assert isinstance(failure, RecompileFailure)
    assert report.failed == ((failure.snapshot_id, failure.code),) == ((refused, "invalid_instance"),)
    assert failure.refusal.verdict == "invalid_package" and failure.refusal.diagnostics
    assert not report.changed and report.recompiled == ()


async def test_a_failure_is_not_a_reason_to_undo_a_snapshot_that_was_recompiled(db_session, alice, bob):
    refused = await stale_pinned(db_session, alice, archive=refused_package())
    good = await stale_pinned(db_session, bob)

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert [item[0] for item in report.recompiled] == [good]
    assert report.failed == ((refused, "invalid_instance"),)
    assert bim.ir_is_installed(await stored_ir(db_session, good))
    assert not bim.ir_is_installed(await stored_ir(db_session, refused))
    assert await snapshot_ir_problem(db_session, uuid.UUID(good)) is None
    assert await snapshot_ir_problem(db_session, uuid.UUID(refused)) == "snapshot_not_recompilable"
    assert await count(db_session, InstanceSnapshot) == await count(db_session, BindingIRSnapshot) == 2


async def test_the_copy_a_regenerated_snapshot_replaces_is_the_same_owners_and_nobody_elses(db_session, alice, bob):
    stale = await stale_pinned(db_session, alice)
    archive = (await db_session.get(InstanceSnapshot, uuid.UUID(stale))).source_archive
    alices_copy = await persist_snapshot(await compile_resolved(archive, db_session, alice), alice, db_session)
    bobs = await persist_snapshot(await compile_resolved(archive, db_session, bob), bob, db_session)
    await db_session.commit()
    assert len({stale, alices_copy, bobs}) == 3

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert [item[0] for item in report.recompiled] == [stale] and report.failures == ()
    assert await db_session.get(InstanceSnapshot, uuid.UUID(alices_copy), populate_existing=True) is None
    survivor = await db_session.get(InstanceSnapshot, uuid.UUID(bobs), populate_existing=True)
    assert survivor is not None and survivor.owner_id == bob.id
    assert await snapshot_ir_problem(db_session, uuid.UUID(bobs)) is None


async def test_the_function_never_commits_the_caller_does(db_session, alice, monkeypatch):
    """Whether a rollback undoes it is the database's to show: SQLite releases a savepoint outside ``BEGIN`` as a
    commit, so that half is in ``test_duplicate_copy_purge_pg.py``; what is pinned here is that no commit is asked for."""
    stale = await stale_pinned(db_session, alice)
    commits: list[str] = []
    real_commit = db_session.commit

    async def spy() -> None:
        commits.append("commit")
        await real_commit()

    monkeypatch.setattr(db_session, "commit", spy)

    report = await recompile_stale_snapshots(db_session)

    assert report.changed and bim.ir_is_installed(await stored_ir(db_session, stale))
    assert commits == []
