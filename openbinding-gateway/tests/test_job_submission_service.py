"""The job submission service, called directly: no HTTP, no router.

``tests/test_idempotency_jobs.py`` and ``tests/test_concurrency_limit.py`` cover
the same rules through ``createRun``; these pin the service's own contract
(result kind, status, body, headers) and the one translation the route adds.
"""

from __future__ import annotations

import json
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from _pricing import pricing_catalog, roomy_plan

from openbinding_gateway import space_client, study_jobs
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, User, UserRole
from openbinding_gateway.modules.execution.adapters import routes as runs_routes
from openbinding_gateway.modules.execution.application import RunRequest
from openbinding_gateway.services import job_submission
from openbinding_gateway.services.job_submission import (
    JobSubmission,
    JobSubmissionResult,
    discard_pending_launches,
    pending_launches,
)
from _problem_helpers import problem_for
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
KEY = "service-key-1"
#: The organization of each revision the fixtures upload, which a run request names.
ORGANIZATIONS: dict[str, uuid.UUID] = {}


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
async def revision_id(db_session, user) -> str:
    """A revision of a problem of the user's organization (the name is the fixture the tests ask for)."""
    upload = await problem_for(db_session, user)
    ORGANIZATIONS[str(upload.revision.id)] = upload.problem.organization_id
    return str(upload.revision.id)


def payload_for(revision: str, **extra) -> dict:
    return {"revision": revision, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION, **extra}


def request_for(revision: str, payload: dict | None = None, key: str | None = KEY) -> RunRequest:
    """The run request of ``payload`` in the revision's organization (any organization for a missing revision)."""
    return RunRequest.from_document(
        ORGANIZATIONS.get(revision, uuid.uuid4()),
        payload if payload is not None else payload_for(revision),
        idempotency_key=key,
    )


async def submit(session, caller, request, **options) -> JobSubmissionResult:
    return await JobSubmission(session, caller, **options).submit(request)


async def job_count(session) -> int:
    return (await session.execute(select(func.count()).select_from(Job))).scalar_one()


# -- A new job and its replay ------------------------------------------------


async def test_a_valid_request_creates_a_queued_job(db_session, user, revision_id):
    result = await submit(db_session, user, request_for(revision_id))

    assert (result.kind, result.status, result.headers) == ("created", 202, {})
    assert set(result.body) == {"id", "status", "profile", "irDigest"}
    assert result.body["status"] == "queued"
    stored = await db_session.get(Job, uuid.UUID(result.body["id"]))
    assert stored.owner_id == user.id
    assert stored.idempotency_key == KEY
    assert stored.provenance["irDigest"] == result.body["irDigest"]
    assert pending_launches(db_session) == []


async def test_the_same_key_and_an_equivalent_body_replay_the_job(db_session, user, revision_id):
    first = await submit(db_session, user, request_for(revision_id))
    # The same request with its members in another order.
    reordered = dict(reversed(list(payload_for(revision_id).items())))
    second = await submit(db_session, user, request_for(revision_id, reordered))

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


async def test_the_same_key_with_another_body_is_a_409_problem(db_session, user, revision_id):
    body = payload_for(revision_id, engine="evolutionary-heuristics", mode="elitist-genetic")
    first = await submit(db_session, user, request_for(revision_id, {**body, "options": {"max_evaluations": 100}}))
    changed = await submit(db_session, user, request_for(revision_id, {**body, "options": {"max_evaluations": 200}}))

    assert first.kind == "created"
    assert (changed.kind, changed.status) == ("problem", 409)
    assert changed.body["code"] == "idempotency_conflict"
    assert changed.body["status"] == 409
    assert await job_count(db_session) == 1


async def test_a_key_is_scoped_to_the_account(db_session, user, revision_id):
    other = User(
        username="other", email="other@example.org", password_hash="x", role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(other)
    await db_session.commit()
    other_upload = await problem_for(db_session, other)
    other_snapshot = str(other_upload.revision.id)
    ORGANIZATIONS[other_snapshot] = other_upload.problem.organization_id

    first = await submit(db_session, user, request_for(revision_id))
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


async def test_losing_the_insert_race_to_a_committed_winner_replays_it(db_session, user, revision_id, monkeypatch):
    # About the INSERT race, which a second job must reach: the default plan allows one job at a time and
    # that limit now applies (plan ``maxConcurrentRuns``), so the account gets a roomier plan.
    space_client.get_gate().plans[user.id] = roomy_plan()
    winner = await submit(db_session, user, request_for(revision_id))

    # Misses the pre-check and the check after the account lock; only the INSERT notices the winner.
    hide_lookups(monkeypatch, 2)
    loser = await submit(db_session, user, request_for(revision_id))

    assert (loser.kind, loser.status) == ("replay", 202)
    assert loser.body["id"] == winner.body["id"]
    assert loser.body["idempotent"] is True
    assert await job_count(db_session) == 1


async def test_a_race_whose_winner_rolled_back_is_a_conflict_and_burns_no_key(
    db_session, user, revision_id, monkeypatch
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
    lost = await submit(db_session, user, request_for(revision_id))

    assert (lost.kind, lost.status) == ("problem", 409)
    assert lost.body["code"] == "job_conflict"
    assert await job_count(db_session) == 0
    assert pending_launches(db_session) == []

    # Nothing was reserved: the same key goes through once the race is over.
    retried = await submit(db_session, user, request_for(revision_id))
    assert retried.kind == "created"
    assert await job_count(db_session) == 1


async def test_a_request_that_waited_on_the_account_lock_gets_the_replay_not_a_429(
    db_session, user, revision_id, monkeypatch
):
    winner = await submit(db_session, user, request_for(revision_id))
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)

    # The pre-check misses; the lookup after the account lock sees the winner.
    hide_lookups(monkeypatch, 1)
    waited = await submit(db_session, user, request_for(revision_id))

    assert (waited.kind, waited.body["id"]) == ("replay", winner.body["id"])


async def test_the_study_cell_race_returns_the_job_that_won_the_cell(db_session, user, revision_id):
    # About the unique index on the cell, which a second launch must reach: it needs a plan that allows
    # a second job in flight (the default one allows one and that limit now applies).
    space_client.get_gate().plans[user.id] = roomy_plan()
    cell_id = uuid.uuid4()
    first = await submit(db_session, user, request_for(revision_id, key=None), study_cell_id=cell_id, commit=False)
    # No key to replay by: only the unique index on the cell tells the second launch it lost.
    second = await submit(db_session, user, request_for(revision_id, key=None), study_cell_id=cell_id, commit=False)

    assert first.kind == "created"
    assert (second.kind, second.body["id"], second.body["idempotent"]) == ("replay", first.body["id"], True)
    assert await job_count(db_session) == 1
    assert pending_launches(db_session) == [uuid.UUID(first.body["id"])]


# -- Limits and the plan ------------------------------------------------------


async def test_the_concurrency_limit_is_a_retryable_429_with_its_headers(
    db_session, user, revision_id, monkeypatch
):
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    first = await submit(db_session, user, request_for(revision_id, key="first"))
    refused = await submit(db_session, user, request_for(revision_id, key="second"))

    assert first.kind == "created"
    assert (refused.kind, refused.status) == ("problem", 429)
    assert refused.body["code"] == "concurrency_limit_exceeded"
    assert refused.body["concurrency"] == {
        "limit_id": "maxConcurrentRuns", "limit": 1, "used": 1, "active": 1, "unit": "job", "source": "technical",
    }
    assert refused.headers == {"Retry-After": "15"}
    assert refused.body["code"] in study_jobs.RETRYABLE_LAUNCH_CODES
    assert await job_count(db_session) == 1


async def test_a_replay_at_the_limit_is_not_refused(db_session, user, revision_id, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    first = await submit(db_session, user, request_for(revision_id))
    again = await submit(db_session, user, request_for(revision_id))

    assert (again.kind, again.body["id"]) == ("replay", first.body["id"])


async def test_an_unreadable_plan_is_a_retryable_503_and_creates_nothing(db_session, user, revision_id):
    space_client.get_gate().unavailable = True

    result = await submit(db_session, user, request_for(revision_id))

    assert (result.kind, result.status) == ("problem", 503)
    assert result.body["code"] == "pricing_unavailable"
    assert result.body["code"] in study_jobs.RETRYABLE_LAUNCH_CODES
    assert await job_count(db_session) == 0


async def test_an_anonymous_caller_is_refused_before_anything_is_read(db_session, revision_id):
    result = await submit(db_session, None, request_for(revision_id))

    assert (result.kind, result.status) == ("problem", 401)
    assert result.body["code"] == "unauthorized"
    assert await job_count(db_session) == 0


async def test_a_request_the_service_refuses_names_its_problem_before_any_job(db_session, user, revision_id):
    unknown = await submit(db_session, user, request_for(revision_id, payload_for(revision_id, engine="no-such-engine")))
    missing = await submit(db_session, user, request_for(str(uuid.uuid4())))

    assert (unknown.status, unknown.body["code"]) == (422, "immutable_engine_required")
    assert (missing.status, missing.body["code"]) == (404, "not_found")
    assert await job_count(db_session) == 0


# -- Without commit -----------------------------------------------------------


async def test_without_commit_the_job_waits_in_the_callers_transaction(db_session, user, revision_id):
    result = await submit(db_session, user, request_for(revision_id), commit=False)

    job_id = uuid.UUID(result.body["id"])
    assert result.kind == "created"
    assert pending_launches(db_session) == [job_id]
    discard_pending_launches(db_session)
    assert pending_launches(db_session) == []


async def test_a_failing_compilation_leaves_no_job(db_session, user, revision_id, monkeypatch):
    async def broken(*args, **kwargs):
        raise RuntimeError("compilation failed")

    monkeypatch.setattr(job_submission, "compile_or_get", broken)
    with pytest.raises(RuntimeError, match="compilation failed"):
        await submit(db_session, user, request_for(revision_id))

    await db_session.rollback()
    assert await job_count(db_session) == 0


# -- The route's translation --------------------------------------------------


def test_the_route_answers_a_refused_submission_in_the_platform_envelope_with_its_headers():
    result = job_submission.problem(
        429, "concurrency_limit_exceeded", "busy", extra={"concurrency": {"limit": 1}}, headers={"Retry-After": "15"},
    )

    response = runs_routes._refusal(result)
    body = json.loads(response.body)

    assert (response.status_code, response.media_type) == (429, "application/json")
    assert response.headers["Retry-After"] == "15"
    assert body["code"] == body["title"] == body["detail"]["code"] == "concurrency_limit_exceeded"
    assert body["detail"]["error"] == "busy"
    assert body["detail"]["concurrency"] == {"limit": 1}


def test_a_refused_422_keeps_the_problem_document_and_its_diagnostics_as_json():
    result = job_submission.problem(422, "engine_mode_incompatible", "cannot run it", [{"code": "x", "message": "m"}])

    response = runs_routes._refusal(result)
    body = json.loads(response.body)

    assert (response.status_code, response.media_type) == (422, "application/json")
    assert (body["code"], body["detail"]) == ("engine_mode_incompatible", "cannot run it")
    assert body["diagnostics"]


def test_the_cell_refusal_carries_the_code_a_launch_retries_on():
    refused = job_submission.problem(429, "concurrency_limit_exceeded", "busy")

    assert refused.body["code"] in study_jobs.RETRYABLE_LAUNCH_CODES
    assert isinstance(JobSubmissionResult("replay", 202, {"id": "j"}).body, dict)
