"""Usage limits that are measurable: size of the binding space, simultaneous jobs, time.

Nothing here talks to SPACE. The plan comes from synthetic ``PlanCaps`` (or the fake
gate built from ``fixtures/pricing_test.yml``), so these tests say what the gateway
does with a limit it is given, not what a real SPACE would deliver.

The limits are ceilings on a measurable thing: how big the binding space of one job is
(an estimate, see ``domain/binding_space.py``), how many jobs run at once, how long one
may take. None of them is a balance that is spent and renewed; a refused request holds
no slot and writes nothing, so there is nothing to refund.
"""

from __future__ import annotations

import json
import math
import uuid

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select

from test_concurrency_limit import a_job, set_limit
from test_idempotency_jobs import _body, _login, _post, _snapshot
from test_job_dispatch import _account
from test_study_cell_launch import BASE, _study

from openbinding_gateway import space_client
from openbinding_gateway.access import policy
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import Job, JobState, InstanceSnapshot, StudyCell, StudyRun, User
from openbinding_gateway.domain.binding_space import (
    EXCEEDED,
    LIMIT_ID,
    LIMIT_UNKNOWN,
    OVER_TECHNICAL,
    UNMEASURED,
    BindingSpace,
    cardinality_exceeds,
    check,
    decimal_digits,
    log10_of,
    parse_cardinality,
)
from openbinding_gateway.jobs import limits as job_limits
from openbinding_gateway.models.problem import problem_body
from openbinding_gateway.routes import jobs as job_routes
from openbinding_gateway.routes import v1
from openbinding_gateway.services.snapshots import Compilation, ir_analysis
from openbinding_gateway.space_client import OpenCaps, OpenGate, PlanCaps
from openbinding_gateway.space_client.open import OPEN_FEATURES


def plan(**limits) -> PlanCaps:
    return PlanCaps(plan="TEST", features={"solve": True}, limits={k: float(v) for k, v in limits.items()})


# -- Reading the size ---------------------------------------------------------


@pytest.mark.parametrize("value, expected", [
    ("2", "2"),
    ("0", "0"),
    ("007", "7"),
    (2, "2"),
    (0, "0"),
    pytest.param("1" + "0" * 5000, "1" + "0" * 5000, id="string-of-5001-digits"),
    # An explicit id: pytest would otherwise call str() on the integer, which Python refuses at this size.
    pytest.param(10**5000, "1" + "0" * 5000, id="int-of-5001-digits"),
])
def test_a_cardinality_is_read_as_canonical_decimal_digits(value, expected):
    assert parse_cardinality(value) == expected


@pytest.mark.parametrize("value", [None, True, False, -1, 2.0, 2.5, "", " 1", "1 ", "-1", "+1", "1e3", "0x10", "1.0", "²", "٣", [], {}])
def test_anything_else_is_not_a_cardinality(value):
    assert parse_cardinality(value) is None


def test_digits_beyond_the_interpreters_text_limit_are_produced_without_str():
    value = 10**4400 + 123

    assert decimal_digits(value) == "1" + "0" * 4397 + "123"
    assert len(decimal_digits(value)) == 4401
    assert decimal_digits(0) == "0"
    with pytest.raises(ValueError):
        decimal_digits(-1)


def test_log10_of_a_decimal_string_is_exact_to_float_precision_at_any_length():
    assert log10_of("0") == 0.0
    assert log10_of("1") == 0.0
    assert log10_of("1000") == pytest.approx(3.0, abs=1e-12)
    assert log10_of("2") == pytest.approx(math.log10(2), abs=1e-15)
    assert log10_of("3" + "0" * 4999) == pytest.approx(5000 + math.log10(3) - 1, abs=1e-9)


def test_an_analysis_is_read_without_raising_whatever_it_holds():
    garbage = [
        None,
        {},
        {"bindingSpaceCardinality": 2.5, "bindingSpaceLog10": "x"},
        {"bindingSpaceCardinality": "-3", "bindingSpaceLog10": -1.0},
        {"bindingSpaceCardinality": None, "bindingSpaceLog10": float("nan")},
        {"bindingSpaceLog10": True},
    ]
    for analysis in garbage:
        space = BindingSpace.from_analysis(analysis)
        assert (space.cardinality, space.log10, space.measured) == (None, None, False), analysis

    space = BindingSpace.from_analysis({"bindingSpaceCardinality": "8", "bindingSpaceLog10": 0.9030899869919435})
    assert (space.cardinality, space.measured) == ("8", True)
    # The estimate comes from the exact digits, not from the float BIM summed.
    assert space.log10_estimate == pytest.approx(math.log10(8), abs=1e-15)


# -- Comparing it with a ceiling ----------------------------------------------


@pytest.mark.parametrize("cardinality, ceiling, exceeds", [
    # Whole ceilings (the unit of the plans) are exact: no logarithm decides.
    (str(10**9), 9, False),
    (str(10**9 + 1), 9, True),
    (str(10**9 - 1), 9, False),
    ("1", 0, False),
    ("2", 0, True),
    ("10", 1, False),
    ("11", 1, True),
    ("0", 0, False),
    ("0", 3, False),
    ("1" + "0" * 4320, 4320, False),
    ("1" + "0" * 4320 + "0", 4320, True),
    ("1" + "0" * 4319 + "1", 4319, True),
    # Fractional ceilings are decided on the leading digits.
    ("2", 0.3, True),
    ("2", 0.31, False),
    ("5", 0.5, True),
    ("3" + "0" * 40, 40.4771, True),
    ("3" + "0" * 40, 40.4772, False),
    ("1" + "0" * 4320, 4319.5, True),
    # A ceiling far larger than the number of digits is never reached, and costs nothing to test.
    ("9" * 100, 1e300, False),
    ("9" * 100, 99.0, True),
    ("9" * 100, 100.0, False),
])
def test_the_cardinality_is_compared_with_the_ceiling_exactly(cardinality, ceiling, exceeds):
    assert cardinality_exceeds(cardinality, ceiling) is exceeds


def test_summed_logarithms_do_not_decide_a_limit_when_the_exact_size_is_known():
    # 5 candidates times 2 candidates: exactly 10. The float sum of the two log10 can land on
    # either side of 1.0; the exact digits cannot.
    analysis = {"bindingSpaceCardinality": "10", "bindingSpaceLog10": math.log10(5) + math.log10(2)}

    assert BindingSpace.from_analysis(analysis).exceeds(1.0) is False
    assert check(BindingSpace.from_analysis(analysis), plan(**{LIMIT_ID: 1})) is None


def test_without_digits_the_float_log10_is_the_fallback():
    assert BindingSpace(None, 3.0).exceeds(2.0) is True
    assert BindingSpace(None, 3.0).exceeds(3.0) is False
    assert BindingSpace(None, None).exceeds(0.0) is False


# -- The decision: exhausted, unknown, unlimited ------------------------------


def test_a_space_above_the_plan_ceiling_is_the_402_with_a_quota_the_frontend_reads():
    refusal = check(BindingSpace("1000", 3.0), plan(**{LIMIT_ID: 2}))

    assert (refusal.status, refusal.code) == (402, EXCEEDED)
    assert refusal.detail == "instance binding space exceeds the caller plan limit"
    assert refusal.extra["quota"] == {
        "limit_id": LIMIT_ID, "state": "exhausted", "unit": "log10 combinations",
        "source": "plan", "limit": 2.0, "used": 3.0,
    }
    assert refusal.extra["binding_space"] == {"kind": "estimate", "log10": 3.0, "digits": 4, "cardinality": "1000"}


def test_a_space_exactly_at_the_ceiling_is_allowed():
    assert check(BindingSpace("100", 2.0), plan(**{LIMIT_ID: 2})) is None
    assert check(BindingSpace("101", 2.0043), plan(**{LIMIT_ID: 2})).code == EXCEEDED


def test_an_unlimited_plan_sets_no_ceiling():
    unlimited = plan(**{LIMIT_ID: math.inf})

    assert check(BindingSpace("9" * 5000, None), unlimited) is None
    # Nothing to compare with, so an unreadable size does not matter either.
    assert check(BindingSpace(None, None), unlimited) is None
    assert check(BindingSpace("9" * 100, None), OpenCaps()) is None


def test_the_technical_safeguard_applies_to_an_unlimited_plan_and_is_a_422_not_a_402():
    refusal = check(BindingSpace("1000", 3.0), plan(**{LIMIT_ID: math.inf}), technical_log10=2.0)

    assert (refusal.status, refusal.code) == (422, OVER_TECHNICAL)
    assert refusal.extra["quota"]["source"] == "technical"
    assert refusal.extra["quota"]["limit"] == 2.0
    assert check(BindingSpace("100", 2.0), plan(**{LIMIT_ID: math.inf}), technical_log10=2.0) is None


def test_the_smaller_of_plan_and_safeguard_is_the_ceiling():
    space = BindingSpace("1000", 3.0)

    assert check(space, plan(**{LIMIT_ID: 2}), technical_log10=5.0).code == EXCEEDED
    assert check(space, plan(**{LIMIT_ID: 5}), technical_log10=2.0).code == OVER_TECHNICAL
    assert check(space, plan(**{LIMIT_ID: 5}), technical_log10=5.0) is None


def test_a_plan_that_declares_no_limit_is_refused_not_granted():
    refusal = check(BindingSpace("2", math.log10(2)), PlanCaps(plan="BARE"))

    assert (refusal.status, refusal.code) == (403, LIMIT_UNKNOWN)
    assert refusal.extra["quota"]["state"] == "unknown"
    assert "limit" not in refusal.extra["quota"]
    # A one-combination instance is not exempt: the limit is unknown, not large.
    assert check(BindingSpace("1", 0.0), PlanCaps(plan="BARE")).code == LIMIT_UNKNOWN


@pytest.mark.parametrize("raw", [float("nan"), -1.0, -math.inf, "many", None])
def test_a_limit_that_is_not_a_usable_number_is_unknown_too(raw):
    caps = PlanCaps(plan="ODD", limits={LIMIT_ID: raw})

    assert check(BindingSpace("2", 0.3), caps).code == LIMIT_UNKNOWN


def test_the_safeguard_stands_in_for_an_unknown_plan_limit():
    bare = PlanCaps(plan="BARE")

    assert check(BindingSpace("100", 2.0), bare, technical_log10=3.0) is None
    refusal = check(BindingSpace("100000", 5.0), bare, technical_log10=3.0)
    assert (refusal.status, refusal.code) == (422, OVER_TECHNICAL)


def test_a_ceiling_with_no_readable_size_is_refused_as_unmeasured():
    refusal = check(BindingSpace(None, None), plan(**{LIMIT_ID: 9}))

    assert (refusal.status, refusal.code) == (422, UNMEASURED)
    assert refusal.extra["quota"]["state"] == "unmeasured"
    assert "used" not in refusal.extra["quota"]


def test_a_refusal_is_json_safe_and_bounded_whatever_the_size():
    refusal = check(BindingSpace("1" + "0" * 4320, 4320.0), plan(**{LIMIT_ID: 100}))

    body = problem_body(refusal.status, refusal.code, refusal.detail, extra=refusal.extra)
    text = json.dumps(body, allow_nan=False)
    assert len(text) < 1500
    assert body["binding_space"] == {"kind": "estimate", "log10": 4320.0, "digits": 4321, "cardinality": None}
    assert body["quota"]["limit"] == 100.0
    assert json.loads(text) == body


def test_every_binding_space_refusal_is_reported_to_diagnostics_as_a_plan_limit():
    from openbinding_gateway.domain.binding_space import REFUSAL_CODES
    from openbinding_gateway.telemetry import categorize_error

    assert REFUSAL_CODES == {EXCEEDED, OVER_TECHNICAL, LIMIT_UNKNOWN, UNMEASURED}
    # A 403 or a 422 would otherwise be filed as an authentication or validation failure.
    for status, code in ((402, EXCEEDED), (422, OVER_TECHNICAL), (403, LIMIT_UNKNOWN), (422, UNMEASURED)):
        assert categorize_error(status, code) == "pricing_quota", code
    assert categorize_error(403, "forbidden") == "auth"
    assert categorize_error(422, "validation_error") == "validation"


# -- Sizes the text conversion of Python cannot hold ---------------------------


def _ir_with(tasks: int, candidates: int) -> dict:
    ids = [f"t{index}" for index in range(tasks)]
    return {"spec": {
        "application": {"tasks": {task: {"kind": "service"} for task in ids}},
        "eligibility": {task: list(range(candidates)) for task in ids},
        "candidates": {},
    }}


def test_a_binding_space_of_more_than_4300_digits_is_analysed_and_limited_without_an_exception():
    analysis = ir_analysis(_ir_with(1440, 1000))

    assert analysis["bindingSpaceCardinality"] == "1" + "0" * 4320
    assert analysis["serviceTasks"] == 1440
    compilation = Compilation(
        archive=b"", ir={}, ir_digest="", instance_digest=None, package_digest="", compilation_digest="",
        source_map={}, analysis=analysis,
    )
    assert compilation.binding_space.cardinality == "1" + "0" * 4320
    assert compilation.binding_space_text == "1" + "0" * 4320
    assert check(compilation.binding_space, plan(**{LIMIT_ID: 4320})) is None
    assert check(compilation.binding_space, plan(**{LIMIT_ID: 4319})).code == EXCEEDED


def test_a_task_without_candidates_makes_the_space_empty_not_infinite():
    analysis = ir_analysis(_ir_with(3, 0))

    assert (analysis["bindingSpaceCardinality"], analysis["bindingSpaceLog10"]) == ("0", 0.0)
    assert check(BindingSpace.from_analysis(analysis), plan(**{LIMIT_ID: 0})) is None


# -- The setting ---------------------------------------------------------------


def test_the_technical_safeguard_is_off_by_default_and_read_from_the_environment(monkeypatch):
    monkeypatch.delenv("MAX_BINDING_SPACE_LOG10", raising=False)
    assert Settings(_env_file=None).max_binding_space_log10 is None

    monkeypatch.setenv("MAX_BINDING_SPACE_LOG10", "12.5")
    assert Settings(_env_file=None).max_binding_space_log10 == 12.5


@pytest.mark.parametrize("value", ["-1", "nan", "inf", "-inf"])
def test_the_technical_safeguard_must_be_a_finite_non_negative_number(monkeypatch, value):
    monkeypatch.setenv("MAX_BINDING_SPACE_LOG10", value)

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


# -- Time ----------------------------------------------------------------------


def test_a_plan_that_declares_no_timeout_is_not_a_zero_second_timeout():
    with pytest.raises(HTTPException) as error:
        policy.solve_timeout_s(PlanCaps(plan="BARE"), 1800.0)

    assert error.value.status_code == 503
    assert error.value.detail["code"] == policy.PRICING_MISCONFIGURED
    assert "does not declare a timeout" in error.value.detail["error"]


def test_the_timeout_is_a_wall_clock_budget_bounded_by_the_gateway():
    assert policy.solve_timeout_s(plan(maxTimeoutSeconds=600), 1800.0) == 600.0
    with pytest.raises(HTTPException):
        policy.solve_timeout_s(plan(maxTimeoutSeconds=3600), 1800.0)


# -- Through the API ------------------------------------------------------------


class PlanGate(OpenGate):
    """A SPACE substitute whose plan is the open one with the given limits changed (``None`` removes one)."""

    def __init__(self, **limits):
        self.limits = {**OpenCaps().limits, **limits}
        for name in [name for name, value in limits.items() if value is None]:
            del self.limits[name]

    async def caps(self, user_id):
        return PlanCaps(plan="TEST", features={name: True for name in OPEN_FEATURES}, limits=dict(self.limits))


def set_plan(**limits) -> PlanGate:
    gate = PlanGate(**limits)
    space_client.set_gate(gate)
    return gate


@pytest.fixture
def dispatched(monkeypatch):
    """Records every job handed to a worker."""
    calls: list[str] = []

    async def record(job_id, *args, **kwargs):
        calls.append(str(job_id))

    monkeypatch.setattr(v1, "dispatch_persisted_job", record)
    monkeypatch.setattr(job_routes, "dispatch_persisted_job", record)
    return calls


async def count(session, model) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)))


async def test_a_job_above_the_plan_limit_is_refused_and_leaves_nothing_behind(
    api_client, db_session, registration, dispatched
):
    set_plan(**{LIMIT_ID: 0.1})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    snapshots = await count(db_session, InstanceSnapshot)

    refused = await _post(api_client, headers, _body(snapshot), key="too-big")

    assert refused.status_code == 402, refused.text
    body = refused.json()
    assert body["code"] == body["title"] == EXCEEDED
    assert body["detail"] == "instance binding space exceeds the caller plan limit"
    assert body["quota"]["limit_id"] == LIMIT_ID
    assert body["quota"]["state"] == "exhausted" and body["quota"]["source"] == "plan"
    assert body["quota"]["limit"] == 0.1
    assert body["quota"]["used"] == pytest.approx(math.log10(2), abs=1e-5)
    assert body["binding_space"]["cardinality"] == "2" and body["binding_space"]["kind"] == "estimate"
    assert json.loads(json.dumps(body, allow_nan=False)) == body
    # No effect: no job, no slot, no snapshot written by the submission, nothing handed to a worker.
    assert await count(db_session, Job) == 0
    assert await count(db_session, InstanceSnapshot) == snapshots
    assert await job_limits.count_in_flight(db_session, await db_session.scalar(select(User.id))) == 0
    assert dispatched == []

    # The idempotency key was not spent by the refusal: once the plan allows it, it creates the job.
    set_plan(**{LIMIT_ID: 5})
    accepted = await _post(api_client, headers, _body(snapshot), key="too-big")
    assert accepted.status_code == 202, accepted.text
    assert await count(db_session, Job) == 1


async def test_a_job_whose_plan_declares_no_limit_is_refused_with_its_own_code(
    api_client, db_session, registration, dispatched
):
    set_plan(**{LIMIT_ID: None})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    refused = await _post(api_client, headers, _body(snapshot), key="unknown")

    assert refused.status_code == 403, refused.text
    body = refused.json()
    assert body["code"] == LIMIT_UNKNOWN
    assert body["quota"]["state"] == "unknown" and "limit" not in body["quota"]
    assert await count(db_session, Job) == 0
    assert dispatched == []


async def test_the_safeguard_applies_when_the_plan_is_unknown_or_unlimited(
    api_client, db_session, registration, dispatched, monkeypatch
):
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    monkeypatch.setattr(get_settings(), "max_binding_space_log10", 5.0)
    set_plan(**{LIMIT_ID: None})
    within = await _post(api_client, headers, _body(snapshot), key="within")
    assert within.status_code == 202, within.text

    monkeypatch.setattr(get_settings(), "max_binding_space_log10", 0.1)
    for name, limits in (("unknown", {LIMIT_ID: None}), ("unlimited", {LIMIT_ID: math.inf})):
        set_plan(**limits)
        refused = await _post(api_client, headers, _body(snapshot), key=f"over-{name}")
        assert refused.status_code == 422, refused.text
        assert refused.json()["code"] == OVER_TECHNICAL
        assert refused.json()["quota"]["source"] == "technical"
    assert await count(db_session, Job) == 1


async def test_an_unlimited_plan_without_a_safeguard_accepts_the_job(
    api_client, db_session, registration, dispatched
):
    set_plan(**{LIMIT_ID: math.inf})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    accepted = await _post(api_client, headers, _body(snapshot), key="unlimited")

    assert accepted.status_code == 202, accepted.text
    assert await count(db_session, Job) == 1


async def test_validation_reports_the_same_refusal_without_creating_anything(
    api_client, db_session, registration
):
    from _repo import REPO_ROOT
    from bim_core.package import load_package

    set_plan(**{LIMIT_ID: 0.1})
    headers = await _login(api_client, registration())
    jobs, snapshots = await count(db_session, Job), await count(db_session, InstanceSnapshot)

    refused = await api_client.post(
        "/v1/validate",
        content=load_package(REPO_ROOT / "examples/demo/01_simple_seq").to_zip(),
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
    )

    assert refused.status_code == 402, refused.text
    assert refused.json()["code"] == EXCEEDED
    assert refused.json()["quota"]["state"] == "exhausted"
    assert (await count(db_session, Job), await count(db_session, InstanceSnapshot)) == (jobs, snapshots)


# -- Retrying and replaying cost nothing twice -----------------------------------


async def test_an_idempotent_replay_is_not_measured_again_and_takes_no_second_slot(
    api_client, db_session, registration, dispatched
):
    set_plan(**{LIMIT_ID: 5})
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    first = await _post(api_client, headers, _body(snapshot), key="once")
    assert first.status_code == 202, first.text

    # The plan shrinks after the job was accepted: the replay answers with the same job, ...
    set_plan(**{LIMIT_ID: 0.1})
    replay = await _post(api_client, headers, _body(snapshot), key="once")
    assert replay.status_code == 202, replay.text
    assert replay.json()["id"] == first.json()["id"] and replay.json()["idempotent"] is True
    # ... while a request with a new key is a new job and meets the new limit.
    other = await _post(api_client, headers, _body(snapshot), key="twice")
    assert other.status_code == 402, other.text

    user_id = await db_session.scalar(select(User.id))
    assert await count(db_session, Job) == 1
    assert await job_limits.count_in_flight(db_session, user_id) == 1
    assert len(dispatched) == 1


async def test_retrying_a_job_holds_its_size_against_the_plan_and_a_refusal_writes_nothing(
    api_client, db_session, registration, dispatched
):
    set_plan(**{LIMIT_ID: 3})
    user_id, headers = await _account(api_client, registration)
    failed = a_job(user_id, JobState.FAILED, instance_complexity={"bindingSpace": str(10**6)})
    db_session.add(failed)
    await db_session.flush()

    refused = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)

    assert refused.status_code == 402, refused.text
    assert refused.json()["code"] == EXCEEDED
    assert refused.json()["binding_space"]["cardinality"] == str(10**6)
    assert await count(db_session, Job) == 1
    assert dispatched == []

    # 10 ** 6 against a ceiling of 6 is exactly at the limit.
    set_plan(**{LIMIT_ID: 6})
    retried = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    again = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)
    assert retried.status_code == again.status_code == 202, retried.text
    assert retried.json()["id"] == again.json()["id"]
    assert await count(db_session, Job) == 2


async def test_a_retry_of_a_job_with_no_recorded_size_is_not_measured(
    api_client, db_session, registration, dispatched
):
    set_plan(**{LIMIT_ID: 0})
    user_id, headers = await _account(api_client, registration)
    failed = a_job(user_id, JobState.FAILED)
    db_session.add(failed)
    await db_session.flush()

    retried = await api_client.post(f"/v1/jobs/{failed.id}/retry", headers=headers)

    assert retried.status_code == 202, retried.text


# -- Studies ----------------------------------------------------------------------


async def test_a_study_run_with_a_case_above_the_limit_is_refused_whole_and_writes_nothing(
    api_client, db_session, registration, dispatched, monkeypatch
):
    headers = await _study(api_client, registration, [1, 2])
    monkeypatch.setattr(get_settings(), "max_binding_space_log10", 0.1)

    refused = await api_client.post(BASE, headers=headers)

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == OVER_TECHNICAL
    assert refused.json()["quota"]["state"] == "exhausted"
    assert refused.json()["binding_space"]["cardinality"] == "2"
    assert await count(db_session, StudyRun) == 0
    assert await count(db_session, StudyCell) == 0
    assert await count(db_session, Job) == 0
    assert dispatched == []

    # Nothing was reserved: the same request goes through once the safeguard allows the case.
    monkeypatch.setattr(get_settings(), "max_binding_space_log10", None)
    accepted = await api_client.post(BASE, headers=headers)
    assert accepted.status_code == 202, accepted.text
    assert await count(db_session, StudyRun) == 1


# -- Simultaneous jobs: a ceiling on what runs now, not a balance ---------------------


async def test_the_concurrency_limit_frees_a_slot_when_a_job_ends_and_counts_nothing_cumulative(
    api_client, db_session, registration, dispatched, monkeypatch
):
    set_limit(monkeypatch, 1)
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)

    for round_number in range(3):
        created = await _post(api_client, headers, _body(snapshot), key=f"round-{round_number}")
        assert created.status_code == 202, created.text
        busy = await _post(api_client, headers, _body(snapshot), key=f"busy-{round_number}")
        assert busy.status_code == 429, busy.text
        job = await db_session.get(Job, uuid.UUID(created.json()["id"]))
        job.state = JobState.COMPLETED
        await db_session.commit()

    # Three jobs ran one after another through one slot; the three refusals created nothing.
    assert await count(db_session, Job) == 3


async def test_the_concurrency_refusal_names_its_limit_for_the_frontend(
    api_client, db_session, registration, dispatched, monkeypatch
):
    set_limit(monkeypatch, 1)
    headers = await _login(api_client, registration())
    snapshot = await _snapshot(api_client, headers)
    await _post(api_client, headers, _body(snapshot), key="holds-the-slot")

    refused = await _post(api_client, headers, _body(snapshot), key="refused")

    assert refused.status_code == 429, refused.text
    assert refused.headers["Retry-After"] == "15"
    assert refused.json()["concurrency"]["limit_id"] == "concurrentJobs"
    assert refused.json()["concurrency"]["limit"] == refused.json()["concurrency"]["used"] == 1
    assert await count(db_session, Job) == 1
