"""The plan's ``concurrentJobs`` bounds simultaneous jobs, together with the deployment's cap.

The effective limit is the lower of the two. A plan that declares nothing usable leaves
the cap alone: an unknown limit is neither "no limit" nor "slots that happen to be free".
It is a ceiling on what runs now, counted from rows: a slot is free again the moment a job
ends, and nothing is accumulated, reserved or charged.

Nothing here talks to SPACE: the plan is a synthetic ``PlanCaps`` or the fixture gate, so
these tests say what the gateway does with a limit it is given, not what a real SPACE sends.
The race between two real transactions needs PostgreSQL and is in
``tests/concurrency/test_plan_concurrency_pg.py``.
"""

from __future__ import annotations

import math
import uuid

import pytest
from sqlalchemy import func, select

from test_concurrency_limit import a_job, make_user, set_limit, study_actors
from test_idempotency_jobs import _body, _login, _post, _snapshot
from test_job_dispatch import _account
from test_study_cell_launch import BASE, _cells, _study
from test_usage_limits import plan, set_plan

from openbinding_gateway import study_jobs
from openbinding_gateway.db.models import Job, JobState, RunState
from openbinding_gateway.domain.entitlements import ConcurrencyLimit, concurrency_limit
from openbinding_gateway.jobs import limits
from openbinding_gateway.routes import jobs as job_routes
from openbinding_gateway.routes import v1
from openbinding_gateway.space_client import PlanCaps

LIMIT = "concurrentJobs"


@pytest.fixture
def no_dispatch(monkeypatch):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(v1, "dispatch_persisted_job", queued)
    monkeypatch.setattr(job_routes, "dispatch_persisted_job", queued)


async def jobs_in_the_database(session) -> int:
    return int(await session.scalar(select(func.count()).select_from(Job)))


# -- Which limit applies --------------------------------------------------------


@pytest.mark.parametrize("declared, technical, expected", [
    (2, 8, ConcurrencyLimit(2, "plan")),
    (1, 8, ConcurrencyLimit(1, "plan")),
    # The cap holds whatever the plan says; when both are equal it is the one reached.
    (8, 8, ConcurrencyLimit(8, "technical")),
    (20, 8, ConcurrencyLimit(8, "technical")),
    (1e30, 8, ConcurrencyLimit(8, "technical")),
    # A declared zero is a limit of zero (nothing may run), not an unknown one.
    (0, 8, ConcurrencyLimit(0, "plan")),
    # A fraction is rounded down: 2.9 simultaneous jobs is 2.
    (2.9, 8, ConcurrencyLimit(2, "plan")),
    (0.5, 8, ConcurrencyLimit(0, "plan")),
])
def test_the_lower_of_the_plan_limit_and_the_cap_wins(declared, technical, expected):
    assert concurrency_limit(plan(**{LIMIT: declared}), technical) == expected


@pytest.mark.parametrize("raw", [math.inf, math.nan, -1.0, -math.inf, None, "many", [], {}, True])
def test_a_limit_that_is_unlimited_or_unusable_leaves_the_cap_alone(raw):
    caps = PlanCaps(plan="ODD", limits={LIMIT: raw})

    assert concurrency_limit(caps, 5) == ConcurrencyLimit(5, "technical")


def test_a_plan_that_does_not_declare_the_limit_leaves_the_cap_alone():
    assert concurrency_limit(PlanCaps(plan="BARE"), 5) == ConcurrencyLimit(5, "technical")
    # No plan at all (the callers that have none): the cap alone, as before the plan was consulted.
    assert concurrency_limit(None, 5) == ConcurrencyLimit(5, "technical")


# -- Counting against it --------------------------------------------------------


async def test_the_refusal_names_the_plan_as_the_source_of_the_limit(db_session):
    user = await make_user(db_session)
    db_session.add_all([a_job(user.id, JobState.QUEUED), a_job(user.id, JobState.RUNNING)])
    await db_session.flush()

    refusal = await limits.enforce_concurrency_limit(db_session, user.id, limit=8, caps=plan(**{LIMIT: 2}))

    assert (refusal.status, refusal.code) == (429, "concurrency_limit_exceeded")
    assert refusal.extra == {
        "concurrency": {
            "limit_id": "concurrentJobs", "limit": 2, "used": 2, "active": 2, "unit": "job", "source": "plan",
        }
    }
    assert refusal.headers == {"Retry-After": "15"}
    # With room under the plan limit nothing is refused, and neither is a larger plan under the same cap.
    assert await limits.enforce_concurrency_limit(db_session, user.id, limit=8, caps=plan(**{LIMIT: 3})) is None
    assert await limits.enforce_concurrency_limit(db_session, user.id, limit=8) is None


async def test_an_unknown_plan_limit_is_the_cap_not_free_slots_and_not_a_refusal(db_session):
    user = await make_user(db_session)
    db_session.add_all([a_job(user.id), a_job(user.id)])
    await db_session.flush()
    unknown = PlanCaps(plan="BARE")

    # Two in flight, cap of three: the unknown plan does not refuse, and does not widen the cap either.
    assert await limits.enforce_concurrency_limit(db_session, user.id, limit=3, caps=unknown) is None
    refusal = await limits.enforce_concurrency_limit(db_session, user.id, limit=2, caps=unknown)
    assert refusal.extra["concurrency"]["source"] == "technical"
    assert refusal.extra["concurrency"]["limit"] == 2


async def test_a_plan_limit_of_zero_refuses_every_creation(db_session):
    user = await make_user(db_session)

    refusal = await limits.enforce_concurrency_limit(db_session, user.id, limit=8, caps=plan(**{LIMIT: 0}))

    assert (refusal.status, refusal.extra["concurrency"]["limit"], refusal.extra["concurrency"]["used"]) == (429, 0, 0)


async def test_a_plan_slot_is_free_again_when_the_job_ends_and_nothing_accumulates(db_session):
    user = await make_user(db_session)
    caps = plan(**{LIMIT: 1})
    for _ in range(4):
        assert await limits.enforce_concurrency_limit(db_session, user.id, limit=8, caps=caps) is None
        job = a_job(user.id)
        db_session.add(job)
        await db_session.flush()
        assert (await limits.enforce_concurrency_limit(db_session, user.id, limit=8, caps=caps)).status == 429
        job.state = JobState.COMPLETED
        await db_session.flush()

    # Four jobs went through one slot; the refusals created nothing and left nothing counted.
    assert await jobs_in_the_database(db_session) == 4
    assert await limits.count_in_flight(db_session, user.id) == 0


# -- POST /v1/jobs ----------------------------------------------------------------


async def test_a_plan_limit_below_the_cap_refuses_the_next_job_and_a_finished_one_frees_the_slot(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 8)
    set_plan(**{LIMIT: 1})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    first = await _post(api_client, headers, _body(snapshot), key="first")
    refused = await _post(api_client, headers, _body(snapshot), key="second")

    assert first.status_code == 202, first.text
    assert refused.status_code == 429, refused.text
    assert refused.json()["code"] == "concurrency_limit_exceeded"
    assert refused.headers["Retry-After"] == "15"
    assert refused.json()["concurrency"] == {
        "limit_id": "concurrentJobs", "limit": 1, "used": 1, "active": 1, "unit": "job", "source": "plan",
    }
    assert await jobs_in_the_database(db_session) == 1

    (await db_session.get(Job, uuid.UUID(first.json()["id"]))).state = JobState.COMPLETED
    await db_session.commit()
    allowed = await _post(api_client, headers, _body(snapshot), key="second")
    assert allowed.status_code == 202, allowed.text


async def test_a_plan_above_the_cap_is_held_to_the_cap(api_client, db_session, registration, no_dispatch, monkeypatch):
    set_limit(monkeypatch, 1)
    set_plan(**{LIMIT: 50})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    await _post(api_client, headers, _body(snapshot), key="first")
    refused = await _post(api_client, headers, _body(snapshot), key="second")

    assert refused.status_code == 429, refused.text
    assert refused.json()["concurrency"]["source"] == "technical"
    assert refused.json()["concurrency"]["limit"] == 1


@pytest.mark.parametrize("declared", [None, math.inf], ids=["undeclared", "unlimited"])
async def test_a_plan_without_a_usable_limit_gets_the_cap_and_not_unlimited_jobs(
    api_client, db_session, registration, no_dispatch, monkeypatch, declared
):
    set_limit(monkeypatch, 2)
    set_plan(**{LIMIT: declared})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    accepted = [await _post(api_client, headers, _body(snapshot), key=f"job-{index}") for index in range(2)]
    refused = await _post(api_client, headers, _body(snapshot), key="job-2")

    assert [response.status_code for response in accepted] == [202, 202]
    assert refused.status_code == 429, refused.text
    assert refused.json()["concurrency"]["source"] == "technical"
    assert refused.json()["concurrency"]["limit"] == 2


async def test_the_fixture_plan_that_allows_one_job_at_a_time_is_held_to_it(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 8)  # the default gate: the fixture's default plan declares one
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    await _post(api_client, headers, _body(snapshot), key="first")
    refused = await _post(api_client, headers, _body(snapshot), key="second")

    assert refused.status_code == 429, refused.text
    assert refused.json()["concurrency"]["limit"] == 1 and refused.json()["concurrency"]["source"] == "plan"


async def test_an_idempotent_replay_at_the_plan_limit_returns_the_job_and_takes_no_second_slot(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 8)
    set_plan(**{LIMIT: 1})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    first = await _post(api_client, headers, _body(snapshot), key="the-key")

    replay = await _post(api_client, headers, _body(snapshot), key="the-key")

    assert first.status_code == replay.status_code == 202, replay.text
    assert replay.json()["id"] == first.json()["id"] and replay.json()["idempotent"] is True
    assert await jobs_in_the_database(db_session) == 1
    assert await limits.count_in_flight(db_session, await db_session.scalar(select(Job.owner_id))) == 1


async def test_the_plan_limit_is_per_account(api_client, db_session, registration, no_dispatch, monkeypatch):
    set_limit(monkeypatch, 8)
    set_plan(**{LIMIT: 1})
    alice, bob = await _login(api_client, registration()), await _login(api_client, registration())
    alice_snapshot, bob_snapshot = await _snapshot(api_client, alice), await _snapshot(api_client, bob)

    first = await _post(api_client, alice, _body(alice_snapshot), key="a")
    other = await _post(api_client, bob, _body(bob_snapshot), key="b")

    assert first.status_code == other.status_code == 202


# -- Retry ------------------------------------------------------------------------


async def test_a_retry_at_the_plan_limit_is_a_429_and_a_replay_of_a_retry_is_not(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 8)
    set_plan(**{LIMIT: 1})
    user_id, headers = await _account(api_client, registration)
    failed, busy = a_job(user_id, JobState.FAILED), a_job(user_id, JobState.QUEUED)
    db_session.add_all([failed, busy])
    await db_session.flush()

    refused = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    assert refused.status_code == 429, refused.text
    assert refused.json()["concurrency"]["source"] == "plan" and refused.json()["concurrency"]["limit"] == 1
    assert refused.headers["Retry-After"] == "15"
    assert await db_session.scalar(select(func.count(Job.id)).where(Job.retry_of_id == failed.id)) == 0

    busy.state = JobState.COMPLETED
    await db_session.flush()
    first = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    again = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)

    assert first.status_code == again.status_code == 202, again.text
    assert first.json()["id"] == again.json()["id"]
    assert await db_session.scalar(select(func.count(Job.id)).where(Job.retry_of_id == failed.id)) == 1


# -- Study cells ------------------------------------------------------------------


async def test_a_study_cell_over_the_plan_limit_gets_the_retryable_429(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    set_limit(monkeypatch, 8)
    headers = await _study(api_client, registration, [1, 2])
    set_plan(**{LIMIT: 1})
    user, organization, project = await study_actors(db_session)

    # Nothing is dispatched, so the first cell's job keeps the plan's only slot.
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
