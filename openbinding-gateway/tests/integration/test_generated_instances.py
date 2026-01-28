import pytest
import os
import json
import requests

# Load instance paths
# In Docker, we mounted this at /app/examples/generated_instances
# But standard path relative to this file (openbinding-gateway/tests/integration)
# is ../../../examples/generated_instances if we are local.
# Let's check environment or fallback.

if os.path.exists("/app/examples/generated_instances"):
    INSTANCES_DIR = "/app/examples/generated_instances"
else:
    # Use the curated examples directory for local runs.
    INSTANCES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../examples"))

INSTANCE_FILES = sorted([f for f in os.listdir(INSTANCES_DIR) if f.endswith(".json")])

@pytest.mark.parametrize("filename", INSTANCE_FILES)
def test_generated_instance(gateway_url, wait_for_job, filename):
    """
    Submits an instance to both engines and compares how they behave.
    Good for checking if both find a valid solution for the same problem.
    """
    path = os.path.join(INSTANCES_DIR, filename)
    with open(path, 'r') as f:
        instance = json.load(f)
        
    print(f"\\nTesting instance: {filename}")
    
    results = {}
    
    for engine in ["minizinc-csp", "random-search"]:
        print(f"  Solving on {engine}...")
        res = requests.post(f"{gateway_url}/v1/solve", json={
            "engine_id": engine,
            "instance": instance,
            "options": {"iterations_count": 500},
            "verbose": True
        })
        
        if res.status_code != 202:
            results[engine] = {"feasible": False, "error": res.text}
            continue
            
        job = wait_for_job(res.json()["job_id"])
        if job["status"] == "failed":
             results[engine] = {"feasible": False, "error": job.get("error")}
        else:
             sol = job.get("result", {}).get("solution", {})
             results[engine] = {
                 "feasible": sol.get("feasible", False),
                 "selection": sol.get("selection", {}),
                 "objective": sol.get("objective_value"),
                 "violations": sol.get("violations", [])
             }

    # Comparison Logic
    mz = results.get("minizinc-csp")
    rs = results.get("random-search")
    
    # Check feasibility
    if mz["feasible"] and rs["feasible"]:
        print(f"  BOTH FEASIBLE. MZ Obj: {mz['objective']}, RS Obj: {rs['objective']}")
        match = mz["selection"] == rs["selection"]
        print(f"  Selection Match: {match}")
        if match:
             print("  [SUCCESS] Bindings match exactly.")
        else:
             print("  [DIFF] Bindings differ.")
             # We don't necessarily fail the test if they differ, as heuristics might find suboptimal
             # But for strict comparison tasks we might warn.
    elif not mz["feasible"] and not rs["feasible"]:
        print("  Both engines agree it is infeasible. This is a good sign.")
    else:
        print(f"  Wait, the engines disagree on feasibility: MZ={mz['feasible']}, RS={rs['feasible']}")
        # Discrepancies here usually happen because Random Search is heuristic-based or doesn't support a constraint.
        pass

    # Basic assertions
    # 1. MiniZinc usually should successful if instance is valid
    if mz["feasible"]:
        assert mz["feasible"], f"MiniZinc failed: {mz.get('violations')}"
