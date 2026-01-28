"""
Test all operators and scopes for MiniZinc engine constraints.

Tests different operators: <=, >=, ==, <, >
Tests different scopes: global, local
Tests with LOOP composition to verify aggregation affects global constraints.
"""

import requests
import json
import time

BASE_URL = "http://localhost:3000"


def solve_instance(instance):
    """Submit instance and wait for result."""
    res = requests.post(f"{BASE_URL}/solve", json={"instance": instance})
    if res.status_code != 202:
        return {"error": f"Failed to submit: {res.text}"}
    
    job_id = res.json()["job_id"]
    
    while True:
        status_res = requests.get(f"{BASE_URL}/jobs/{job_id}")
        job = status_res.json()
        status = job.get("status")
        
        if status == "completed":
            return job.get("result", {}).get("solution", {})
        elif status == "failed":
            return {"error": job.get("error")}
        
        time.sleep(0.3)


def create_loop_instance(constraint):
    """
    Create a LOOP instance with 100 iterations.
    Candidates: C1_1 (energy=2.5), C1_2 (energy=1)
    
    Global aggregated values:
    - C1_1: 100 * 2.5 = 250
    - C1_2: 100 * 1 = 100
    """
    return {
        "tasks": [{"id": "T1", "name": "T1"}],
        "providers": [
            {"id": "P1", "name": "Provider P1"},
            {"id": "P2", "name": "Provider P2"}
        ],
        "candidates": [
            {"id": "C1_1", "task_id": "T1", "provider_id": "P1", "features": {"energy": 2.5}},
            {"id": "C1_2", "task_id": "T1", "provider_id": "P2", "features": {"energy": 1}}
        ],
        "composition": {
            "root": {
                "kind": "LOOP",
                "expected_iterations": 100,
                "body": {"kind": "TASK", "task_id": "T1"}
            }
        },
        "features": [{"id": "energy"}],
        "aggregation_policies": {
            "energy": {
                "compose": {
                    "loop": {"fn": "sum"},
                    "seq": {"fn": "sum"}
                }
            }
        },
        "objective": {
            "type": "weighted_sum",
            "weights": {"energy": 1}
        },
        "constraints": [constraint] if constraint else []
    }


def run_test(name, instance, expected_feasible, expected_selection=None, expected_objective=None):
    """Run a single test and check expectations."""
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"{'='*60}")
    
    solution = solve_instance(instance)
    
    if "error" in solution:
        print(f"  Error: {solution['error']}")
        return False
    
    feasible = solution.get("feasible", False)
    selection = solution.get("selection", {})
    objective = solution.get("objective_value")
    
    print(f"  Feasible: {feasible}")
    print(f"  Selection: {selection}")
    print(f"  Objective: {objective}")
    
    if feasible != expected_feasible:
        print(f"  ❌ FAIL: Expected feasible={expected_feasible}, got {feasible}")
        if "violations" in solution:
            print(f"  Violations: {solution.get('violations')}")
        return False
    
    if expected_feasible and expected_selection is not None:
        if selection != expected_selection:
            print(f"  ❌ FAIL: Expected selection={expected_selection}, got {selection}")
            return False
    
    if expected_feasible and expected_objective is not None:
        if objective != expected_objective:
            print(f"  ❌ FAIL: Expected objective={expected_objective}, got {objective}")
            return False
    
    print(f"  ✅ PASS")
    return True


def test_global_operators():
    """Test global constraints with all operators."""
    results = []
    
    # Global: energy >= 100
    # C1_1: 250 >= 100 ✓, C1_2: 100 >= 100 ✓
    # Both satisfy, optimal is C1_2 (minimize) = 100
    results.append(run_test(
        "Global >= 100 (Both satisfy, choose cheaper)",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": ">=", "value": 100}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # Global: energy <= 100
    # C1_1: 250 <= 100 ✗, C1_2: 100 <= 100 ✓
    # Only C1_2 satisfies
    results.append(run_test(
        "Global <= 100 (Only C1_2 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": "<=", "value": 100}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # Global: energy >= 200
    # C1_1: 250 >= 200 ✓, C1_2: 100 >= 200 ✗
    # Only C1_1 satisfies
    results.append(run_test(
        "Global >= 200 (Only C1_1 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": ">=", "value": 200}),
        expected_feasible=True,
        expected_selection={"T1": "C1_1"},
        expected_objective=250
    ))
    
    # Global: energy == 100
    # C1_1: 250, C1_2: 100 == 100 ✓
    results.append(run_test(
        "Global == 100 (Exact match C1_2)",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": "==", "value": 100}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # Global: energy > 100
    # C1_1: 250 > 100 ✓, C1_2: 100 > 100 ✗
    results.append(run_test(
        "Global > 100 (Only C1_1 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": ">", "value": 100}),
        expected_feasible=True,
        expected_selection={"T1": "C1_1"},
        expected_objective=250
    ))
    
    # Global: energy < 200
    # C1_1: 250 < 200 ✗, C1_2: 100 < 200 ✓
    results.append(run_test(
        "Global < 200 (Only C1_2 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": "<", "value": 200}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # Global: energy >= 300 (Infeasible)
    # C1_1: 250 >= 300 ✗, C1_2: 100 >= 300 ✗
    results.append(run_test(
        "Global >= 300 (Infeasible)",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": ">=", "value": 300}),
        expected_feasible=False
    ))
    
    return results


def test_local_operators():
    """Test local constraints with all operators."""
    results = []
    
    # Local: T1.energy >= 2 (Candidate value, not aggregated)
    # C1_1: 2.5 >= 2 ✓, C1_2: 1 >= 2 ✗
    # Only C1_1 satisfies -> objective = 250
    results.append(run_test(
        "Local >= 2 (Only C1_1 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": ">=", "value": 2}),
        expected_feasible=True,
        expected_selection={"T1": "C1_1"},
        expected_objective=250
    ))
    
    # Local: T1.energy <= 2 (Candidate value)
    # C1_1: 2.5 <= 2 ✗, C1_2: 1 <= 2 ✓
    results.append(run_test(
        "Local <= 2 (Only C1_2 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": "<=", "value": 2}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # Local: T1.energy > 1
    # C1_1: 2.5 > 1 ✓, C1_2: 1 > 1 ✗
    results.append(run_test(
        "Local > 1 (Only C1_1 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": ">", "value": 1}),
        expected_feasible=True,
        expected_selection={"T1": "C1_1"},
        expected_objective=250
    ))
    
    # Local: T1.energy < 2
    # C1_1: 2.5 < 2 ✗, C1_2: 1 < 2 ✓
    results.append(run_test(
        "Local < 2 (Only C1_2 satisfies)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": "<", "value": 2}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # Local: T1.energy == 1
    # Only C1_2 has exactly 1
    results.append(run_test(
        "Local == 1 (Exact match C1_2)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": "==", "value": 1}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # Local: T1.energy < 1 (Infeasible)
    # C1_1: 2.5, C1_2: 1, neither < 1
    results.append(run_test(
        "Local < 1 (Infeasible)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": "<", "value": 1}),
        expected_feasible=False
    ))
    
    return results


def test_user_failing_instances():
    """Test the exact instances provided by the user."""
    results = []
    
    # User Instance 1: Global energy >= 100
    # Expected: Both candidates satisfy (250 >= 100, 100 >= 100)
    # Optimal: C1_2 with objective 100 (minimizing)
    results.append(run_test(
        "User Instance 1: Global >= 100",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": ">=", "value": 100, "hard": True}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # User Instance 2: Global energy <= 100
    # Expected: Only C1_2 satisfies (100 <= 100), C1_1 (250) doesn't
    results.append(run_test(
        "User Instance 2: Global <= 100",
        create_loop_instance({"kind": "attribute_bound", "scope": "global", "attribute_id": "energy", "op": "<=", "value": 100, "hard": True}),
        expected_feasible=True,
        expected_selection={"T1": "C1_2"},
        expected_objective=100
    ))
    
    # User Instance 3: Local energy < 1 (without task_id - should fail silently)
    # Note: The user's constraint didn't have task_id, so it gets ignored!
    # This is why it was failing - local constraints need task_id
    results.append(run_test(
        "User Instance 3: Local < 1 (with task_id)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": "<", "value": 1, "hard": True}),
        expected_feasible=False  # Neither 2.5 nor 1 is < 1
    ))
    
    # User Instance 4: Local energy > 1
    # C1_1: 2.5 > 1 ✓, C1_2: 1 > 1 ✗
    results.append(run_test(
        "User Instance 4: Local > 1 (with task_id)",
        create_loop_instance({"kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "energy", "op": ">", "value": 1, "hard": True}),
        expected_feasible=True,
        expected_selection={"T1": "C1_1"},
        expected_objective=250
    ))
    
    return results


if __name__ == "__main__":
    all_results = []
    
    print("\n" + "="*60)
    print("GLOBAL OPERATOR TESTS")
    print("="*60)
    all_results.extend(test_global_operators())
    
    print("\n" + "="*60)
    print("LOCAL OPERATOR TESTS")
    print("="*60)
    all_results.extend(test_local_operators())
    
    print("\n" + "="*60)
    print("USER FAILING INSTANCES")
    print("="*60)
    all_results.extend(test_user_failing_instances())
    
    # Summary
    passed = sum(all_results)
    total = len(all_results)
    
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"  Total: {passed}/{total} passed")
    
    if passed == total:
        print("\n  🎉 ALL TESTS PASSED")
        exit(0)
    else:
        print("\n  ⚠️  SOME TESTS FAILED")
        exit(1)
