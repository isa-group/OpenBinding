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


def _uses_product_space(feature_id: str, agg_policies: Dict[str, Any]) -> bool:
    policy = agg_policies.get(feature_id, {}) or {}
    compose = policy.get("compose", {}) or {}
    fns = [compose.get("seq", {}).get("fn"), compose.get("and", {}).get("fn"), compose.get("xor", {}).get("fn"), compose.get("loop", {}).get("fn")]
    return any(str(fn or "").lower() in ("product", "scaled_product") for fn in fns)


def _raw_default_for(feature_id: str, features: Dict[str, Any], agg_policies: Dict[str, Any]) -> float:
    policy = agg_policies.get(feature_id, {})
    if "neutral" in policy and isinstance(policy.get("neutral"), (int, float)):
        return float(policy["neutral"])
    feat = features.get(feature_id, {})
    direction = feat.get("direction")
    vr = feat.get("valid_range") or {}
    if direction == "maximize" or direction == "MAXIMIZE":
        return float(vr.get("min", 0.0))
    return float(vr.get("max", 0.0))


def _product_ratio_denominator(feature_id: str, features: Dict[str, Any], agg_policies: Dict[str, Any]) -> float:
    if not _uses_product_space(feature_id, agg_policies):
        return 1.0

    feat = features.get(feature_id, {}) or {}
    scale = str(feat.get("scale") or "").upper()
    vr = feat.get("valid_range") or {}

    try:
        mx = float(vr.get("max", 1.0))
    except (TypeError, ValueError):
        mx = 1.0

    if scale == "RATIO" and mx > 1.0:
        return mx
    return 1.0


def _to_composition_value(raw: float, feature_id: str, features: Dict[str, Any], agg_policies: Dict[str, Any]) -> float:
    denominator = _product_ratio_denominator(feature_id, features, agg_policies)
    if denominator <= 1.0:
        return raw

    if 0.0 <= raw <= 1.0:
        return raw
    return raw / denominator


def _from_composition_value(value: float, feature_id: str, features: Dict[str, Any], agg_policies: Dict[str, Any]) -> float:
    denominator = _product_ratio_denominator(feature_id, features, agg_policies)
    if denominator <= 1.0:
        return value
    return value * denominator


def _default_composition_value(feature_id: str, features: Dict[str, Any], agg_policies: Dict[str, Any]) -> float:
    raw = _raw_default_for(feature_id, features, agg_policies)
    return _to_composition_value(raw, feature_id, features, agg_policies)


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


def _task_value(
    node: Dict[str, Any],
    feature_id: str,
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    task_id = node.get("task_id")
    cand = selected_candidate_by_task.get(task_id)
    if cand is None:
        return _default_composition_value(feature_id, features, agg_policies)

    raw = float((cand.get("features", {}) or {}).get(feature_id, _raw_default_for(feature_id, features, agg_policies)))
    return _to_composition_value(raw, feature_id, features, agg_policies)


def _compose_seq_or_and(
    kind: str,
    node: Dict[str, Any],
    feature_id: str,
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    compose = (agg_policies.get(feature_id, {}) or {}).get("compose", {}) or {}
    children = node.get("children", []) or []
    values = [_compose_value(c, feature_id, selected_candidate_by_task, features, agg_policies) for c in children]
    fn = compose.get("seq" if kind == "SEQ" else "and", {}).get("fn")
    return _agg_fn(fn or ("sum" if kind == "SEQ" else "max"), values)


def _compose_xor(
    node: Dict[str, Any],
    feature_id: str,
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    compose = (agg_policies.get(feature_id, {}) or {}).get("compose", {}) or {}
    branches = node.get("branches", []) or []
    values = [_compose_value(b.get("child", {}), feature_id, selected_candidate_by_task, features, agg_policies) for b in branches]
    probs = [float(b.get("p", 0.0)) for b in branches]
    fn = compose.get("xor", {}).get("fn")
    if str(fn or "").lower() in ("", "sum", "weighted_sum", "scaled_sum"):
        return _agg_fn("weighted_sum", values, probs)
    return _agg_fn(fn, values)


def _compose_loop(
    node: Dict[str, Any],
    feature_id: str,
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    compose = (agg_policies.get(feature_id, {}) or {}).get("compose", {}) or {}
    body = node.get("body", {}) or {}
    body_val = _compose_value(body, feature_id, selected_candidate_by_task, features, agg_policies)
    fn = str(compose.get("loop", {}).get("fn") or "sum").lower()

    iterations = node.get("expected_iterations")
    if iterations is None:
        # Fallback shared with the Java engines and the MiniZinc dzn builder:
        # midpoint of the declared bounds, 1 when no usable bounds exist.
        bounds = node.get("bounds") or {}
        mn = float(bounds.get("min", 0.0) or 0.0)
        mx = float(bounds.get("max", 0.0) or 0.0)
        iterations = (mn + mx) / 2.0 if (mn > 0.0 or mx > 0.0) else 1.0
    count = float(iterations)

    if "product" in fn:
        return float(body_val ** count)
    if "sum" in fn or "wsum" in fn or "scale" in fn:
        return float(body_val * count)
    return body_val


def _compose_value(
    node: Dict[str, Any],
    feature_id: str,
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    kind = node.get("kind")

    if kind == "TASK":
        return _task_value(node, feature_id, selected_candidate_by_task, features, agg_policies)

    if kind == "ELEMENT":
        return _default_composition_value(feature_id, features, agg_policies)

    if kind in ("SEQ", "AND"):
        return _compose_seq_or_and(kind, node, feature_id, selected_candidate_by_task, features, agg_policies)

    if kind == "XOR":
        return _compose_xor(node, feature_id, selected_candidate_by_task, features, agg_policies)

    if kind == "LOOP":
        return _compose_loop(node, feature_id, selected_candidate_by_task, features, agg_policies)

    return _default_composition_value(feature_id, features, agg_policies)


def compute_aggregated_qos(
    composition_root: Dict[str, Any],
    features: Dict[str, Any],
    selected_candidate_by_task: Dict[str, Dict[str, Any]],
    agg_policies: Dict[str, Any],
) -> Dict[str, float]:
    aggregated_qos: Dict[str, float] = {}
    for fid in features.keys():
        composed = _compose_value(
            composition_root,
            fid,
            selected_candidate_by_task,
            features,
            agg_policies,
        )
        aggregated_qos[fid] = _from_composition_value(composed, fid, features, agg_policies)
    return aggregated_qos


def _recompute_solution_aggregated_features(
    solution: Dict[str, Any],
    root: Dict[str, Any],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
    candidates_by_id: Dict[str, Dict[str, Any]],
) -> None:
    binding = solution.get("binding")
    if not isinstance(binding, dict) or not binding or not root or not features:
        solution.setdefault("aggregated_features", {})
        return

    selected_candidate_by_task = build_selected_candidate_by_task(binding, candidates_by_id)
    solution["aggregated_features"] = compute_aggregated_qos(
        root,
        features,
        selected_candidate_by_task,
        agg_policies,
    )


def _objective_weights(obj: Dict[str, Any]) -> Dict[str, float]:
    objective_type = str(obj.get("type") or "").upper()
    weights = {str(fid): float(weight) for fid, weight in (obj.get("weights", {}) or {}).items()}

    if objective_type in {"MONO", "MANY", "MULTI"}:
        for target in obj.get("targets", []) or []:
            weights.setdefault(str(target), 1.0)

    return weights


def _canonicalize_solution_objective_value(
    solution: Dict[str, Any],
    objective: Dict[str, Any],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> None:
    aggregated_qos = solution.get("aggregated_features")
    if not isinstance(aggregated_qos, dict):
        return

    objective_type = str(objective.get("type") or "").upper()
    if objective_type not in {"MONO", "WEIGHTED_SUM", "MANY", "MULTI"}:
        return

    if objective_type in {"MONO", "WEIGHTED_SUM"} and solution.get("objective_value") is not None:
        return

    normalized_qos = normalize_qos(aggregated_qos, features, agg_policies)
    solution["objective_value"] = compute_objective_value(objective, normalized_qos)


def canonicalize_result_data(result_data: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(result_data, dict):
        return result_data

    solutions = result_data.get("solutions")
    if not isinstance(solutions, list):
        return result_data

    # BIM* instances get the full reference evaluation (end-to-end latency,
    # capacity/transition constraints, canonical normalized objective).
    from .bimstar import apply_bimstar_evaluation, is_bimstar

    if is_bimstar(original_request):
        return apply_bimstar_evaluation(result_data, original_request)

    root = (original_request.get("composition") or {}).get("root") or {}
    features = {feature["id"]: feature for feature in (original_request.get("features") or [])}
    agg_policies = (original_request.get("aggregation_policies") or {})
    candidates_by_id = {candidate["id"]: candidate for candidate in (original_request.get("candidates") or [])}
    objective = original_request.get("objective") or {}
    for solution in solutions:
        if not isinstance(solution, dict):
            continue
        _recompute_solution_aggregated_features(solution, root, features, agg_policies, candidates_by_id)
        _canonicalize_solution_objective_value(solution, objective, features, agg_policies)

    return result_data


def normalize_qos(
    aggregated_qos: Dict[str, float],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> Dict[str, float]:
    return {fid: _normalize_value(fid, val, features, agg_policies) for fid, val in aggregated_qos.items()}


def _is_increasing(feature_id: str, features: Dict[str, Any], norm: Dict[str, Any]) -> bool:
    increasing = norm.get("increasing_is_better")
    if increasing is not None:
        return bool(increasing)

    direction = str((features.get(feature_id, {}) or {}).get("direction") or "").lower()
    return direction == "maximize"


def _normalize_minmax(raw: float, bounds: Dict[str, Any], increasing: bool) -> float:
    mn = float(bounds.get("min", 0.0))
    mx = float(bounds.get("max", 1.0))
    if mx == mn:
        return 0.0

    value = (raw - mn) / (mx - mn)
    value = min(1.0, max(0.0, value))
    return value if increasing else (1.0 - value)


def _normalize_value(
    feature_id: str,
    raw: float,
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    norm = (agg_policies.get(feature_id, {}) or {}).get("normalize")
    if not norm:
        return raw

    ntype = norm.get("type")
    if ntype == "minmax":
        return _normalize_minmax(raw, norm.get("bounds") or {}, _is_increasing(feature_id, features, norm))
    if ntype in ("identity", None):
        return raw
    return raw


def compute_objective_value(obj: Dict[str, Any], normalized_qos: Dict[str, float]) -> float:
    objective_type = str(obj.get("type") or "").upper()
    if objective_type not in {"MONO", "WEIGHTED_SUM", "MANY", "MULTI"}:
        return 0.0

    objective_value = 0.0
    for fid, weight in _objective_weights(obj).items():
        val = float(normalized_qos.get(fid, 0.0))
        objective_value += float(weight) * val

    return objective_value
