"""The engine's raw answer survives a BIM that cannot evaluate it, and the evaluation can be retried (contract C4).

The answer is written and committed before BIM is called; a BIM failure leaves
the job FAILED with the stable code ``bim_evaluation_failed`` and a reference to
the kept answer (never its body); any success deletes every row of the job; and
``POST /v1/jobs/{id}/reevaluate`` evaluates the kept answer without running the
engine again. Everything here is SQLite with a stubbed engine transport; the
row locks are exercised in ``tests/concurrency/test_job_evidence_pg.py``.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import uuid
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from bim_client import BimServiceError
from bim_core.canonical import digest
from pydantic import ValidationError
from sqlalchemy import func, select, update

from _b1_helpers import gate, make_key  # noqa: F401
from _paths import GATEWAY_ROOT
from _pricing import pricing_catalog
from analysis_b3_b4_b6._helpers import account_with_snapshot, answer, only_job, precondition, submit
from openbinding_gateway.core.public_errors import JOB_FAILURES
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import AuditEvent, Job, JobEngineEvidence, JobState, User, UserRole, utcnow
from openbinding_gateway.integrations import bim
from openbinding_gateway.jobs import evidence as job_evidence
from openbinding_gateway.jobs import reconciler
from openbinding_gateway.jobs.leases import aware
from openbinding_gateway.routes import jobs as jobs_routes
from openbinding_gateway.services import execution
from test_viewer_read_only import (  # noqa: F401
    EXECUTE_SCOPES,
    PROBLEM,
    READ_SCOPES,
    lab,
    no_dispatch,
    organization_job,
)

ROOT = GATEWAY_ROOT

#: Present only in the engine's raw answer, so finding it means the raw answer is exposed or kept.
MARKER = "raw-engine-marker-9e21"

#: Taken before any test patches it.
REAL_REEVALUATE = bim.AsyncBim.reevaluate


def code_of(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    return body.get("code") or body.get("title") or (detail.get("code") if isinstance(detail, dict) else None)


@pytest.fixture
def engine(monkeypatch) -> list[int]:
    """The engine answers with a marked result; the list counts how many times it was asked."""
    solves: list[int] = []

    async def solve(*_args, **_kwargs):
        solves.append(1)
        return answer(engineRun=MARKER)

    monkeypatch.setattr(execution, "solve_remote", solve)
    return solves


@pytest.fixture
def bim_down(monkeypatch) -> list[int]:
    calls: list[int] = []

    async def unavailable(self, *_args, **_kwargs):
        calls.append(1)
        raise BimServiceError("service_unavailable", "the service could not be reached (ConnectError)")

    monkeypatch.setattr(bim.AsyncBim, "reevaluate", unavailable)
    return calls


@pytest.fixture
def bim_back(monkeypatch) -> list[int]:
    """BIM answers again (the real in-process evaluation); the list counts the calls."""
    calls: list[int] = []

    async def reevaluate(self, *args, **kwargs):
        calls.append(1)
        return await REAL_REEVALUATE(self, *args, **kwargs)

    monkeypatch.setattr(bim.AsyncBim, "reevaluate", reevaluate)
    return calls


@pytest.fixture
async def failed(api_client, db_session, registration, engine, bim_down):
    """A personal job whose solve worked and whose evaluation failed because BIM was down."""
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)
    job = await only_job(db_session)
    precondition(job.state is JobState.FAILED, f"the job ended {job.state.value}, not failed")
    return SimpleNamespace(headers=headers, job=job, url=f"/v1/jobs/{job.id}/reevaluate")


@pytest.fixture
async def owner(db_session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(user)
    await db_session.commit()
    return user


async def evidence_rows(session, job_id=None) -> list[JobEngineEvidence]:
    query = select(JobEngineEvidence).order_by(JobEngineEvidence.attempt)
    if job_id is not None:
        query = query.where(JobEngineEvidence.job_id == job_id)
    return list((await session.execute(query)).scalars().all())


async def count_evidence(session, job_id=None) -> int:
    query = select(func.count()).select_from(JobEngineEvidence)
    if job_id is not None:
        query = query.where(JobEngineEvidence.job_id == job_id)
    return (await session.execute(query)).scalar_one()


def canned_evaluation(provenance: dict) -> tuple[dict, dict]:
    final = {**provenance, "engineReported": {}}
    return final, {"termination": "FEASIBLE", "solutions": [], "provenance": final}


# -- What the worker writes ----------------------------------------------------


async def test_the_answer_is_written_and_committed_before_bim_is_asked(
    api_client, db_session, registration, engine, monkeypatch
):
    seen: dict = {}

    async def watching(self, *_args, **_kwargs):
        # No open transaction means the evidence is durable and no row lock is held.
        seen["in_transaction"] = db_session.in_transaction()
        seen["rows"] = await count_evidence(db_session)
        raise BimServiceError("service_unavailable", "down")

    monkeypatch.setattr(bim.AsyncBim, "reevaluate", watching)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)

    await submit(api_client, headers, snapshot_id)

    assert seen == {"in_transaction": False, "rows": 1}


async def test_a_bim_failure_keeps_the_answer_and_fails_the_job_with_a_stable_code(failed, db_session):
    job = failed.job
    [row] = await evidence_rows(db_session, job.id)

    assert job.state is JobState.FAILED
    assert job.termination == "UNKNOWN"
    assert job.result["solutions"] == []
    assert job.result["code"] == "bim_evaluation_failed"
    assert job.result["error"] == JOB_FAILURES["bim_evaluation_failed"]
    assert job.result["evidence"] == {
        "id": str(row.id),
        "digest": row.digest,
        "expiresAt": aware(row.expires_at).isoformat(),
    }
    assert MARKER not in repr(job.result)
    assert row.raw_result["engineRun"] == MARKER
    assert row.attempt == job.attempt == 1
    assert row.digest == digest(row.raw_result)
    retention = aware(row.expires_at) - aware(row.created_at)
    assert abs(retention - timedelta(days=get_settings().evidence_retention_days)) < timedelta(seconds=30)


async def test_the_kept_answer_is_in_no_view_of_the_job(api_client, failed):
    one = await api_client.get(f"/v1/jobs/{failed.job.id}", headers=failed.headers)
    listed = await api_client.get("/v1/jobs", headers=failed.headers)

    assert one.status_code == listed.status_code == 200
    assert MARKER not in one.text and MARKER not in listed.text


async def test_the_evidence_is_not_exposed_by_a_route(api_client, failed):
    from openbinding_gateway.main import app

    response = await api_client.get(f"/v1/jobs/{failed.job.id}/evidence", headers=failed.headers)

    assert response.status_code in (404, 405)
    assert not [path for path in app.openapi()["paths"] if path.endswith("/evidence")]


async def test_a_success_of_any_attempt_deletes_every_row_of_the_job(failed, db_session, bim_back):
    job = failed.job
    db_session.add(
        JobEngineEvidence(
            job_id=job.id, attempt=0, raw_result={"older": True}, digest="sha256:" + "0" * 64,
            expires_at=utcnow() + timedelta(days=1),
        )
    )
    job.state, job.result, job.termination, job.finished_at = JobState.QUEUED, None, None, None
    await db_session.commit()
    precondition(await count_evidence(db_session, job.id) == 2, "the job should hold two rows")

    await execution.finish_persisted_job(str(job.id), db_session)
    await db_session.commit()

    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED
    assert job.attempt == 2
    assert await count_evidence(db_session) == 0


async def test_a_lost_lease_after_the_evidence_commit_deletes_its_own_row(
    api_client, db_session, registration, engine, monkeypatch
):
    async def stolen(self, *args, **kwargs):
        await db_session.execute(update(Job).values(lease_token="someone-else"))
        await db_session.commit()
        return await REAL_REEVALUATE(self, *args, **kwargs)

    monkeypatch.setattr(bim.AsyncBim, "reevaluate", stolen)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert job.state is JobState.RUNNING and job.lease_token == "someone-else"
    assert job.result is None
    assert await count_evidence(db_session) == 0


@pytest.mark.parametrize("evaluation", ["succeeds", "fails"])
async def test_a_cancellation_that_came_in_during_the_evaluation_cancels_the_job(
    api_client, db_session, registration, engine, monkeypatch, evaluation
):
    async def cancelled_meanwhile(self, *args, **kwargs):
        await db_session.execute(update(Job).values(cancellation_requested=True))
        await db_session.commit()
        if evaluation == "fails":
            raise BimServiceError("service_unavailable", "down")
        return await REAL_REEVALUATE(self, *args, **kwargs)

    monkeypatch.setattr(bim.AsyncBim, "reevaluate", cancelled_meanwhile)
    headers, snapshot_id = await account_with_snapshot(api_client, registration)

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert job.state is JobState.CANCELLED
    assert job.result is None
    assert await count_evidence(db_session) == 0


# -- The authorized retry of the evaluation --------------------------------------


async def test_the_retry_completes_the_job_without_running_the_engine(api_client, db_session, failed, engine, bim_back):
    job = failed.job
    [row] = await evidence_rows(db_session, job.id)
    solves = len(engine)

    response = await api_client.post(failed.url, headers=failed.headers)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert response.json()["result"]["solutions"]
    assert len(engine) == solves
    assert len(bim_back) == 1
    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED
    assert job.termination is not None
    assert job.lease_token is None and job.finished_at is not None
    assert "evidence" not in job.result
    assert "engineReported" in job.provenance
    assert await count_evidence(db_session) == 0
    events = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "job.reevaluated"))).scalars().all()
    [event] = events
    assert event.actor_id == job.owner_id and event.target_id == job.id
    assert event.detail == {
        "jobId": str(job.id), "ownerId": str(job.owner_id), "evidenceId": str(row.id), "result": "completed",
    }


async def test_a_second_retry_after_the_first_won_is_refused(api_client, db_session, failed, bim_back):
    first = await api_client.post(failed.url, headers=failed.headers)
    second = await api_client.post(failed.url, headers=failed.headers)

    assert (first.status_code, second.status_code) == (200, 409)
    assert code_of(second) == "job_not_reevaluable"
    assert len(bim_back) == 1


async def test_of_two_simultaneous_retries_only_one_completes_the_job(api_client, db_session, failed, monkeypatch):
    job = failed.job
    calls = {"n": 0}
    inner: dict = {}

    async def evaluated(_document, _raw, _optimization, _guarantees, provenance):
        calls["n"] += 1
        if calls["n"] == 1:
            # While the first is evaluating (no transaction, no lock) a second one runs to the end.
            inner["response"] = await api_client.post(failed.url, headers=failed.headers)
        return canned_evaluation(provenance)

    monkeypatch.setattr(jobs_routes, "evaluate_engine_result", evaluated)

    outer = await api_client.post(failed.url, headers=failed.headers)

    assert inner["response"].status_code == 200, inner["response"].text
    assert outer.status_code == 409 and code_of(outer) == "job_not_reevaluable"
    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED
    events = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "job.reevaluated"))).scalars().all()
    assert len(events) == 1


async def test_a_cancellation_during_the_retry_wins_and_the_job_stays_failed(api_client, db_session, failed, monkeypatch):
    job = failed.job
    before = dict(job.result)

    async def cancelled_meanwhile(_document, _raw, _optimization, _guarantees, provenance):
        await db_session.execute(update(Job).where(Job.id == job.id).values(cancellation_requested=True))
        await db_session.commit()
        return canned_evaluation(provenance)

    monkeypatch.setattr(jobs_routes, "evaluate_engine_result", cancelled_meanwhile)

    response = await api_client.post(failed.url, headers=failed.headers)

    assert response.status_code == 409 and code_of(response) == "cancellation_requested"
    await db_session.refresh(job)
    assert job.state is JobState.FAILED and job.result == before
    assert await count_evidence(db_session, job.id) == 1


async def test_a_bim_that_fails_again_leaves_the_job_and_its_evidence_as_they_were(api_client, db_session, failed, bim_down):
    job = failed.job
    before = dict(job.result)
    [row] = await evidence_rows(db_session, job.id)
    asked = len(bim_down)

    responses = [await api_client.post(failed.url, headers=failed.headers) for _ in range(2)]

    assert [response.status_code for response in responses] == [503, 503]
    assert {code_of(response) for response in responses} == {"bim_evaluation_failed"}
    assert MARKER not in responses[0].text
    assert len(bim_down) == asked + 2
    await db_session.refresh(job)
    assert job.state is JobState.FAILED and job.result == before
    [same] = await evidence_rows(db_session, job.id)
    assert same.id == row.id
    audit = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "job.reevaluated"))).scalars().all()
    assert audit == []


async def _in_a_study(_session, job, _row):
    job.study_cell_id = uuid.uuid4()


async def _retried(session, job, _row):
    session.add(
        Job(
            owner_id=job.owner_id, engine_id=job.engine_id, engine_job_id="again", service_url=job.service_url,
            state=JobState.QUEUED, retry_of_id=job.id,
        )
    )


async def _cancelling(_session, job, _row):
    job.cancellation_requested = True


async def _completed(_session, job, _row):
    job.state = JobState.COMPLETED


async def _failed_otherwise(_session, job, _row):
    job.result = {**job.result, "code": "engine_failed"}


async def _expired(_session, _job, row):
    row.expires_at = utcnow() - timedelta(seconds=1)


async def _swept(session, _job, row):
    await session.delete(row)


async def _from_an_older_attempt(_session, job, _row):
    job.attempt = job.attempt + 1


async def _another_row(_session, job, _row):
    job.result = {**job.result, "evidence": {**job.result["evidence"], "id": str(uuid.uuid4())}}


REFUSALS = {
    "study_cell": (_in_a_study, 409, "job_in_study"),
    "retried": (_retried, 409, "job_already_retried"),
    "cancellation_requested": (_cancelling, 409, "cancellation_requested"),
    "completed": (_completed, 409, "job_not_reevaluable"),
    "failed_for_another_reason": (_failed_otherwise, 409, "job_not_reevaluable"),
    "expired": (_expired, 410, "evidence_expired"),
    "swept": (_swept, 410, "evidence_expired"),
    "older_attempt": (_from_an_older_attempt, 410, "evidence_expired"),
    "another_row": (_another_row, 410, "evidence_expired"),
}


@pytest.mark.parametrize("case", REFUSALS)
async def test_the_retry_is_refused_and_changes_nothing(api_client, db_session, failed, bim_back, case):
    mutate, status, code = REFUSALS[case]
    job = failed.job
    [row] = await evidence_rows(db_session, job.id)
    await mutate(db_session, job, row)
    await db_session.commit()
    state, result = job.state, dict(job.result)
    rows = await count_evidence(db_session)

    response = await api_client.post(failed.url, headers=failed.headers)

    assert (response.status_code, code_of(response)) == (status, code)
    assert bim_back == []
    await db_session.refresh(job)
    assert job.state is state and job.result == result
    assert await count_evidence(db_session) == rows
    events = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "job.reevaluated"))).scalars().all()
    assert events == []


async def test_another_user_gets_the_404_of_a_job_that_does_not_exist(api_client, failed, registration):
    from analysis_b3_b4_b6._helpers import account_headers

    stranger = await account_headers(api_client, registration)

    foreign = await api_client.post(failed.url, headers=stranger)
    missing = await api_client.post(f"/v1/jobs/{uuid.uuid4()}/reevaluate", headers=stranger)
    anonymous = await api_client.post(failed.url)

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert anonymous.status_code in (401, 403)


# -- Roles and keys ------------------------------------------------------------


@pytest.fixture
def evaluation(monkeypatch):
    async def evaluated(_document, _raw, _optimization, _guarantees, provenance):
        return canned_evaluation(provenance)

    monkeypatch.setattr(jobs_routes, "evaluate_engine_result", evaluated)


async def failed_org_job(db_session, lab, person) -> Job:  # noqa: F811
    job = organization_job(lab, person, JobState.FAILED)
    job.attempt = 1
    job.original_request = {
        "bindingProblem": PROBLEM,
        "mode": {"id": "seeded", "terminationGuarantees": ["FEASIBLE"]},
    }
    db_session.add(job)
    await db_session.flush()
    row = JobEngineEvidence(
        id=uuid.uuid4(), job_id=job.id, attempt=1, raw_result={"termination": "FEASIBLE", "solutions": []},
        digest="sha256:" + "1" * 64, expires_at=utcnow() + timedelta(days=1),
    )
    db_session.add(row)
    job.result = {
        "termination": "UNKNOWN", "solutions": [], "code": "bim_evaluation_failed",
        "error": JOB_FAILURES["bim_evaluation_failed"], "provenance": {},
        "evidence": {"id": str(row.id), "digest": row.digest, "expiresAt": row.expires_at.isoformat()},
    }
    await db_session.commit()
    return job


@pytest.mark.parametrize("role", ["MEMBER", "ADMIN", "OWNER"])
async def test_a_member_or_above_retries_the_evaluation_of_their_job(
    api_client, db_session, lab, evaluation, role  # noqa: F811
):
    job = await failed_org_job(db_session, lab, lab.people[role])

    response = await api_client.post(f"/v1/jobs/{job.id}/reevaluate", headers=lab.people[role].headers)

    assert response.status_code == 200, response.text
    await db_session.refresh(job)
    assert job.state is JobState.COMPLETED


async def test_a_viewer_cannot_retry_the_evaluation(api_client, db_session, lab, evaluation):  # noqa: F811
    job = await failed_org_job(db_session, lab, lab.people["VIEWER"])

    response = await api_client.post(f"/v1/jobs/{job.id}/reevaluate", headers=lab.people["VIEWER"].headers)

    assert response.status_code == 403 and code_of(response) == "insufficient_role"
    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert await count_evidence(db_session, job.id) == 1


async def test_a_member_who_does_not_own_the_job_gets_a_404(api_client, db_session, lab, evaluation):  # noqa: F811
    job = await failed_org_job(db_session, lab, lab.people["MEMBER"])

    response = await api_client.post(f"/v1/jobs/{job.id}/reevaluate", headers=lab.people["ADMIN"].headers)
    outsider = await api_client.post(f"/v1/jobs/{job.id}/reevaluate", headers=lab.outsider.headers)

    assert response.status_code == outsider.status_code == 404
    assert response.json() == outsider.json()


async def test_a_read_only_key_cannot_retry_the_evaluation(api_client, db_session, lab, evaluation):  # noqa: F811
    job = await failed_org_job(db_session, lab, lab.people["MEMBER"])
    key = await make_key(api_client, lab.people["MEMBER"].headers, READ_SCOPES)

    response = await api_client.post(f"/v1/jobs/{job.id}/reevaluate", headers=key)

    assert response.status_code == 403 and code_of(response) == "insufficient_api_key_permission"
    await db_session.refresh(job)
    assert job.state is JobState.FAILED


async def test_a_key_that_may_execute_retries_the_evaluation_with_the_role_of_its_user(
    api_client, db_session, lab, evaluation  # noqa: F811
):
    member_job = await failed_org_job(db_session, lab, lab.people["MEMBER"])
    viewer_job = await failed_org_job(db_session, lab, lab.people["VIEWER"])
    member_key = await make_key(api_client, lab.people["MEMBER"].headers, EXECUTE_SCOPES)
    viewer_key = await make_key(api_client, lab.people["VIEWER"].headers, EXECUTE_SCOPES)

    allowed = await api_client.post(f"/v1/jobs/{member_job.id}/reevaluate", headers=member_key)
    denied = await api_client.post(f"/v1/jobs/{viewer_job.id}/reevaluate", headers=viewer_key)

    assert allowed.status_code == 200, allowed.text
    assert denied.status_code == 403 and code_of(denied) == "insufficient_role"
    await db_session.refresh(viewer_job)
    assert viewer_job.state is JobState.FAILED


# -- Retention -----------------------------------------------------------------


def test_the_retention_is_validated():
    assert Settings().evidence_retention_days == 14
    assert Settings(evidence_retention_days=90).evidence_retention_days == 90
    for invalid in (-1, 0, 91):
        with pytest.raises(ValidationError):
            Settings(evidence_retention_days=invalid)


async def test_the_expiry_follows_the_configured_retention(db_session, owner, monkeypatch):
    monkeypatch.setattr(get_settings(), "evidence_retention_days", 3)
    job = Job(owner_id=owner.id, engine_id="random-search", engine_job_id="e", service_url="http://engine")
    db_session.add(job)
    await db_session.commit()

    stored = await job_evidence.store(db_session, job.id, 1, {"termination": "FEASIBLE"})
    await db_session.commit()

    assert abs(aware(stored.expires_at) - utcnow() - timedelta(days=3)) < timedelta(seconds=30)


async def test_an_answer_over_the_bound_is_not_kept(db_session, owner):
    job = Job(owner_id=owner.id, engine_id="random-search", engine_job_id="e", service_url="http://engine")
    db_session.add(job)
    await db_session.commit()

    stored = await job_evidence.store(db_session, job.id, 1, {"blob": "x" * (job_evidence.MAX_EVIDENCE_BYTES + 1)})

    assert stored is None
    assert await count_evidence(db_session) == 0


async def test_the_sweep_deletes_only_expired_evidence_in_bounded_batches(db_session, owner):
    job = Job(owner_id=owner.id, engine_id="random-search", engine_job_id="e", service_url="http://engine")
    db_session.add(job)
    await db_session.commit()
    now = utcnow()
    for attempt in range(1, 6):
        db_session.add(
            JobEngineEvidence(
                job_id=job.id, attempt=attempt, raw_result={}, digest="sha256:" + "2" * 64,
                expires_at=now - timedelta(hours=attempt),
            )
        )
    for attempt in (6, 7):
        db_session.add(
            JobEngineEvidence(
                job_id=job.id, attempt=attempt, raw_result={}, digest="sha256:" + "3" * 64,
                expires_at=now + timedelta(hours=attempt),
            )
        )
    await db_session.commit()

    first = await job_evidence.purge_expired(db_session, limit=2)
    await db_session.commit()
    assert first == 2 and await count_evidence(db_session) == 5

    rest = await reconciler.purge_expired_evidence(db_session)
    await db_session.commit()
    assert rest == 3
    assert [row.attempt for row in await evidence_rows(db_session)] == [6, 7]


async def test_a_retry_after_the_sweep_answers_410(api_client, db_session, failed, bim_back):
    [row] = await evidence_rows(db_session, failed.job.id)
    row.expires_at = utcnow() - timedelta(seconds=1)
    await db_session.commit()

    assert await reconciler.purge_expired_evidence(db_session) == 1
    await db_session.commit()
    response = await api_client.post(failed.url, headers=failed.headers)

    assert response.status_code == 410 and code_of(response) == "evidence_expired"
    assert bim_back == []


# -- The migration -------------------------------------------------------------

PREVIOUS_REVISION = "f2a3b4c5d6e7"
THIS_REVISION = "a5b6c7d8e9f0"


def alembic(database: Path, *arguments: str) -> subprocess.CompletedProcess:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=ROOT, env=environment, capture_output=True, text=True, check=False,
    )


def run(database: Path, *arguments: str) -> str:
    done = alembic(database, *arguments)
    assert done.returncode == 0, done.stdout + done.stderr
    return done.stdout


def has_table(database: Path) -> bool:
    with sqlite3.connect(database) as connection:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_engine_evidence'")
        return rows.fetchone() is not None


def table_indexes(database: Path) -> dict[str, int]:
    with sqlite3.connect(database) as connection:
        return {row[1]: row[2] for row in connection.execute("PRAGMA index_list(job_engine_evidence)")}


def test_the_migration_hangs_from_the_previous_head_and_its_downgrade_drops_the_table(tmp_path):
    database = tmp_path / "evidence.db"

    heads = run(database, "heads")
    # Later migrations hang from this revision, so it is no longer the head;
    # it only has to stay in the single linear history.
    assert heads.count("(head)") == 1 and THIS_REVISION in run(database, "history")

    run(database, "upgrade", PREVIOUS_REVISION)
    assert not has_table(database)

    run(database, "upgrade", "head")
    assert has_table(database)
    indexes = table_indexes(database)
    assert indexes["uq_job_engine_evidence_job_attempt"] == 1  # unique
    assert "ix_job_engine_evidence_expires_at" in indexes

    run(database, "downgrade", PREVIOUS_REVISION)
    assert not has_table(database)

    run(database, "upgrade", "head")
    assert has_table(database)
