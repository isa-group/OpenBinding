"""The job submission service, called directly: no HTTP, no router.

``tests/test_idempotency_jobs.py`` and ``tests/test_concurrency_limit.py`` cover
the same rules through ``POST /v1/jobs``; these pin the service's own contract
(result kind, status, body, headers) and the one translation the route adds.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from _pricing import pricing_catalog
from _repo import REPO_ROOT

from openbinding_gateway import space_client, study_jobs
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, User, UserRole
from openbinding_gateway.models.problem import PROBLEM_MEDIA_TYPE
from openbinding_gateway.routes import v1
from openbinding_gateway.services import job_submission
from openbinding_gateway.services.job_submission import (
    JobSubmission,
    JobSubmissionInput,
    JobSubmissionResult,
    discard_pending_launches,
    pending_launches,
)
from openbinding_gateway.services.snapshots import compile_resolved, persist_snapshot
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
KEY = "service-key-1"


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
async def snapshot_id(db_session, user) -> str:
    compilation = await compile_resolved(load_package(EXAMPLE).to_zip(), db_session, user)
    stored = await persist_snapshot(compilation, user, db_session)
    await db_session.commit()
    assert stored
    return stored


def payload_for(snapshot: str, **extra) -> dict:
    return {"snapshot": snapshot, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION, **extra}


def request_for(snapshot: str, payload: dict | None = None, key: str | None = KEY) -> JobSubmissionInput:
    return JobSubmissionInput(
        payload=payload if payload is not None else payload_for(snapshot),
        idempotency_key=key,
        snapshot_id=snapshot,
    )


async def submit(session, caller, request, **options) -> JobSubmissionResult:
    return await JobSubmission(session, caller, **options).submit(request)


async def job_count(session) -> int:
    return (await session.execute(select(func.count()).select_from(Job))).scalar_one()


# -- A new job and its replay ------------------------------------------------


async def test_a_valid_request_creates_a_queued_job(db_session, user, snapshot_id):
    result = await submit(db_session, user, request_for(snapshot_id))

    assert (result.kind, result.status, result.headers) == ("created", 202, {})
    assert set(result.body) == {"id", "status", "profile", "irDigest"}
    assert result.body["status"] == "queued"
    stored = await db_session.get(Job, uuid.UUID(result.body["id"]))
    assert stored.owner_id == user.id
    assert stored.idempotency_key == KEY
    assert stored.provenance["irDigest"] == result.body["irDigest"]
    assert pending_launches(db_session) == []


async def test_the_same_key_and_an_equivalent_body_replay_the_job(db_session, user, snapshot_id):
    first = await submit(db_session, user, request_for(snapshot_id))
    # The same request with its members in another order.
    reordered = dict(reversed(list(payload_for(snapshot_id).items())))
    second = await submit(db_session, user, request_for(snapshot_id, reordered))

    assert first.kind == "created"
    assert (second.kind, second.status) == ("replay", 202)
    assert second.body == {
        "id": first.body["id"],
        "status": "queued",
        "profile": first.body["profile"],
        "irDigest": first.body["irDigest"],
        "idempotent": True,
    }
    assert await job_count(db_session) == 1


async def test_the_same_key_with_another_body_is_a_409_problem(db_session, user, snapshot_id):
    body = payload_for(snapshot_id, engine="evolutionary-heuristics", mode="elitist-genetic")
    first = await submit(db_session, user, request_for(snapshot_id, {**body, "options": {"max_evaluations": 100}}))
    changed = await submit(db_session, user, request_for(snapshot_id, {**body, "options": {"max_evaluations": 200}}))

    assert first.kind == "created"
    assert (changed.kind, changed.status) == ("problem", 409)
    assert changed.body["code"] == "idempotency_conflict"
    assert changed.body["status"] == 409
    assert await job_count(db_session) == 1


async def test_a_key_is_scoped_to_the_account(db_session, user, snapshot_id):
    other = User(
        username="other", email="other@example.org", password_hash="x", role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(other)
    await db_session.commit()
    compilation = await compile_resolved(load_package(EXAMPLE).to_zip(), db_session, other)
    other_snapshot = await persist_snapshot(compilation, other, db_session)
    await db_session.commit()

    first = await submit(db_session, user, request_for(snapshot_id))
    second = await submit(db_session, other, request_for(other_snapshot))

    assert first.kind == second.kind == "created"
    assert first.body["id"] != second.body["id"]


# -- Races on the idempotency key --------------------------------------------


def hide_lookups(monkeypatch, hidden: int) -> None:
    """Make the first `hidden` lookups of a key miss, as if the winner had not committed yet."""
    real = job_submission._find_idempotent_job
    seen: list[str] = []

    async def find(session, owner_id, key):
        seen.append(key)
        return None if len(seen) <= hidden else await real(session, owner_id, key)

    monkeypatch.setattr(job_submission, "_find_idempotent_job", find)


async def test_losing_the_insert_race_to_a_committed_winner_replays_it(db_session, user, snapshot_id, monkeypatch):
    winner = await submit(db_session, user, request_for(snapshot_id))

    # Misses the pre-check and the check after the account lock; only the INSERT notices the winner.
    hide_lookups(monkeypatch, 2)
    loser = await submit(db_session, user, request_for(snapshot_id))

    assert (loser.kind, loser.status) == ("replay", 202)
    assert loser.body["id"] == winner.body["id"]
    assert loser.body["idempotent"] is True
    assert await job_count(db_session) == 1


async def test_a_race_whose_winner_rolled_back_is_a_conflict_and_burns_no_key(
    db_session, user, snapshot_id, monkeypatch
):
    real_flush = AsyncSession.flush
    collided: list[bool] = []

    async def flush(self, *args, **kwargs):
        # The winner's row makes the INSERT fail; by the time the loser looks again the winner has rolled back.
        if self is db_session and not collided and any(isinstance(item, Job) for item in self.new):
            collided.append(True)
            raise IntegrityError("INSERT INTO jobs", {}, Exception("UNIQUE constraint failed"))
        return await real_flush(self, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "flush", flush)
    lost = await submit(db_session, user, request_for(snapshot_id))

    assert (lost.kind, lost.status) == ("problem", 409)
    assert lost.body["code"] == "job_conflict"
    assert await job_count(db_session) == 0
    assert pending_launches(db_session) == []

    # Nothing was reserved: the same key goes through once the race is over.
    retried = await submit(db_session, user, request_for(snapshot_id))
    assert retried.kind == "created"
    assert await job_count(db_session) == 1


async def test_a_request_that_waited_on_the_account_lock_gets_the_replay_not_a_429(
    db_session, user, snapshot_id, monkeypatch
):
    winner = await submit(db_session, user, request_for(snapshot_id))
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)

    # The pre-check misses; the lookup after the account lock sees the winner.
    hide_lookups(monkeypatch, 1)
    waited = await submit(db_session, user, request_for(snapshot_id))

    assert (waited.kind, waited.body["id"]) == ("replay", winner.body["id"])


async def test_the_study_cell_race_returns_the_job_that_won_the_cell(db_session, user, snapshot_id):
    cell_id = uuid.uuid4()
    first = await submit(db_session, user, request_for(snapshot_id, key=None), study_cell_id=cell_id, commit=False)
    # No key to replay by: only the unique index on the cell tells the second launch it lost.
    second = await submit(db_session, user, request_for(snapshot_id, key=None), study_cell_id=cell_id, commit=False)

    assert first.kind == "created"
    assert (second.kind, second.body["id"], second.body["idempotent"]) == ("replay", first.body["id"], True)
    assert await job_count(db_session) == 1
    assert pending_launches(db_session) == [uuid.UUID(first.body["id"])]


# -- Limits and the plan ------------------------------------------------------


async def test_the_concurrency_limit_is_a_retryable_429_with_its_headers(
    db_session, user, snapshot_id, monkeypatch
):
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    first = await submit(db_session, user, request_for(snapshot_id, key="first"))
    refused = await submit(db_session, user, request_for(snapshot_id, key="second"))

    assert first.kind == "created"
    assert (refused.kind, refused.status) == ("problem", 429)
    assert refused.body["code"] == "concurrency_limit_exceeded"
    assert refused.body["concurrency"] == {"limit": 1, "active": 1}
    assert refused.headers == {"Retry-After": "15"}
    assert refused.body["code"] in study_jobs.RETRYABLE_LAUNCH_CODES
    assert await job_count(db_session) == 1


async def test_a_replay_at_the_limit_is_not_refused(db_session, user, snapshot_id, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    first = await submit(db_session, user, request_for(snapshot_id))
    again = await submit(db_session, user, request_for(snapshot_id))

    assert (again.kind, again.body["id"]) == ("replay", first.body["id"])


async def test_an_unreadable_plan_is_a_retryable_503_and_creates_nothing(db_session, user, snapshot_id):
    space_client.get_gate().unavailable = True

    result = await submit(db_session, user, request_for(snapshot_id))

    assert (result.kind, result.status) == ("problem", 503)
    assert result.body["code"] == "pricing_unavailable"
    assert result.body["code"] in study_jobs.RETRYABLE_LAUNCH_CODES
    assert await job_count(db_session) == 0


async def test_an_anonymous_caller_is_refused_after_the_request_is_validated(db_session):
    upload = JobSubmissionInput(
        payload={"mode": "seeded", "optimization": OPTIMIZATION},
        archive=load_package(EXAMPLE).to_zip(),
    )

    result = await submit(db_session, None, upload)

    assert (result.kind, result.status) == ("problem", 401)
    assert result.body["code"] == "unauthorized"
    assert await job_count(db_session) == 0


async def test_a_request_the_service_refuses_names_its_problem_before_any_job(db_session, user, snapshot_id):
    unknown = await submit(db_session, user, request_for(snapshot_id, payload_for(snapshot_id, engine="no-such-engine")))
    missing = await submit(db_session, user, request_for(str(uuid.uuid4())))

    assert (unknown.status, unknown.body["code"]) == (422, "immutable_engine_required")
    assert (missing.status, missing.body["code"]) == (404, "not_found")
    assert await job_count(db_session) == 0


# -- Without commit -----------------------------------------------------------


async def test_without_commit_the_job_waits_in_the_callers_transaction(db_session, user, snapshot_id):
    result = await submit(db_session, user, request_for(snapshot_id), commit=False)

    job_id = uuid.UUID(result.body["id"])
    assert result.kind == "created"
    assert pending_launches(db_session) == [job_id]
    discard_pending_launches(db_session)
    assert pending_launches(db_session) == []


async def test_a_failing_snapshot_persister_leaves_no_job(db_session, user, snapshot_id):
    async def broken(*args, **kwargs):
        raise RuntimeError("snapshot failed")

    with pytest.raises(RuntimeError, match="snapshot failed"):
        await submit(db_session, user, request_for(snapshot_id), snapshot_persister=broken)

    await db_session.rollback()
    assert await job_count(db_session) == 0


# -- The route's translation --------------------------------------------------


def test_the_route_answers_a_problem_result_as_problem_json_with_its_headers():
    result = job_submission.problem(429, "concurrency_limit_exceeded", "busy", headers={"Retry-After": "15"})

    response = v1._job_response(result)

    assert response.status_code == 429
    assert response.media_type == PROBLEM_MEDIA_TYPE
    assert response.headers["Retry-After"] == "15"


def test_the_route_answers_a_replay_as_plain_json_and_a_new_job_as_its_document():
    body = {"id": "j", "status": "queued", "profile": "p", "irDigest": "d", "idempotent": True}
    replay = v1._job_response(JobSubmissionResult("replay", 202, body))
    new = v1._job_response(job_submission.created({"id": "j"}))

    assert (replay.status_code, replay.media_type) == (202, "application/json")
    assert new == {"id": "j"}
