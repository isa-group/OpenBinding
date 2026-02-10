import pytest
import requests
import json

def create_loop_instance(constraint):
    """
    Creates a simple LOOP scenario where a task repeats 10 times.
    Useful for checking if global aggregations (sum, max, etc.) work as expected.
    """
    return {
        "metadata": {"id": "test-operators", "name": "Operators Test", "version": "1.0", "created_at": "2026-01-01T00:00:00Z"},
        "tasks": [{"id": "T1", "name": "T1"}],
        "providers": [
            {"id": "P1", "name": "Provider P1"},
            {"id": "P2", "name": "Provider P2"}
        ],
        "candidates": [
            {"id": "C1_1", "task_id": "T1", "provider_id": "P1", "name": "C1_1", "features": {"energy": 2.5}},
            {"id": "C1_2", "task_id": "T1", "provider_id": "P2", "name": "C1_2", "features": {"energy": 1}}
        ],
        "composition": {
            "type": "STRUCTURED",
            "root": {
                "id": "loop1", "kind": "LOOP",
                "expected_iterations": 10,
                "body": {"id": "t1", "kind": "TASK", "task_id": "T1"}
            }
        },
        "features": [{"id": "energy", "name": "Energy", "direction": "MINIMIZE", "unit": "J", "scale": "RATIO", "valid_range": {"min": 0, "max": 1000}}],
        "aggregation_policies": {
            "energy": {
                "neutral": 0,
                "compose": {
                    "loop": {"fn": "SUM"},
                    "seq": {"fn": "SUM"}
                }
            }
        },
        "objective": {
            "type": "SINGLE",
            "targets": ["energy"],
            "weights": {"energy": 1.0}
        },
        "constraints": [{**constraint, "id": "c0"}] if constraint else []
    }

@pytest.mark.parametrize("op,val,expected_feasible,expected_cand", [
    (">=", 10, True, "C1_2"), # Both valid (25>=10, 10>=10). Minimize -> C1_2 (10)
    ("<=", 10, True, "C1_2"), # Only C1_2 valid (10<=10). C1_1 (25) invalid.
    ("==", 10, True, "C1_2"),
    ("<", 20, True, "C1_2"),
    (">=", 30, False, None)   # Infeasible
])
def test_global_operators(gateway_url, wait_for_job, engine, op, val, expected_feasible, expected_cand):
    """Verifies that the engine correctly handles different operators (>=, <=, ==, etc) on global attributes."""
    
    constraint = {
        "kind": "ATTRIBUTE_BOUND", 
        "scope": "GLOBAL", 
        "attribute_id": "energy", 
        "op": op, 
        "value": val,
        "hard": True
    }
    
    instance = create_loop_instance(constraint)
    
    # Submit
    res = requests.post(f"{gateway_url}/v1/solve", json={
        "engine_id": engine,
        "instance": instance,
        "verbose": True
    })
    
    if res.status_code == 422:
        pytest.fail(f"Gateway rejected request: {res.text}")

    assert res.status_code in [200, 202]
    data = res.json()
    job_id = data["job_id"]
    
    # Wait
    if res.status_code == 200:
        job = data
    else:
        job = wait_for_job(job_id)
    assert job["status"] in ["completed", "failed"]
    
    result = job.get("result", {})
    solutions = result.get("solutions", [])
    
    if not solutions:
        feasible = False
        selection = {}
    else:
        sol = solutions[0]
        feasible = sol.get("is_feasible", False)
        selection = sol.get("binding", {})
    
    assert feasible == expected_feasible
    
    if expected_feasible and expected_cand:
        assert selection.get("T1") == expected_cand
        
@pytest.mark.parametrize("op,val,expected_feasible,expected_cand", [
    (">=", 2, True, "C1_1"), # C1_1(2.5)>=2, C1_2(1)<2. Minimize -> C1_1 is only choice
    ("<=", 2, True, "C1_2"), # C1_2(1)<=2
    (">", 1, True, "C1_1"),
    ("<", 2, True, "C1_2"),
    ("==", 1, True, "C1_2"),
    ("<", 1, False, None)
])
def test_local_operators(gateway_url, wait_for_job, engine, op, val, expected_feasible, expected_cand):
    """Verifies operators on local task constraints. Note: Random Search usually skips these."""
    
    if engine == "random-search":
        pytest.skip("Random Search does not support local constraints")

    constraint = {
        "kind": "ATTRIBUTE_BOUND", 
        "scope": "LOCAL", 
        "tasks": ["T1"],
        "attribute_id": "energy", 
        "op": op, 
        "value": val,
        "hard": True
    }
    
    instance = create_loop_instance(constraint)
    
    res = requests.post(f"{gateway_url}/v1/solve", json={
        "engine_id": engine,
        "instance": instance
    })
    
    if res.status_code == 422:
        pytest.fail(f"Gateway rejected request: {res.text}")

    assert res.status_code in [200, 202]
    data = res.json()
    job_id = data["job_id"]
    
    if res.status_code == 200:
        job = data
    else:
        job = wait_for_job(job_id)
    result = job.get("result", {})
    solutions = result.get("solutions", [])
    
    if not solutions:
        feasible = False
        selection = {}
    else:
        sol = solutions[0]
        feasible = sol.get("is_feasible", False)
        selection = sol.get("binding", {})
    
    assert feasible == expected_feasible
    if expected_feasible:
        assert selection.get("T1") == expected_cand
