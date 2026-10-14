"""The port for SPACE's period counters (class B), against a synthetic source.

``taskStarts``, ``federatedTaskStarts``, ``solverSeconds`` and ``studyRuns`` accumulate per
billing period, and the gateway keeps no count of them: if SPACE measures them it is the
source, and the gateway only asks (``domain/usage_counters.py``). Nothing here talks to
SPACE. ``SyntheticSpaceUsage`` answers with whatever a test tells it to, so these tests say
what the gateway does with each kind of answer (room, exhausted, unknown, nonsense), not what
a real SPACE would send. Also: a deployment-side cap on the cells of a study run, which needs
no counter at all.
"""

from __future__ import annotations

import json
import math
import uuid

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from test_concurrency_limit import a_job
from test_idempotency_jobs import _body, _login, _post, _snapshot
from test_job_dispatch import _account
from test_study_cell_launch import BASE, _cells, _study
from test_usage_limits import set_plan

from openbinding_gateway import study_jobs
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import Job, JobState, RunState, StudyCell, StudyRun
from openbinding_gateway.domain import usage_counters
from openbinding_gateway.domain.usage_counters import (
    EXHAUSTED_CODE,
    UNKNOWN_CODE,
    UnreportedUsage,
    UsageCounterSource,
    UsageReading,
    UsageState,
)
from openbinding_gateway.models.problem import problem_body
from openbinding_gateway.routes import jobs as job_routes
from openbinding_gateway.routes import v1
from openbinding_gateway.space_client import PricingUnavailable
from openbinding_gateway.telemetry import categorize_error

USER = uuid.uuid4()


class SyntheticSpaceUsage:
    """A stand-in for SPACE's native counters: read-only, and it remembers every question.

    ``readings`` maps a counter to a ``UsageReading``, to an exception to raise, or to a
    callable returning either; a counter it has no entry for is ``available`` with no limit.
    """

    def __init__(self, **readings):
        self.readings = dict(readings)
        self.asked: list[str] = []

    async def reading(self, user_id, counter):
        self.asked.append(counter)
        answer = self.readings.get(counter, UsageReading.available(counter))
        if callable(answer):
            answer = answer()
        if isinstance(answer, BaseException):
            raise answer
        return answer


@pytest.fixture
def space():
    """Installs a synthetic source for the test and removes it afterwards (none is the default)."""
    source = SyntheticSpaceUsage()
    usage_counters.set_usage_source(source)
    yield source
    usage_counters.set_usage_source(None)


@pytest.fixture
def no_dispatch(monkeypatch):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(v1, "dispatch_persisted_job", queued)
    monkeypatch.setattr(job_routes, "dispatch_persisted_job", queued)


async def count(session, model) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)))


def quota_of(body: dict) -> dict:
    """The ``quota`` of a problem, wherever the route puts it (top level, or inside ``detail``)."""
    return body["quota"] if "quota" in body else body["detail"]["quota"]


# -- The port --------------------------------------------------------------------------


def test_the_synthetic_source_satisfies_the_port_and_so_does_the_fail_closed_one():
    assert isinstance(SyntheticSpaceUsage(), UsageCounterSource)
    assert isinstance(UnreportedUsage(), UsageCounterSource)


async def test_without_a_source_nothing_is_asked_and_nothing_is_enforced():
    assert usage_counters.get_usage_source() is None

    assert await usage_counters.usage_refusal(USER, "taskStarts", "solverSeconds") is None
    assert await usage_counters.job_start_refusal(USER, federated=True) is None


@pytest.mark.parametrize("reading", [
    UsageReading.available("taskStarts", used=3, limit=10),
    UsageReading.available("taskStarts", used=0),            # no limit declared: unlimited
    UsageReading.available("taskStarts", used=9.5, limit=10),
    UsageReading.available("taskStarts", used=5, limit=math.inf),  # SPACE's unlimited
])
async def test_a_counter_with_room_goes_on(reading):
    assert usage_counters.refusal_for(usage_counters.sanitize(reading, "taskStarts")) is None


@pytest.mark.parametrize("reading", [
    UsageReading.exhausted("taskStarts"),
    UsageReading.exhausted("taskStarts", used=10, limit=10),
    # The numbers win over the label: "available" with nothing left is exhausted.
    UsageReading.available("taskStarts", used=10, limit=10),
    UsageReading.available("taskStarts", used=11, limit=10),
    UsageReading.available("taskStarts", used=1, limit=0),
])
async def test_an_exhausted_counter_is_a_402_with_a_quota_the_frontend_reads(reading):
    refusal = usage_counters.refusal_for(usage_counters.sanitize(reading, "taskStarts"))

    assert (refusal.status, refusal.code) == (402, EXHAUSTED_CODE)
    quota = refusal.extra["quota"]
    assert quota["limit_id"] == "taskStarts" and quota["state"] == "exhausted"
    assert quota["unit"] == "task" and quota["source"] == "space"
    assert refusal.headers == {}  # waiting a few seconds does not renew a period counter


def test_the_exhausted_quota_carries_the_numbers_it_was_given():
    refusal = usage_counters.refusal_for(UsageReading.exhausted("solverSeconds", used=3600.0, limit=3600.0))

    assert refusal.extra["quota"] == {
        "limit_id": "solverSeconds", "state": "exhausted", "unit": "second", "source": "space",
        "limit": 3600.0, "used": 3600.0,
    }


@pytest.mark.parametrize("answer", [
    UsageReading.unknown("taskStarts"),
    "available",                                                           # not a reading
    None,
    UsageReading.available("studyRuns", used=0, limit=5),                  # another counter's answer
    UsageReading.available("taskStarts", used=math.nan, limit=5),
    UsageReading.available("taskStarts", used=-1, limit=5),
    UsageReading.available("taskStarts", used=1, limit=-5),
    UsageReading.available("taskStarts", used=1, limit=math.nan),
    UsageReading.available("taskStarts", used=True, limit=5),
    UsageReading.available("taskStarts", used="1", limit=5),
    UsageReading.available("taskStarts", used=1, limit=-math.inf),
    UsageReading("taskStarts", "available", 1, 5),                         # a state that is not a UsageState
    PricingUnavailable("SPACE is down"),                                   # the source could not be asked
    RuntimeError("boom"),
    TimeoutError(),
], ids=lambda value: type(value).__name__ + ":" + str(getattr(value, "state", value))[:30])
async def test_an_answer_that_is_unknown_or_makes_no_sense_is_never_room(answer):
    source = SyntheticSpaceUsage(taskStarts=answer)

    reading = await usage_counters.read(source, USER, "taskStarts")
    refusal = usage_counters.refusal_for(reading)

    assert reading.state is UsageState.UNKNOWN
    assert (refusal.status, refusal.code) == (503, UNKNOWN_CODE)
    assert refusal.extra["quota"] == {
        "limit_id": "taskStarts", "state": "unknown", "unit": "task", "source": "space",
    }
    assert refusal.headers == {"Retry-After": "15"}


async def test_a_source_that_knows_nothing_refuses_every_start_as_unknown():
    usage_counters.set_usage_source(UnreportedUsage())
    try:
        refusal = await usage_counters.job_start_refusal(USER, federated=False)
    finally:
        usage_counters.set_usage_source(None)

    assert (refusal.status, refusal.code) == (503, UNKNOWN_CODE)


async def test_a_job_start_asks_its_task_counter_then_the_solver_seconds_and_stops_at_the_first_refusal(space):
    assert await usage_counters.job_start_refusal(USER, federated=False) is None
    assert await usage_counters.job_start_refusal(USER, federated=True) is None
    assert space.asked == ["taskStarts", "solverSeconds", "federatedTaskStarts", "solverSeconds"]

    space.asked.clear()
    space.readings["taskStarts"] = UsageReading.exhausted("taskStarts")
    refusal = await usage_counters.job_start_refusal(USER, federated=False)
    assert refusal.code == EXHAUSTED_CODE
    assert space.asked == ["taskStarts"]


def test_the_refusals_are_json_safe_and_filed_as_plan_limits_for_diagnostics():
    for refusal in (
        usage_counters.refusal_for(UsageReading.exhausted("studyRuns", used=5, limit=5)),
        usage_counters.refusal_for(UsageReading.unknown("studyRuns")),
    ):
        body = problem_body(refusal.status, refusal.code, refusal.detail, extra=refusal.extra)
        assert json.loads(json.dumps(body, allow_nan=False)) == body
    assert categorize_error(402, EXHAUSTED_CODE) == "pricing_quota"
    assert categorize_error(503, UNKNOWN_CODE) == "pricing_quota"
    assert categorize_error(503, "something_else") == "system_bug"


def test_only_the_unknown_refusal_is_retryable_for_a_study_cell():
    assert UNKNOWN_CODE in study_jobs.RETRYABLE_LAUNCH_CODES
    assert EXHAUSTED_CODE not in study_jobs.RETRYABLE_LAUNCH_CODES


# -- A job start --------------------------------------------------------------------------


async def test_an_exhausted_counter_refuses_the_job_before_anything_is_written(
    api_client, db_session, registration, no_dispatch, space
):
    space.readings["taskStarts"] = UsageReading.exhausted("taskStarts", used=5, limit=5)
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    refused = await _post(api_client, headers, _body(snapshot), key="the-key")

    assert refused.status_code == 402, refused.text
    body = refused.json()
    assert body["code"] == EXHAUSTED_CODE
    assert quota_of(body) == {
        "limit_id": "taskStarts", "state": "exhausted", "unit": "task", "source": "space", "limit": 5.0, "used": 5.0,
    }
    assert await count(db_session, Job) == 0

    # Nothing was reserved and the key was not spent: once the counter has room the same request goes through.
    space.readings["taskStarts"] = UsageReading.available("taskStarts", used=4, limit=5)
    accepted = await _post(api_client, headers, _body(snapshot), key="the-key")
    assert accepted.status_code == 202, accepted.text
    assert await count(db_session, Job) == 1


async def test_a_counter_that_cannot_be_read_refuses_the_job_as_unknown_and_creates_nothing(
    api_client, db_session, registration, no_dispatch, space
):
    space.readings["solverSeconds"] = PricingUnavailable("SPACE is down")
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    refused = await _post(api_client, headers, _body(snapshot), key="unread")

    assert refused.status_code == 503, refused.text
    assert refused.json()["code"] == UNKNOWN_CODE
    assert refused.headers["Retry-After"] == "15"
    assert quota_of(refused.json())["state"] == "unknown" and "limit" not in quota_of(refused.json())
    assert await count(db_session, Job) == 0


async def test_a_replay_is_answered_before_the_counters_are_asked_so_it_is_not_counted_twice(
    api_client, db_session, registration, no_dispatch, space
):
    set_plan()  # room for a second job in flight, so only the counter can refuse the new key
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    first = await _post(api_client, headers, _body(snapshot), key="once")
    assert first.status_code == 202, first.text
    assert space.asked == ["taskStarts", "solverSeconds"]  # one question per start, asked once

    # SPACE has now counted that start, and the period's last one is spent.
    space.readings["taskStarts"] = UsageReading.available("taskStarts", used=1, limit=1)
    replay = await _post(api_client, headers, _body(snapshot), key="once")
    assert replay.status_code == 202, replay.text
    assert replay.json()["id"] == first.json()["id"] and replay.json()["idempotent"] is True
    assert space.asked == ["taskStarts", "solverSeconds"]  # the replay asked nothing

    # A new key is a new start and meets the spent counter.
    other = await _post(api_client, headers, _body(snapshot), key="twice")
    assert other.status_code == 402, other.text
    assert await count(db_session, Job) == 1


async def test_a_retry_is_a_new_start_but_the_replay_of_a_retry_is_not(
    api_client, db_session, registration, no_dispatch, space
):
    user_id, headers = await _account(api_client, registration)
    failed = a_job(user_id, JobState.FAILED)
    db_session.add(failed)
    await db_session.flush()

    space.readings["taskStarts"] = UsageReading.exhausted("taskStarts")
    refused = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    assert refused.status_code == 402, refused.text
    assert await db_session.scalar(select(func.count(Job.id)).where(Job.retry_of_id == failed.id)) == 0

    space.readings["taskStarts"] = UsageReading.available("taskStarts", used=0, limit=1)
    first = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    assert first.status_code == 202, first.text
    asked = list(space.asked)

    space.readings["taskStarts"] = UsageReading.exhausted("taskStarts")
    again = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    assert again.status_code == 202, again.text
    assert again.json()["id"] == first.json()["id"]
    assert space.asked == asked
    assert await db_session.scalar(select(func.count(Job.id)).where(Job.retry_of_id == failed.id)) == 1


# -- A study run ---------------------------------------------------------------------------


async def test_an_exhausted_study_runs_counter_refuses_the_run_whole_and_writes_nothing(
    api_client, db_session, registration, no_dispatch, space
):
    headers = await _study(api_client, registration, [1, 2])
    space.readings["studyRuns"] = UsageReading.exhausted("studyRuns", used=3, limit=3)

    refused = await api_client.post(BASE, headers=headers)

    assert refused.status_code == 402, refused.text
    assert refused.json()["code"] == EXHAUSTED_CODE
    assert quota_of(refused.json())["limit_id"] == "studyRuns" and quota_of(refused.json())["unit"] == "run"
    assert [await count(db_session, model) for model in (StudyRun, StudyCell, Job)] == [0, 0, 0]

    space.readings["studyRuns"] = UsageReading.available("studyRuns", used=2, limit=3)
    accepted = await api_client.post(BASE, headers=headers)
    assert accepted.status_code == 202, accepted.text
    assert await count(db_session, StudyRun) == 1


async def test_an_unreadable_study_runs_counter_refuses_the_run_as_unknown(
    api_client, db_session, registration, no_dispatch, space
):
    headers = await _study(api_client, registration, [1])
    space.readings["studyRuns"] = TimeoutError()

    refused = await api_client.post(BASE, headers=headers)

    assert refused.status_code == 503, refused.text
    assert refused.json()["code"] == UNKNOWN_CODE
    assert refused.headers["Retry-After"] == "15"
    assert await count(db_session, StudyRun) == 0


async def test_a_cell_whose_counter_is_unknown_stays_queued_for_later_instead_of_failing(
    api_client, db_session, registration, no_dispatch, space
):
    headers = await _study(api_client, registration, [1, 2])
    space.readings["taskStarts"] = UsageReading.unknown("taskStarts")

    run = await api_client.post(BASE, headers=headers)

    assert run.status_code == 202, run.text
    cells = await _cells(db_session, run.json()["id"])
    assert {cell.state for cell in cells} == {RunState.QUEUED}
    assert {cell.job_id for cell in cells} == {None}
    assert await count(db_session, Job) == 0


# -- A deployment cap on the cells of one run ------------------------------------------------


def test_the_cell_cap_is_off_by_default_and_read_from_the_environment(monkeypatch):
    monkeypatch.delenv("MAX_CELLS_PER_STUDY_RUN", raising=False)
    assert Settings(_env_file=None).max_cells_per_study_run is None

    monkeypatch.setenv("MAX_CELLS_PER_STUDY_RUN", "50")
    assert Settings(_env_file=None).max_cells_per_study_run == 50


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "many"])
def test_the_cell_cap_must_be_a_positive_whole_number(monkeypatch, value):
    monkeypatch.setenv("MAX_CELLS_PER_STUDY_RUN", value)

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


async def test_a_run_past_the_cell_cap_is_refused_whole_before_anything_is_written(
    api_client, db_session, registration, no_dispatch, monkeypatch
):
    headers = await _study(api_client, registration, [1, 2])
    monkeypatch.setattr(get_settings(), "max_cells_per_study_run", 1)

    refused = await api_client.post(BASE, headers=headers)

    assert refused.status_code == 422, refused.text
    body = refused.json()
    assert body["code"] == "study_run_too_large"
    assert quota_of(body) == {
        "limit_id": "maxCellsPerRun", "state": "exhausted", "unit": "cell", "source": "technical",
        "limit": 1, "used": 2,
    }
    assert [await count(db_session, model) for model in (StudyRun, StudyCell, Job)] == [0, 0, 0]

    # A cap equal to the number of cells lets the run through, and so does no cap at all.
    monkeypatch.setattr(get_settings(), "max_cells_per_study_run", 2)
    assert (await api_client.post(BASE, headers=headers)).status_code == 202
    monkeypatch.setattr(get_settings(), "max_cells_per_study_run", None)
    assert (await api_client.post(BASE, headers=headers)).status_code == 202
    assert await count(db_session, StudyRun) == 2
