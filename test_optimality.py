"""
MiniZinc Engine Constraint Optimality Tests

This script verifies that the MiniZinc engine correctly:
1. Transforms problem instances to DZN format
2. Applies constraints to restrict the solution space
3. Returns OPTIMAL bindings (not just feasible ones)

Each test specifies:
- Input instance with constraints
- Expected selection (exact bindings)
- Expected objective value
"""

import requests
import time
import json
import copy

BASE_URL = "http://localhost:3000"
from typing import Optional


def run_optimality_test(name: str, instance: dict, expected_selection: Optional[dict], 
                        expected_objective: Optional[float], expect_feasible: bool = True) -> bool:
    """
    Run a test that verifies the optimal binding selection.
    
    Args:
        name: Test name
        instance: Problem instance
        expected_selection: Expected task->candidate mapping (e.g., {"T1": "C1", "T2": "C3"})
        expected_objective: Expected objective value
        expect_feasible: Whether the problem should be feasible
    
    Returns:
        True if test passes, False otherwise
    """
    print(f"\n{'='*60}")
    print(f"TEST: {name}")
    print(f"{'='*60}")
    
    try:
        res = requests.post(f"{BASE_URL}/solve", json={"instance": instance})
        if res.status_code != 202:
            print(f"  ❌ Error starting job: {res.text}")
            return False
        
        job_id = res.json()["job_id"]
        
        # Poll for completion
        while True:
            status_res = requests.get(f"{BASE_URL}/jobs/{job_id}")
            job = status_res.json()
            status = job.get("status")
            
            if status == "completed":
                result = job.get("result", {})
                solution = result.get("solution", {})
                feasible = solution.get("feasible", False)
                selection = solution.get("selection", {})
                objective = solution.get("objective_value")
                
                print(f"  Feasible: {feasible}")
                print(f"  Selection: {selection}")
                print(f"  Objective: {objective}")
                
                # Check feasibility first
                if feasible != expect_feasible:
                    print(f"  ❌ FAIL: Expected feasible={expect_feasible}, got {feasible}")
                    if "violations" in result:
                        print(f"  Violations: {result['violations']}")
                    return False
                
                # If infeasible is expected, we're done
                if not expect_feasible:
                    print(f"  ✅ PASS (Correctly infeasible)")
                    return True
                
                # Check exact selection
                if expected_selection is not None:
                    if selection != expected_selection:
                        print(f"  ❌ FAIL: Expected selection={expected_selection}")
                        print(f"           Got selection={selection}")
                        return False
                
                # Check objective value
                if expected_objective is not None:
                    if abs(objective - expected_objective) > 1e-6:
                        print(f"  ❌ FAIL: Expected objective={expected_objective}, got {objective}")
                        return False
                
                print(f"  ✅ PASS")
                return True
                
            elif status == "failed":
                print(f"  ❌ Job Failed: {job.get('error')}")
                return False
            
            time.sleep(0.3)
            
    except Exception as e:
        print(f"  ❌ Exception: {e}")
        return False


# ============================================================================
# BASE INSTANCE
# ============================================================================
# Two tasks (T1, T2) with 2 candidates each from 2 providers
# Candidates:
#   C1: T1, ProvA, cost=10
#   C2: T1, ProvB, cost=50
#   C3: T2, ProvA, cost=10
#   C4: T2, ProvB, cost=50
#
# Composition: SEQ(T1, T2) => costs are SUMMED
# Objective: minimize weighted_sum(cost) with weight=1

BASE_INSTANCE = {
    "tasks": [
        {"id": "T1"},
        {"id": "T2"}
    ],
    "providers": [
        {"id": "ProvA"},
        {"id": "ProvB"}
    ],
    "candidates": [
        {"id": "C1", "task_id": "T1", "provider_id": "ProvA", "qos": {"cost": 10}},
        {"id": "C2", "task_id": "T1", "provider_id": "ProvB", "qos": {"cost": 50}},
        {"id": "C3", "task_id": "T2", "provider_id": "ProvA", "qos": {"cost": 10}},
        {"id": "C4", "task_id": "T2", "provider_id": "ProvB", "qos": {"cost": 50}}
    ],
    "composition": {
        "root": {
            "kind": "SEQ",
            "children": [
                {"kind": "TASK", "task_id": "T1"},
                {"kind": "TASK", "task_id": "T2"}
            ]
        }
    },
    "features": [{"id": "cost"}],
    "aggregation_policies": {
        "cost": {"compose": {"seq": {"fn": "sum"}}}
    },
    "objective": {
        "type": "weighted_sum",
        "weights": {"cost": 1}
    }
}


def create_instance(**overrides) -> dict:
    """Create a copy of BASE_INSTANCE with overrides."""
    instance = copy.deepcopy(BASE_INSTANCE)
    for key, value in overrides.items():
        instance[key] = value
    return instance


# ============================================================================
# TEST CASES
# ============================================================================

def test_01_no_constraints():
    """
    No constraints, pure optimization.
    Optimal: C1+C3 (both from ProvA, cheapest) = 10+10 = 20
    """
    instance = create_instance(constraints=[])
    return run_optimality_test(
        name="01. No Constraints - Pure Optimization",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


def test_02_global_cost_constraint_satisfied():
    """
    Global constraint: cost <= 30
    Optimal within constraint: C1+C3 = 20 (satisfies <= 30)
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost", 
         "op": "<=", "value": 30}
    ])
    return run_optimality_test(
        name="02. Global Constraint cost<=30 (Satisfied)",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


def test_03_global_cost_constraint_tight():
    """
    Global constraint: cost <= 20
    Only solution: C1+C3 = 20 (exactly at limit)
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost", 
         "op": "<=", "value": 20}
    ])
    return run_optimality_test(
        name="03. Global Constraint cost<=20 (Tight)",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


def test_04_global_cost_constraint_infeasible():
    """
    Global constraint: cost <= 15
    Minimum possible is 20, so INFEASIBLE
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost", 
         "op": "<=", "value": 15}
    ])
    return run_optimality_test(
        name="04. Global Constraint cost<=15 (Infeasible)",
        instance=instance,
        expected_selection=None,
        expected_objective=None,
        expect_feasible=False
    )


def test_05_local_constraint_forces_expensive():
    """
    Local constraint: T2.cost >= 40
    Forces C4 (cost=50) for T2
    Optimal: C1 (10) + C4 (50) = 60
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "local", "task_id": "T2",
         "attribute_id": "cost", "op": ">=", "value": 40}
    ])
    return run_optimality_test(
        name="05. Local Constraint T2.cost>=40 (Forces C4)",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C4"},
        expected_objective=60
    )


def test_06_local_constraint_on_t1():
    """
    Local constraint: T1.cost >= 40
    Forces C2 (cost=50) for T1
    Optimal: C2 (50) + C3 (10) = 60
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "local", "task_id": "T1",
         "attribute_id": "cost", "op": ">=", "value": 40}
    ])
    return run_optimality_test(
        name="06. Local Constraint T1.cost>=40 (Forces C2)",
        instance=instance,
        expected_selection={"T1": "C2", "T2": "C3"},
        expected_objective=60
    )


def test_07_dep_same_provider():
    """
    Dependency: same_provider for T1, T2
    Options: (C1+C3)=ProvA=20, (C2+C4)=ProvB=100
    Optimal: C1+C3 = 20
    """
    instance = create_instance(constraints=[
        {"kind": "dependency", "type": "same_provider", "tasks": ["T1", "T2"]}
    ])
    return run_optimality_test(
        name="07. Dependency Same Provider",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


def test_08_dep_different_provider():
    """
    Dependency: different_provider for T1, T2
    Options: (C1+C4)=60, (C2+C3)=60
    Both are optimal at 60. Either is acceptable.
    """
    instance = create_instance(constraints=[
        {"kind": "dependency", "type": "different_provider", "tasks": ["T1", "T2"]}
    ])
    # Either C1+C4 or C2+C3 is valid
    return run_optimality_test(
        name="08. Dependency Different Provider",
        instance=instance,
        expected_selection=None,  # Don't check exact selection, multiple optima
        expected_objective=60
    )


def test_09_dep_different_with_local():
    """
    Dependency: different_provider + Local: T1.cost >= 40
    Forces C2 for T1 (ProvB). Different provider means T2 must use ProvA -> C3
    Optimal: C2 (50) + C3 (10) = 60
    """
    instance = create_instance(constraints=[
        {"kind": "dependency", "type": "different_provider", "tasks": ["T1", "T2"]},
        {"kind": "attribute_bound", "scope": "local", "task_id": "T1",
         "attribute_id": "cost", "op": ">=", "value": 40}
    ])
    return run_optimality_test(
        name="09. Diff Provider + Local T1>=40 (Forces C2+C3)",
        instance=instance,
        expected_selection={"T1": "C2", "T2": "C3"},
        expected_objective=60
    )


def test_10_soft_constraint_ignored():
    """
    Soft constraint (hard=False): cost <= 15
    Should be IGNORED. Optimal: C1+C3 = 20
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
         "op": "<=", "value": 15, "hard": False}
    ])
    return run_optimality_test(
        name="10. Soft Constraint Ignored",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


def test_11_multiple_constraints_combo():
    """
    Global: cost <= 100
    Local T1: cost <= 30 (allows C1 only)
    Local T2: cost >= 5 (allows both)
    Optimal: C1 (10) + C3 (10) = 20
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
         "op": "<=", "value": 100},
        {"kind": "attribute_bound", "scope": "local", "task_id": "T1",
         "attribute_id": "cost", "op": "<=", "value": 30},
        {"kind": "attribute_bound", "scope": "local", "task_id": "T2",
         "attribute_id": "cost", "op": ">=", "value": 5}
    ])
    return run_optimality_test(
        name="11. Multiple Constraints Combo",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


def test_12_global_eq_exact():
    """
    Global: cost == 20
    Only possible: C1+C3 = 20
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
         "op": "==", "value": 20}
    ])
    return run_optimality_test(
        name="12. Global Constraint cost==20 (Exact)",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


def test_13_global_ge_forces_expensive():
    """
    Global: cost >= 100
    Forces expensive: C2 (50) + C4 (50) = 100
    """
    instance = create_instance(constraints=[
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
         "op": ">=", "value": 100}
    ])
    return run_optimality_test(
        name="13. Global cost>=100 (Forces C2+C4)",
        instance=instance,
        expected_selection={"T1": "C2", "T2": "C4"},
        expected_objective=100
    )


def test_14_same_provider_with_global():
    """
    Same provider constraint + Global constraint.
    Same provider: forces (C1+C3) or (C2+C4)
    Global: cost <= 50
    Only C1+C3 = 20 satisfies both.
    """
    instance = create_instance(constraints=[
        {"kind": "dependency", "type": "same_provider", "tasks": ["T1", "T2"]},
        {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
         "op": "<=", "value": 50}
    ])
    return run_optimality_test(
        name="14. Same Provider + Global cost<=50",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=20
    )


# ============================================================================
# XOR COMPOSITION TESTS
# ============================================================================

def test_15_xor_no_constraint():
    """
    XOR composition: XOR(T1, T2) with 70/30 probability split
    Candidates: C1(T1,cost=10), C2(T1,cost=50), C3(T2,cost=20), C4(T2,cost=100)
    Aggregation: XOR uses weighted_sum (expected cost)
    Expected cost: 0.7*C1_cost + 0.3*C3_cost = 0.7*10 + 0.3*20 = 7 + 6 = 13
    Optimal: C1 for T1, C3 for T2 (cheapest per branch)
    """
    instance = {
        "tasks": [{"id": "T1"}, {"id": "T2"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 50}},
            {"id": "C3", "task_id": "T2", "provider_id": "P1", "qos": {"cost": 20}},
            {"id": "C4", "task_id": "T2", "provider_id": "P2", "qos": {"cost": 100}},
        ],
        "composition": {
            "root": {
                "kind": "XOR",
                "children": [
                    {"kind": "TASK", "task_id": "T1", "probability": 0.7},
                    {"kind": "TASK", "task_id": "T2", "probability": 0.3}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"xor": {"fn": "weighted_sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": []
    }
    return run_optimality_test(
        name="15. XOR No Constraint",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=13  # 0.7*10 + 0.3*20
    )


def test_16_xor_with_local_constraint():
    """
    XOR(T1, T2) with local constraint: T1.cost >= 40
    Forces C2 (cost=50) for T1
    Expected cost: 0.7*50 + 0.3*20 = 35 + 6 = 41
    """
    instance = {
        "tasks": [{"id": "T1"}, {"id": "T2"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 50}},
            {"id": "C3", "task_id": "T2", "provider_id": "P1", "qos": {"cost": 20}},
            {"id": "C4", "task_id": "T2", "provider_id": "P2", "qos": {"cost": 100}},
        ],
        "composition": {
            "root": {
                "kind": "XOR",
                "children": [
                    {"kind": "TASK", "task_id": "T1", "probability": 0.7},
                    {"kind": "TASK", "task_id": "T2", "probability": 0.3}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"xor": {"fn": "weighted_sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": [
            {"kind": "attribute_bound", "scope": "local", "task_id": "T1",
             "attribute_id": "cost", "op": ">=", "value": 40}
        ]
    }
    return run_optimality_test(
        name="16. XOR with Local Constraint",
        instance=instance,
        expected_selection={"T1": "C2", "T2": "C3"},
        expected_objective=41  # 0.7*50 + 0.3*20
    )


def test_17_xor_with_global_constraint():
    """
    XOR(T1, T2) with global constraint: cost <= 20
    Expected costs: (C1,C3)=13, (C1,C4)=0.7*10+0.3*100=37, (C2,C3)=41, (C2,C4)=65
    Only (C1,C3)=13 satisfies <= 20
    """
    instance = {
        "tasks": [{"id": "T1"}, {"id": "T2"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 50}},
            {"id": "C3", "task_id": "T2", "provider_id": "P1", "qos": {"cost": 20}},
            {"id": "C4", "task_id": "T2", "provider_id": "P2", "qos": {"cost": 100}},
        ],
        "composition": {
            "root": {
                "kind": "XOR",
                "children": [
                    {"kind": "TASK", "task_id": "T1", "probability": 0.7},
                    {"kind": "TASK", "task_id": "T2", "probability": 0.3}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"xor": {"fn": "weighted_sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": [
            {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
             "op": "<=", "value": 20}
        ]
    }
    return run_optimality_test(
        name="17. XOR with Global Constraint",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=13
    )


# ============================================================================
# LOOP COMPOSITION TESTS
# ============================================================================

def test_18_loop_no_constraint():
    """
    LOOP(T1) with 3 expected iterations
    C1: cost=10, C2: cost=50
    With SUM aggregation for loops: cost = iterations * candidate_cost
    Optimal: C1 -> 3 * 10 = 30
    """
    instance = {
        "tasks": [{"id": "T1"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 50}},
        ],
        "composition": {
            "root": {
                "kind": "LOOP",
                "iterations": 3,
                "children": [
                    {"kind": "TASK", "task_id": "T1"}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"loop": {"fn": "sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": []
    }
    return run_optimality_test(
        name="18. LOOP No Constraint (3 iterations)",
        instance=instance,
        expected_selection={"T1": "C1"},
        expected_objective=30  # 3 * 10
    )


def test_19_loop_with_global_constraint():
    """
    LOOP(T1) with 3 iterations
    Global constraint: cost <= 100
    C1: 3*10=30, C2: 3*50=150
    Only C1 satisfies <= 100
    """
    instance = {
        "tasks": [{"id": "T1"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 50}},
        ],
        "composition": {
            "root": {
                "kind": "LOOP",
                "iterations": 3,
                "children": [
                    {"kind": "TASK", "task_id": "T1"}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"loop": {"fn": "sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": [
            {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
             "op": "<=", "value": 100}
        ]
    }
    return run_optimality_test(
        name="19. LOOP with Global Constraint",
        instance=instance,
        expected_selection={"T1": "C1"},
        expected_objective=30
    )


def test_20_loop_with_local_constraint():
    """
    LOOP(T1) with 3 iterations
    Local constraint: T1.cost >= 40 (forces C2)
    Only C2 satisfies >= 40
    Expected: 3 * 50 = 150
    """
    instance = {
        "tasks": [{"id": "T1"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 50}},
        ],
        "composition": {
            "root": {
                "kind": "LOOP",
                "iterations": 3,
                "children": [
                    {"kind": "TASK", "task_id": "T1"}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"loop": {"fn": "sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": [
            {"kind": "attribute_bound", "scope": "local", "task_id": "T1",
             "attribute_id": "cost", "op": ">=", "value": 40}
        ]
    }
    return run_optimality_test(
        name="20. LOOP with Local Constraint",
        instance=instance,
        expected_selection={"T1": "C2"},
        expected_objective=150  # 3 * 50
    )


# ============================================================================
# MIXED COMPOSITION TESTS
# ============================================================================

def test_21_seq_with_loop():
    """
    SEQ(T1, LOOP(T2, 2 iterations))
    C1(T1)=10, C2(T1)=30, C3(T2)=20, C4(T2)=60
    Optimal: C1 + 2*C3 = 10 + 40 = 50
    """
    instance = {
        "tasks": [{"id": "T1"}, {"id": "T2"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 30}},
            {"id": "C3", "task_id": "T2", "provider_id": "P1", "qos": {"cost": 20}},
            {"id": "C4", "task_id": "T2", "provider_id": "P2", "qos": {"cost": 60}},
        ],
        "composition": {
            "root": {
                "kind": "SEQ",
                "children": [
                    {"kind": "TASK", "task_id": "T1"},
                    {"kind": "LOOP", "iterations": 2, "children": [
                        {"kind": "TASK", "task_id": "T2"}
                    ]}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"seq": {"fn": "sum"}, "loop": {"fn": "sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": []
    }
    return run_optimality_test(
        name="21. SEQ with LOOP",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=50  # 10 + 2*20
    )


def test_22_seq_loop_with_constraint():
    """
    SEQ(T1, LOOP(T2, 2 iterations))
    Global constraint: cost <= 60
    Options: (C1,C3)=50, (C1,C4)=130, (C2,C3)=70, (C2,C4)=150
    Only (C1,C3)=50 satisfies <= 60
    """
    instance = {
        "tasks": [{"id": "T1"}, {"id": "T2"}],
        "providers": [{"id": "P1"}, {"id": "P2"}],
        "candidates": [
            {"id": "C1", "task_id": "T1", "provider_id": "P1", "qos": {"cost": 10}},
            {"id": "C2", "task_id": "T1", "provider_id": "P2", "qos": {"cost": 30}},
            {"id": "C3", "task_id": "T2", "provider_id": "P1", "qos": {"cost": 20}},
            {"id": "C4", "task_id": "T2", "provider_id": "P2", "qos": {"cost": 60}},
        ],
        "composition": {
            "root": {
                "kind": "SEQ",
                "children": [
                    {"kind": "TASK", "task_id": "T1"},
                    {"kind": "LOOP", "iterations": 2, "children": [
                        {"kind": "TASK", "task_id": "T2"}
                    ]}
                ]
            }
        },
        "features": [{"id": "cost"}],
        "aggregation_policies": {
            "cost": {"compose": {"seq": {"fn": "sum"}, "loop": {"fn": "sum"}}}
        },
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}},
        "constraints": [
            {"kind": "attribute_bound", "scope": "global", "attribute_id": "cost",
             "op": "<=", "value": 60}
        ]
    }
    return run_optimality_test(
        name="22. SEQ+LOOP with Global Constraint",
        instance=instance,
        expected_selection={"T1": "C1", "T2": "C3"},
        expected_objective=50
    )


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    tests = [
        test_01_no_constraints,
        test_02_global_cost_constraint_satisfied,
        test_03_global_cost_constraint_tight,
        test_04_global_cost_constraint_infeasible,
        test_05_local_constraint_forces_expensive,
        test_06_local_constraint_on_t1,
        test_07_dep_same_provider,
        test_08_dep_different_provider,
        test_09_dep_different_with_local,
        test_10_soft_constraint_ignored,
        test_11_multiple_constraints_combo,
        test_12_global_eq_exact,
        test_13_global_ge_forces_expensive,
        test_14_same_provider_with_global,
        # XOR tests
        test_15_xor_no_constraint,
        test_16_xor_with_local_constraint,
        test_17_xor_with_global_constraint,
        # LOOP tests
        test_18_loop_no_constraint,
        test_19_loop_with_global_constraint,
        test_20_loop_with_local_constraint,
        # Mixed composition tests
        test_21_seq_with_loop,
        test_22_seq_loop_with_constraint,
    ]
    
    results = []
    for test_fn in tests:
        result = test_fn()
        results.append((test_fn.__name__, result))
    
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    
    passed = sum(1 for _, r in results if r)
    failed = sum(1 for _, r in results if not r)
    
    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"  {status}: {name}")
    
    print(f"\n  Total: {passed}/{len(results)} passed")
    
    if failed > 0:
        print("\n  ⚠️  SOME TESTS FAILED")
        exit(1)
    else:
        print("\n  🎉 ALL TESTS PASSED")
        exit(0)
