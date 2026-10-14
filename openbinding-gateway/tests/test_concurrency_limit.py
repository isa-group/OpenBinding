"""The technical limit on queued plus running jobs per account.

It is configuration (``MAX_CONCURRENT_JOBS_PER_USER``), independent of SPACE and
of the plan, and it is enforced inside the transaction that creates the job: by
``POST /v1/jobs``, by retry and by study-cell launches. That two creations in two
transactions cannot both take the last slot needs PostgreSQL and lives in
``tests/concurrency/test_job_leases_pg.py``.
"""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from _pricing import largest_plan, pricing_catalog
from test_idempotency_jobs import _body, _login, _post, _snapshot
from test_job_dispatch import _account
from test_study_cell_launch import BASE, _cells, _study

from openbinding_gateway import space_client, study_jobs
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import Job, JobState, Organization, Project, RunState, User, UserRole
from openbinding_gateway.domain.entitlements import Refusal
from openbinding_gateway.jobs import limits
from openbinding_gateway.routes import jobs as job_routes
from openbinding_gateway.routes import v1


def set_limit(monkeypatch, value: int) -> None:
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", value)


def a_job(owner_id, state=JobState.QUEUED, **extra) -> Job:
    return Job(
        owner_id=owner_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()),
        service_url="http://engine", state=state, original_request={}, options={}, provenance={}, **extra,
    )


@pytest.fixture
def no_dispatch(monkeypatch):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(v1, "dispatch_persisted_job", queued)
    monkeypatch.setattr(job_routes, "dispatch_persisted_job", queued)


# -- The setting ------------------------------------------------------------


def test_the_default_limit_is_eight(monkeypatch):
    monkeypatch.delenv("MAX_CONCURRENT_JOBS_PER_USER", raising=False)

    assert Settings(_env_file=None).max_concurrent_jobs_per_user == 8


def test_the_limit_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("MAX_CONCURRENT_JOBS_PER_USER", "3")

    assert Settings(_env_file=None).max_concurrent_jobs_per_user == 3


@pytest.mark.parametrize("value", ["0", "-1"])
def test_the_limit_is_at_least_one(monkeypatch, value):
    monkeypatch.setenv("MAX_CONCURRENT_JOBS_PER_USER", value)

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


# -- The function -----------------------------------------------------------


async def make_user(db_session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash", role=UserRole.USER, plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(user)
    await db_session.flush()
    return user


async def test_only_queued_and_running_jobs_of_the_owner_count(db_session):
    mine, theirs = await make_user(db_session), await make_user(db_session)
    db_session.add_all([
        a_job(mine.id, JobState.QUEUED), a_job(mine.id, JobState.RUNNING),
        a_job(mine.id, JobState.COMPLETED), a_job(mine.id, JobState.FAILED), a_job(mine.id, JobState.CANCELLED),
        a_job(theirs.id, JobState.QUEUED),
    ])
    await db_session.flush()

    assert await limits.count_in_flight(db_session, mine.id) == 2
    assert await limits.count_in_flight(db_session, theirs.id) == 1


async def test_below_the_limit_nothing_is_refused_and_at_it_the_429_is(db_session):
    user = await make_user(db_session)
    db_session.add(a_job(user.id))
    await db_session.flush()

    assert await limits.enforce_concurrency_limit(db_session, user.id, limit=2) is None
    refusal = await limits.enforce_concurrency_limit(db_session, user.id, limit=1)

    assert isinstance(refusal, Refusal)
    assert (refusal.status, refusal.code) == (429, "concurrency_limit_exceeded")
    assert refusal.extra == {
        "concurrency": {
            "limit_id": "concurrentJobs", "limit": 1, "used": 1, "active": 1, "unit": "job", "source": "technical",
        }
    }
    assert refusal.headers == {"Retry-After": "15"}


async def test_the_limit_defaults_to_the_setting(db_session, monkeypatch):
    user = await make_user(db_session)
    db_session.add(a_job(user.id))
    await db_session.flush()

    set_limit(monkeypatch, 1)
    assert (await limits.enforce_concurrency_limit(db_session, user.id)).status == 429
    set_limit(monkeypatch, 2)
    assert await limits.enforce_concurrency_limit(db_session, user.id) is None


async def test_jobs_added_earlier_in_the_same_transaction_count(db_session):
    user = await make_user(db_session)
    db_session.add(a_job(user.id))  # not flushed: the count must still see it

    assert (await limits.enforce_concurrency_limit(db_session, user.id, limit=1)).status == 429


# -- POST /v1/jobs ----------------------------------------------------------


async def test_creating_a_job_at_the_limit_is_a_429_and_finishing_one_frees_the_slot(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 1)
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    first = await _post(api_client, headers, _body(snapshot), key="first")
    refused = await _post(api_client, headers, _body(snapshot), key="second")

    assert first.status_code == 202, first.text
    assert refused.status_code == 429, refused.text
    assert refused.json()["title"] == "concurrency_limit_exceeded"
    assert refused.headers["Retry-After"] == "15"
    # Named like a 402 quota (limit_id, limit, used) so the frontend reads it; ``active`` is kept.
    assert refused.json()["concurrency"] == {
        "limit_id": "concurrentJobs", "limit": 1, "used": 1, "active": 1, "unit": "job", "source": "technical",
    }
    assert await db_session.scalar(select(func.count()).select_from(Job)) == 1

    job = await db_session.get(Job, uuid.UUID(first.json()["id"]))
    job.state = JobState.COMPLETED
    await db_session.commit()

    allowed = await _post(api_client, headers, _body(snapshot), key="second")
    assert allowed.status_code == 202, allowed.text


async def test_a_running_job_holds_its_slot_too(api_client, db_session, registration, no_dispatch, monkeypatch):
    set_limit(monkeypatch, 1)
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    first = await _post(api_client, headers, _body(snapshot), key="first")
    (await db_session.get(Job, uuid.UUID(first.json()["id"]))).state = JobState.RUNNING
    await db_session.commit()

    refused = await _post(api_client, headers, _body(snapshot), key="second")

    assert refused.status_code == 429, refused.text


async def test_an_idempotent_replay_at_the_limit_returns_the_job_not_a_429(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 1)
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    first = await _post(api_client, headers, _body(snapshot), key="the-key")

    replay = await _post(api_client, headers, _body(snapshot), key="the-key")

    assert first.status_code == replay.status_code == 202, replay.text
    assert replay.json()["id"] == first.json()["id"] and replay.json()["idempotent"] is True
    assert await limits.count_in_flight(db_session, (await db_session.scalar(select(User.id)))) == 1


async def test_the_limit_is_per_account(api_client, db_session, registration, no_dispatch, monkeypatch):
    set_limit(monkeypatch, 1)
    alice, bob = await _login(api_client, registration()), await _login(api_client, registration())
    alice_snapshot, bob_snapshot = await _snapshot(api_client, alice), await _snapshot(api_client, bob)

    first = await _post(api_client, alice, _body(alice_snapshot), key="a")
    other = await _post(api_client, bob, _body(bob_snapshot), key="b")

    assert first.status_code == other.status_code == 202


async def test_the_limit_does_not_depend_on_the_plan(api_client, db_session, registration, no_dispatch, monkeypatch):
    set_limit(monkeypatch, 1)
    details = registration()
    headers = await _login(api_client, details)
    user_id = await db_session.scalar(select(User.id).where(User.username == details["username"]))
    space_client.get_gate().plans[user_id] = largest_plan()
    snapshot = await _snapshot(api_client, headers)

    await _post(api_client, headers, _body(snapshot), key="first")
    refused = await _post(api_client, headers, _body(snapshot), key="second")

    assert refused.status_code == 429


# -- Retry ------------------------------------------------------------------


async def test_a_retry_at_the_limit_is_a_429_and_a_replay_of_a_retry_is_not(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    user_id, headers = await _account(api_client, registration)
    failed = a_job(user_id, JobState.FAILED)
    busy = a_job(user_id, JobState.QUEUED)
    db_session.add_all([failed, busy])
    await db_session.flush()
    set_limit(monkeypatch, 1)

    refused = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    assert refused.status_code == 429, refused.text
    assert refused.headers["Retry-After"] == "15"
    assert await db_session.scalar(select(func.count(Job.id)).where(Job.retry_of_id == failed.id)) == 0

    busy.state = JobState.COMPLETED
    await db_session.flush()
    first = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    # The replacement now holds the only slot, yet asking again answers with it.
    again = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)

    assert first.status_code == again.status_code == 202, again.text
    assert first.json()["id"] == again.json()["id"]


async def test_cancelling_a_queued_job_frees_its_slot(api_client, db_session, registration, no_dispatch, monkeypatch):
    user_id, headers = await _account(api_client, registration)
    queued = a_job(user_id, JobState.QUEUED)
    failed = a_job(user_id, JobState.FAILED)
    db_session.add_all([queued, failed])
    await db_session.flush()
    set_limit(monkeypatch, 1)
    assert (await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)).status_code == 429

    cancelled = await api_client.post(f"/v1/jobs/{queued.id}/cancel", headers=headers)
    retried = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)

    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    assert retried.status_code == 202, retried.text


# -- Study cells ------------------------------------------------------------


async def study_actors(db_session):
    user = (await db_session.execute(select(User))).scalars().one()
    organization = (await db_session.execute(select(Organization).where(Organization.slug == "lab"))).scalars().one()
    project = (await db_session.execute(select(Project).where(Project.slug == "routing"))).scalars().one()
    return user, organization, project


async def test_a_study_cell_at_the_limit_gets_the_retryable_429(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 1)
    headers = await _study(api_client, registration, [1, 2])
    user, organization, project = await study_actors(db_session)

    # Nothing is dispatched, so the first cell's job keeps the account's only slot.
    run = await api_client.post(BASE, headers=headers)

    assert run.status_code == 202, run.text
    launched, waiting = await _cells(db_session, run.json()["id"])
    assert launched.job_id is not None
    assert waiting.job_id is None and waiting.state is RunState.QUEUED
    with pytest.raises(study_jobs.StudyLaunchError) as refused:
        await study_jobs.launch_study_cell(db_session, waiting, user, organization, project.id)
    assert refused.value.code == "concurrency_limit_exceeded"
    assert refused.value.code in study_jobs.RETRYABLE_LAUNCH_CODES
    assert v1.pending_launches(db_session) == []


async def test_a_run_started_at_the_limit_leaves_its_cells_queued_for_later(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    headers = await _study(api_client, registration, [1, 2])
    user, _, _ = await study_actors(db_session)
    set_limit(monkeypatch, 1)
    db_session.add(a_job(user.id, JobState.QUEUED))
    await db_session.commit()

    run = await api_client.post(BASE, headers=headers)

    assert run.status_code == 202, run.text
    cells = await _cells(db_session, run.json()["id"])
    assert {cell.state for cell in cells} == {RunState.QUEUED}
    assert {cell.job_id for cell in cells} == {None}
    assert run.json()["state"] == "queued"
