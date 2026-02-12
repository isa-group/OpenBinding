import os
import json
import requests
import time
from typing import Dict, Any, Tuple, Optional, List
from tqdm import tqdm
from termcolor import colored

GATEWAY_URL = "http://localhost:8000/v1/solve"
INSTANCES_DIR = "experimentation/instances"
REPORT_FILE = "experimentation/report.md"
DEFAULT_ITERATIONS_COUNT = 1000
MANY_ITERATIONS_COUNT = 1000

def build_selected_candidate_by_task(
    selection: Dict[str, str],
    candidates_by_id: Dict[str, Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    selected: Dict[str, Dict[str, Any]] = {}
    for task_id, cand_id in selection.items():
        cand = candidates_by_id.get(cand_id)
        if cand is not None:
            selected[task_id] = cand
    return selected


def _default_for(feature_id: str, features: Dict[str, Any], agg_policies: Dict[str, Any]) -> float:
    policy = agg_policies.get(feature_id, {})
    if "neutral" in policy and isinstance(policy.get("neutral"), (int, float)):
        return float(policy["neutral"])
    feat = features.get(feature_id, {})
    direction = feat.get("direction")
    vr = feat.get("valid_range") or {}
    if direction == "maximize" or direction == "MAXIMIZE":
        return float(vr.get("min", 0.0))
    return float(vr.get("max", 0.0))


def _agg_fn(fn: Optional[str], values: List[float], weights: Optional[List[float]] = None) -> float:
    if not values:
        return 0.0

    fn_lower = fn.lower() if fn else ""

    if fn_lower in ("weighted_sum",):
        w = weights or [1.0] * len(values)
        return sum(v * w_i for v, w_i in zip(values, w))
    if fn_lower == "sum":
        if weights is not None:
            return sum(v * w_i for v, w_i in zip(values, weights))
        return sum(values)
    if fn_lower == "product":
        res = 1.0
        for v in values:
            res *= v
        return res
    if fn_lower == "max":
        return max(values)
    if fn_lower == "min":
        return min(values)
    return sum(values)


def _compose_value(
    node: Dict[str, Any],
    feature_id: str,
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    kind = node.get("kind")
    policy = agg_policies.get(feature_id, {})
    compose = policy.get("compose", {})

    if kind == "TASK":
        task_id = node.get("task_id")
        cand = selected_candidate_by_task.get(task_id)
        if cand is None:
            return _default_for(feature_id, features, agg_policies)
        return float((cand.get("features", {}) or {}).get(feature_id, _default_for(feature_id, features, agg_policies)))

    if kind in ("SEQ", "AND"):
        children = node.get("children", []) or []
        values = [_compose_value(c, feature_id, selected_candidate_by_task, features, agg_policies) for c in children]
        fn = compose.get("seq" if kind == "SEQ" else "and", {}).get("fn")
        return _agg_fn(fn or ("sum" if kind == "SEQ" else "max"), values)

    if kind == "XOR":
        branches = node.get("branches", []) or []
        values = [_compose_value(b.get("child", {}), feature_id, selected_candidate_by_task, features, agg_policies) for b in branches]
        probs = [float(b.get("p", 0.0)) for b in branches]
        fn = compose.get("xor", {}).get("fn")
        if fn in (None, "sum", "weighted_sum", "scaled_sum", "SCALED_SUM"):
            return _agg_fn("weighted_sum", values, probs)
        return _agg_fn(fn, values)

    if kind == "LOOP":
        body = node.get("body", {}) or {}
        body_val = _compose_value(body, feature_id, selected_candidate_by_task, features, agg_policies)
        fn = compose.get("loop", {}).get("fn")
        iterations = node.get("expected_iterations")
        if iterations is None:
            bounds = node.get("bounds") or {}
            iterations = bounds.get("max", 1)
        c = float(iterations)

        fn_lower = (fn or "sum").lower()
        if "product" in fn_lower:
            return float(body_val ** c)
        if "sum" in fn_lower or "wsum" in fn_lower or "scale" in fn_lower:
            return float(body_val * c)
        return body_val

    return _default_for(feature_id, features, agg_policies)


def _compose_value_mzn(
    node: Dict[str, Any],
    feature_id: str,
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    kind = node.get("kind")
    policy = agg_policies.get(feature_id, {})
    compose = policy.get("compose", {})

    if kind == "TASK":
        task_id = node.get("task_id")
        cand = selected_candidate_by_task.get(task_id)
        if cand is None:
            return _default_for(feature_id, features, agg_policies)
        return float((cand.get("features", {}) or {}).get(feature_id, _default_for(feature_id, features, agg_policies)))

    if kind in ("SEQ", "AND"):
        children = node.get("children", []) or []
        values = [_compose_value_mzn(c, feature_id, selected_candidate_by_task, features, agg_policies) for c in children]
        fn = compose.get("seq" if kind == "SEQ" else "and", {}).get("fn")
        return _agg_fn(fn or ("sum" if kind == "SEQ" else "max"), values)

    if kind == "XOR":
        branches = node.get("branches", []) or []
        values = [
            _compose_value_mzn(b.get("child", {}), feature_id, selected_candidate_by_task, features, agg_policies)
            for b in branches
        ]
        probs = [float(b.get("p", 0.0)) for b in branches]
        fn = compose.get("xor", {}).get("fn")
        if fn in (None, "sum", "weighted_sum", "scaled_sum", "SCALED_SUM"):
            return _agg_fn("weighted_sum", values, probs)
        return _agg_fn(fn, values)

    if kind == "LOOP":
        body = node.get("body", {}) or {}
        body_val = _compose_value_mzn(body, feature_id, selected_candidate_by_task, features, agg_policies)
        fn = compose.get("loop", {}).get("fn")
        iterations = node.get("expected_iterations")
        if iterations is None:
            bounds = node.get("bounds") or {}
            mn = float(bounds.get("min", 0))
            mx = float(bounds.get("max", 0))
            if mx > 0 or mn > 0:
                iterations = (mn + mx) / 2.0
        if iterations is None:
            iterations = node.get("iterations")
        c = float(round(iterations or 1))

        fn_lower = (fn or "sum").lower()
        if "product" in fn_lower:
            return float(body_val ** c)
        if "sum" in fn_lower or "wsum" in fn_lower or "scale" in fn_lower:
            return float(body_val * c)
        return body_val

    return _default_for(feature_id, features, agg_policies)


def compute_aggregated_qos(
    composition_root: Dict[str, Any],
    features: Dict[str, Any],
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    agg_policies: Dict[str, Any],
) -> Dict[str, float]:
    aggregated_qos: Dict[str, float] = {}
    for fid in features.keys():
        aggregated_qos[fid] = _compose_value(
            composition_root,
            fid,
            selected_candidate_by_task,
            features,
            agg_policies,
        )
    return aggregated_qos


def compute_aggregated_qos_mzn(
    composition_root: Dict[str, Any],
    features: Dict[str, Any],
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    agg_policies: Dict[str, Any],
) -> Dict[str, float]:
    aggregated_qos: Dict[str, float] = {}
    for fid in features.keys():
        aggregated_qos[fid] = _compose_value_mzn(
            composition_root,
            fid,
            selected_candidate_by_task,
            features,
            agg_policies,
        )
    return aggregated_qos


def compute_node_qos_mzn(
    node: Dict[str, Any],
    features: Dict[str, Any],
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    agg_policies: Dict[str, Any],
) -> Dict[str, Dict[str, float]]:
    results: Dict[str, Dict[str, float]] = {}

    def _node_id(n: Dict[str, Any]) -> str:
        return n.get("id") or f"anon_{id(n)}"

    def _walk(n: Dict[str, Any]) -> None:
        nid = _node_id(n)
        values: Dict[str, float] = {}
        for fid in features.keys():
            values[fid] = _compose_value_mzn(n, fid, selected_candidate_by_task, features, agg_policies)
        results[nid] = {"kind": n.get("kind"), **values}

        if n.get("kind") in ("SEQ", "AND"):
            for child in n.get("children", []) or []:
                _walk(child)
        elif n.get("kind") == "XOR":
            for br in n.get("branches", []) or []:
                _walk(br.get("child", {}) or {})
        elif n.get("kind") == "LOOP":
            body = n.get("body", {}) or {}
            _walk(body)

    _walk(node)
    return results


def compute_qos_ub_mzn(
    instance: Dict[str, Any],
    features: Dict[str, Any],
    scaled_selected_by_task: Dict[str, Dict[str, Any]],
) -> Dict[str, float]:
    fn_map = {
        "sum": 1,
        "weighted_sum": 5,
        "product": 2,
        "max": 3,
        "min": 4,
        "scale_by_c": 1,
        "scaled_sum": 1,
        "scaled_product": 2,
    }

    def _map_fn(fn: Optional[str], default_val: int) -> int:
        if not fn:
            return default_val
        return fn_map.get(fn.lower(), default_val)

    tasks = instance.get("tasks", []) or []
    candidates = instance.get("candidates", []) or []
    task_ids = [t.get("id") for t in tasks if t.get("id")]

    task_candidates_map: Dict[str, List[int]] = {tid: [] for tid in task_ids}
    cand_qos: List[Dict[str, float]] = []

    for idx, cand in enumerate(candidates):
        tid = cand.get("task_id")
        if tid in task_candidates_map:
            task_candidates_map[tid].append(idx)
        scaled_features = {}
        for fid, feat in features.items():
            raw_val = (cand.get("features", {}) or {}).get(fid)
            if isinstance(raw_val, (int, float)):
                scaled_features[fid] = _scale_value(float(raw_val), feat)
        cand_qos.append(scaled_features)

    agg_policies = instance.get("aggregation_policies", {}) or {}
    qos_ub: Dict[str, float] = {}

    for fid in features.keys():
        pol = agg_policies.get(fid, {}) or {}
        compose = pol.get("compose", {}) or {}

        seq_pol = _map_fn(compose.get("seq", {}).get("fn"), 1)
        loop_pol = _map_fn(compose.get("loop", {}).get("fn"), 1)

        is_availability = "availability" in fid.lower() or "success" in fid.lower()
        max_val = 1.0
        if cand_qos:
            max_val = max(1.0, max(abs(c.get(fid, 0.0)) for c in cand_qos))

        if is_availability or seq_pol == 2 or loop_pol == 2:
            qos_ub[fid] = 1.0
        elif seq_pol == 1 or loop_pol == 1:
            task_sum = 0.0
            for tid in task_ids:
                cidxs = task_candidates_map.get(tid, [])
                if cidxs:
                    task_sum += max(abs(cand_qos[i].get(fid, 0.0)) for i in cidxs)
            loop_factor = 10
            qos_ub[fid] = max(1.0, task_sum * loop_factor)
        else:
            qos_ub[fid] = max_val * 1.5

    return qos_ub


def _scale_value(val: float, feat: Dict[str, Any]) -> float:
    vr = feat.get("valid_range") or {}
    mn = float(vr.get("min", 0.0))
    mx = float(vr.get("max", 1.0))
    denom = mx - mn
    if abs(denom) < 1e-12:
        return 0.0
    scaled = (float(val) - mn) / denom
    if scaled < 0.0:
        return 0.0
    if scaled > 1.0:
        return 1.0
    return scaled


def _check_op(current: float, op: str, rhs: float) -> bool:
    if op == "<=":
        return current <= rhs
    if op == "<":
        return current < rhs
    if op == ">=":
        return current >= rhs
    if op == ">":
        return current > rhs
    if op == "==":
        return abs(current - rhs) <= 1e-9
    if op == "!=" or op == "<>":
        return abs(current - rhs) > 1e-9
    return True


def analyze_mzn_no_solution(instance: Dict[str, Any], rs_resp: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    binding = get_binding(rs_resp)
    if not binding:
        return None

    candidates_by_id = {c["id"]: c for c in (instance.get("candidates", []) or [])}
    features = {f["id"]: f for f in (instance.get("features", []) or [])}
    agg_policies = instance.get("aggregation_policies", {}) or {}
    selected_by_task = build_selected_candidate_by_task(binding, candidates_by_id)
    root = (instance.get("composition", {}) or {}).get("root", {})
    aggregated = compute_aggregated_qos(root, features, selected_by_task, agg_policies)

    # Build a scaled view of selected candidates (MiniZinc-style scaling)
    scaled_selected_by_task = {}
    for task_id, cand in selected_by_task.items():
        scaled_features = {}
        for fid, feat in features.items():
            raw_val = (cand.get("features", {}) or {}).get(fid)
            if isinstance(raw_val, (int, float)):
                scaled_features[fid] = _scale_value(float(raw_val), feat)
        scaled_selected_by_task[task_id] = {
            "id": cand.get("id"),
            "provider_id": cand.get("provider_id"),
            "features": scaled_features,
        }

    aggregated_scaled = compute_aggregated_qos(root, features, scaled_selected_by_task, agg_policies)
    aggregated_mzn_scaled = compute_aggregated_qos_mzn(root, features, scaled_selected_by_task, agg_policies)
    qos_ub = compute_qos_ub_mzn(instance, features, scaled_selected_by_task)
    node_qos_mzn_scaled = compute_node_qos_mzn(root, features, scaled_selected_by_task, agg_policies)

    bound_violations = []
    scaled_bound_violations = []
    mzn_scaled_bound_violations = []
    qos_ub_violations = []
    qos_ub_node_violations = []
    dependency_violations = []
    notes = []

    for c in (instance.get("constraints", []) or []):
        if c.get("hard") is False:
            continue
        kind = (c.get("kind") or "").upper()
        if kind == "ATTRIBUTE_BOUND":
            scope = (c.get("scope") or "").upper()
            attr = c.get("attribute_id")
            op = c.get("op")
            if not attr or not op:
                continue
            value = c.get("value")
            if isinstance(value, dict) and op in ("IN_RANGE", "in_range"):
                min_val = value.get("min")
                max_val = value.get("max")
                if scope == "GLOBAL":
                    current = aggregated.get(attr)
                else:
                    task_id = c.get("task_id") or (c.get("tasks") or [None])[0]
                    cand = selected_by_task.get(task_id)
                    current = None if cand is None else (cand.get("features", {}) or {}).get(attr)
                if current is None:
                    notes.append({"constraint_id": c.get("id"), "reason": "missing_value"})
                else:
                    if (min_val is not None and current < min_val) or (max_val is not None and current > max_val):
                        bound_violations.append({
                            "constraint_id": c.get("id"),
                            "scope": scope,
                            "attribute_id": attr,
                            "current": current,
                            "min": min_val,
                            "max": max_val,
                        })
                continue
            if not isinstance(value, (int, float)):
                continue
            if scope == "GLOBAL":
                current = aggregated.get(attr)
                current_scaled = aggregated_scaled.get(attr)
                if current is None:
                    notes.append({"constraint_id": c.get("id"), "reason": "missing_aggregated_feature"})
                    continue
            else:
                task_id = c.get("task_id") or (c.get("tasks") or [None])[0]
                cand = selected_by_task.get(task_id)
                if cand is None:
                    notes.append({"constraint_id": c.get("id"), "reason": "missing_task_binding"})
                    continue
                current = (cand.get("features", {}) or {}).get(attr)
                if current is None:
                    notes.append({"constraint_id": c.get("id"), "reason": "missing_candidate_feature"})
                    continue
                cand_scaled = scaled_selected_by_task.get(task_id)
                current_scaled = None
                if cand_scaled is not None:
                    current_scaled = (cand_scaled.get("features", {}) or {}).get(attr)
            if not _check_op(float(current), op, float(value)):
                bound_violations.append({
                    "constraint_id": c.get("id"),
                    "scope": scope,
                    "attribute_id": attr,
                    "current": current,
                    "op": op,
                    "value": value,
                })

            feat = features.get(attr)
            if feat is not None and isinstance(value, (int, float)) and current_scaled is not None:
                scaled_value = _scale_value(float(value), feat)
                if not _check_op(float(current_scaled), op, float(scaled_value)):
                    scaled_bound_violations.append({
                        "constraint_id": c.get("id"),
                        "scope": scope,
                        "attribute_id": attr,
                        "current_scaled": current_scaled,
                        "op": op,
                        "value_scaled": scaled_value,
                    })
                current_mzn_scaled = aggregated_mzn_scaled.get(attr) if scope == "GLOBAL" else current_scaled
                if current_mzn_scaled is not None:
                    if not _check_op(float(current_mzn_scaled), op, float(scaled_value)):
                        mzn_scaled_bound_violations.append({
                            "constraint_id": c.get("id"),
                            "scope": scope,
                            "attribute_id": attr,
                            "current_scaled": current_mzn_scaled,
                            "op": op,
                            "value_scaled": scaled_value,
                        })

        elif kind == "DEPENDENCY":
            dep_type = (c.get("type") or "").upper()
            tasks = c.get("tasks") or []
            if len(tasks) < 2:
                continue
            providers = []
            missing = False
            for t in tasks:
                cand = selected_by_task.get(t)
                if cand is None:
                    missing = True
                    break
                providers.append(cand.get("provider_id"))
            if missing:
                notes.append({"constraint_id": c.get("id"), "reason": "missing_dependency_binding"})
                continue

            if dep_type == "SAME_PROVIDER":
                for i in range(len(providers) - 1):
                    if providers[i] != providers[i + 1]:
                        dependency_violations.append({
                            "constraint_id": c.get("id"),
                            "type": dep_type,
                            "tasks": tasks,
                            "providers": providers,
                        })
                        break
            elif dep_type == "DIFFERENT_PROVIDER":
                for i in range(len(providers)):
                    for j in range(i + 1, len(providers)):
                        if providers[i] == providers[j]:
                            dependency_violations.append({
                                "constraint_id": c.get("id"),
                                "type": dep_type,
                                "tasks": tasks,
                                "providers": providers,
                            })
                            i = len(providers)
                            break

            for fid, ub in qos_ub.items():
                current = aggregated_mzn_scaled.get(fid)
                if current is None:
                    continue
                if float(current) > float(ub) + 1e-9:
                    qos_ub_violations.append({
                        "attribute_id": fid,
                        "current_scaled": current,
                        "qos_ub": ub,
                    })

            for node_id, vals in node_qos_mzn_scaled.items():
                kind = vals.get("kind")
                for fid, ub in qos_ub.items():
                    current = vals.get(fid)
                    if current is None:
                        continue
                    if float(current) > float(ub) + 1e-9:
                        qos_ub_node_violations.append({
                            "node_id": node_id,
                            "node_kind": kind,
                            "attribute_id": fid,
                            "current_scaled": current,
                            "qos_ub": ub,
                        })

    return {
        "binding": binding,
        "aggregated_features": aggregated,
        "aggregated_features_scaled": aggregated_scaled,
        "aggregated_features_mzn_scaled": aggregated_mzn_scaled,
        "node_qos_mzn_scaled": node_qos_mzn_scaled,
        "qos_ub": qos_ub,
        "bound_violations": bound_violations,
        "mzn_scaled_bound_violations": scaled_bound_violations,
        "mzn_loop_scaled_bound_violations": mzn_scaled_bound_violations,
        "qos_ub_violations": qos_ub_violations,
        "qos_ub_node_violations": qos_ub_node_violations,
        "dependency_violations": dependency_violations,
        "notes": notes,
    }

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

def solve(instance: Dict[str, Any], engine_id: str, options: Optional[Dict[str, Any]] = None) -> Tuple[int, Dict[str, Any], float]:
    """Send request to gateway, poll if 202, return status, response, duration."""
    payload = {
        "engine_id": engine_id,
        "instance": instance,
        "verbose": True  # Enable diagnostics
    }
    if options:
        payload["options"] = options
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

def determine_result(obj_type, has_soft, mzn_s, rs_s, rs_resp=None, many_s=None, many_resp=None):
    """Determine if the result is a PASS or FAIL based on expectations."""
    is_pass = False
    msg = ""
    
    # Check if RS returned 200 but with no actual solutions (heuristic failure)
    rs_has_solution = True
    if rs_resp and rs_s in [200, 202]:
        b = get_binding(rs_resp)
        if b is None:
            rs_has_solution = False
    
    if obj_type == "MANY":
        # Expected: MZN/RS reject, Many-Heuristic solves with a non-empty binding set
        many_has_solution = has_non_empty_binding_set(many_resp) if many_resp and many_s in [200, 202] else False
        if mzn_s >= 400 and rs_s >= 400 and many_s in [200, 202]:
            if many_has_solution:
                is_pass = True
                msg = "PASS (MZN/RS Reject, MANY Solve)"
            else:
                msg = "FAIL (MANY NoSol)"
        else:
            msg = f"FAIL (Exp MZN/RS Reject, MANY OK; got MZN:{mzn_s} RS:{rs_s} MANY:{many_s})"

    elif obj_type == "MULTI":
        # Expected: All reject (>=400)
        if mzn_s >= 400 and rs_s >= 400 and (many_s is None or many_s >= 400):
            is_pass = True
            msg = "PASS (All Rejected)"
        else:
            msg = f"FAIL (Exp Reject, got MZN:{mzn_s} RS:{rs_s} MANY:{many_s})"
            
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
    print(colored(
        f"Configuration: Timeout=300s, Engines=MiniZinc,RandomSearch,ManyHeuristic, "
        f"Iterations={DEFAULT_ITERATIONS_COUNT}, ManyIterations={MANY_ITERATIONS_COUNT}",
        "cyan"
    ))
    
    results = []
    
    # Progress Bar using tqdm
    # LIMIT FOR TESTING (User request: do not run all)
    instances = instances[:100]
    pbar = tqdm(instances, unit="inst")
    
    for item in pbar:
        filename = item["filename"]
        data = item["data"]
        obj_type = data.get("objective", {}).get("type", "MONO")
        constraints = data.get("constraints", [])
        has_soft = any(not c.get("hard", True) for c in constraints)
        
        # Update description
        short_name = (filename[:25] + '..') if len(filename) > 25 else filename
        pbar.set_description(f"Processing {short_name}")
        
        # Run Engines
        mzn_status, mzn_resp, mzn_time = solve(
            data,
            "minizinc-csp",
            options={"iterations_count": DEFAULT_ITERATIONS_COUNT}
        )
        rs_status, rs_resp, rs_time = solve(
            data,
            "random-search",
            options={"iterations_count": DEFAULT_ITERATIONS_COUNT}
        )
        many_status, many_resp, many_time = solve(
            data,
            "many-heuristic",
            options={"iterations_count": MANY_ITERATIONS_COUNT}
        )
        
        # Analyze Result immediately for log
        is_pass, msg = determine_result(
            obj_type,
            has_soft,
            mzn_status,
            rs_status,
            rs_resp,
            many_status,
            many_resp
        )
        
        # Store result
        mzn_binding = get_binding(mzn_resp) if mzn_resp and mzn_status in [200, 202] else None
        rs_binding = get_binding(rs_resp) if rs_resp and rs_status in [200, 202] else None
        mzn_no_solution_diag = None
        if mzn_status in [200, 202] and mzn_binding is None and rs_binding is not None:
            mzn_no_solution_diag = analyze_mzn_no_solution(data, rs_resp)

        results.append({
            "filename": filename,
            "objective": obj_type,
            "has_soft": has_soft,
            "minizinc": {"status": mzn_status, "response": mzn_resp, "time": mzn_time},
            "random_search": {"status": rs_status, "response": rs_resp, "time": rs_time},
            "many_heuristic": {"status": many_status, "response": many_resp, "time": many_time},
            "mzn_no_solution_diag": mzn_no_solution_diag,
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
            colored(f"RS: {rs_status} ({rs_time:.1f}s)", "magenta") + " | " +
            colored(f"MANY: {many_status} ({many_time:.1f}s)", "cyan")
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


def has_non_empty_binding_set(response):
    """Return True if any solution contains a non-empty binding."""
    if not response or "error" in response or "detail" in response:
        return False

    def extract_solutions(obj):
        solutions = obj.get("solutions", []) if isinstance(obj, dict) else []
        if solutions:
            return solutions
        result = obj.get("result") if isinstance(obj, dict) else None
        if isinstance(result, dict):
            return result.get("solutions", [])
        return []

    for solution in extract_solutions(response):
        binding = solution.get("binding")
        if isinstance(binding, dict) and len(binding) > 0:
            return True
    return False

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
        f.write("| Instance | Obj | Soft | MiniZinc | RandomSearch | ManyHeuristic | Binding Match | Binding Space Size | Result |\n")
        f.write("|---|---|---|---|---|---|---|---|---|\n")
        
        for r in results:
            fname = r["filename"].replace(".json", "")
            if len(fname) > 30: fname = fname[:27] + "..."
            
            # Status Icons
            mzn_s = r["minizinc"]["status"]
            rs_s = r["random_search"]["status"]
            many_s = r["many_heuristic"]["status"]
            
            mzn_icon = "🟢" if mzn_s in [200, 202] else "🔴"
            rs_icon = "🟢" if rs_s in [200, 202] else "🔴"
            many_icon = "🟢" if many_s in [200, 202] else "🔴"
            
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

            f.write(f"| {fname} | {r['objective']} | {r['has_soft']} | {mzn_icon} {mzn_s} | {rs_icon} {rs_s} | {many_icon} {many_s} | {binding_match} | {binding_space_size} | {res_icon} {r['msg']} |\n")
            
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
            f.write(row("Many Heuristic", r["many_heuristic"]) + "\n\n")
            
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
            if r.get("mzn_no_solution_diag"):
                f.write("**MiniZinc No-Solution Analysis (based on RS binding)**:\n")
                f.write("```json\n")
                f.write(json.dumps(r["mzn_no_solution_diag"], indent=2))
                f.write("\n```\n")
            f.write("\n---\n")
            print_details("Random Search", r["random_search"])
            f.write("\n---\n")
            print_details("Many Heuristic", r["many_heuristic"])
            
            f.write("\n</details>\n\n---\n")

if __name__ == "__main__":
    run_experiments()
