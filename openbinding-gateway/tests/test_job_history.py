"""An account's own solves, as far back as its plan keeps them.

The retention window has been in the pricing since the plans were written, and
carried all the way through `PlanCaps` to `GET /v1/users/me/usage`, where the
interface displays it. Nothing ever applied it, because there was no endpoint
for it to bound - a limit declared, published, and unenforced, which is the
same shape of bug as an engine capability nobody checks.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio

from openbinding_gateway import space_client
from openbinding_gateway.db.models import Job, JobState, utcnow
from openbinding_gateway.space_client import FakePricingGate

pytestmark = pytest.mark.asyncio


async def account(client, registration) -> tuple[dict, str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), tokens.json()["access_token"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def gate():
    """A pricing gate installed for the duration of one test."""
    installed = FakePricingGate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


def a_job(owner_id, *, age_days: float = 0, engine="random-search", result=None) -> Job:
    return Job(
        id=uuid.uuid4(),
        owner_id=uuid.UUID(owner_id) if isinstance(owner_id, str) else owner_id,
        engine_id=engine,
        engine_job_id="sync",
        service_url="http://engine",
        state=JobState.COMPLETED,
        created_at=utcnow() - timedelta(days=age_days),
        result=result,
    )


async def test_a_fresh_account_has_no_history(api_client, registration):
    _, token = await account(api_client, registration)

    body = (await api_client.get("/v1/users/me/jobs", headers=auth(token))).json()

    assert body["jobs"] == []
    assert body["total"] == 0


async def test_your_own_solves_come_back_newest_first(
    api_client, registration, db_session
):
    profile, token = await account(api_client, registration)
    owner = uuid.UUID(profile["id"])
    db_session.add(a_job(owner, age_days=2, engine="minizinc-csp"))
    db_session.add(a_job(owner, age_days=0, engine="random-search"))
    await db_session.flush()

    body = (await api_client.get("/v1/users/me/jobs", headers=auth(token))).json()

    assert [j["engine_id"] for j in body["jobs"]] == ["random-search", "minizinc-csp"]
    assert body["total"] == 2


async def test_somebody_elses_solves_are_not_yours(api_client, registration, db_session):
    alice, _ = await account(api_client, registration)
    _, bob_token = await account(api_client, registration)
    db_session.add(a_job(uuid.UUID(alice["id"])))
    await db_session.flush()

    body = (await api_client.get("/v1/users/me/jobs", headers=auth(bob_token))).json()

    assert body["jobs"] == []


async def test_the_plan_decides_how_far_back_the_history_goes(
    api_client, registration, db_session, gate
):
    # The free plan keeps seven days. A job from ten days ago is not "missing";
    # it is outside what this plan is sold as keeping.
    profile, token = await account(api_client, registration)
    owner = uuid.UUID(profile["id"])
    db_session.add(a_job(owner, age_days=3))
    db_session.add(a_job(owner, age_days=10))
    await db_session.flush()

    body = (await api_client.get("/v1/users/me/jobs", headers=auth(token))).json()

    assert body["total"] == 1
    assert body["retention_days"] == 7


async def test_a_longer_retention_shows_more_of_it(
    api_client, registration, db_session, gate
):
    profile, token = await account(api_client, registration)
    gate.plans[uuid.UUID(profile["id"])] = "PRO"
    owner = uuid.UUID(profile["id"])
    db_session.add(a_job(owner, age_days=3))
    db_session.add(a_job(owner, age_days=10))
    await db_session.flush()

    body = (await api_client.get("/v1/users/me/jobs", headers=auth(token))).json()

    assert body["total"] == 2
    assert body["retention_days"] == 90


async def test_ageing_out_of_a_history_does_not_delete_the_row(
    api_client, registration, db_session
):
    """The cutoff is a view, not a deletion.

    The metering reconciler settles abandoned jobs by looking at rows, and an
    audit needs them; dropping a row because it stopped being interesting to
    one endpoint would break both.
    """
    from sqlalchemy import func, select

    profile, token = await account(api_client, registration)
    db_session.add(a_job(uuid.UUID(profile["id"]), age_days=30))
    await db_session.flush()

    body = (await api_client.get("/v1/users/me/jobs", headers=auth(token))).json()

    assert body["total"] == 0
    assert await db_session.scalar(select(func.count()).select_from(Job)) == 1


async def test_a_summary_says_what_happened_without_the_answer_itself(
    api_client, registration, db_session
):
    # A result can be hundreds of megabytes. A history is for finding the one
    # you want, and GET /v1/jobs/{id} is where the answer lives.
    profile, token = await account(api_client, registration)
    db_session.add(
        a_job(
            uuid.UUID(profile["id"]),
            result={"feasibility": "FEASIBLE", "solutions": [{"binding": {}}, {"binding": {}}]},
        )
    )
    await db_session.flush()

    job = (await api_client.get("/v1/users/me/jobs", headers=auth(token))).json()["jobs"][0]

    assert job["feasibility"] == "FEASIBLE"
    assert job["solutions"] == 2
    assert "result" not in job


async def test_a_job_with_no_result_yet_is_summarised_without_one(
    api_client, registration, db_session
):
    profile, token = await account(api_client, registration)
    db_session.add(a_job(uuid.UUID(profile["id"]), result=None))
    await db_session.flush()

    job = (await api_client.get("/v1/users/me/jobs", headers=auth(token))).json()["jobs"][0]

    assert job["feasibility"] is None
    assert job["solutions"] is None


async def test_the_history_is_paged(api_client, registration, db_session):
    profile, token = await account(api_client, registration)
    for _ in range(5):
        db_session.add(a_job(uuid.UUID(profile["id"])))
    await db_session.flush()

    page = (
        await api_client.get("/v1/users/me/jobs?limit=2&offset=1", headers=auth(token))
    ).json()

    assert len(page["jobs"]) == 2
    assert page["total"] == 5, "the total counts everything visible, not the page"


async def test_the_history_needs_an_account(api_client):
    assert (await api_client.get("/v1/users/me/jobs")).status_code == 401


# -- Getting back what you asked --------------------------------------------


async def test_a_job_can_be_read_back_as_the_request_that_made_it(
    api_client, registration, db_session
):
    """A retention window over outcomes alone is not worth having.

    Being told that a solve was feasible three weeks ago, with no way to run it
    again or compare an engine against it, is a record of something rather than
    a record you can use.
    """
    profile, token = await account(api_client, registration)
    instance = {"metadata": {"id": "kept"}, "tasks": [{"id": "t1"}]}
    job = a_job(uuid.UUID(profile["id"]))
    job.original_request = instance
    db_session.add(job)
    await db_session.flush()

    body = (
        await api_client.get(f"/v1/jobs/{job.id}/request", headers=auth(token))
    ).json()

    assert body["instance"] == instance
    assert body["engine_id"] == "random-search"


async def test_the_request_of_somebody_elses_job_is_not_yours(
    api_client, registration, db_session
):
    alice, _ = await account(api_client, registration)
    _, bob_token = await account(api_client, registration)
    job = a_job(uuid.UUID(alice["id"]))
    job.original_request = {"tasks": []}
    db_session.add(job)
    await db_session.flush()

    response = await api_client.get(f"/v1/jobs/{job.id}/request", headers=auth(bob_token))

    assert response.status_code == 404


async def test_a_job_that_recorded_nothing_says_so_rather_than_lying(
    api_client, registration, db_session
):
    # Jobs solved before the gateway kept instances cannot be reproduced, and
    # an empty instance would be a worse answer than admitting it.
    profile, token = await account(api_client, registration)
    job = a_job(uuid.UUID(profile["id"]))
    db_session.add(job)
    await db_session.flush()

    response = await api_client.get(f"/v1/jobs/{job.id}/request", headers=auth(token))

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "request_not_kept"


async def test_a_synchronous_solve_records_what_it_was_asked(micro_placement_instance):
    """The synchronous path never did, so most solves were unreproducible.

    Only the asynchronous branch stored the instance; a solve that came back in
    one response stored the answer and nothing else - so the history could tell
    you an engine had said "feasible" and never what it had been asked.

    Driven through the router rather than the endpoint, because this is a fact
    about what route_solve records, and the endpoint would only obscure it.
    """
    from unittest.mock import AsyncMock, MagicMock, patch

    from openbinding_gateway.models.api import SolveRequest
    from openbinding_gateway.routing.router import Router

    binding = {task["id"]: f"c_{task['id']}_p1" for task in micro_placement_instance["tasks"]}
    engine_body = {"solutions": [{"binding": binding}], "provenance": {"engine_id": "stub"}}

    plugin = MagicMock()
    plugin.transform_request.return_value = ({"instance": micro_placement_instance}, [])
    plugin.transform_response.side_effect = lambda *_, **__: dict(engine_body)
    plugin.get_capabilities.return_value = {"type": "HEURISTIC"}
    plugin.is_synchronous_response.return_value = True

    answer = MagicMock()
    answer.status_code = 200
    answer.json.return_value = engine_body
    answer.raise_for_status.return_value = None

    transport = MagicMock()
    transport.solve = AsyncMock(return_value=answer)

    with patch(
        "openbinding_gateway.registry.engine.EngineRegistry.get_plugin", return_value=plugin
    ), patch(
        "openbinding_gateway.registry.engine.EngineRegistry.get_url", return_value="http://stub"
    ), patch(
        "openbinding_gateway.registry.engine.EngineRegistry.get_transport", return_value=transport
    ):
        response = await Router().route_solve(
            SolveRequest(
                engine_id="stub",
                instance=micro_placement_instance,
                options={"seed": 7},
            )
        )

    from openbinding_gateway.jobs import JobManager

    stored = await JobManager.get_job(str(response.job_id))
    assert stored.metadata["original_request"]["tasks"] == micro_placement_instance["tasks"]
    assert stored.metadata["options"] == {"seed": 7}
