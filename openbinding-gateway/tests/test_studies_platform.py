"""Reproducible study matrices and binding-analysis aggregates."""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from pydantic import ValidationError
from sqlalchemy import select

from _repo import REPO_ROOT

from openbinding_gateway import space_client
from openbinding_gateway.db.models import Job, JobState, StudyCell
from openbinding_gateway.models.platform import StudyDefinition
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.routes import studies as study_routes
from _pricing import fake_pricing_gate, largest_plan
from openbinding_gateway.studies import aggregate_metrics, expand_study, nondominated
from openbinding_gateway.v1.package import load_package


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


def test_matrix_expansion_is_sorted_reproducible_and_fingerprinted() -> None:
    first_case, second_case = uuid.uuid4(), uuid.uuid4()
    definition = StudyDefinition(
        case_revision_ids=[second_case, first_case],
        engines=[engine("zeta", "b"), engine("alpha", "a")],
        parameter_sets=[{"temperature": 2}, {"temperature": 1}],
        seeds=[7, 3],
    )

    first = expand_study(definition)
    second = expand_study(definition)

    assert first == second
    assert len(first) == 16
    assert len({cell["fingerprint"] for cell in first}) == 16
    assert [cell["ordinal"] for cell in first] == list(range(16))
    assert first[0]["engine"]["name"] == "alpha"
    assert first[0]["seed"] == 3


def test_study_matrix_is_bounded_before_any_jobs_are_created() -> None:
    with pytest.raises(ValidationError, match="10,000"):
        StudyDefinition(
            case_revision_ids=[uuid.uuid4() for _ in range(101)],
            engines=[engine(f"engine-{index}", "a") for index in range(2)],
            parameter_sets=[{"batch": index} for index in range(50)],
            seeds=[0],
        )


def test_study_definition_rejects_duplicate_axes_and_malformed_engine_digests() -> None:
    case_id = uuid.uuid4()
    with pytest.raises(ValidationError, match="parameter_sets contains duplicates"):
        StudyDefinition(
            case_revision_ids=[case_id],
            engines=[engine("exact", "a")],
            parameter_sets=[{"iterations": 10}, {"iterations": 10}],
        )
    with pytest.raises(ValidationError, match="engine digest"):
        StudyDefinition(
            case_revision_ids=[case_id],
            engines=[engine("exact", "x")],
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


async def executable_revision_payload(client, headers):
    package = load_package(EXAMPLE)
    snapshot = await client.post('/v1/instances', headers={**headers, 'Content-Type': 'application/vnd.bim+zip'}, content=package.to_zip())
    assert snapshot.status_code == 201, snapshot.text
    return {'document': package.instance(), 'source_snapshot_id': snapshot.json()['id']}


async def test_a_study_can_freeze_case_revisions_from_a_collection(
    api_client, db_session, registration, study_gate
) -> None:
    headers = await _headers(api_client, registration)
    profile = await api_client.get("/v1/users/me", headers=headers)
    study_gate.plans[uuid.UUID(profile.json()["id"])] = largest_plan()
    await api_client.post(
        "/v1/organizations",
        headers=headers,
        json={"slug": "collection-lab", "name": "Collection Lab"},
    )
    await api_client.post(
        "/v1/organizations/collection-lab/projects",
        headers=headers,
        json={"slug": "bench", "name": "Benchmark", "visibility": "private"},
    )
    await api_client.post(
        "/v1/organizations/collection-lab/projects/bench/cases",
        headers=headers,
        json={"slug": "case-a", "name": "Case A"},
    )
    revision = await api_client.post(
        "/v1/organizations/collection-lab/projects/bench/cases/case-a/revisions",
        headers=headers,
        json=await executable_revision_payload(api_client, headers),
    )
    collection = await api_client.post('/v1/organizations/collection-lab/library', headers=headers,
        json={'name': 'suite', 'display_name': 'Suite', 'kind': 'Collection'})
    identity = collection.json()['id']
    draft = await api_client.post(f'/v1/artifacts/{identity}/drafts', headers=headers,
        json={'content': {'apiVersion': 'openbinding/collection/v1', 'members': [{
            'caseRevisionId': revision.json()['id'], 'compositionDigest': revision.json()['digest']}]}})
    collection_revision = await api_client.post(f"/v1/artifacts/{identity}/drafts/{draft.json()['id']}/seal",
        headers=headers, json={'revision': 1})
    assert collection_revision.status_code == 201, collection_revision.text
    created = await api_client.post(
        "/v1/organizations/collection-lab/projects/bench/studies",
        headers=headers,
        json={
            "slug": "from-suite",
            "name": "From suite",
            "definition": {
                "collection_version_id": collection_revision.json()["id"],
                "engines": [routes._engine_ref(routes._manifest("random-search"))],
                "parameter_sets": [{}],
                "seeds": [0],
            },
        },
    )

    assert created.status_code == 201, created.text
    assert created.json()["definition"]["case_revision_ids"] == [revision.json()["id"]]
    definition_artifact = created.json()['definition_artifact_id']
    definition_version = created.json()['definition_version_id']
    manifest = (await api_client.get(f'/v1/artifacts/{definition_artifact}/versions/{definition_version}', headers=headers)).json()
    assert manifest['manifest']['dependencies'] == [collection_revision.json()['ref']]
    # Editing the collection does not replace the cases already sealed into a study.
    next_draft = await api_client.post(f'/v1/artifacts/{identity}/drafts', headers=headers,
        json={'content': {'apiVersion': 'openbinding/collection/v1', 'members': []},
              'based_on_id': collection_revision.json()['id']})
    next_collection = await api_client.post(f"/v1/artifacts/{identity}/drafts/{next_draft.json()['id']}/seal",
        headers=headers, json={'revision': 1})
    assert next_collection.status_code == 201, next_collection.text
    unchanged = await api_client.get('/v1/organizations/collection-lab/projects/bench/studies', headers=headers)
    assert unchanged.json()[0]['definition_version_id'] == definition_version
    assert unchanged.json()[0]['definition']['case_revision_ids'] == [revision.json()['id']]

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
        "/v1/organizations/collection-lab/projects/bench/studies", headers=key_headers
    )
    blocked_run = await api_client.post(
        "/v1/organizations/collection-lab/projects/bench/studies/from-suite/runs",
        headers=key_headers,
    )
    blocked_create = await api_client.post(
        "/v1/organizations/collection-lab/projects/bench/studies",
        headers=key_headers,
        json={
            "slug": "forbidden-engine",
            "name": "Forbidden engine",
            "definition": {
                "case_revision_ids": [revision.json()["id"]],
                "engines": [routes._engine_ref(routes._manifest("random-search"))],
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
    monkeypatch.setattr(routes, "solve_remote", solve)
    headers = await _headers(api_client, registration)
    package = load_package(EXAMPLE)
    snapshot = await api_client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    manifest = routes._manifest("random-search")
    exact_engine = {**routes._engine_ref(manifest, "bim.builtin"), "mode": "seeded"}
    org = await api_client.post(
        "/v1/organizations",
        headers=headers,
        json={"slug": "lab", "name": "Binding Lab"},
    )
    project = await api_client.post(
        "/v1/organizations/lab/projects",
        headers=headers,
        json={"slug": "routing", "name": "Routing", "visibility": "private"},
    )
    case = await api_client.post(
        "/v1/organizations/lab/projects/routing/cases",
        headers=headers,
        json={"slug": "checkout", "name": "Checkout"},
    )
    revision = await api_client.post(
        "/v1/organizations/lab/projects/routing/cases/checkout/revisions",
        headers=headers,
        json={
            "document": package.instance(),
            "source_snapshot_id": snapshot.json()["id"],
        },
    )
    assert revision.status_code == 201, revision.text
    study = await api_client.post(
        "/v1/organizations/lab/projects/routing/studies",
        headers=headers,
        json={
            "slug": "compare",
            "name": "Compare engines",
            "definition": {
                "case_revision_ids": [revision.json()["id"]],
                "engines": [exact_engine],
                "parameter_sets": [{"iterations": 100}, {"iterations": 200}],
                "seeds": [1, 2],
            },
        },
    )
    run = await api_client.post(
        "/v1/organizations/lab/projects/routing/studies/compare/runs", headers=headers
    )
    cells = (
        await db_session.execute(
            select(StudyCell)
            .where(StudyCell.study_run_id == uuid.UUID(run.json()["id"]))
            .order_by(StudyCell.ordinal)
        )
    ).scalars().all()
    listed_runs = await api_client.get(
        "/v1/organizations/lab/projects/routing/studies/compare/runs", headers=headers
    )
    listed_cells = await api_client.get(
        f"/v1/organizations/lab/projects/routing/studies/compare/runs/{run.json()['id']}/cells",
        headers=headers,
    )

    assert org.status_code == 201 and project.status_code == 201
    assert case.status_code == 201 and study.status_code == 201
    assert run.status_code == 202, run.text
    assert run.json()["cells"] == 4
    assert [cell.seed for cell in cells] == [1, 2, 1, 2]
    assert len({cell.fingerprint for cell in cells}) == 4
    assert all(cell.job_id is not None for cell in cells), [(cell.state.value, cell.metrics) for cell in cells]
    assert all(cell.state.value == "completed" for cell in cells)
    assert listed_runs.json()[0]["matrix_digest"] == run.json()["matrix_digest"]
    assert len(listed_cells.json()) == 4
    assert all(cell["state"] == "completed" for cell in listed_cells.json())
    assert [feature for _, feature, _ in study_gate.evaluations].count(
        "studies"
    ) == 1

    report_doc = {'provenance': {
        'study': {'runId': run.json()['id'], 'matrixDigest': run.json()['matrix_digest']},
        'datasets': [{'reference': revision.json()['id'], 'digest': revision.json()['digest']}],
        'software': [{'name': 'test-evaluator', 'version': '1', 'digest': 'sha256-' + 'a' * 64}],
        'bimVersion': 'bim/v1', 'engineRevisions': [exact_engine], 'parameters': {},
    }}
    evidence_report = await api_client.post('/v1/organizations/lab/projects/routing/reports', headers=headers,
        json={'slug': 'run-evidence', 'title': 'Run evidence', 'study_run_id': run.json()['id'], 'document': report_doc})
    assert evidence_report.status_code == 201, evidence_report.text
    sealed_report = await api_client.post('/v1/organizations/lab/projects/routing/reports/run-evidence/freeze', headers=headers)
    assert sealed_report.status_code == 200, sealed_report.text
    from openbinding_gateway.db.models import ArtifactEvidence
    evidence_rows = (await db_session.scalars(select(ArtifactEvidence).where(ArtifactEvidence.version_id == uuid.UUID(sealed_report.json()['version_id'])))).all()
    assert len(evidence_rows) == 5
    from sqlalchemy import update
    from sqlalchemy.exc import DBAPIError
    with pytest.raises(DBAPIError):
        async with db_session.begin_nested():
            await db_session.execute(update(Job).where(Job.id == cells[0].job_id).values(result={'solutions': []}))
    from openbinding_gateway.db.models import StudyRun
    for statement in (
        update(StudyRun).where(StudyRun.id == uuid.UUID(run.json()['id'])).values(summary={'changed': True}),
        update(StudyCell).where(StudyCell.id == cells[0].id).values(metrics={'changed': True}),
        update(StudyCell).where(StudyCell.id == cells[0].id).values(job_id=None),
    ):
        with pytest.raises(DBAPIError):
            async with db_session.begin_nested():
                await db_session.execute(statement)
    retry_evidence = await api_client.post(
        f"/v1/organizations/lab/projects/routing/studies/compare/runs/{run.json()['id']}/cells/{cells[0].id}/retry", headers=headers)
    assert retry_evidence.status_code == 409, retry_evidence.text
    assert retry_evidence.json()['detail']['code'] == 'sealed_evidence'
    private_publication = await api_client.post('/v1/organizations/lab/projects/routing/publications', headers=headers,
        json={'report_id': evidence_report.json()['id'], 'slug': 'private-evidence'})
    assert private_publication.status_code == 422, private_publication.text

    original_version_id = study.json()['definition_version_id']
    artifact_id = study.json()['definition_artifact_id']
    assert run.json()['definition_version_id'] == original_version_id
    content = (await api_client.get(f'/v1/artifacts/{artifact_id}/versions/{original_version_id}/content', headers=headers)).json()
    content['seeds'] = [99]
    draft = await api_client.post(f'/v1/artifacts/{artifact_id}/drafts', headers=headers,
        json={'content': content, 'based_on_id': original_version_id})
    sealed = await api_client.post(f"/v1/artifacts/{artifact_id}/drafts/{draft.json()['id']}/seal", headers=headers,
        json={'revision': 1, 'version': '2'})
    assert sealed.status_code == 201, sealed.text
    selected = await api_client.patch('/v1/organizations/lab/projects/routing/studies/compare', headers=headers,
        json={'definition_version_id': sealed.json()['id']})
    assert selected.status_code == 200, selected.text
    assert selected.json()['definition']['seeds'] == [99]
    history = await api_client.get('/v1/organizations/lab/projects/routing/studies/compare/runs', headers=headers)
    assert history.json()[0]['definition_version_id'] == original_version_id
    assert history.json()[0]['matrix_digest'] == run.json()['matrix_digest']
    from sqlalchemy import update, delete
    from sqlalchemy.exc import DBAPIError
    from openbinding_gateway.db.models import StudyRun
    for statement in (
        update(StudyRun).where(StudyRun.id == uuid.UUID(run.json()['id'])).values(definition_version_id=uuid.UUID(sealed.json()['id'])),
        delete(StudyRun).where(StudyRun.id == uuid.UUID(run.json()['id'])),
        update(StudyCell).where(StudyCell.study_run_id == uuid.UUID(run.json()['id'])).values(seed=123),
        update(StudyCell).where(StudyCell.study_run_id == uuid.UUID(run.json()['id'])).values(parameters={'iterations': 999}),
        delete(StudyCell).where(StudyCell.study_run_id == uuid.UUID(run.json()['id'])),
    ):
        with pytest.raises(DBAPIError):
            async with db_session.begin_nested():
                await db_session.execute(statement)

    profile = await api_client.get('/v1/users/me', headers=headers)
    study_gate.plans[uuid.UUID(profile.json()['id'])] = largest_plan()
    second_project = await api_client.post('/v1/organizations/lab/projects', headers=headers,
        json={'slug': 'shared-study', 'name': 'Shared study', 'visibility': 'public'})
    assert second_project.status_code == 201, second_project.text
    reused = await api_client.post('/v1/organizations/lab/projects/shared-study/studies', headers=headers,
        json={'slug': 'compare', 'name': 'Shared definition', 'definition_version_id': original_version_id})
    assert reused.status_code == 201, reused.text
    assert reused.json()['definition_artifact_id'] == artifact_id
    assert reused.json()['definition_version_id'] == original_version_id
    assert reused.json()['definition']['seeds'] == study.json()['definition']['seeds']
    from openbinding_gateway.v1.canonical import digest
    exported = await api_client.get('/v1/organizations/lab/projects/routing/package?format=json', headers=headers)
    assert exported.status_code == 200, exported.text
    package = exported.json()
    imported = await api_client.post('/v1/organizations/lab/projects/shared-study/package', headers=headers, json=package)
    assert imported.status_code == 200, imported.text
    imported_runs = await api_client.get('/v1/organizations/lab/projects/shared-study/studies/compare/runs', headers=headers)
    assert imported_runs.json()[0]['definition_version_id'] == original_version_id
    assert imported_runs.json()[0]['matrix_digest'] == run.json()['matrix_digest']
    imported_cells = await api_client.get(f"/v1/organizations/lab/projects/shared-study/studies/compare/runs/{imported_runs.json()[0]['id']}/cells", headers=headers)
    assert {cell['binding_case_revision_id'] for cell in imported_cells.json()} == {revision.json()['id']}
    package['studies'][0]['runs'][0]['cells'][0]['seed'] = 999
    package['packageDigest'] = digest({key: value for key, value in package.items() if key != 'packageDigest'})
    tampered = await api_client.post('/v1/organizations/lab/projects/shared-study/package', headers=headers, json=package)
    assert tampered.status_code == 422, tampered.text
    assert tampered.json()['detail']['code'] == 'study_cell_mismatch'
    # Reconstruct a new local closure: its case revision and Study identity do
    # not exist yet, so the definition must be sealed after the case import.
    import base64
    import json
    from copy import deepcopy
    from openbinding_gateway.v1.canonical import canonical_json, digest_bytes
    fresh = deepcopy(exported.json())
    fresh['studies'] = []
    fresh_revision_id = str(uuid.uuid4())
    fresh['cases'][0]['id'] = str(uuid.uuid4())
    fresh['cases'][0]['slug'] = 'fresh-closure-case'
    fresh['cases'][0]['revisions'][0]['id'] = fresh_revision_id
    fresh_refs = {}
    for entry in fresh['library']:
        if entry['manifest']['kind'] != 'Study':
            continue
        original_digest = entry['ref']['versionDigest']
        document = json.loads(base64.b64decode(entry['contentBase64']))
        document['cases'][0]['caseRevisionId'] = fresh_revision_id
        content = canonical_json(document)
        entry['contentBase64'] = base64.b64encode(content).decode()
        entry['manifest']['contentDigest'] = digest_bytes(content)
        entry['manifest']['identity']['name'] += '-fresh'
        entry['ref']['name'] += '-fresh'
        entry['ref']['versionDigest'] = digest(entry['manifest'])
        fresh_refs[original_digest] = entry['ref']
    fresh['projectArtifacts'] = [fresh_refs.get(ref['versionDigest'], ref) for ref in fresh['projectArtifacts']]
    fresh['packageDigest'] = digest({key: value for key, value in fresh.items() if key != 'packageDigest'})
    restored_fresh = await api_client.post('/v1/organizations/lab/projects/shared-study/package', headers=headers, json=fresh)
    assert restored_fresh.status_code == 200, restored_fresh.text
    from openbinding_gateway.db.models import BindingCaseRevision, ArtifactCaseReference
    assert await db_session.get(BindingCaseRevision, uuid.UUID(fresh_revision_id)) is not None
    assert len((await db_session.scalars(select(ArtifactCaseReference).where(ArtifactCaseReference.case_revision_id == uuid.UUID(fresh_revision_id)))).all()) == 2


    removed = await api_client.delete('/v1/organizations/lab/projects/routing/studies/compare', headers=headers)
    assert removed.status_code == 409
    archived = await api_client.patch('/v1/organizations/lab/projects/routing/studies/compare', headers=headers,
        json={'archived': True})
    assert archived.json()['archived'] is True
    assert (await api_client.get('/v1/organizations/lab/projects/routing/studies', headers=headers)).json() == []
    assert (await api_client.get('/v1/organizations/lab/projects/routing/studies?include_archived=true', headers=headers)).json()[0]['id'] == study.json()['id']



async def test_study_cancel_and_cell_retry_are_http_idempotent(
    api_client, db_session, registration, study_gate, monkeypatch
) -> None:
    async def leave_queued(session, cell, user, organization, project_id):
        job = Job(
            owner_id=user.id,
            engine_id=cell.engine_ref["name"],
            engine_job_id=str(uuid.uuid4()),
            service_url="http://engine",
            state=JobState.QUEUED,
            original_request={},
            options={},
            provenance={},
            organization_id=organization.id,
            project_id=project_id,
            billing_sponsor_user_id=organization.billing_sponsor_user_id,
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
    await api_client.post(
        "/v1/organizations/retry-lab/projects",
        headers=headers,
        json={"slug": "bench", "name": "Benchmark", "visibility": "private"},
    )
    await api_client.post(
        "/v1/organizations/retry-lab/projects/bench/cases",
        headers=headers,
        json={"slug": "case-a", "name": "Case A"},
    )
    revision = await api_client.post(
        "/v1/organizations/retry-lab/projects/bench/cases/case-a/revisions",
        headers=headers,
        json=await executable_revision_payload(api_client, headers),
    )
    created = await api_client.post(
        "/v1/organizations/retry-lab/projects/bench/studies",
        headers=headers,
        json={
            "slug": "retry-study",
            "name": "Retry study",
            "definition": {
                "case_revision_ids": [revision.json()["id"]],
                "engines": [routes._engine_ref(routes._manifest("random-search"))],
                "parameter_sets": [{}],
                "seeds": [0],
            },
        },
    )
    assert created.status_code == 201, created.text
    run = await api_client.post(
        "/v1/organizations/retry-lab/projects/bench/studies/retry-study/runs",
        headers=headers,
    )
    cells = await api_client.get(
        f"/v1/organizations/retry-lab/projects/bench/studies/retry-study/runs/{run.json()['id']}/cells",
        headers=headers,
    )
    cell_id = cells.json()[0]["id"]
    original_job_id = cells.json()[0]["job_id"]
    base = (
        "/v1/organizations/retry-lab/projects/bench/studies/retry-study/"
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
