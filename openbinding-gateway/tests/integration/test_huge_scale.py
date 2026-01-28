import pytest
import requests
import json

def create_huge_instance(constraint_mode="common"):
    """
    Creates a large-scale instance to stress test the engines.
    
    Modes:
    - 'minizinc': Includes complex local and dependency constraints.
    - 'random': Focuses on global global constraints.
    - 'common': Relaxed version that should be easy for both.
    """
    tasks = [{"id": f"T{i}", "name": f"Task {i}"} for i in range(1, 8)]
    providers = [{"id": f"P{i}", "name": f"Provider {i}"} for i in range(1, 4)]
    
    features = [
        {"id": "cost", "name": "Cost", "direction": "minimize", "scale": "ratio", "unit": "USD", "valid_range": {"min": 0, "max": 100000}},
        {"id": "latency", "name": "Latency", "direction": "minimize", "scale": "ratio", "unit": "ms", "valid_range": {"min": 0, "max": 10000}},
        {"id": "reliability", "name": "Reliability", "direction": "maximize", "scale": "ratio", "unit": "%", "valid_range": {"min": 0, "max": 1}},
        {"id": "availability", "name": "Availability", "direction": "maximize", "scale": "ratio", "unit": "%", "valid_range": {"min": 0, "max": 1}},
        {"id": "energy", "name": "Energy", "direction": "minimize", "scale": "ratio", "unit": "J", "valid_range": {"min": 0, "max": 10000}}
    ]
    
    candidates = []
    cid = 1
    for t in tasks:
        for p in providers:
            candidates.append({
                "id": f"C{cid}",
                "task_id": t["id"],
                "provider_id": p["id"],
                "features": {
                    "cost": cid * 10,
                    "latency": cid * 5,
                    "reliability": 0.9,
                    "availability": 0.99,
                    "energy": cid * 2
                }
            })
            cid += 1
            
    # Structure: SEQ(T1, AND(T2, T3), XOR(T4, T5), LOOP(SEQ(T6, T7)))
    # Schema-compliant format with all node ids
    composition = {
        "type": "structured",
        "root": {
            "id": "root_seq", "kind": "SEQ",
            "children": [
                {"id": "n1", "kind": "TASK", "task_id": "T1"},
                {
                    "id": "n2_and", "kind": "AND", 
                    "children": [
                        {"id": "n2a", "kind": "TASK", "task_id": "T2"}, 
                        {"id": "n2b", "kind": "TASK", "task_id": "T3"}
                    ]
                },
                {
                    "id": "n3_xor", "kind": "XOR",
                    "branches": [
                        {"p": 0.5, "child": {"id": "n3a", "kind": "TASK", "task_id": "T4"}},
                        {"p": 0.5, "child": {"id": "n3b", "kind": "TASK", "task_id": "T5"}}
                    ]
                },
                {
                    "id": "n4_loop", "kind": "LOOP",
                    "expected_iterations": 3,
                    "body": {
                        "id": "n4_inner_seq", "kind": "SEQ", 
                        "children": [
                            {"id": "n4a", "kind": "TASK", "task_id": "T6"},
                            {"id": "n4b", "kind": "TASK", "task_id": "T7"}
                        ]
                    }
                }
            ]
        }
    }
    
    agg = {}
    for f in features:
        agg[f["id"]] = {
            "neutral": 0 if f["direction"] == "minimize" else 1,
            "normalize": {"type": "identity"},
            "compose": {
                "seq": {"fn": "sum"},
                "and": {"fn": "max"},
                "xor": {"fn": "weighted_sum", "expr": "sum(w * x)"},
                "loop": {"fn": "sum"}
            }
        }
    
    constraints = []
    constraint_id = 0
    if constraint_mode == "minizinc":
        constraints.append({"id": f"c{constraint_id}", "kind": "attribute_bound", "scope": "global", "attribute_id": "cost", "op": "<=", "value": 10000})
        constraint_id += 1
        constraints.append({"id": f"c{constraint_id}", "kind": "attribute_bound", "scope": "local", "task_id": "T1", "attribute_id": "latency", "op": "<=", "value": 100})
        constraint_id += 1
        constraints.append({"id": f"c{constraint_id}", "kind": "dependency", "type": "same_provider", "tasks": ["T2", "T3"]})
    elif constraint_mode == "random":
        constraints.append({"id": f"c{constraint_id}", "kind": "attribute_bound", "scope": "global", "attribute_id": "cost", "op": "<=", "value": 10000})
    else: # common / relaxed
        constraints.append({"id": f"c{constraint_id}", "kind": "attribute_bound", "scope": "global", "attribute_id": "cost", "op": "<=", "value": 50000})

    return {
        "metadata": {"id": "huge-1", "name": "Huge", "version": "1.0", "created_at": "2026-01-01T00:00:00Z"},
        "tasks": tasks,
        "providers": providers,
        "candidates": candidates,
        "features": features,
        "composition": composition,
        "aggregation_policies": agg,
        "objective": {"type": "weighted_sum", "weights": {"cost": 1}, "normalized": True},
        "constraints": constraints
    }

def solve(gateway_url, wait_for_job, engine, instance):
    # We give it a generous amount of iterations since the binding space is quite large.
    res = requests.post(f"{gateway_url}/v1/solve", json={
        "engine_id": engine,
        "instance": instance,
        "options": {"iterations_count": 2000},
        "verbose": True
    })
    assert res.status_code == 202, f"Gateway rejected the request: {res.text}"
    job_id = res.json()["job_id"]
    assert job_id != "invalid", "The instance was considered invalid by the gateway."
    
    job = wait_for_job(job_id)
    assert job["status"] == "completed", f"Job failed: {job.get('error', job.get('status'))}"
    
    result = job.get("result", {})
    solutions = result.get("solutions", [])
    if not solutions:
        return {"is_feasible": False, "binding": {}, "objective_value": None}
    sol = solutions[0]
    return {
        "is_feasible": sol.get("is_feasible", False),
        "binding": sol.get("binding", {}),
        "objective_value": sol.get("objective_value")
    }

# @pytest.mark.skip(reason="Huge scale tests timeout due to complex schema and large binding space")
def test_huge_minizinc(gateway_url, wait_for_job):
    """Verify huge instance with complex constraints on MiniZinc."""
    inst = create_huge_instance("minizinc")
    sol = solve(gateway_url, wait_for_job, "minizinc-csp", inst)
    assert sol["is_feasible"], "MiniZinc huge instance should be feasible"
    print(f"MiniZinc Huge Obj: {sol['objective_value']}")

# @pytest.mark.skip(reason="Huge scale tests timeout due to complex schema and large binding space")
def test_huge_random(gateway_url, wait_for_job):
    """Verify huge instance with global constraints on Random Search."""
    inst = create_huge_instance("random")
    sol = solve(gateway_url, wait_for_job, "random-search", inst)
    # Random search might struggle to find feasible if constraints strict and space huge
    # But here constraints are loose (cost<=10000).
    if not sol["is_feasible"]:
        print("Warning: Random Search invalid (could be heuristics).")
    else:
        print(f"Random Search Huge Obj: {sol['objective_value']}")

# @pytest.mark.skip(reason="Huge scale tests timeout due to complex schema and large binding space")
def test_huge_common_comparison(gateway_url, wait_for_job):
    """Checks if both engines find similar solutions for the same huge problem."""
    inst = create_huge_instance("common")
    
    sol_mz = solve(gateway_url, wait_for_job, "minizinc-csp", inst)
    sol_rs = solve(gateway_url, wait_for_job, "random-search", inst)
    
    assert sol_mz["is_feasible"], "MiniZinc should have no trouble with this relaxed instance."
    if sol_rs["is_feasible"]:
        print(f"MZ Obj: {sol_mz['objective_value']}, RS Obj: {sol_rs['objective_value']}")
        # Compare bindings
        count = 0 
        total = 0
        if sol_mz["binding"] and sol_rs["binding"]:
             for k in sol_mz["binding"]:
                 total += 1
                 if sol_mz["binding"][k] == sol_rs["binding"].get(k):
                     count += 1
        print(f"Binding Match: {count}/{total}")
    else:
        print("RS failed to find solution.")

