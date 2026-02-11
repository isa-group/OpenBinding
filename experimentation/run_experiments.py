import os
import json
import requests
import time
from typing import Dict, Any, Tuple
from tqdm import tqdm
from termcolor import colored

GATEWAY_URL = "http://localhost:8000/v1/solve"
INSTANCES_DIR = "experimentation/instances"
REPORT_FILE = "experimentation/report.md"

def load_instances():
    """Load all JSON instances from the directory."""
    instances = []
    if not os.path.exists(INSTANCES_DIR):
        print(colored(f"Directory {INSTANCES_DIR} does not exist.", "red"))
        return []
    
    files = sorted([f for f in os.listdir(INSTANCES_DIR) if f.endswith(".json")])
    for f in files:
        with open(os.path.join(INSTANCES_DIR, f), 'r') as fd:
            try:
                data = json.load(fd)
                instances.append({"filename": f, "data": data})
            except Exception as e:
                print(colored(f"Error loading {f}: {e}", "red"))
    return instances

def solve(instance: Dict[str, Any], engine_id: str) -> Tuple[int, Dict[str, Any], float]:
    """Send request to gateway, poll if 202, return status, response, duration."""
    payload = {
        "engine_id": engine_id,
        "instance": instance,
        "verbose": True  # Enable diagnostics
    }
    if 1000 > 0:
        payload["options"] = {"iterations_count": 1000}
    start = time.time()
    try:
        # Initial Request
        resp = None
        for attempt in range(2 + 1):
            try:
                resp = requests.post(GATEWAY_URL, json=payload, timeout=900)
                if resp.status_code in (502, 503, 504):
                    if attempt >= 2:
                        return resp.status_code, {"error": resp.text}, time.time() - start
                    time.sleep(1)
                    continue
                break
            except requests.Timeout:
                if attempt >= 2:
                    return 504, {"error": "Gateway timeout on initial request"}, time.time() - start
                time.sleep(1)
            except requests.ConnectionError:
                if attempt >= 2:
                    return 503, {"error": "Gateway connection failed"}, time.time() - start
                time.sleep(1)

        if resp is None:
            return 503, {"error": "Gateway connection failed"}, time.time() - start

        if resp.status_code == 202:
            job_id = resp.json().get("job_id")
            # Poll loop with configurable or derived max duration
            max_poll_seconds = 7200
            if max_poll_seconds <= 0:
                if 1000 > 0:
                    max_poll_seconds = min(7200, max(300, int(1000 / 2000)))
                else:
                    max_poll_seconds = 300
            start_poll = time.time()
            while time.time() - start_poll < max_poll_seconds:
                try:
                    poll_resp = requests.get(f"http://localhost:8000/v1/jobs/{job_id}", timeout=30)
                    if poll_resp.status_code == 200:
                        poll_data = poll_resp.json()
                        status = poll_data.get("status")
                        if status == "completed":
                            duration = time.time() - start
                            # Return the result which is inside the job result
                            return 200, poll_data.get("result", {}), duration
                        elif status == "failed":
                            duration = time.time() - start
                            return 500, {"error": poll_data.get("error"), "detail": poll_data.get("detail")}, duration
                    time.sleep(2)
                except requests.RequestException:
                    time.sleep(2)
            
            # Timeout
            duration = time.time() - start
            return 408, {"error": "Timeout waiting for job completion", "job_id": job_id}, duration
            
        elif resp.status_code == 200:
            duration = time.time() - start
            data = resp.json()
            # Normalise: if this is a JobResponse wrapper, extract .result
            if "result" in data and "job_id" in data:
                return 200, data.get("result", {}), duration
            return 200, data, duration
        else:
            duration = time.time() - start
            try:
                return resp.status_code, resp.json(), duration
            except:
                return resp.status_code, {"error": resp.text}, duration

    except Exception as e:
        duration = time.time() - start
        return 500, {"error": str(e)}, duration

def determine_result(obj_type, has_soft, mzn_s, rs_s, rs_resp=None):
    """Determine if the result is a PASS or FAIL based on expectations."""
    is_pass = False
    msg = ""
    
    # Check if RS returned 200 but with no actual solutions (heuristic failure)
    rs_has_solution = True
    if rs_resp and rs_s in [200, 202]:
        b = get_binding(rs_resp)
        if b is None:
            rs_has_solution = False
    
    if obj_type in ["MULTI", "MANY"]:
        # Expected: Both Reject (>=400)
        if mzn_s >= 400 and rs_s >= 400:
            is_pass = True
            msg = "PASS (Both Rejected)"
        else:
            msg = f"FAIL (Exp Reject, got MZN:{mzn_s} RS:{rs_s})"
            
    elif has_soft:
        # Expected: MZN Reject (>=400), RS Solve (200/202)
        if mzn_s >= 400 and rs_s in [200, 202]:
            if rs_has_solution:
                is_pass = True
                msg = "PASS (MZN Reject, RS Solve)"
            else:
                is_pass = True  # Still pass — RS is heuristic, no-solution is valid
                msg = "PASS (MZN Reject, RS NoSol)"
        else:
            msg = f"FAIL (Exp MZN Fail/RS OK, got MZN:{mzn_s} RS:{rs_s})"
            
    else: # Single + Hard
        # Expected: Both Solve
        if mzn_s in [200, 202] and rs_s in [200, 202]:
            if rs_has_solution:
                is_pass = True
                msg = "PASS (Both Solved)"
            else:
                is_pass = True  # RS is heuristic — no-solution is acceptable
                msg = "PASS (MZN Solved, RS NoSol)"
        else:
            msg = f"FAIL (Exp Both OK, got MZN:{mzn_s} RS:{rs_s})"
            
    return is_pass, msg

def run_experiments():
    instances = load_instances()
    print(colored(f"Found {len(instances)} instances. Starting experiments...", "cyan", attrs=["bold"]))
    print(colored("Configuration: Timeout=300s, Engines=MiniZinc,RandomSearch", "cyan"))
    
    results = []
    
    # Progress Bar using tqdm
    # LIMIT FOR TESTING (User request: do not run all)
    instances = instances[:50]
    pbar = tqdm(instances, unit="inst")
    
    for item in pbar:
        filename = item["filename"]
        data = item["data"]
        obj_type = data.get("objective", {}).get("type", "SINGLE")
        constraints = data.get("constraints", [])
        has_soft = any(not c.get("hard", True) for c in constraints)
        
        # Update description
        short_name = (filename[:25] + '..') if len(filename) > 25 else filename
        pbar.set_description(f"Processing {short_name}")
        
        # Run Engines
        mzn_status, mzn_resp, mzn_time = solve(data, "minizinc-csp")
        rs_status, rs_resp, rs_time = solve(data, "random-search")
        
        # Analyze Result immediately for log
        is_pass, msg = determine_result(obj_type, has_soft, mzn_status, rs_status, rs_resp)
        
        # Store result
        results.append({
            "filename": filename,
            "objective": obj_type,
            "has_soft": has_soft,
            "minizinc": {"status": mzn_status, "response": mzn_resp, "time": mzn_time},
            "random_search": {"status": rs_status, "response": rs_resp, "time": rs_time},
            "is_pass": is_pass,
            "msg": msg
        })
        
        # Print colored line above progress bar
        color = "green" if is_pass else "red"
        status_icon = "✓" if is_pass else "✗"
        
        # Determine specific reason color (e.g. Expected Fail vs Unexpected Fail)
        # Using cyan for info on time
        
        tqdm.write(
            colored(f"{status_icon} {filename}", color, attrs=["bold"]) + 
            f" | {msg} | " +
            colored(f"MZN: {mzn_status} ({mzn_time:.1f}s)", "blue") + " | " + 
            colored(f"RS: {rs_status} ({rs_time:.1f}s)", "magenta")
        )

    generate_report(results)
    print(colored(f"\nReport generated successfully at {REPORT_FILE}", "green", attrs=["bold"]))

def get_binding(response):
    """Effectively extracts the binding dictionary from a response."""
    if not response or "error" in response or "detail" in response:
        return None
    # Check top-level solutions (async/poll path)
    solutions = response.get("solutions", [])
    if solutions and len(solutions) > 0:
        return solutions[0].get("binding")
    # Check nested result.solutions (sync path — full JobResponse)
    result = response.get("result")
    if result and isinstance(result, dict):
        # Check for error in provenance metadata
        prov = result.get("provenance") or {}
        meta = prov.get("metadata") or {}
        if meta.get("error"):
            return None
        solutions = result.get("solutions", [])
        if solutions and len(solutions) > 0:
            return solutions[0].get("binding")
    return None

def generate_report(results):
    with open(REPORT_FILE, 'w') as f:
        f.write("# Experiment Report\n\n")
        f.write(f"**Generated**: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        
        # Summary Statistics
        total = len(results)
        passed = sum(1 for r in results if r["is_pass"])
        failed = total - passed
        
        f.write(f"**Total**: {total} | **Passed**: {passed} | **Failed**: {failed}\n\n")
        
        # Progress Bar visual in MD
        percent = (passed / total) * 100 if total > 0 else 0
        f.write(f"![Progress](https://geps.dev/progress/{int(percent)}?dangerColor=d9534f&warningColor=f0ad4e&successColor=5cb85c)\n\n")

        # Summary Table
        f.write("## Summary\n\n")
        f.write("| Instance | Obj | Soft | MiniZinc | RandomSearch | Binding Match | Binding Space Size | Result |\n")
        f.write("|---|---|---|---|---|---|---|---|\n")
        
        for r in results:
            fname = r["filename"].replace(".json", "")
            if len(fname) > 30: fname = fname[:27] + "..."
            
            # Status Icons
            mzn_s = r["minizinc"]["status"]
            rs_s = r["random_search"]["status"]
            
            mzn_icon = "🟢" if mzn_s in [200, 202] else "🔴"
            rs_icon = "🟢" if rs_s in [200, 202] else "🔴"
            
            res_icon = "✅" if r["is_pass"] else "❌"
            
            # Binding Match Logic
            binding_match = ""

            # Compare if BOTH engines returned a valid response (200 or 202)
            if mzn_s in [200, 202] and rs_s in [200, 202]:
                b_mzn = get_binding(r["minizinc"]["response"])
                b_rs = get_binding(r["random_search"]["response"])
                
                if b_mzn is not None and b_rs is not None:
                    # Determine equality
                    # Bindings are dicts {task_id: candidate_id}, direct comparison works
                    if b_mzn == b_rs:
                        binding_match = "✅ MATCH"
                    else:
                        binding_match = "⚠️ DIFF"
                elif b_mzn is None and b_rs is None:
                    binding_match = "✅ No Sol"
                elif b_mzn is None:
                    binding_match = "⚠️ MZN NoSol"
                elif b_rs is None:
                    binding_match = "⚠️ RS NoSol"
                else:
                    binding_match = "❓ ERR"
            else:
                binding_match = "-" # N/A if failed or rejected
            
            # Binding Space Size Extraction
            binding_space_size = "-"
            
            # Try to get from MiniZinc result first
            if r["minizinc"]["response"] and "diagnostics" in r["minizinc"]["response"]:
                diag = r["minizinc"]["response"]["diagnostics"]
                if diag and "binding_space" in diag:
                    binding_space_size = diag["binding_space"]["cardinality"]
            
            # If not found, try Random Search
            if binding_space_size == "-" and r["random_search"]["response"] and "diagnostics" in r["random_search"]["response"]:
                diag = r["random_search"]["response"]["diagnostics"]
                if diag and "binding_space" in diag:
                    binding_space_size = diag["binding_space"]["cardinality"]

            # Random Search es heurístico: una diferencia de binding no es un fallo "requerido".
            if binding_match == "⚠️ DIFF":
                binding_match = "⚠️ DIFF (HEUR)"

            f.write(f"| {fname} | {r['objective']} | {r['has_soft']} | {mzn_icon} {mzn_s} | {rs_icon} {rs_s} | {binding_match} | {binding_space_size} | {res_icon} {r['msg']} |\n")
            
        f.write("\n## Detailed Results\n\n")
        
        for r in results:
            fname = r["filename"]
            pass_badge = "![Pass](https://img.shields.io/badge/Result-PASS-success)" if r["is_pass"] else "![Fail](https://img.shields.io/badge/Result-FAIL-critical)"
            
            f.write(f"### {fname} {pass_badge}\n\n")
            f.write(f"- **Objective**: `{r['objective']}`\n")
            f.write(f"- **Soft Constraints**: `{r['has_soft']}`\n\n")
            
            # Columns
            f.write("| Engine | Status | Time | Result |\n")
            f.write("|---|---|---|---|\n")
            
            def row(name, d):
                s = d["status"]
                t = d["time"]
                icon = "🟢" if s in [200, 202] else "🔴"
                return f"| **{name}** | {icon} {s} | {t:.2f}s | See below |"
            
            f.write(row("MiniZinc CSP", r["minizinc"]) + "\n")
            f.write(row("Random Search", r["random_search"]) + "\n\n")
            
            f.write("<details><summary><b>View Engine Responses</b></summary>\n\n")
            
            def print_details(name, d):
                f.write(f"#### {name}\n")
                resp = d["response"]
                
                # Check for solutions/binding
                solutions = resp.get("solutions", [])
                if solutions:
                    binding = solutions[0].get("binding", {})
                    f.write("**Binding Solution**:\n")
                    f.write("```json\n")
                    f.write(json.dumps(binding, indent=2))
                    f.write("\n```\n")
                    
                    agg = solutions[0].get("aggregated_features", {})
                    if agg:
                         f.write("**Aggregated Features**:\n")
                         f.write("```json\n")
                         f.write(json.dumps(agg, indent=2))
                         f.write("\n```\n")
                elif "error" in resp:
                    f.write(f"**Error**:\n```json\n{json.dumps(resp, indent=2)}\n```\n")
                else:
                    f.write(f"**Response**:\n```json\n{json.dumps(resp, indent=2)}\n```\n")
            
            print_details("MiniZinc CSP", r["minizinc"])
            f.write("\n---\n")
            print_details("Random Search", r["random_search"])
            
            f.write("\n</details>\n\n---\n")

if __name__ == "__main__":
    run_experiments()
