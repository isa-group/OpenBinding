"""Real canonical counterfactuals, bounded coverage and owner-scoped access."""
import copy
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from openbinding_gateway.db.models import Job, JobState, User
from openbinding_gateway.v1.analysis import analyze_neighborhood
from openbinding_gateway.v1.compiler import BindingProblem, compile_instance
from openbinding_gateway.v1.package import load_package

EXAMPLES = Path(__file__).resolve().parents[2] / "examples/demo"


def problem_and_binding(example="17_analysis_tradeoffs"):
    problem = compile_instance(load_package(EXAMPLES / example))
    binding = {task: refs[0] for task, refs in problem.document["spec"]["eligibility"].items()}
    return problem, binding


@pytest.mark.parametrize("example", ["17_analysis_tradeoffs", "18_analysis_constraints", "19_analysis_journey"])
def test_each_move_is_a_real_single_task_canonical_evaluation(example):
    problem, binding = problem_and_binding(example)
    original = copy.deepcopy(binding)
    result = analyze_neighborhood(problem, binding)
    assert binding == original
    assert result["coverage"]["complete"]
    assert result["coverage"]["total"] == 10
    for move in result["moves"]:
        changed = move["decision"]["binding"]
        assert sum(changed[t] != binding[t] for t in binding) == 1
        evaluation = problem.evaluate(changed)
        assert move["objectives"] == evaluation["objectives"]
        assert move["violations"] == evaluation["violations"]
        assert move["feasible"] == (not any(v["enforcement"] == "hard" for v in evaluation["violations"]))
        for delta, base, new in zip(move["componentDeltas"], result["base"]["objectives"]["components"], move["objectives"]["components"], strict=True):
            assert delta["loss"] == new["loss"] - base["loss"]


def test_partial_and_empty_coverage_never_claims_unchecked_local_optimality():
    problem, binding = problem_and_binding()
    result = analyze_neighborhood(problem, binding, limit=1)
    assert result["coverage"]["evaluated"] == 1
    assert not result["coverage"]["complete"]
    assert result["coverage"]["stopReason"] == "evaluation-limit"
    assert "unchecked" in result["conclusion"]
    timed = analyze_neighborhood(problem, binding, seconds=0)
    assert timed["coverage"]["evaluated"] == 0
    assert timed["coverage"]["stopReason"] == "time-budget"
    task = next(iter(binding))
    only = analyze_neighborhood(problem, binding, task=task)
    assert only["coverage"]["total"] == 5
    assert all(m["task"] == task for m in only["moves"])
    document = copy.deepcopy(problem.document)
    document["spec"]["eligibility"] = {t: [ref, ref] for t, ref in binding.items()}
    singleton = analyze_neighborhood(BindingProblem(document, problem.digest, {}), binding)
    assert singleton["coverage"]["total"] == 0
    assert singleton["coverage"]["complete"]
    assert "no eligible" in singleton["conclusion"]
    with pytest.raises(ValueError):
        analyze_neighborhood(problem, binding, task="unknown")
    with pytest.raises(ValueError):
        analyze_neighborhood(problem, binding, limit=129)


def test_failed_evaluations_are_not_counted_as_complete(monkeypatch):
    problem, binding = problem_and_binding()
    original = BindingProblem.evaluate

    def evaluate(self, candidate):
        if candidate != binding:
            raise ValueError("Undefined metric")
        return original(self, candidate)

    monkeypatch.setattr(BindingProblem, "evaluate", evaluate)
    result = analyze_neighborhood(problem, binding)
    assert result["coverage"]["attempted"] == result["coverage"]["total"] == 10
    assert result["coverage"]["evaluated"] == 0
    assert not result["coverage"]["complete"]
    assert len(result["failures"]) == 10


@pytest.mark.parametrize("mode", ["weighted", "pareto", "lexicographic", "satisfy"])
def test_comparison_respects_canonical_mode(mode):
    problem, binding = problem_and_binding()
    document = copy.deepcopy(problem.document)
    document["spec"]["optimization"]["mode"] = mode
    changed_problem = BindingProblem(document, problem.digest, {})
    result = analyze_neighborhood(changed_problem, binding)
    for move in result["moves"]:
        a, b = move["objectives"]["score"], result["base"]["objectives"]["score"]
        if mode == "pareto":
            expected = "equal" if a == b else "better" if all(x <= y for x, y in zip(a, b, strict=True)) else "worse" if all(x >= y for x, y in zip(a, b, strict=True)) else "trade-off"
        else:
            expected = "better" if a < b else "worse" if a > b else "equal"
        assert move["comparison"] == expected


async def test_endpoint_requires_owner_and_validates_budget(api_client, db_session, registration):
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201
    login = await api_client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    owner = (await db_session.execute(select(User).where(User.username == details["username"]))).scalar_one()
    problem, binding = problem_and_binding()
    solution = {"decision": {"kind": "binding", "binding": binding}, **problem.evaluate(binding)}
    job = Job(owner_id=owner.id, engine_id="analysis-test", engine_job_id="analysis-test", service_url="https://example.invalid", state=JobState.COMPLETED,
              original_request={"bindingProblem": problem.document}, provenance={"irDigest": problem.digest}, result={"solutions": [solution]})
    db_session.add(job)
    await db_session.commit()
    url = f"/v1/jobs/{job.id}/analysis/neighborhood"
    assert (await api_client.get(url)).status_code == 401
    response = await api_client.get(url, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["irDigest"] == problem.digest
    assert response.json()["coverage"]["total"] == 10
    assert (await api_client.get(url + "?limit=129", headers=headers)).status_code == 422
    assert (await api_client.get(url + "?solution_index=99", headers=headers)).status_code == 422
    assert (await api_client.get(url + "?task=unknown", headers=headers)).status_code == 422
    # Seed archives store the pinned IR via a snapshot rather than original_request.
    snapshot = await api_client.post("/v1/instances", headers={**headers, "Content-Type": "application/vnd.bim+zip"},
                                     content=load_package(EXAMPLES / "17_analysis_tradeoffs").to_zip())
    assert snapshot.status_code == 201, snapshot.text
    job.instance_snapshot_id = uuid.UUID(snapshot.json()["id"])
    job.original_request = None
    job.provenance = {"irDigest": snapshot.json()["irDigest"]}
    await db_session.commit()
    fallback = await api_client.get(url, headers=headers)
    assert fallback.status_code == 200, fallback.text
    assert fallback.json()["irDigest"] == snapshot.json()["irDigest"]
    ir_response = await api_client.get(f"/v1/jobs/{job.id}/ir", headers=headers)
    assert ir_response.status_code == 200
    assert ir_response.json()["kind"] == "BindingProblem"
    assert ir_response.json()["spec"]["constraints"] == problem.document["spec"]["constraints"]
    other = registration()
    await api_client.post("/v1/auth/register", json=other)
    login = await api_client.post("/v1/auth/login", json={"username_or_email": other["username"], "password": other["password"]})
    assert (await api_client.get(url, headers={"Authorization": f"Bearer {login.json()['access_token']}"})).status_code == 404
    await db_session.refresh(job)
    assert job.result == {"solutions": [solution]}


def test_infeasible_base_is_repaired_only_by_a_feasible_substitution():
    problem, binding = problem_and_binding("18_analysis_constraints")
    for task, refs in problem.document["spec"]["eligibility"].items():
        binding[task] = next(ref for ref in refs if ref["id"] == "overloaded")
    result = analyze_neighborhood(problem, binding)
    assert not result["base"]["feasible"]
    assert any(move["comparison"] == "repairs-feasibility" for move in result["moves"])
    assert all(move["comparison"] == ("repairs-feasibility" if move["feasible"] else "infeasible") for move in result["moves"])
