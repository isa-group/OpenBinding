from __future__ import annotations

from typing import Any, Dict, List, Optional


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


def normalize_qos(
    aggregated_qos: Dict[str, float],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> Dict[str, float]:
    def _normalize_value(feature_id: str, raw: float) -> float:
        norm = (agg_policies.get(feature_id, {}) or {}).get("normalize")
        if not norm:
            return raw

        ntype = norm.get("type")
        increasing = norm.get("increasing_is_better")
        if increasing is None:
            direction = (features.get(feature_id, {}) or {}).get("direction")
            increasing = True if direction == "maximize" else False

        if ntype == "minmax":
            bounds = norm.get("bounds") or {}
            mn = float(bounds.get("min", 0.0))
            mx = float(bounds.get("max", 1.0))
            if mx == mn:
                return 0.0
            v = (raw - mn) / (mx - mn)
            if v < 0.0:
                v = 0.0
            if v > 1.0:
                v = 1.0
            return v if increasing else (1.0 - v)

        if ntype == "identity" or ntype is None:
            return raw

        return raw

    return {fid: _normalize_value(fid, val) for fid, val in aggregated_qos.items()}


def compute_objective_value(obj: Dict[str, Any], normalized_qos: Dict[str, float]) -> float:
    objective_value = 0.0
    if obj.get("type") in ("MONO", "weighted_sum"):
        if obj.get("type") == "MONO":
            targets = obj.get("targets", [])
            weights = obj.get("weights", {})
            for t in targets:
                if t not in weights:
                    weights[t] = 1.0
        else:
            weights = obj.get("weights", {}) or {}

        for fid, w in weights.items():
            val = float(normalized_qos.get(fid, 0.0))
            objective_value += float(w) * val

    return objective_value
