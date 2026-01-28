import os
import json
import time
import requests
import sys

GATEWAY_URL = "http://127.0.0.1:8000"

def get_engines():
    try:
        r = requests.get(f"{GATEWAY_URL}/v1/engines")
        r.raise_for_status()
        return [e["id"] for e in r.json()]
    except Exception as e:
        print(f"Error fetching engines: {e}")
        return []

def solve_instance(engine_id, filename, instance):
    print(f"  > Solving on {engine_id}...", end=" ", flush=True)
    
    payload = {
        "engine_id": engine_id,
        "instance": instance,
        "options": {"iterations_count": 100}, # random-search option just in case
        "verbose": True
    }

    try:
        # Submit
        r = requests.post(f"{GATEWAY_URL}/v1/solve", json=payload)
        
        if r.status_code != 202:
            try:
                err = r.json()
                print(f"[ERROR] HTTP {r.status_code}: {err.get('error', r.text)}")
            except:
                print(f"[ERROR] HTTP {r.status_code}: {r.text}")
            return False

        job = r.json()
        job_id = job["job_id"]
        status = job["status"]
        
        # Poll if needed
        while status in ["queued", "running"]:
            time.sleep(0.5)
            r = requests.get(f"{GATEWAY_URL}/v1/jobs/{job_id}")
            if r.status_code != 200:
                print(f"[ERROR] Polling failed: {r.status_code}")
                return False
            job = r.json()
            status = job["status"]

        if status == "failed":
            error_msg = job.get('error', 'Unknown error')
            print(f"[FAILED] {error_msg}")
            # Try to print more detail if available? 
            # Usually error is in 'error' field.
            return False
            
        elif status == "completed":
            res = job.get("result", {})
            solutions = res.get("solutions", [])
            if not solutions:
                 print(f"[FAILED] No solutions returned (Infeasible?)")
                 print(json.dumps(res, indent=2))
                 return False
            
            sol = solutions[0]
            if sol.get("is_feasible"):
                obj = sol.get("objective_value")
                bs = res.get("diagnostics", {}).get("binding_space", {}).get("cardinality")
                print(f"[OK] Feasible. Obj: {obj}. Binding space: {bs}")
                print(json.dumps(sol, indent=2))
                return True
            else:
                 print(f"[FAILED] Infeasible.")
                 violations = sol.get("violations", [])
                 if violations:
                     print(f"    Violations: {len(violations)}")
                     for v in violations[:3]:
                         print(f"      - {v.get('message', v)}")
                 return False

    except Exception as e:
        print(f"[EXCEPTION] {e}")
        return False

def main():
    # 1. Discover Engines
    engines = get_engines()
    print(f"Available Engines: {engines}")
    
    targets = ["minizinc-csp", "random-search"]
    # Check if present
    for t in targets:
        if t not in engines:
            print(f"WARNING: Targeted engine '{t}' not found in gateway registry.")
    
    # 2. Load Instances
    instances_dir = os.path.join(os.getcwd(), "examples/generated_instances")
    if not os.path.exists(instances_dir):
        print(f"Directory not found: {instances_dir}")
        sys.exit(1)
        
    files = sorted([f for f in os.listdir(instances_dir) if f.endswith(".json")])
    print(f"Found {len(files)} instances.\n")
    
    failed_count = 0
    
    for f in files:
        path = os.path.join(instances_dir, f)
        print(f"Instance: {f}")
        try:
            with open(path, 'r') as fp:
                instance = json.load(fp)
        except Exception as e:
            print(f"  [Error] Failed to load JSON: {e}")
            failed_count += 2
            continue

        for engine in targets:
            if engine in engines:
                success = solve_instance(engine, f, instance)
                if not success:
                    failed_count += 1
                    # print("Stopping validation due to failure to debug output.")
                    # sys.exit(1)
            else:
                print(f"  > Skipping {engine} (not available)")
        
        print("-" * 40)

    if failed_count == 0:
        print("\nAll tests passed successfully!")
        sys.exit(0)
    else:
        print(f"\nThere were {failed_count} failures.")
        sys.exit(1)

if __name__ == "__main__":
    main()
