"""A stale snapshot whose stored package the installed compiler refuses: kept, diagnosed, and honestly not runnable.

``recompile_stale_snapshots`` leaves a snapshot as it was when its package does not compile again. These tests
age a snapshot as a previous toolchain release would have stored it (``test_ir_cutover.age_snapshot``) and give
it three kinds of stored package, all synthetic: one the compiler accepts (it is recompiled), one it reads but
refuses (``invalid_instance``), and one it cannot read at all. The rules pinned here (docs/qa/SNAPSHOT_INVALID_INSTANCE.md):

* the refusal is reported with the compiler's exact, stable, redacted findings, not just a code;
* nothing is deleted, hidden or rewritten: package, IR, revision and digests stay byte for byte;
* launching it answers ``422 snapshot_not_recompilable`` (not the ``contract_not_installed`` that says to
  recompile) with the reason, writes no job, and a toolchain that is merely unavailable is never taken for a verdict;
* a recompilable one still answers ``contract_not_installed`` until recompiled.

SQLite, no network.
"""

from __future__ import annotations

import json
import uuid

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select

from bim_core.package import load_package
from openbinding_gateway.db.models import (
    BindingIRSnapshot,
    InstanceResource,
    InstanceSnapshot,
    Job,
    JobState,
    User,
)
from openbinding_gateway.db.platform_models import BindingCaseRevision
from openbinding_gateway.integrations import bim
from openbinding_gateway.services import snapshots
from openbinding_gateway.services.job_submission import JobSubmission
from openbinding_gateway.services.snapshots import (
    NOT_RECOMPILABLE,
    NOT_RECOMPILABLE_MESSAGE,
    compile_refusal,
    diagnose_snapshot,
    persist_snapshot,
    recompile_stale_snapshots,
    snapshot_ir,
)
from test_ir_cutover import (
    OPTIMIZATION,
    PREVIOUS_RELEASE,
    SIMPLE,
    age_snapshot,
    count,
    launch_request,
    snapshot_ir_problem,
    stored_ir,
)
from test_snapshot_recompile import make_user, refused_package, stale_pinned

NOT_A_PACKAGE = b"this is not a package"


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    return await make_user(db_session)


@pytest_asyncio.fixture
async def stale(db_session, owner) -> str:
    """The id of a snapshot a previous release compiled, pinned by a case revision of ``owner``."""
    return await stale_pinned(db_session, owner)


async def store_archive(session, snapshot_id: str, archive: bytes) -> None:
    """What an old compiler could have accepted and the installed one does not: the stored package is another one."""
    snapshot = await session.get(InstanceSnapshot, uuid.UUID(snapshot_id))
    snapshot.source_archive = archive
    await session.commit()


async def fingerprint(session, snapshot_id: str) -> dict:
    """Everything stored for the snapshot, read from the database (not from the session's objects)."""
    identifier = uuid.UUID(snapshot_id)
    snapshot = (
        await session.execute(
            select(
                InstanceSnapshot.id, InstanceSnapshot.owner_id, InstanceSnapshot.name, InstanceSnapshot.package_digest,
                InstanceSnapshot.instance_digest, InstanceSnapshot.compilation_digest, InstanceSnapshot.root_document,
                InstanceSnapshot.resource_digests, InstanceSnapshot.source_archive,
            ).where(InstanceSnapshot.id == identifier)
        )
    ).one()
    ir = (
        await session.execute(
            select(BindingIRSnapshot.ir_digest, BindingIRSnapshot.document, BindingIRSnapshot.source_map)
            .where(BindingIRSnapshot.snapshot_id == identifier)
        )
    ).one()
    resources = (
        await session.execute(
            select(InstanceResource.resource_id, InstanceResource.digest, InstanceResource.content)
            .where(InstanceResource.snapshot_id == identifier).order_by(InstanceResource.resource_id)
        )
    ).all()
    revisions = (
        await session.execute(
            select(BindingCaseRevision.id, BindingCaseRevision.digest, BindingCaseRevision.source_snapshot_id)
            .where(BindingCaseRevision.source_snapshot_id == identifier)
        )
    ).all()
    return {
        "snapshot": tuple(snapshot), "ir": tuple(ir),
        "resources": [tuple(row) for row in resources], "revisions": [tuple(row) for row in revisions],
    }


async def snapshot_of(session, snapshot_id: str) -> InstanceSnapshot:
    return await session.get(InstanceSnapshot, uuid.UUID(snapshot_id), populate_existing=True)


# -- a valid package: recompiled ---------------------------------------------------------------------


async def test_a_package_the_compiler_accepts_is_diagnosed_recompilable_and_recompiled(db_session, owner, stale):
    diagnosis = await diagnose_snapshot(db_session, await snapshot_of(db_session, stale))

    assert (diagnosis.status, diagnosis.code, diagnosis.compiles, diagnosis.identity_matches) == ("recompilable", None, True, True)
    assert diagnosis.ir_installed is False and diagnosis.refusal is None
    # Until it is recompiled, a launch says to recompile; it does not call the package refused.
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale)) == "contract_not_installed"

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert report.changed and report.failures == () and report.failed == ()
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale)) is None
    assert (await diagnose_snapshot(db_session, await snapshot_of(db_session, stale))).status == "current"


# -- a package the compiler refuses: kept, reported, not runnable --------------------------------------


async def test_a_refused_package_is_reported_with_the_compilers_findings_and_nothing_is_touched(db_session, owner, stale):
    await store_archive(db_session, stale, refused_package())
    before = await fingerprint(db_session, stale)

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()

    assert not report.changed
    [failure] = report.failures
    assert report.failed == ((stale, "invalid_instance"),)
    refusal = failure.refusal
    assert (refusal.verdict, refusal.code, refusal.about_the_package) == ("invalid_package", "invalid_instance", True)
    assert refusal.diagnostic_count == len(refusal.diagnostics) >= 1
    for finding in refusal.diagnostics:
        assert finding["code"] and finding["message"]
    # Kept: package, IR (still the previous release's), digests, resources, and the revision that pins it.
    assert await fingerprint(db_session, stale) == before
    assert await count(db_session, InstanceSnapshot) == await count(db_session, BindingIRSnapshot) == 1
    assert not bim.ir_is_installed(await stored_ir(db_session, stale))
    revision = (await db_session.scalars(select(BindingCaseRevision))).one()
    assert revision.source_snapshot_id == uuid.UUID(stale)


async def test_the_findings_are_stable_from_one_run_to_the_next(db_session, owner, stale):
    await store_archive(db_session, stale, refused_package())

    first = [item.refusal.as_dict() for item in (await recompile_stale_snapshots(db_session)).failures]
    second = [item.refusal.as_dict() for item in (await recompile_stale_snapshots(db_session)).failures]
    diagnosis = await diagnose_snapshot(db_session, await snapshot_of(db_session, stale))

    assert first == second == [diagnosis.refusal.as_dict()] and first


async def test_launching_a_refused_snapshot_is_snapshot_not_recompilable_with_the_reason_and_writes_no_job(
    db_session, owner, stale
):
    await store_archive(db_session, stale, refused_package())
    before = await fingerprint(db_session, stale)

    result = await JobSubmission(db_session, owner).submit(launch_request(stale))

    assert (result.kind, result.status) == ("problem", 422)
    assert result.body["code"] == NOT_RECOMPILABLE == "snapshot_not_recompilable"
    assert result.body["detail"] == NOT_RECOMPILABLE_MESSAGE
    assert "kept" in result.body["detail"] and "upload it again" in result.body["detail"]
    assert result.body["reason"]["code"] == "invalid_instance"
    assert result.body["reason"]["diagnostics"] and result.body["reason"]["diagnosticCount"] >= 1
    assert PREVIOUS_RELEASE not in json.dumps(result.body) and stale not in json.dumps(result.body)
    assert await count(db_session, Job) == 0
    assert await fingerprint(db_session, stale) == before


async def test_over_http_a_refused_snapshot_answers_422_snapshot_not_recompilable(api_client, db_session, registration):
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201
    login = await api_client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    uploaded = await api_client.post(
        "/v1/instances", headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=load_package(SIMPLE).to_zip(),
    )
    assert uploaded.status_code == 201, uploaded.text
    snapshot_id = uploaded.json()["id"]
    await age_snapshot(db_session, snapshot_id)
    await store_archive(db_session, snapshot_id, refused_package())

    launch = await api_client.post(
        "/v1/jobs", headers=headers,
        json={"snapshot": snapshot_id, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )

    assert launch.status_code == 422, launch.text
    body = launch.json()
    assert body["code"] == "snapshot_not_recompilable" and body["detail"] == NOT_RECOMPILABLE_MESSAGE
    assert body["reason"]["code"] == "invalid_instance" and body["reason"]["diagnostics"]
    assert PREVIOUS_RELEASE not in launch.text
    assert await count(db_session, Job) == 0


async def test_fixing_the_source_makes_a_new_snapshot_and_keeps_the_old_one(db_session, owner, stale):
    """Repaired is not deleted: the corrected package is another snapshot; the refused one stays as evidence."""
    await store_archive(db_session, stale, refused_package())
    before = await fingerprint(db_session, stale)

    fixed = await persist_snapshot(
        await snapshots.compile_resolved(load_package(SIMPLE).to_zip(), db_session, owner), owner, db_session
    )
    await db_session.commit()

    assert fixed != stale and await count(db_session, InstanceSnapshot) == 2
    assert await fingerprint(db_session, stale) == before
    assert await snapshot_ir_problem(db_session, uuid.UUID(fixed)) is None
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale)) == NOT_RECOMPILABLE


# -- a corrupt package ------------------------------------------------------------------------------


async def test_a_corrupt_package_is_unreadable_not_invalid_and_is_kept(db_session, owner, stale):
    await store_archive(db_session, stale, NOT_A_PACKAGE)
    before = await fingerprint(db_session, stale)

    report = await recompile_stale_snapshots(db_session)
    await db_session.commit()
    diagnosis = await diagnose_snapshot(db_session, await snapshot_of(db_session, stale))

    [failure] = report.failures
    assert failure.refusal.verdict == "unreadable_package" and failure.refusal.about_the_package
    assert failure.code == failure.refusal.code and failure.code != "invalid_instance"
    assert (diagnosis.status, diagnosis.compiles) == ("not_recompilable", False)
    assert diagnosis.code == failure.code
    assert await fingerprint(db_session, stale) == before
    result = await JobSubmission(db_session, owner).submit(launch_request(stale))
    assert (result.status, result.body["code"], result.body["reason"]["code"]) == (422, NOT_RECOMPILABLE, failure.code)
    assert NOT_A_PACKAGE.decode() not in json.dumps(result.body)


# -- other ways of not being recompilable, and ways of not knowing -------------------------------------


async def test_a_package_read_as_another_one_is_not_recompilable_and_says_so(db_session, owner, stale):
    snapshot = await snapshot_of(db_session, stale)
    snapshot.package_digest = "sha256-" + "f" * 64
    await db_session.commit()

    diagnosis = await diagnose_snapshot(db_session, snapshot)
    with pytest.raises(HTTPException) as refused:
        await snapshot_ir(snapshot, db_session)

    assert (diagnosis.status, diagnosis.code, diagnosis.compiles, diagnosis.identity_matches) == (
        "not_recompilable", "snapshot_identity_changed", True, False
    )
    assert refused.value.status_code == 422
    assert refused.value.detail["code"] == NOT_RECOMPILABLE
    assert refused.value.detail["reason"]["code"] == "snapshot_identity_changed"
    assert refused.value.detail["reason"]["message"]


async def test_a_copy_that_a_job_uses_blocks_but_is_not_a_verdict_on_the_package(db_session, owner, stale):
    current = await snapshot_of(db_session, stale)
    twin = await persist_snapshot(await snapshots.compile_resolved(current.source_archive, db_session, owner), owner, db_session)
    db_session.add(Job(
        owner_id=owner.id, engine_id="cutover-test", engine_job_id="cutover-test", service_url="https://example.invalid",
        state=JobState.COMPLETED, instance_snapshot_id=uuid.UUID(twin),
    ))
    await db_session.commit()

    diagnosis = await diagnose_snapshot(db_session, current)

    assert (diagnosis.status, diagnosis.code) == ("blocked", "snapshot_conflict")
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale)) == "contract_not_installed"


@pytest.mark.parametrize("unavailable", [
    HTTPException(503, detail={"code": "bim_unavailable", "message": "The BIM toolchain is unavailable; retry shortly"}),
    HTTPException(502, detail={"code": "bim_service_error", "message": "The BIM toolchain answered unexpectedly"}),
])
async def test_a_toolchain_that_does_not_answer_is_not_a_verdict_on_the_package(
    db_session, owner, stale, monkeypatch, unavailable
):
    await store_archive(db_session, stale, refused_package())

    async def away(*_args, **_kwargs):
        raise unavailable

    monkeypatch.setattr(snapshots, "compile_resolved", away)

    diagnosis = await diagnose_snapshot(db_session, await snapshot_of(db_session, stale))
    report = await recompile_stale_snapshots(db_session)

    assert (diagnosis.status, diagnosis.compiles) == ("undetermined", None)
    assert diagnosis.refusal.verdict == "unavailable" and not diagnosis.refusal.about_the_package
    assert [item.refusal.verdict for item in report.failures] == ["unavailable"]
    # It is not marked: the launch still says to recompile, because nothing is known about the package.
    assert await snapshot_ir_problem(db_session, uuid.UUID(stale)) == "contract_not_installed"


async def test_a_snapshot_without_an_ir_row_is_reported_as_such(db_session, owner, stale):
    stored = await db_session.scalar(select(BindingIRSnapshot).where(BindingIRSnapshot.snapshot_id == uuid.UUID(stale)))
    await db_session.delete(stored)
    await db_session.commit()

    diagnosis = await diagnose_snapshot(db_session, await snapshot_of(db_session, stale))

    assert (diagnosis.status, diagnosis.code, diagnosis.ir_installed) == ("ir_missing", "snapshot_ir_missing", None)


# -- the refusal in stable, redacted terms -------------------------------------------------------------


def test_a_refusal_keeps_the_codes_and_pointers_and_redacts_the_text():
    leaky = HTTPException(422, detail={
        "code": "invalid_instance",
        "message": "The BIM source was refused: Authorization: Bearer abc.def.ghi-secret",
        "diagnostics": [
            {"code": "unknown_task", "message": "token leak: Authorization: Bearer abc.def.ghi-secret", "resource": "application.json",
             "pointer": "/spec/workflow/sequence/0/task/id"},
            *({"code": f"extra_{n}", "message": "m " * 400} for n in range(8)),
        ],
    })

    refusal = compile_refusal(leaky)

    assert (refusal.verdict, refusal.code, refusal.diagnostic_count) == ("invalid_package", "invalid_instance", 9)
    assert len(refusal.diagnostics) == 5  # bounded
    assert refusal.diagnostics[0]["code"] == "unknown_task"
    assert refusal.diagnostics[0]["pointer"] == "/spec/workflow/sequence/0/task/id"
    assert refusal.diagnostics[0]["resource"] == "application.json"
    assert "abc.def.ghi-secret" not in json.dumps(refusal.as_dict())
    assert all(len(item["message"]) <= 300 for item in refusal.diagnostics)


def test_an_unexpected_exception_names_only_its_type():
    refusal = compile_refusal(KeyError("password=hunter2 in /srv/private/path"))

    assert (refusal.verdict, refusal.code) == ("error", "KeyError")
    assert "hunter2" not in json.dumps(refusal.as_dict()) and not refusal.about_the_package
