"""Reproducible study matrices and binding-analysis aggregates."""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from _problem_helpers import upload_problem
from _problem_helpers import placeholder_refs
from pydantic import ValidationError
from sqlalchemy import select

from _repo import REPO_ROOT

from openbinding_gateway import space_client
from openbinding_gateway.db.models import Job, JobState, StudyCell
from openbinding_gateway.models.platform import StudyDefinition
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import execution
from openbinding_gateway.services.engines import engine_ref
from openbinding_gateway.routes import studies as study_routes
from _pricing import fake_pricing_gate, largest_plan
from openbinding_gateway.studies import aggregate_metrics, expand_study, nondominated
from bim_core.canonical import digest


EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"


@pytest_asyncio.fixture
async def study_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


def engine(name: str, fill: str) -> dict[str, str]:
    return {
        "namespace": "bim.builtin",
        "name": name,
        "version": "1.0.0",
        "digest": f"sha256-{fill * 64}",
    }


OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}


def study_engine(reference: dict[str, str], mode: str = "seeded") -> dict:
    """A study engine pins an exact revision plus an explicit mode and execution optimization."""
    return {**reference, "mode": mode, "optimization": dict(OPTIMIZATION)}


def test_matrix_expansion_is_sorted_reproducible_and_fingerprinted() -> None:
    first_case, second_case = uuid.uuid4(), uuid.uuid4()
    definition = StudyDefinition(
        revision_ids=[second_case, first_case],
        engines=[study_engine(engine("zeta", "b")), study_engine(engine("alpha", "a"))],
        parameter_sets=[{"temperature": 2}, {"temperature": 1}],
        seeds=[7, 3],
    )

    compilations = {str(first_case): str(uuid.uuid4()), str(second_case): str(uuid.uuid4())}
    first = expand_study(definition, compilations)
    second = expand_study(definition, compilations)

    assert first == second
    assert len(first) == 16
    assert len({cell["fingerprint"] for cell in first}) == 16
    assert [cell["ordinal"] for cell in first] == list(range(16))
    assert first[0]["engine"]["name"] == "alpha"
    assert first[0]["seed"] == 3
    assert {cell["compilationId"] for cell in first} == set(compilations.values())
    # The pinned compilation is part of the fingerprint: another compilation is another cell.
    other = expand_study(definition, {key: str(uuid.uuid4()) for key in compilations})
    assert {cell["fingerprint"] for cell in other}.isdisjoint({cell["fingerprint"] for cell in first})


def test_study_matrix_is_bounded_before_any_jobs_are_created() -> None:
    with pytest.raises(ValidationError, match="10,000"):
        StudyDefinition(
            revision_ids=[uuid.uuid4() for _ in range(101)],
            engines=[study_engine(engine(f"engine-{index}", "a")) for index in range(2)],
            parameter_sets=[{"batch": index} for index in range(50)],
            seeds=[0],
        )


def test_study_definition_rejects_duplicate_axes_and_malformed_engine_digests() -> None:
    case_id = uuid.uuid4()
    with pytest.raises(ValidationError, match="parameter_sets contains duplicates"):
        StudyDefinition(
            revision_ids=[case_id],
            engines=[study_engine(engine("exact", "a"))],
            parameter_sets=[{"iterations": 10}, {"iterations": 10}],
        )
    with pytest.raises(ValidationError, match="engine digest"):
        StudyDefinition(
            revision_ids=[case_id],
            engines=[study_engine(engine("exact", "x"))],
        )


def test_study_definition_requires_an_explicit_mode_and_optimization_per_engine() -> None:
    case_id = uuid.uuid4()
    with pytest.raises(ValidationError, match="explicit mode"):
        StudyDefinition(revision_ids=[case_id], engines=[engine("exact", "a")])
    with pytest.raises(ValidationError, match="optimization type and scalarization"):
        StudyDefinition(
            revision_ids=[case_id],
            engines=[{**engine("exact", "a"), "mode": "seeded"}],
        )


def test_pareto_and_stability_aggregates_are_deterministic() -> None:
    metrics = [
        {
            "status": "completed",
            "feasible": True,
            "objectives": {"latency": 1, "cost": 4},
            "runtimeSeconds": 2,
            "engine": "a",
        },
        {
            "status": "completed",
            "feasible": True,
            "objectives": {"latency": 2, "cost": 2},
            "runtimeSeconds": 1,
            "engine": "a",
        },
        {
            "status": "completed",
            "feasible": True,
            "objectives": {"latency": 3, "cost": 5},
            "runtimeSeconds": 3,
            "engine": "b",
        },
        {"status": "failed", "engine": "b"},
    ]

    aggregate = aggregate_metrics(metrics)

    assert nondominated([metric.get("objectives", {}) for metric in metrics]) == [
        {"latency": 2, "cost": 2},
        {"latency": 1, "cost": 4},
    ]
    assert aggregate["cells"] == 4
    assert aggregate["completed"] == 3
    assert aggregate["failed"] == 1
    assert aggregate["pareto"] == []
    assert "incompatible" in aggregate["paretoStatus"]
    assert aggregate["runtimes_s"] == [1.0, 2.0, 3.0]


async def _headers(client, registration) -> dict[str, str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def test_a_study_keeps_the_revisions_it_selects_inline(
    api_client, db_session, registration, study_gate
) -> None:
    headers = await _headers(api_client, registration)
    profile = await api_client.get("/v1/users/me", headers=headers)
    study_gate.plans[uuid.UUID(profile.json()["id"])] = largest_plan()
    await api_client.post(
        "/v1/organizations",
        headers=headers,
        json={"slug": "suite-lab", "name": "Suite Lab"},
    )
    revision = await upload_problem(api_client, headers, "suite-lab", slug="case-a")
    created = await api_client.post(
        "/v1/organizations/suite-lab/studies",
        headers=headers,
        json={
            "slug": "from-suite",
            "name": "From suite",
            "definition": {
                "revision_ids": [revision["revision_id"]],
                "engines": [study_engine(engine_ref(routes._manifest("random-search")))],
                "parameter_sets": [{}],
                "seeds": [0],
            },
        },
    )

    assert created.status_code == 201, created.text
    assert created.json()["definition"]["revision_ids"] == [revision["revision_id"]]
    assert created.json()["definition_digest"] == digest(created.json()["definition"])
    assert created.json()["organization_id"] == (await api_client.get("/v1/organizations/suite-lab", headers=headers)).json()["id"]
    listed = await api_client.get('/v1/organizations/suite-lab/studies', headers=headers)
    assert listed.json()[0]['definition'] == created.json()['definition']
    read = await api_client.get('/v1/organizations/suite-lab/studies/from-suite', headers=headers)
    assert read.status_code == 200 and read.headers.get("ETag")
    assert read.json()["definition_digest"] == created.json()["definition_digest"]

    key = await api_client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": "different engine only",
            "permissions": ["studies:read", "studies:write"],
            "engine_access": {"all": False, "engines": [engine("other", "b")]},
            "boundary": {},
        },
    )
    assert key.status_code == 201, key.text
    key_headers = {"X-API-Key": key.json()["secret"]}
    hidden = await api_client.get(
        "/v1/organizations/suite-lab/studies", headers=key_headers
    )
    blocked_run = await api_client.post(
        "/v1/organizations/suite-lab/studies/from-suite/runs",
        headers=key_headers,
    )
    blocked_create = await api_client.post(
        "/v1/organizations/suite-lab/studies",
        headers=key_headers,
        json={
            "slug": "forbidden-engine",
            "name": "Forbidden engine",
            "definition": {
                "revision_ids": [revision["revision_id"]],
                "engines": [study_engine(engine_ref(routes._manifest("random-search")))],
                "parameter_sets": [{}],
                "seeds": [0],
            },
        },
    )
    assert hidden.status_code == 200 and hidden.json() == []
    assert blocked_run.status_code == 403
    assert blocked_run.json()["detail"]["code"] == "api_key_engine_forbidden"
    assert blocked_create.status_code == 403
    assert blocked_create.json()["detail"]["code"] == "api_key_engine_forbidden"


@pytest.mark.parametrize("grant", ["exact", "all"])
async def test_an_api_key_that_grants_the_engine_can_use_studies(
    api_client, db_session, registration, study_gate, monkeypatch, grant
) -> None:
    # A study engine carries its mode and optimization; the key grants the revision those pin.
    async def solve(*args, **kwargs):
        return {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": {
            "t1": {"resource": "catalog", "id": "c1a"},
            "t2": {"resource": "catalog", "id": "c2a"},
            "t3": {"resource": "catalog", "id": "c3a"},
        }}}]}

    from openbinding_gateway.core.settings import get_settings
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", solve)
    headers = await _headers(api_client, registration)
    profile = await api_client.get("/v1/users/me", headers=headers)
    study_gate.plans[uuid.UUID(profile.json()["id"])] = largest_plan()
    assert (await api_client.post(
        "/v1/organizations", headers=headers, json={"slug": "keyed", "name": "Keyed"}
    )).status_code == 201
    revision = await upload_problem(api_client, headers, "keyed", slug="case-a")
    reference = engine_ref(routes._manifest("random-search"), "bim.builtin")
    key = await api_client.post(
        "/v1/users/me/api-keys",
        headers=headers,
        json={
            "name": f"studies with {grant}",
            "permissions": ["studies:read", "studies:write"],
            "engine_access": (
                {"all": False, "engines": [reference]} if grant == "exact" else {"all": True, "engines": []}
            ),
            "boundary": {},
        },
    )
    assert key.status_code == 201, key.text
    key_headers = {"X-API-Key": key.json()["secret"]}
    base = "/v1/organizations/keyed/studies"

    created = await api_client.post(base, headers=key_headers, json={
        "slug": "keyed-study",
        "name": "Keyed study",
        "definition": {
            "revision_ids": [revision["revision_id"]],
            "engines": [study_engine(reference)],
            "parameter_sets": [{}],
            "seeds": [0],
        },
    })
    assert created.status_code == 201, created.text
    listed = await api_client.get(base, headers=key_headers)
    assert [item["slug"] for item in listed.json()] == ["keyed-study"]
    read = await api_client.get(f"{base}/keyed-study", headers=key_headers)
    assert read.status_code == 200, read.text
    run = await api_client.post(f"{base}/keyed-study/runs", headers=key_headers)
    assert run.status_code == 202, run.text
    run_read = await api_client.get(f"{base}/keyed-study/runs/{run.json()['id']}", headers=key_headers)
    assert run_read.status_code == 200, run_read.text
    assert run_read.json()["definition_digest"] == run.json()["definition_digest"]
    cells = await api_client.get(f"{base}/keyed-study/runs/{run.json()['id']}/cells", headers=key_headers)
    assert cells.status_code == 200 and len(cells.json()) == 1, cells.text


async def test_study_run_persists_the_exact_cartesian_matrix(
    api_client, db_session, registration, study_gate, monkeypatch
) -> None:
    async def solve(*args, **kwargs):
        return {
            "termination": "FEASIBLE",
            "solutions": [{
                "decision": {
                    "kind": "binding",
                    "binding": {
                        "t1": {"resource": "catalog", "id": "c1a"},
                        "t2": {"resource": "catalog", "id": "c2a"},
                        "t3": {"resource": "catalog", "id": "c3a"},
                    },
                }
            }],
        }

    from openbinding_gateway.core.settings import get_settings
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", solve)
    headers = await _headers(api_client, registration)
    manifest = routes._manifest("random-search")
    exact_engine = study_engine(engine_ref(manifest, "bim.builtin"))
    org = await api_client.post(
        "/v1/organizations",
        headers=headers,
        json={"slug": "lab", "name": "Binding Lab"},
    )
    revision = await upload_problem(api_client, headers, "lab", slug="checkout")
    study = await api_client.post(
        "/v1/organizations/lab/studies",
        headers=headers,
        json={
            "slug": "compare",
            "name": "Compare engines",
            "definition": {
                "revision_ids": [revision["revision_id"]],
                "engines": [exact_engine],
                "parameter_sets": [{"iterations": 100}, {"iterations": 200}],
                "seeds": [1, 2],
            },
        },
    )
    run = await api_client.post(
        "/v1/organizations/lab/studies/compare/runs", headers=headers
    )
    cells = (
        await db_session.execute(
            select(StudyCell)
            .where(StudyCell.study_run_id == uuid.UUID(run.json()["id"]))
            .order_by(StudyCell.ordinal)
        )
    ).scalars().all()
    listed_runs = await api_client.get(
        "/v1/organizations/lab/studies/compare/runs", headers=headers
    )
    listed_cells = await api_client.get(
        f"/v1/organizations/lab/studies/compare/runs/{run.json()['id']}/cells",
        headers=headers,
    )

    assert org.status_code == 201
    assert study.status_code == 201
    assert run.status_code == 202, run.text
    assert run.json()["cells"] == 4
    assert [cell.seed for cell in cells] == [1, 2, 1, 2]
    assert len({cell.fingerprint for cell in cells}) == 4
    assert all(cell.job_id is not None for cell in cells), [(cell.state.value, cell.metrics) for cell in cells]
    assert all(cell.state.value == "completed" for cell in cells)
    assert listed_runs.json()[0]["matrix_digest"] == run.json()["matrix_digest"]
    assert len(listed_cells.json()) == 4
    assert all(cell["state"] == "completed" for cell in listed_cells.json())

    # The run froze the definition it ran, with the compilation of its one revision.
    frozen = run.json()["definition"]
    assert frozen["apiVersion"] == "openbinding/study-run/v1"
    assert [item["revisionId"] for item in frozen["problems"]] == [revision["revision_id"]]
    assert frozen["seeds"] == [1, 2]
    assert run.json()["definition_digest"] == digest(frozen)
    assert {str(cell.compilation_id) for cell in cells} == {frozen["problems"][0]["compilationId"]}
    jobs = (await db_session.scalars(select(Job).where(Job.id.in_([cell.job_id for cell in cells])))).all()
    assert {str(job.compilation_id) for job in jobs} == {frozen["problems"][0]["compilationId"]}

    tag = (await api_client.get('/v1/organizations/lab/studies/compare', headers=headers)).headers["ETag"]
    edited = await api_client.patch('/v1/organizations/lab/studies/compare', headers={**headers, "If-Match": tag},
        json={'definition': {**study.json()['definition'], 'seeds': [99]}})
    assert edited.status_code == 200, edited.text
    assert edited.json()['definition']['seeds'] == [99]
    stale = await api_client.patch('/v1/organizations/lab/studies/compare', headers={**headers, "If-Match": tag},
        json={'name': 'Too late'})
    assert stale.status_code == 412
    history = await api_client.get('/v1/organizations/lab/studies/compare/runs', headers=headers)
    assert history.json()[0]['definition'] == frozen
    assert history.json()[0]['matrix_digest'] == run.json()['matrix_digest']
    from sqlalchemy import update, delete
    from sqlalchemy.exc import DBAPIError
    from openbinding_gateway.db.models import StudyRun
    run_id = uuid.UUID(run.json()['id'])
    for statement in (
        update(StudyRun).where(StudyRun.id == run_id).values(definition={**frozen, "seeds": [99]}),
        update(StudyRun).where(StudyRun.id == run_id).values(definition_digest="sha256-" + "0" * 64),
        delete(StudyRun).where(StudyRun.id == run_id),
        update(StudyCell).where(StudyCell.study_run_id == run_id).values(seed=123),
        update(StudyCell).where(StudyCell.study_run_id == run_id).values(parameters={'iterations': 999}),
        delete(StudyCell).where(StudyCell.study_run_id == run_id),
    ):
        with pytest.raises(DBAPIError):
            async with db_session.begin_nested():
                await db_session.execute(statement)

    removed = await api_client.delete('/v1/organizations/lab/studies/compare', headers=headers)
    assert removed.status_code == 409
    archived = await api_client.patch('/v1/organizations/lab/studies/compare', headers=headers,
        json={'archived': True})
    assert archived.json()['archived'] is True
    assert (await api_client.get('/v1/organizations/lab/studies', headers=headers)).json() == []
    assert (await api_client.get('/v1/organizations/lab/studies?include_archived=true', headers=headers)).json()[0]['id'] == study.json()['id']



async def test_study_cancel_and_cell_retry_are_http_idempotent(
    api_client, db_session, registration, study_gate, monkeypatch
) -> None:
    async def leave_queued(session, cell, user, organization):
        job = Job(
            created_by_id=user.id,
            engine_id=cell.engine_ref["name"],
            engine_job_id=str(uuid.uuid4()),
            service_url="http://engine",
            state=JobState.QUEUED,
            original_request={},
            options={},
            provenance={},
            organization_id=organization.id,
            **placeholder_refs('organization_id'),
        )
        session.add(job)
        await session.flush()
        cell.job_id = job.id
        await session.flush()
        return job

    monkeypatch.setattr(study_routes, "launch_study_cell", leave_queued)
    headers = await _headers(api_client, registration)
    await api_client.post(
        "/v1/organizations",
        headers=headers,
        json={"slug": "retry-lab", "name": "Retry Lab"},
    )
    revision = await upload_problem(api_client, headers, "retry-lab", slug="case-a")
    created = await api_client.post(
        "/v1/organizations/retry-lab/studies",
        headers=headers,
        json={
            "slug": "retry-study",
            "name": "Retry study",
            "definition": {
                "revision_ids": [revision["revision_id"]],
                "engines": [study_engine(engine_ref(routes._manifest("random-search")))],
                "parameter_sets": [{}],
                "seeds": [0],
            },
        },
    )
    assert created.status_code == 201, created.text
    run = await api_client.post(
        "/v1/organizations/retry-lab/studies/retry-study/runs",
        headers=headers,
    )
    cells = await api_client.get(
        f"/v1/organizations/retry-lab/studies/retry-study/runs/{run.json()['id']}/cells",
        headers=headers,
    )
    cell_id = cells.json()[0]["id"]
    original_job_id = cells.json()[0]["job_id"]
    base = (
        "/v1/organizations/retry-lab/studies/retry-study/"
        f"runs/{run.json()['id']}"
    )

    cancelled = await api_client.post(f"{base}/cancel", headers=headers)
    repeated_cancel = await api_client.post(f"{base}/cancel", headers=headers)
    first_retry = await api_client.post(f"{base}/cells/{cell_id}/retry", headers=headers)
    second_retry = await api_client.post(f"{base}/cells/{cell_id}/retry", headers=headers)
    retries = (
        await db_session.execute(
            select(Job).where(Job.retry_of_id == uuid.UUID(original_job_id))
        )
    ).scalars().all()

    assert run.status_code == 202
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    assert repeated_cancel.status_code == 409
    assert first_retry.status_code == second_retry.status_code == 200
    assert first_retry.json()["jobId"] == second_retry.json()["jobId"]
    assert first_retry.json()["idempotent"] is False
    assert second_retry.json()["idempotent"] is True
    assert len(retries) == 1
