"""Independent arithmetic oracles and real canonical evidence for archive decisions."""
import copy
import itertools
import random
from pathlib import Path

import pytest

from openbinding_gateway.models.analysis import AnalysisQuery, AnalysisSource, Requirement
from openbinding_gateway.v1.archive import (
    build_archive, candidate_detail, decide, dominates, exact_layers, first_front, query_archive,
)
from openbinding_gateway.v1.archive_geometry import budget_map, preference_geometry
from openbinding_gateway.v1.canonical import digest
from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package


def example_archive(points=None, directions=None, constraints=None):
    points = points or [(0, 1), (.6, .6), (1, 0), (.85, .85)]
    m = len(points[0])
    terms = [{"feature": {"resource": "app", "id": f"x{j}"}, "direction": (directions or ["minimize"] * m)[j]} for j in range(m)]
    document = {"spec": {"optimization": {"mode": "pareto", "terms": terms}, "constraints": constraints or []}}
    solutions = [{"decision": {"kind": "binding", "binding": {"task": {"resource": "catalog", "id": str(i)}}},
        "features": {f"x{j}": x for j, x in enumerate(point)}, "violations": [],
        "objectives": {"mode": "pareto", "penalty": 0, "score": [*point, 0],
            "components": [{"feature": term["feature"], "value": point[j], "loss": point[j], "weight": 1} for j, term in enumerate(terms)]}}
        for i, point in enumerate(points)]
    result = {"solutions": solutions}
    source = AnalysisSource(id="source", engine="fixture", state="completed", createdAt="2026-01-01", irDigest=digest(document), evaluatorDigest="verified-evaluator", resultDigest=digest(result), legacy=False)
    return build_archive([(source, document, result)])


def binding_names(rows):
    return [c.binding["task"]["id"] for c in rows]


def test_balanced_unsupported_winner_dominated_runner_up_and_fixed_normalization():
    archive = example_archive()
    q = AnalysisQuery(sources=["source"])
    assert binding_names(decide(archive, q).ordered) == ["1", "3", *binding_names(decide(archive, q).ordered)[2:]]
    assert set(binding_names(decide(archive, q).ordered)[2:]) == {"0", "2"}
    weighted = decide(archive, q.model_copy(update={"rule": "weighted"}))
    assert set(binding_names(weighted.ordered)[:2]) == {"0", "2"}
    assert weighted.ranks[weighted.ordered[0].id] == weighted.ranks[weighted.ordered[1].id]
    before = [c.normalized for c in archive.candidates]
    budget = q.model_copy(update={"requirements": [Requirement(dimension="app:x0", value=.7)]})
    assert set(binding_names(decide(archive, budget).ordered)) == {"0", "1"}
    assert [c.normalized for c in archive.candidates] == before
    response = query_archive(archive, q)
    assert response["winnerCount"] == 1 and response["nextCount"] == 1
    assert response["pareto"]["frontCount"] == 3


@pytest.mark.parametrize("m", [1, 2, 3])
def test_fast_front_matches_exhaustive_oracle_with_duplicates_and_ties(m):
    rng = random.Random(42)
    for n in (0, 1, 4, 50, 200):
        rows = tuple(tuple(rng.randint(-3, 5) for _ in range(m)) for _ in range(n))
        expected = {i for i, row in enumerate(rows) if not any(dominates(other, row) for other in rows)}
        assert first_front(rows) == expected
        ranks = exact_layers(rows)
        assert {i for i, rank in enumerate(ranks) if rank == 1} == expected
        for i, row in enumerate(rows):
            assert ranks[i] == 1 + max((ranks[j] for j, other in enumerate(rows) if dominates(other, row)), default=0)


def test_general_layers_cancel_without_quadratic_storage():
    calls = []
    def stop(done, total):
        calls.append((done, total))
        raise RuntimeError("cancel")
    with pytest.raises(RuntimeError, match="cancel"):
        exact_layers(tuple((i, i, -i, i % 3) for i in range(200)), stop)
    assert calls[0][0] == 4096


def test_power_cell_winners_match_direct_scores_including_fixed_hidden_priority():
    archive = example_archive([(0, 1, .5, 1), (.6, .6, .2, 0), (1, 0, .5, .5), (.2, .9, .8, .2)])
    query = AnalysisQuery(sources=["source"], rule="weighted", axes=["app:x0", "app:x1", "app:x2"], geometry="power")
    decision = decide(archive, query)
    geometry = preference_geometry(archive, decision, query)
    assert geometry["mass"] == .75
    for u, v in itertools.product([.1, .2, .3], repeat=2):
        weights = [.75*u, .75*v, .75*(1-u-v), .25, 0]
        scores = {c.id: sum(w*z for w, z in zip(weights, c.normalized, strict=True)) for c in decision.ordered}
        affine_scores = {cid: cell["coefficients"][0]*u + cell["coefficients"][1]*v + cell["coefficients"][2]
                         for cell in geometry["cells"] for cid in cell["ids"]}
        assert affine_scores == pytest.approx(scores)
        assert min(affine_scores, key=affine_scores.get) == min(scores, key=scores.get)
    assert preference_geometry(archive, decision, query.model_copy(update={"rule": "balanced"}))["state"] == "unavailable"


def constraint(op, value):
    return {"ref": {"resource": "rules", "id": op}, "when": {"kind": "literal", "value": True}, "enforcement": "hard",
        "assert": {"kind": "compare", "op": op, "left": {"kind": "path", "segments": ["features", "x0"]},
                   "right": {"kind": "literal", "value": value}}}


def test_budgets_use_one_witness_ignore_own_axes_and_do_not_invert_upper_bounds():
    archive = example_archive([(0, 1, 1), (.6, .6, .5), (1, 0, 0)], constraints=[constraint("gte", -.1), constraint("lte", 10)])
    query = AnalysisQuery(sources=["source"], axes=["app:x0", "app:x1"], requirements=[
        Requirement(dimension="app:x0", value=.2), Requirement(dimension="app:x2", value=.5)])
    result = budget_map(archive, decide(archive, query), query)
    assert result["witnessCount"] == 2  # Own x budget does not erase its achievement map.
    assert [(p["x"], p["y"]) for p in result["corners"]] == [(.6, .6), (1, 0)]
    assert len(result["excluded"]) == 1
    assert result["excluded"][0]["label"] == "rules:gte"


def test_real_canonical_archive_keeps_hard_violations_and_penalty_dimension():
    problem = compile_instance(load_package(Path(__file__).parents[2] / "examples/demo/18_analysis_constraints"))
    tasks = sorted(problem.document["spec"]["eligibility"])
    solutions = []
    for refs in itertools.product(*(problem.document["spec"]["eligibility"][t] for t in tasks)):
        binding = dict(zip(tasks, refs, strict=True))
        solutions.append({"decision": {"kind": "binding", "binding": binding}, **problem.evaluate(binding)})
    source = AnalysisSource(id="canonical", engine="diagnostic", state="completed", createdAt="2026-01-01", irDigest=problem.digest,
                            evaluatorDigest="test", resultDigest=digest(solutions), legacy=False)
    archive = build_archive([(source, problem.document, {"solutions": solutions})])
    assert len(archive.candidates) == 36
    assert archive.dimensions[2].direction == "maximize"
    assert not archive.dimensions[-1].constant
    decision = decide(archive, AnalysisQuery(sources=["canonical"]))
    assert all(c.feasible is True for c in decision.ordered)
    assert any(c.feasible is False for c in archive.candidates)
    detail = candidate_detail(archive, AnalysisQuery(sources=["canonical"], selected=decision.ordered[0].id))
    assert not detail["dominance"]["dominatorCount"]


def test_pooling_deduplicates_occurrences_but_rejects_conflicting_evaluations():
    archive = example_archive()
    source = archive.sources[0]
    result = {"solutions": [c.solution for c in archive.candidates]}
    second = source.model_copy(update={"id": "other"})
    pooled = build_archive([(source, archive.document, result), (second, archive.document, result)])
    assert len(pooled.candidates) == 4
    assert all(len(c.occurrences) == 2 for c in pooled.candidates)
    conflicting = copy.deepcopy(result)
    conflicting["solutions"][0]["objectives"]["penalty"] = 2
    with pytest.raises(ValueError, match="contradictory"):
        build_archive([(source, archive.document, result), (second, archive.document, conflicting)])
    with pytest.raises(ValueError, match="Pooling"):
        build_archive([(source, archive.document, result), (second.model_copy(update={"legacy": True}), archive.document, result)])


async def test_api_canonical_sources_revision_export_and_auth(api_client, db_session, registration, monkeypatch):
    from sqlalchemy import select
    from openbinding_gateway.db.models import Job, JobState, User
    from openbinding_gateway.v1.compiler import BindingProblem, compiler_bundle_digest

    details = registration()
    await api_client.post("/v1/auth/register", json=details)
    token = (await api_client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    owner = (await db_session.execute(select(User).where(User.username == details["username"]))).scalar_one()
    problem = compile_instance(load_package(Path(__file__).parents[2] / "examples/demo/17_analysis_tradeoffs"))
    binding = {t: refs[0] for t, refs in problem.document["spec"]["eligibility"].items()}
    result = {"solutions": [{"decision": {"kind": "binding", "binding": binding}, **problem.evaluate(binding)}]}
    jobs = [Job(owner_id=owner.id, engine_id="diagnostic", engine_job_id=f"fixture-{i}", service_url="https://example.invalid",
        state=JobState.COMPLETED, original_request={"bindingProblem": problem.document}, result=copy.deepcopy(result),
        provenance={"irDigest": problem.digest, "evaluatorDigest": compiler_bundle_digest()}) for i in range(2)]
    db_session.add_all(jobs)
    await db_session.commit()
    def forbidden(*args, **kwargs):
        raise AssertionError("Stored-only analysis must never evaluate a binding")
    monkeypatch.setattr(BindingProblem, "evaluate", forbidden)
    query = {"sources": [str(j.id) for j in jobs]}
    assert (await api_client.post("/v1/analysis/query", json=query)).status_code == 401
    response = await api_client.post("/v1/analysis/query", json=query, headers=headers)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["counts"]["stored"] == 2 and data["counts"]["unique"] == 1
    assert data["winners"][0]["occurrences"] == 2
    selected = data["winners"][0]["id"]
    detail = await api_client.post("/v1/analysis/candidate", json={**query, "selected": selected}, headers=headers)
    assert detail.status_code == 200, detail.text
    assert detail.json()["binding"] == binding
    receipt = await api_client.post("/v1/analysis/export", json={**query, "format": "receipt", "selected": selected}, headers=headers)
    assert receipt.status_code == 200 and receipt.json()["kind"] == "binding-decision"
    csv = await api_client.post("/v1/analysis/export", json={**query, "format": "csv"}, headers=headers)
    assert csv.status_code == 200 and selected in csv.text
    listing = await api_client.get("/v1/analysis/sources", headers=headers)
    assert len(listing.json()["items"]) == 2 and "solutions" not in listing.text
    from test_api_keys import mint_key
    catalog = (await api_client.get("/v1/engines", headers=headers)).json()["engines"]
    blocked_key = await mint_key(api_client, token, permissions=["jobs:read"], all_engines=False, engines=[catalog[0]["ref"]])
    key_headers = {"X-API-Key": blocked_key["secret"]}
    # The owner cache has already been populated; grants still gate every surface.
    for endpoint, payload in [("query", query), ("candidate", {**query, "selected": selected}),
                              ("export", {**query, "format": "csv"}), ("pareto", query)]:
        denied = await api_client.post(f"/v1/analysis/{endpoint}", json=payload, headers=key_headers)
        assert denied.status_code == 404, denied.text
    assert not (await api_client.get("/v1/analysis/sources", headers=key_headers)).json()["items"]
    changed = copy.deepcopy(result)
    changed["solutions"] = []
    jobs[1].result = changed
    await db_session.commit()
    stale = await api_client.post("/v1/analysis/query", json={**query, "revision": data["revision"]}, headers=headers)
    assert stale.status_code == 409
    other = registration()
    await api_client.post("/v1/auth/register", json=other)
    other_token = (await api_client.post("/v1/auth/login", json={"username_or_email": other["username"], "password": other["password"]})).json()["access_token"]
    denied = await api_client.post("/v1/analysis/query", json=query, headers={"Authorization": f"Bearer {other_token}"})
    assert denied.status_code == 404


def test_requirements_constants_zero_priorities_unknown_and_hypervolume():
    from openbinding_gateway.v1.archive import hypervolume_2d
    archive = example_archive([(0, 1), (.6, .6), (1, 0), (.85, .85)])
    q = AnalysisQuery(sources=["source"], weights={"app:x0": 0, "app:x1": 0})
    decision = decide(archive, q)
    assert decision.weights == [.5, .5, 0]
    assert hypervolume_2d(archive, decision.ordered)["value"] == pytest.approx(.37)
    assert not decide(archive, q.model_copy(update={"requirements": [Requirement(dimension="app:x0", value=-1)]})).ordered
    constant = example_archive([(1, 1), (1, 1)])
    assert len(query_archive(constant, q)["winners"]) == 2
    source = archive.sources[0]
    raw = copy.deepcopy(archive.candidates[0].solution)
    raw.pop("violations")
    unknown = build_archive([(source, archive.document, {"solutions": [raw]})])
    assert unknown.candidates[0].feasible is None
    assert not decide(unknown, AnalysisQuery(sources=["source"])).ordered


async def test_analysis_worker_atomic_completion_failure_retry_and_cancel(db_session, monkeypatch):
    import uuid
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from openbinding_gateway import analysis_jobs
    from openbinding_gateway.db import base
    from openbinding_gateway.db.models import AnalysisTask, Job, JobState, User
    from openbinding_gateway.routes import analysis
    problem = compile_instance(load_package(Path(__file__).parents[2] / "examples/demo/17_analysis_tradeoffs"))
    owner = User(username="worker-owner", email="worker@example.invalid", password_hash="unused", is_active=True, plan_cache="BASIC")
    db_session.add(owner)
    await db_session.flush()
    solutions = []
    tasks = sorted(problem.document["spec"]["eligibility"])
    for refs in itertools.product(*(problem.document["spec"]["eligibility"][t] for t in tasks)):
        binding = dict(zip(tasks, refs, strict=True))
        solutions.append({"decision": {"kind": "binding", "binding": binding}, **problem.evaluate(binding)})
    job = Job(owner_id=owner.id, engine_id="fixture", engine_job_id="worker-fixture", service_url="https://example.invalid",
        state=JobState.COMPLETED, original_request={"bindingProblem": problem.document}, result={"solutions": solutions},
        provenance={"irDigest": problem.digest, "evaluatorDigest": "fixture"})
    db_session.add(job)
    await db_session.commit()
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    monkeypatch.setattr(base, "session_factory", lambda: factory)
    async def queued(_):
        pass
    monkeypatch.setattr(analysis_jobs, "dispatch_analysis", queued)
    query = AnalysisQuery(sources=[str(job.id)], layers=True)
    task = await analysis.start_pareto(query, owner, db_session)
    again = await analysis.start_pareto(query, owner, db_session)
    assert again.id == task.id
    original = analysis_jobs.exact_layers
    def fail(*_):
        raise RuntimeError("worker failure test")
    monkeypatch.setattr(analysis_jobs, "exact_layers", fail)
    await analysis_jobs.execute_analysis(task.id)
    failed = await analysis.get_pareto(uuid.UUID(task.id), owner, db_session)
    assert failed.state == "failed" and failed.result is None
    task = await analysis.start_pareto(query, owner, db_session)
    assert task.state == "queued"
    # An expired worker lease is durably requeued before delivery, without a partial result.
    from datetime import timedelta
    from openbinding_gateway.db.models import utcnow
    record = await db_session.get(AnalysisTask, uuid.UUID(task.id))
    record.state = "running"
    record.lease_until = utcnow() - timedelta(seconds=1)
    record.lease_token = "abandoned-worker"
    await db_session.commit()
    await analysis_jobs.redeliver_analysis(db_session)
    await db_session.refresh(record)
    assert record.state == "queued" and record.lease_token is None and record.result is None
    monkeypatch.setattr(analysis_jobs, "exact_layers", original)
    await analysis_jobs.execute_analysis(task.id)
    done = await analysis.get_pareto(uuid.UUID(task.id), owner, db_session)
    assert done.state == "completed" and done.result["complete"]
    await analysis_jobs.execute_analysis(task.id)  # Duplicate queue delivery cannot overwrite completion.
    assert (await analysis.get_pareto(uuid.UUID(task.id), owner, db_session)).result == done.result
    cancel = await analysis.start_pareto(query.model_copy(update={"layers": False}), owner, db_session)
    job.result = {"solutions": []}
    await db_session.commit()
    cancelled = await analysis.cancel_pareto(uuid.UUID(cancel.id), owner, db_session)
    assert cancelled.state == "cancelled" and cancelled.result is None
    await analysis_jobs.execute_analysis(cancel.id)
    stored = await db_session.get(AnalysisTask, uuid.UUID(cancel.id), populate_existing=True)
    assert stored.state == "cancelled" and stored.result is None


def test_interned_assignment_identity_matches_canonical_json_with_unicode():
    archive = example_archive()
    source = archive.sources[0]
    row = copy.deepcopy(archive.candidates[0].solution)
    row['decision']['binding'] = {name: {'resource': 'catalog', 'id': 'quote" / 雪'} for name in ['\U0001f600', '\ue000', 'a']}
    result = build_archive([(source, archive.document, {'solutions': [row]})])
    assert result.candidates[0].id == digest(row['decision']['binding'])
