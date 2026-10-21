"""A ``jobs:read`` key reads analyses; only a key that may execute starts or cancels analysis work.

``POST /v1/analysis/pareto`` creates and dispatches an ``AnalysisTask`` and its
``/cancel`` stops one, so they need the permission ``POST /v1/jobs`` needs
(``engines:execute``). ``query``, ``candidate``, ``export`` and ``sources`` only
read stored evidence. Account sessions do not go through key permissions.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from bim_core.compiler import compile_instance
from bim_core.package import load_package
from _repo import REPO_ROOT
from openbinding_gateway import analysis_jobs
from openbinding_gateway.db.models import AnalysisTask, Job, JobState, User
from openbinding_gateway.security.apikeys import analysis_work_permissions, required_permissions
from test_api_keys import mint_key

READ_ONLY = ["jobs:read"]
CAN_EXECUTE = ["jobs:read", "engines:execute"]
ENGINE = {"namespace": "bim.builtin", "name": "diagnostic", "version": "1.0.0", "digest": "sha256-" + "0" * 64}


@pytest.mark.parametrize(
    "method, path, expected",
    [
        ("POST", "/v1/analysis/pareto", {"engines:execute"}),
        ("POST", "/v1/analysis/pareto/{task_id}/cancel", {"engines:execute"}),
        ("POST", "/v1/analysis/pareto/3f2a/cancel", {"engines:execute"}),
        ("GET", "/v1/analysis/pareto/{task_id}", set()),
        ("GET", "/v1/analysis/sources", set()),
        ("POST", "/v1/analysis/query", set()),
        ("POST", "/v1/analysis/candidate", set()),
        ("POST", "/v1/analysis/export", set()),
        ("POST", "/v1/analysis/reports", set()),
    ],
)
def test_only_the_routes_that_start_or_stop_work_need_the_execution_permission(method, path, expected):
    assert analysis_work_permissions(path, method) == expected


def test_the_documented_route_permissions_do_not_change():
    # The OpenAPI document is generated from this table and is unchanged.
    assert required_permissions("/v1/analysis/pareto", "POST") == {"jobs:read"}
    assert required_permissions("/v1/analysis/reports", "POST") == {"jobs:read", "reports:write"}


@pytest.fixture
async def analysis(api_client, db_session, registration, monkeypatch):
    """An account with two completed jobs to analyse, and its session headers."""
    dispatched: list[str] = []

    async def queued(task_id):
        dispatched.append(task_id)

    monkeypatch.setattr(analysis_jobs, "dispatch_analysis", queued)
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201
    login = await api_client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    token = login.json()["access_token"]
    owner = (await db_session.execute(select(User).where(User.username == details["username"]))).scalar_one()
    problem = compile_instance(load_package(REPO_ROOT / "examples/demo/17_analysis_tradeoffs"))
    binding = {task: refs[0] for task, refs in problem.document["spec"]["eligibility"].items()}
    result = {"solutions": [{"decision": {"kind": "binding", "binding": binding}, **problem.evaluate(binding)}]}
    from bim_core.compiler import compiler_bundle_digest

    jobs = [
        Job(
            owner_id=owner.id, engine_id="diagnostic", engine_job_id=f"scopes-{index}",
            service_url="https://example.invalid", state=JobState.COMPLETED,
            original_request={"bindingProblem": problem.document}, result=dict(result),
            # A key reads only jobs whose pinned Engine it may use; ``allEngines`` keys may use any.
            provenance={
                "irDigest": problem.digest,
                "evaluatorDigest": compiler_bundle_digest(),
                "engine": ENGINE,
            },
        )
        for index in range(2)
    ]
    db_session.add_all(jobs)
    await db_session.commit()
    return {
        "session": {"Authorization": f"Bearer {token}"},
        "token": token,
        "query": {"sources": [str(job.id) for job in jobs]},
        "dispatched": dispatched,
    }


async def key_headers(api_client, analysis, permissions):
    minted = await mint_key(api_client, analysis["token"], permissions=permissions)
    return {"X-API-Key": minted["secret"]}


async def task_count(db_session):
    return (await db_session.execute(select(func.count()).select_from(AnalysisTask))).scalar_one()


async def test_a_jobs_read_key_reads_analyses(api_client, analysis):
    headers = await key_headers(api_client, analysis, READ_ONLY)
    query = analysis["query"]

    listing = await api_client.get("/v1/analysis/sources", headers=headers)
    queried = await api_client.post("/v1/analysis/query", json=query, headers=headers)
    exported = await api_client.post("/v1/analysis/export", json={**query, "format": "csv"}, headers=headers)

    assert listing.status_code == 200, listing.text
    assert queried.status_code == 200, queried.text
    assert exported.status_code == 200, exported.text
    selected = queried.json()["winners"][0]["id"]
    candidate = await api_client.post(
        "/v1/analysis/candidate", json={**query, "selected": selected}, headers=headers
    )
    assert candidate.status_code == 200, candidate.text


async def test_a_jobs_read_key_cannot_create_analysis_work(api_client, db_session, analysis):
    headers = await key_headers(api_client, analysis, READ_ONLY)

    refused = await api_client.post("/v1/analysis/pareto", json=analysis["query"], headers=headers)

    assert refused.status_code == 403, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "insufficient_api_key_permission"
    assert detail["missing_permissions"] == ["engines:execute"]
    assert await task_count(db_session) == 0
    assert analysis["dispatched"] == []


async def test_a_key_that_may_execute_starts_reads_and_cancels_analysis_work(api_client, db_session, analysis):
    headers = await key_headers(api_client, analysis, CAN_EXECUTE)

    started = await api_client.post("/v1/analysis/pareto", json=analysis["query"], headers=headers)

    assert started.status_code == 202, started.text
    task_id = started.json()["id"]
    assert analysis["dispatched"] == [task_id]
    assert (await api_client.get(f"/v1/analysis/pareto/{task_id}", headers=headers)).status_code == 200
    cancelled = await api_client.post(f"/v1/analysis/pareto/{task_id}/cancel", headers=headers)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["state"] == "cancelled"


async def test_a_jobs_read_key_cannot_cancel_a_task(api_client, db_session, analysis):
    started = await api_client.post("/v1/analysis/pareto", json=analysis["query"], headers=analysis["session"])
    assert started.status_code == 202, started.text
    task_id = started.json()["id"]
    read_only = await key_headers(api_client, analysis, READ_ONLY)

    read = await api_client.get(f"/v1/analysis/pareto/{task_id}", headers=read_only)
    refused = await api_client.post(f"/v1/analysis/pareto/{task_id}/cancel", headers=read_only)

    assert read.status_code == 200, read.text
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["code"] == "insufficient_api_key_permission"
    state = (await db_session.execute(
        select(AnalysisTask.state).execution_options(populate_existing=True)
    )).scalar_one()
    assert state == "queued"


async def test_a_session_is_not_subject_to_key_permissions(api_client, analysis):
    started = await api_client.post("/v1/analysis/pareto", json=analysis["query"], headers=analysis["session"])
    assert started.status_code == 202, started.text

    cancelled = await api_client.post(
        f"/v1/analysis/pareto/{started.json()['id']}/cancel", headers=analysis["session"]
    )

    assert cancelled.status_code == 200, cancelled.text


async def test_a_key_without_jobs_read_is_still_refused_everywhere(api_client, analysis):
    headers = await key_headers(api_client, analysis, ["engines:execute"])

    for method, path in (("get", "/v1/analysis/sources"), ("post", "/v1/analysis/pareto")):
        response = await getattr(api_client, method)(path, headers=headers, **(
            {"json": analysis["query"]} if method == "post" else {}
        ))
        assert response.status_code == 403, (path, response.text)
