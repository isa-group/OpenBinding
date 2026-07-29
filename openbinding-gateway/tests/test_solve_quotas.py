"""What /solve does about a plan, over HTTP.

The engines are stubbed: what is under test is the gateway's decision, not
anybody's search. Each case is one way a request can be brought inside a plan
or turned away, and the status codes matter as much as the outcomes - a client
needs to tell "your instance is invalid" from "your allowance is spent" from
"we could not find out", because only one of those is worth retrying.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.space_client import FakePricingGate


@pytest_asyncio.fixture
async def gate():
    installed = FakePricingGate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


@pytest.fixture
def stub_engine(monkeypatch):
    """An engine that answers instantly, so timing is not part of the test."""
    from openbinding_gateway.models.api import Feasibility, JobResponse, JobStatus, SolveResponse
    from openbinding_gateway.routing.router import Router

    seen = {}

    async def route_solve(self, request, binding_space=None, warnings=None, **kwargs):
        seen["options"] = dict(request.options or {})
        seen["budget_s"] = kwargs.get("budget_s")
        seen["owner_id"] = kwargs.get("owner_id")
        job = await _make_job(kwargs.get("owner_id"), kwargs.get("session"))
        return JobResponse(
            job_id=job,
            status=JobStatus.COMPLETED,
            result=SolveResponse(
                feasibility=Feasibility.FEASIBLE,
                solutions=[],
                provenance={"engine_id": request.engine_id, "execution_time_ms": 1500},
            ),
        )

    async def _make_job(owner_id, session):
        from openbinding_gateway.jobs import JobManager

        job = await JobManager.create_job(
            "random-search", "sync", "http://engine", owner_id=owner_id, session=session
        )
        return job.id

    monkeypatch.setattr(Router, "route_solve", route_solve)
    return seen


@pytest.fixture
def instance(micro_placement_instance):
    return micro_placement_instance


async def account(client, registration) -> tuple[dict, dict]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), {"Authorization": f"Bearer {tokens.json()['access_token']}"}


def solve_body(instance, **options):
    return {"engine_id": "random-search", "instance": instance, "options": options}


# -- Who may solve ----------------------------------------------------------


async def test_solving_needs_an_account(api_client, gate, instance):
    response = await api_client.post("/v1/solve", json=solve_body(instance))

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthorized"


async def test_an_account_may_solve(api_client, registration, gate, instance, stub_engine):
    _, headers = await account(api_client, registration)

    response = await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert response.status_code == 200, response.text


async def test_an_api_key_may_solve(api_client, registration, gate, instance, stub_engine):
    # Both channels reach the same account, so both spend the same allowance.
    _, headers = await account(api_client, registration)
    key = await api_client.post("/v1/users/me/api-keys", headers=headers, json={"name": "k"})

    response = await api_client.post(
        "/v1/solve",
        headers={"X-API-Key": key.json()["secret"]},
        json=solve_body(instance),
    )

    assert response.status_code == 200


async def test_analysis_stays_open_to_visitors(api_client, gate, instance):
    # Someone evaluating OpenBinding can measure an instance before deciding
    # whether to sign up.
    response = await api_client.post(
        "/v1/analyze", json={"engine_id": "random-search", "instance": instance}
    )

    assert response.status_code == 200


# -- Spending ---------------------------------------------------------------


async def test_a_solve_spends_a_task(api_client, registration, gate, instance, stub_engine):
    profile, headers = await account(api_client, registration)

    await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))
    usage = await gate.usage(uuid.UUID(profile["id"]))

    assert usage.limits["tasksLimit"].used == 1


async def test_a_finished_solve_charges_the_engine_time(
    api_client, registration, gate, instance, stub_engine
):
    profile, headers = await account(api_client, registration)

    await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))
    usage = await gate.usage(uuid.UUID(profile["id"]))

    # The stub reports 1500 ms, and the engine's own figure is preferred over
    # the clock around the call.
    assert usage.limits["solverTimeLimit"].used == 1.5


async def test_a_finished_solve_gives_its_slot_back(
    api_client, registration, gate, instance, stub_engine
):
    # Otherwise an account allowed one concurrent solve could never solve again.
    profile, headers = await account(api_client, registration)

    await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))
    usage = await gate.usage(uuid.UUID(profile["id"]))

    assert usage.limits["concurrentTasksLimit"].used == 0


async def test_a_free_account_can_solve_repeatedly(
    api_client, registration, gate, instance, stub_engine
):
    _, headers = await account(api_client, registration)

    for _ in range(3):
        response = await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))
        assert response.status_code == 200


# -- Refusals ---------------------------------------------------------------


async def test_a_spent_allowance_is_refused_with_402(
    api_client, registration, gate, instance, stub_engine
):
    # 402 rather than 403: this is an allowance spent, not a permission
    # missing, and only one of those is worth retrying next month.
    profile, headers = await account(api_client, registration)
    gate.exhaust(uuid.UUID(profile["id"]), "tasksLimit")

    response = await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert response.status_code == 402
    assert response.json()["detail"]["code"] == "quota_exceeded"


async def test_a_refusal_names_the_limit_and_what_it_allows(
    api_client, registration, gate, instance, stub_engine
):
    profile, headers = await account(api_client, registration)
    gate.exhaust(uuid.UUID(profile["id"]), "tasksLimit")

    quota = (await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))).json()[
        "detail"
    ]["quota"]

    assert quota["limit_id"] == "tasksLimit"
    assert quota["limit"] == 100


async def test_a_refused_solve_spends_nothing(
    api_client, registration, gate, instance, stub_engine
):
    profile, headers = await account(api_client, registration)
    user_id = uuid.UUID(profile["id"])
    gate.exhaust(user_id, "tasksLimit")

    await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert (await gate.usage(user_id)).limits["concurrentTasksLimit"].used == 0


async def test_an_instance_too_large_for_the_plan_is_refused(
    api_client, registration, gate, instance, stub_engine, monkeypatch
):
    # Refused rather than reduced: there is no smaller version of an instance.
    from openbinding_gateway.models.api import BindingSpaceSummary

    profile, headers = await account(api_client, registration)
    monkeypatch.setattr(
        "openbinding_gateway.main.compute_binding_space_summary",
        lambda _: BindingSpaceSummary(
            cardinality="10000000000000", log10_cardinality=13.0, per_task_counts={}
        ),
    )

    response = await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert response.status_code == 402
    assert response.json()["detail"]["code"] == "binding_space_too_large"


async def test_the_same_instance_is_solvable_on_the_larger_plan(
    api_client, registration, gate, instance, stub_engine, monkeypatch
):
    from openbinding_gateway.models.api import BindingSpaceSummary

    profile, headers = await account(api_client, registration)
    await gate.change_plan(uuid.UUID(profile["id"]), "PRO")
    monkeypatch.setattr(
        "openbinding_gateway.main.compute_binding_space_summary",
        lambda _: BindingSpaceSummary(
            cardinality="10000000000000", log10_cardinality=13.0, per_task_counts={}
        ),
    )

    response = await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert response.status_code == 200


# -- Clamping ---------------------------------------------------------------


async def test_an_over_long_budget_is_reduced_rather_than_refused(
    api_client, registration, gate, instance, stub_engine
):
    # Engine defaults exceed the free plan's ceiling, so refusing would make
    # the default request fail for every new account.
    _, headers = await account(api_client, registration)

    response = await api_client.post(
        "/v1/solve", headers=headers, json=solve_body(instance, time_budget_ms=99_999_999)
    )

    assert response.status_code == 200
    assert stub_engine["options"]["time_budget_ms"] == 300_000


async def test_over_much_search_effort_is_reduced(
    api_client, registration, gate, instance, stub_engine
):
    _, headers = await account(api_client, registration)

    await api_client.post(
        "/v1/solve", headers=headers, json=solve_body(instance, iterations_count=50_000_000)
    )

    assert stub_engine["options"]["iterations_count"] == 10_000


async def test_the_larger_plan_leaves_the_same_request_alone(
    api_client, registration, gate, instance, stub_engine
):
    profile, headers = await account(api_client, registration)
    await gate.change_plan(uuid.UUID(profile["id"]), "PRO")

    await api_client.post(
        "/v1/solve", headers=headers, json=solve_body(instance, iterations_count=50_000)
    )

    assert stub_engine["options"]["iterations_count"] == 50_000


async def test_the_engine_is_never_waited_on_longer_than_the_plan_allows(
    api_client, registration, gate, instance, stub_engine
):
    _, headers = await account(api_client, registration)

    await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert stub_engine["budget_s"] <= 300.0 + 30.0


# -- When the pricing service is down ---------------------------------------


async def test_an_unreachable_pricing_service_holds_solving(
    api_client, registration, gate, instance, stub_engine, monkeypatch
):
    # Fail closed: handing out an unmetered half-hour of solver time is worse
    # than a temporary outage, and 503 says which it is.
    _, headers = await account(api_client, registration)
    monkeypatch.setattr(
        "openbinding_gateway.main.get_settings",
        lambda: _settings_with(space_fail_mode="closed"),
    )
    gate.unavailable = True

    response = await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "pricing_unavailable"
    assert response.headers.get("retry-after") == "30"


async def test_failing_open_lets_the_work_through(
    api_client, registration, gate, instance, stub_engine, monkeypatch
):
    # What local development wants: work without the whole pricing stack up.
    _, headers = await account(api_client, registration)
    monkeypatch.setattr(
        "openbinding_gateway.main.get_settings",
        lambda: _settings_with(space_fail_mode="open"),
    )
    gate.unavailable = True

    response = await api_client.post("/v1/solve", headers=headers, json=solve_body(instance))

    assert response.status_code == 200


def _settings_with(**overrides):
    from openbinding_gateway.core.settings import Settings

    return Settings(_env_file=None, **overrides)
