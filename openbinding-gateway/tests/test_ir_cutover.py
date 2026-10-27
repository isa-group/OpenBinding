"""A snapshot compiled by another release of bim-toolchain: a stable refusal, and a recompilation.

Persisted snapshots keep the IR the toolchain returned and the package it was compiled from. After a
release that changes the IR (a new ``compilerDigest``), the stored IR pins a Profile and Dialects that are
not installed: every operation on it is refused. These tests age a snapshot the way that release would
(``aged``), then pin what the gateway promises (``docs/qa/IR_CUTOVER.md``): the refusal is the same
``422 contract_not_installed`` that says to recompile, never a 500 and never a stored value; the package is
compiled again and the IR of the snapshot that a sealed case revision pins is replaced in place (every id
stays), and the seed of the lab does it idempotently without touching users, organizations, projects or cases.

Synthetic data, SQLite. There is no migration in this cut-over (nothing is purged); the sealing of the
revisions is the one rule the PostgreSQL triggers enforce differently from SQLite, and
``recompile_stale_snapshots`` does not write them. The removal of a duplicate copy of a package (and the
isolation between owners and the rollback of a failed run) is repeated on a real PostgreSQL in
``tests/test_duplicate_copy_purge_pg.py``; a snapshot whose package the compiler refuses is
``tests/test_snapshot_invalid_instance.py``.
"""

from __future__ import annotations

import copy
import json
import sys
import uuid

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import func, select

from _paths import GATEWAY_ROOT
from _pricing import pricing_catalog
from _repo import REPO_ROOT

_tools_dir = str(GATEWAY_ROOT / "tools")
if _tools_dir not in sys.path:
    sys.path.insert(0, _tools_dir)

import seed_lab  # noqa: E402

from bim_core.compiler import compile_instance  # noqa: E402
from bim_core.package import load_package  # noqa: E402
from openbinding_gateway.db.models import (  # noqa: E402
    BindingIRSnapshot,
    InstanceSnapshot,
    Job,
    JobState,
    User,
    UserRole,
)
from openbinding_gateway.db.platform_models import (  # noqa: E402
    BindingCase,
    BindingCaseRevision,
    Organization,
    Project,
    Visibility,
)
from openbinding_gateway.integrations import bim  # noqa: E402
from openbinding_gateway.services.job_submission import JobSubmission, JobSubmissionInput  # noqa: E402
from openbinding_gateway.services.snapshots import (  # noqa: E402
    compile_resolved,
    persist_snapshot,
    recompile_stale_snapshots,
    snapshot_ir,
)

EXAMPLES = REPO_ROOT / "examples"
SIMPLE = EXAMPLES / "demo" / "01_simple_seq"
PASSWORD = "synthetic-lab-password-1"
PREVIOUS_RELEASE = "1.0.0+previous-release"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


def aged(document: dict) -> dict:
    """The IR as the previous release stored it: the Profile and Dialects it pinned are not the installed ones."""
    old = copy.deepcopy(document)
    old["spec"]["profile"]["version"] = PREVIOUS_RELEASE
    for dialect in old["spec"]["dialects"]:
        dialect["adapter"]["digest"] = "sha256-" + "0" * 64
    return old


async def age_snapshot(session, snapshot_id) -> None:
    """Make a stored snapshot the one the previous release compiled (its compilation digest changes too)."""
    identifier = uuid.UUID(str(snapshot_id))
    stored = await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == identifier))
    stored.document = aged(stored.document)
    snapshot = await session.get(InstanceSnapshot, identifier)
    snapshot.compilation_digest = "sha256-" + "0" * 64
    await session.commit()


async def stored_ir(session, snapshot_id) -> dict:
    return (
        await session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == uuid.UUID(str(snapshot_id))))
    ).document


async def count(session, model) -> int:
    return int((await session.scalar(select(func.count()).select_from(model))) or 0)


@pytest_asyncio.fixture
async def user(db_session) -> User:
    account = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(account)
    await db_session.commit()
    return account


@pytest_asyncio.fixture
async def stale_snapshot_id(db_session, user) -> str:
    compilation = await compile_resolved(load_package(SIMPLE).to_zip(), db_session, user)
    stored = await persist_snapshot(compilation, user, db_session)
    await db_session.commit()
    await age_snapshot(db_session, stored)
    return stored


@pytest_asyncio.fixture
async def pinned_revision(db_session, user, stale_snapshot_id) -> BindingCaseRevision:
    """A case revision that pins the stale snapshot."""
    organization = Organization(
        slug="cutover", name="Cut-over", parent_id=None, billing_sponsor_user_id=user.id, created_by_id=user.id
    )
    db_session.add(organization)
    await db_session.flush()
    project = Project(
        organization_id=organization.id, slug="p", name="P", description="", visibility=Visibility.PRIVATE,
        created_by_id=user.id,
    )
    db_session.add(project)
    await db_session.flush()
    case = BindingCase(project_id=project.id, slug="c", name="C", description="", created_by_id=user.id)
    db_session.add(case)
    await db_session.flush()
    revision = BindingCaseRevision(
        binding_case_id=case.id, revision=1, digest="sha256-" + "1" * 64, document={},
        source_snapshot_id=uuid.UUID(stale_snapshot_id), created_by_id=user.id,
    )
    db_session.add(revision)
    await db_session.commit()
    return revision


def launch_request(snapshot: str) -> JobSubmissionInput:
    return JobSubmissionInput(
        payload={"snapshot": snapshot, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
        idempotency_key=None,
        snapshot_id=snapshot,
    )


# -- the refusal -----------------------------------------------------------------------------------


def test_an_ir_is_installed_only_when_the_toolchain_that_compiled_it_is_the_installed_one():
    document = compile_instance(load_package(SIMPLE)).document
    assert bim.ir_is_installed(document)
    assert not bim.ir_is_installed(aged(document))
    profile_only = copy.deepcopy(document)
    profile_only["spec"]["profile"]["version"] = PREVIOUS_RELEASE
    assert not bim.ir_is_installed(profile_only)
    dialect_only = copy.deepcopy(document)
    dialect_only["spec"]["dialects"][0]["adapter"]["digest"] = "sha256-" + "0" * 64
    assert not bim.ir_is_installed(dialect_only)
    # A document that has no spec is the toolchain's to call malformed, not this check's.
    assert bim.ir_is_installed({}) and bim.ir_is_installed({"spec": []})


async def test_a_launch_on_a_snapshot_of_another_toolchain_is_a_stable_422_and_stores_nothing(
    db_session, user, stale_snapshot_id
):
    result = await JobSubmission(db_session, user).submit(launch_request(stale_snapshot_id))

    assert (result.kind, result.status) == ("problem", 422)
    assert result.body["code"] == "contract_not_installed"
    assert result.body["detail"] == bim.STALE_IR_MESSAGE
    assert "recompile" in result.body["detail"]
    assert PREVIOUS_RELEASE not in json.dumps(result.body) and stale_snapshot_id not in json.dumps(result.body)
    assert await count(db_session, Job) == 0


async def test_reading_the_stored_ir_of_such_a_snapshot_refuses_with_the_same_problem(db_session, user, stale_snapshot_id):
    snapshot = await db_session.get(InstanceSnapshot, uuid.UUID(stale_snapshot_id))
    with pytest.raises(HTTPException) as refused:
        await snapshot_ir(snapshot, db_session)
    assert refused.value.status_code == 422
    assert refused.value.detail == {"code": "contract_not_installed", "message": bim.STALE_IR_MESSAGE}


async def test_over_http_a_stale_snapshot_and_an_old_job_answer_422_never_500(api_client, db_session, registration):
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201
    login = await api_client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    owner = (await db_session.execute(select(User).where(User.username == details["username"]))).scalar_one()
    package = load_package(EXAMPLES / "demo" / "17_analysis_tradeoffs")
    uploaded = await api_client.post(
        "/v1/instances", headers={**headers, "Content-Type": "application/vnd.bim+zip"}, content=package.to_zip()
    )
    assert uploaded.status_code == 201, uploaded.text
    snapshot_id = uploaded.json()["id"]
    problem = compile_instance(package)
    binding = {task: refs[0] for task, refs in problem.document["spec"]["eligibility"].items()}
    solution = {"decision": {"kind": "binding", "binding": binding}, **problem.evaluate(binding)}
    job = Job(
        owner_id=owner.id, engine_id="cutover-test", engine_job_id="cutover-test", service_url="https://example.invalid",
        state=JobState.COMPLETED, instance_snapshot_id=uuid.UUID(snapshot_id), original_request=None,
        provenance={"irDigest": uploaded.json()["irDigest"]}, result={"solutions": [solution]},
    )
    db_session.add(job)
    await db_session.commit()
    analysis = f"/v1/jobs/{job.id}/analysis/neighborhood"
    assert (await api_client.get(analysis, headers=headers)).status_code == 200

    await age_snapshot(db_session, snapshot_id)

    launch = await api_client.post(
        "/v1/jobs",
        headers=headers,
        json={"snapshot": snapshot_id, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert launch.status_code == 422, launch.text
    assert launch.json()["code"] == "contract_not_installed"
    assert launch.json()["detail"] == bim.STALE_IR_MESSAGE
    old_job = await api_client.get(analysis, headers=headers)
    assert old_job.status_code == 422, old_job.text
    assert old_job.json()["code"] == "contract_not_installed"
    assert old_job.json()["detail"] == bim.STALE_IR_MESSAGE
    # What the job already holds stays readable.
    assert (await api_client.get(f"/v1/jobs/{job.id}", headers=headers)).status_code == 200
    assert (await api_client.get(f"/v1/jobs/{job.id}/report", headers=headers)).status_code == 200
    assert PREVIOUS_RELEASE not in launch.text + old_job.text


# -- the recompilation -----------------------------------------------------------------------------


async def test_recompiling_regenerates_the_snapshot_a_revision_pins_and_every_id_stays(
    db_session, user, stale_snapshot_id, pinned_revision
):
    revision_id = pinned_revision.id
    before = await db_session.get(InstanceSnapshot, uuid.UUID(stale_snapshot_id))
    package, instance = before.package_digest, before.instance_digest

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert report.changed and report.failed == ()
    assert report.recompiled == ((stale_snapshot_id, (str(revision_id),)),)
    # The sealed revision is untouched and still pins the same snapshot, which now has the installed toolchain's IR.
    revision = await db_session.get(BindingCaseRevision, revision_id, populate_existing=True)
    assert revision.source_snapshot_id == uuid.UUID(stale_snapshot_id)
    snapshot = await db_session.get(InstanceSnapshot, uuid.UUID(stale_snapshot_id), populate_existing=True)
    assert (snapshot.package_digest, snapshot.instance_digest) == (package, instance)
    assert snapshot.owner_id == user.id and snapshot.compilation_digest != "sha256-" + "0" * 64
    assert bim.ir_is_installed(await stored_ir(db_session, stale_snapshot_id))
    assert await count(db_session, InstanceSnapshot) == await count(db_session, BindingIRSnapshot) == 1
    assert await snapshot_ir_problem(db_session, snapshot.id) is None
    # The same package uploaded again is this snapshot, not a second one.
    again = await persist_snapshot(await compile_resolved(snapshot.source_archive, db_session, user), user, db_session)
    assert again == stale_snapshot_id

    launched = await JobSubmission(db_session, user).submit(launch_request(stale_snapshot_id))
    assert (launched.kind, launched.status) == ("created", 202)


async def test_a_second_recompilation_finds_nothing_to_do(db_session, user, stale_snapshot_id, pinned_revision):
    first = await recompile_stale_snapshots(db_session)
    await db_session.commit()
    stored = await stored_ir(db_session, stale_snapshot_id)

    second = await recompile_stale_snapshots(db_session)

    assert first.changed and not second.changed and second.failed == ()
    assert await stored_ir(db_session, stale_snapshot_id) == stored


async def test_a_snapshot_no_revision_pins_is_left_alone(db_session, user, stale_snapshot_id):
    report = await recompile_stale_snapshots(db_session)

    assert not report.changed and report.failed == ()
    assert not bim.ir_is_installed(await stored_ir(db_session, stale_snapshot_id))


async def test_a_copy_of_the_package_made_after_the_release_is_replaced_by_the_regenerated_snapshot(
    db_session, user, stale_snapshot_id, pinned_revision
):
    """What a seed or an upload run after the release leaves: a second snapshot of the same package, nobody's."""
    stale = await db_session.get(InstanceSnapshot, uuid.UUID(stale_snapshot_id))
    twin_id = await persist_snapshot(await compile_resolved(stale.source_archive, db_session, user), user, db_session)
    await db_session.commit()
    assert twin_id != stale_snapshot_id and await count(db_session, InstanceSnapshot) == 2

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert report.changed and report.failed == ()
    assert await count(db_session, InstanceSnapshot) == await count(db_session, BindingIRSnapshot) == 1
    assert await db_session.get(InstanceSnapshot, uuid.UUID(twin_id), populate_existing=True) is None
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale_snapshot_id)) is None


async def test_a_copy_that_a_job_uses_is_not_removed_and_the_snapshot_stays_refused(
    db_session, user, stale_snapshot_id, pinned_revision
):
    stale = await db_session.get(InstanceSnapshot, uuid.UUID(stale_snapshot_id))
    twin_id = await persist_snapshot(await compile_resolved(stale.source_archive, db_session, user), user, db_session)
    db_session.add(Job(
        owner_id=user.id, engine_id="cutover-test", engine_job_id="cutover-test", service_url="https://example.invalid",
        state=JobState.COMPLETED, instance_snapshot_id=uuid.UUID(twin_id),
    ))
    await db_session.commit()

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert not report.changed and report.failed == ((stale_snapshot_id, "snapshot_conflict"),)
    assert await count(db_session, InstanceSnapshot) == 2
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale_snapshot_id)) == "contract_not_installed"
    assert await snapshot_ir_problem(db_session, uuid.UUID(twin_id)) is None


async def test_a_package_that_cannot_be_compiled_again_is_reported_and_left_alone(
    db_session, user, stale_snapshot_id, pinned_revision
):
    snapshot = await db_session.get(InstanceSnapshot, uuid.UUID(stale_snapshot_id))
    snapshot.source_archive = b"this is not a package"
    await db_session.commit()

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert not report.changed
    [(failed_id, code)] = report.failed
    assert failed_id == stale_snapshot_id and code
    # The package itself is what the installed toolchain cannot read, so recompiling would not help and the
    # launch does not say to (docs/qa/SNAPSHOT_INVALID_INSTANCE.md); the snapshot is kept.
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale_snapshot_id)) == "snapshot_not_recompilable"
    assert await count(db_session, InstanceSnapshot) == 1


async def test_a_package_the_toolchain_reads_as_another_one_is_refused(
    db_session, user, stale_snapshot_id, pinned_revision
):
    snapshot = await db_session.get(InstanceSnapshot, uuid.UUID(stale_snapshot_id))
    snapshot.package_digest = "sha256-" + "f" * 64
    await db_session.commit()

    report = await recompile_stale_snapshots(db_session)

    assert not report.changed and report.failed == ((stale_snapshot_id, "snapshot_identity_changed"),)
    assert not bim.ir_is_installed(await stored_ir(db_session, stale_snapshot_id))


# -- the lab seed ----------------------------------------------------------------------------------


async def test_the_seed_recompiles_a_lab_of_another_toolchain_and_keeps_every_id(db_session):
    first = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    assert first["recompileFailed"] == []
    revision = (await db_session.scalars(select(BindingCaseRevision))).one()
    revision_id, snapshot_id = revision.id, revision.source_snapshot_id
    hashes = {u.username: u.password_hash for u in (await db_session.scalars(select(User))).all()}
    await age_snapshot(db_session, snapshot_id)
    assert await snapshot_ir_problem(db_session, snapshot_id) == "contract_not_installed"

    second = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert second["created"] == [f"recompiled-case-revision:{revision_id}"]
    assert second["recompileFailed"] == []
    assert second["ids"] == first["ids"] and second["ids"]["caseRevision"] == str(revision_id)
    # Nothing was added or removed: the same users, keys, organizations, project, case, revision and snapshots.
    assert second["counts"] == first["counts"]
    revision = await db_session.get(BindingCaseRevision, revision_id, populate_existing=True)
    assert revision.source_snapshot_id == snapshot_id
    assert bim.ir_is_installed(await stored_ir(db_session, snapshot_id))
    assert await snapshot_ir_problem(db_session, snapshot_id) is None
    assert {u.username: u.password_hash for u in (await db_session.scalars(select(User))).all()} == hashes

    third = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert third["created"] == [] and third["recompileFailed"] == []
    assert third["counts"] == second["counts"] and third["ids"] == second["ids"]


async def test_the_seed_removes_the_copy_an_earlier_seed_made_after_the_release(db_session):
    """The lab as found: the seed was run again after the release, which compiled a second snapshot of the package."""
    first = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    revision = (await db_session.scalars(select(BindingCaseRevision))).one()
    snapshot_id = revision.source_snapshot_id
    await age_snapshot(db_session, snapshot_id)
    owner = await db_session.scalar(select(User).where(User.username == "lab-owner"))
    snapshot = await db_session.get(InstanceSnapshot, snapshot_id)
    twin = await persist_snapshot(await compile_resolved(snapshot.source_archive, db_session, owner), owner, db_session)
    await db_session.commit()
    assert twin != str(snapshot_id)
    assert (await seed_lab.count_rows(db_session, {"lab-owner": owner}, {}))["snapshots"] == first["counts"]["snapshots"] + 1

    second = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert second["created"] == [f"recompiled-case-revision:{revision.id}"] and second["recompileFailed"] == []
    assert second["counts"] == first["counts"] and second["ids"] == first["ids"]
    assert await db_session.get(InstanceSnapshot, uuid.UUID(twin), populate_existing=True) is None
    assert await snapshot_ir_problem(db_session, snapshot_id) is None


async def test_the_seed_of_a_current_lab_changes_nothing(db_session):
    first = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)
    second = await seed_lab.seed(db_session, PASSWORD, EXAMPLES)

    assert second["created"] == [] and second["recompileFailed"] == []
    assert second["counts"] == first["counts"]


async def snapshot_ir_problem(session, snapshot_id) -> str | None:
    """The code ``snapshot_ir`` refuses the snapshot with, or ``None`` when it hands the IR back."""
    snapshot = await session.get(InstanceSnapshot, snapshot_id)
    try:
        await snapshot_ir(snapshot, session)
    except HTTPException as exc:
        return exc.detail["code"]
    return None
