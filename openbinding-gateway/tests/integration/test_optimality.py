import pytest
import requests
import json
import copy

# ============================================================================
# BASE INSTANCE - Schema compliant
# ============================================================================
BASE_INSTANCE = {
    "metadata": {"id": "test-optimality", "name": "Optimality Test", "version": "1.0", "created_at": "2026-01-01T00:00:00Z"},
    "tasks": [{"id": "T1", "name": "Task 1"}, {"id": "T2", "name": "Task 2"}],
    "providers": [{"id": "ProvA", "name": "Provider A"}, {"id": "ProvB", "name": "Provider B"}],
    "candidates": [
        {"id": "C1", "task_id": "T1", "provider_id": "ProvA", "features": {"cost": 10}},
        {"id": "C2", "task_id": "T1", "provider_id": "ProvB", "features": {"cost": 50}},
        {"id": "C3", "task_id": "T2", "provider_id": "ProvA", "features": {"cost": 10}},
        {"id": "C4", "task_id": "T2", "provider_id": "ProvB", "features": {"cost": 50}}
    ],
    "composition": {"type": "structured", "root": {
        "id": "seq1", "kind": "SEQ",
        "children": [{"id": "t1", "kind": "TASK", "task_id": "T1"}, {"id": "t2", "kind": "TASK", "task_id": "T2"}]
    }},
    "features": [{"id": "cost", "name": "Cost", "direction": "minimize", "scale": "ratio", "unit": "USD", "valid_range": {"min": 0, "max": 10000}}],
    "aggregation_policies": {"cost": {"neutral": 0, "normalize": {"type": "identity"}, "compose": {"seq": {"fn": "sum"}}}},
    "objective": {"type": "weighted_sum", "weights": {"cost": 1}, "normalized": True}
}

def create_instance(**overrides) -> dict:
    instance = copy.deepcopy(BASE_INSTANCE)
    for key, value in overrides.items():
        if key == "constraints" and value:
            # Add id field to each constraint if not present
            value = [{**c, "id": c.get("id", f"c{i}")} for i, c in enumerate(value)]
        instance[key] = value
    return instance

def run_test(gateway_url, wait_for_job, engine, instance, expected_selection, expected_objective, expect_feasible=True):
    """Run test helper."""
    res = requests.post(f"{gateway_url}/v1/solve", json={
        "engine_id": engine,
        "instance": instance,
        "verbose": True
    })
    assert res.status_code == 202
    job = wait_for_job(res.json()["job_id"])
    
    if expect_feasible and job["status"] == "failed":
         pytest.fail(f"Job failed: {job.get('error')}")

    result = job.get("result", {})
    solutions = result.get("solutions", [])
    
    if not solutions:
        feasible = False
        selection = {}
        obj = None
    else:
        sol = solutions[0]
        feasible = sol.get("is_feasible", False)
        selection = sol.get("binding", {})
        obj = sol.get("objective_value")
    
    assert feasible == expect_feasible
    
    if expect_feasible:
        if expected_selection:
            assert selection == expected_selection
        if expected_objective is not None:
            assert abs(obj - expected_objective) < 1e-4

# --- TESTS ---

def test_no_constraints(gateway_url, wait_for_job, engine):
    """Optimal: C1+C3 (10+10=20)"""
    instance = create_instance(constraints=[])
    run_test(gateway_url, wait_for_job, engine, instance, {"T1": "C1", "T2": "C3"}, 20)

def test_global_satisfied(gateway_url, wait_for_job, engine):
    """Global <= 30. Optimal: 20."""
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost", "op": "<=", "value": 30}
    ])
    run_test(gateway_url, wait_for_job, engine, instance, {"T1": "C1", "T2": "C3"}, 20)

def test_global_tight(gateway_url, wait_for_job, engine):
    """Global <= 20. Optimal: 20."""
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost", "op": "<=", "value": 20}
    ])
    run_test(gateway_url, wait_for_job, engine, instance, {"T1": "C1", "T2": "C3"}, 20)

def test_global_infeasible(gateway_url, wait_for_job, engine):
    """Global <= 15. Min is 20. Infeasible."""
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost", "op": "<=", "value": 15}
    ])
    run_test(gateway_url, wait_for_job, engine, instance, None, None, expect_feasible=False)

def test_local_constraints(gateway_url, wait_for_job, engine):
    """Local: T2.cost >= 40. Forces C4 (50). Total 60."""
    if engine == "random-search":
        pytest.skip("Random Search does not support local constraints")
        
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "local", "task_id": "T2", "attribute_id": "cost", "op": ">=", "value": 40}
    ])
    run_test(gateway_url, wait_for_job, engine, instance, {"T1": "C1", "T2": "C4"}, 60)

def test_dependency_same(gateway_url, wait_for_job, engine):
    """Dependency: same_provider. Opt: ProvA (20). ProvB is 100."""
    if engine == "random-search":
        pytest.skip("Random Search does not support dependency constraints")
        
    instance = create_instance(constraints=[
        {"kind": "dependency", "type": "same_provider", "tasks": ["T1", "T2"]}
    ])
    run_test(gateway_url, wait_for_job, engine, instance, {"T1": "C1", "T2": "C3"}, 20)

def test_xor_composition(gateway_url, wait_for_job, engine):
    """XOR(T1, T2) 70/30. Expected: 0.7*10 + 0.3*10 = 10."""
    instance = copy.deepcopy(BASE_INSTANCE)
    instance["composition"]["root"] = {
        "id": "xor1", "kind": "XOR", 
        "branches": [
            {"p": 0.7, "child": {"id": "b1", "kind": "TASK", "task_id": "T1"}},
            {"p": 0.3, "child": {"id": "b2", "kind": "TASK", "task_id": "T2"}}
        ]
    }
    instance["aggregation_policies"]["cost"]["compose"]["xor"] = {"fn": "weighted_sum", "expr": "sum(w * x)"}
    instance["constraints"] = []
    
    # With 70% T1 (cost 10) + 30% T2 (cost 10), expected = 10
    run_test(gateway_url, wait_for_job, engine, instance, {"T1": "C1", "T2": "C3"}, 10)

def test_loop_composition(gateway_url, wait_for_job, engine):
    """LOOP(T1, 3 iters). 3*10 = 30."""
    if engine == "minizinc-csp":
        pytest.skip("MiniZinc requires all tasks bound; LOOP test uses only T1 from 2-task instance")
    instance = copy.deepcopy(BASE_INSTANCE)
    instance["composition"]["root"] = {
        "id": "loop1", "kind": "LOOP", 
        "expected_iterations": 3,
        "body": {"id": "t1", "kind": "TASK", "task_id": "T1"}
    }
    instance["aggregation_policies"]["cost"]["compose"]["loop"] = {"fn": "sum"}
    instance["constraints"] = []
    
    run_test(gateway_url, wait_for_job, engine, instance, {"T1": "C1"}, 30)
