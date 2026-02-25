import copy
import itertools
import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

# Configuration (no CLI args; deterministic generation)
ROOT_DIR = Path(__file__).resolve().parents[1]
LITERATURE_DIR = ROOT_DIR / "examples" / "literature"
DEFAULT_OUTPUT_DIR = ROOT_DIR / "experimentation" / "instances"

SCENARIOS = [
    "benatallah.json",
    "bultan.json",
    "cremaschi.json",
    "netedu.json",
    "pautasso.json",
    "zhang.json",
]

TARGET_BINDING_SPACE = 100
EXTRA_FEATURES_PER_SCENARIO = 3
EXTRA_PROVIDERS_PER_SCENARIO = 5
MAX_HARD_VARIANT_RETRIES = 10
MAX_HARD_ATTRIBUTE_BOUNDS_PER_INSTANCE = 2
MAX_HARD_DEPENDENCIES_PER_INSTANCE = 2

RANDOM_SEED = 12345

def load_scenario(filename: str) -> Dict[str, Any]:
    with (LITERATURE_DIR / filename).open("r", encoding="utf-8") as f:
        return json.load(f)

def save_instance(instance: Dict[str, Any], output_dir: Path, name: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    filepath = output_dir / name
    with filepath.open("w", encoding="utf-8") as f:
        json.dump(instance, f, indent=2, ensure_ascii=False)
    print(f"Generated: {filepath}")
    return filepath

def calculate_binding_space(instance: Dict[str, Any]) -> int:
    tasks = [t["id"] for t in instance.get("tasks", [])]
    if not tasks:
        return 0

    counts: Dict[str, int] = {tid: 0 for tid in tasks}
    for candidate in instance.get("candidates", []):
        tid = candidate.get("task_id")
        if tid in counts:
            counts[tid] += 1

    if any(v <= 0 for v in counts.values()):
        return 0

    space = 1
    for v in counts.values():
        space *= v
    return space

def _id_set(items: Iterable[Dict[str, Any]]) -> Set[str]:
    return {str(x.get("id")) for x in items if "id" in x}


def _unique_id(prefix: str, used: Set[str]) -> str:
    i = 1
    while True:
        candidate = f"{prefix}{i}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        i += 1


def _feature_map(instance: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {f["id"]: f for f in instance.get("features", [])}


def _clamp(v: float, mn: float, mx: float) -> float:
    return max(mn, min(mx, v))


def _range_for_feature(feature_def: Dict[str, Any]) -> Tuple[float, float]:
    vr = feature_def.get("valid_range") or {}
    return float(vr.get("min", 0.0)), float(vr.get("max", 1.0))


def _ensure_aggregation_policy_for_feature(
    instance: Dict[str, Any], feature_id: str, direction: str
) -> None:
    policies = instance.setdefault("aggregation_policies", {})
    if feature_id in policies:
        return

    # Prefer copying an existing policy of the same direction.
    fmap = _feature_map(instance)
    for existing_id, policy in policies.items():
        fdef = fmap.get(existing_id)
        if fdef and fdef.get("direction") == direction:
            policies[feature_id] = copy.deepcopy(policy)
            return

    if direction == "MAXIMIZE":
        policies[feature_id] = {
            "neutral": 1,
            "compose": {
                "seq": {"fn": "PRODUCT"},
                "and": {"fn": "PRODUCT"},
                "loop": {"fn": "SCALED_PRODUCT"},
            },
        }
    else:
        policies[feature_id] = {
            "neutral": 0,
            "compose": {
                "seq": {"fn": "SUM"},
                "and": {"fn": "MAX"},
                "loop": {"fn": "SCALED_SUM"},
            },
        }


def _composition_operators_used(instance: Dict[str, Any]) -> Set[str]:
    operators: Set[str] = set()
    root = (instance.get("composition") or {}).get("root")
    if not isinstance(root, dict):
        return operators

    def walk(node: Dict[str, Any]) -> None:
        kind = str(node.get("kind", "")).upper()
        if kind == "SEQ":
            operators.add("seq")
            for child in node.get("children", []) or []:
                if isinstance(child, dict):
                    walk(child)
        elif kind == "AND":
            operators.add("and")
            for child in node.get("children", []) or []:
                if isinstance(child, dict):
                    walk(child)
        elif kind == "XOR":
            operators.add("xor")
            for branch in node.get("branches", []) or []:
                if isinstance(branch, dict) and isinstance(branch.get("child"), dict):
                    walk(branch["child"])
        elif kind == "LOOP":
            operators.add("loop")
            body = node.get("body")
            if isinstance(body, dict):
                walk(body)

    walk(root)
    return operators


def _default_compose_fn(direction: str, operator: str) -> str:
    if operator == "xor":
        # Expected-value style default for probabilistic branch composition.
        return "SCALED_SUM"
    if direction == "MAXIMIZE":
        return {
            "seq": "PRODUCT",
            "and": "PRODUCT",
            "loop": "SCALED_PRODUCT",
        }.get(operator, "PRODUCT")
    return {
        "seq": "SUM",
        "and": "MAX",
        "loop": "SCALED_SUM",
    }.get(operator, "SUM")


def ensure_aggregation_policies_complete(instance: Dict[str, Any]) -> None:
    fmap = _feature_map(instance)
    policies = instance.setdefault("aggregation_policies", {})

    # 1) Ensure every feature has a policy.
    for feature_id, feature_def in fmap.items():
        _ensure_aggregation_policy_for_feature(
            instance,
            feature_id,
            str(feature_def.get("direction", "MINIMIZE")),
        )

    # 2) Ensure each policy has functions for every operator used in composition.
    required_ops = _composition_operators_used(instance)
    if not required_ops:
        return

    for feature_id, feature_def in fmap.items():
        direction = str(feature_def.get("direction", "MINIMIZE"))
        policy = policies.setdefault(feature_id, {})
        compose = policy.setdefault("compose", {})

        for op in sorted(required_ops):
            if op in compose:
                continue
            compose[op] = {"fn": _default_compose_fn(direction, op)}


def expand_features(instance: Dict[str, Any], count: int) -> None:
    used_feature_ids = _id_set(instance.get("features", []))
    existing_features = instance.get("features", [])

    # Alternate directions to have both MINIMIZE and MAXIMIZE features.
    directions = ["MINIMIZE", "MAXIMIZE"]
    for i in range(count):
        direction = directions[i % len(directions)]
        new_id = _unique_id("gen_feat_", used_feature_ids)

        if direction == "MAXIMIZE":
            valid_range = {"min": 0, "max": 1}
            unit = "ratio"
        else:
            valid_range = {"min": 0, "max": 1000}
            unit = "unit"

        existing_features.append(
            {
                "id": new_id,
                "name": f"Generated feature {new_id}",
                "direction": direction,
                "unit": unit,
                "scale": "RATIO",
                "valid_range": valid_range,
            }
        )
        _ensure_aggregation_policy_for_feature(instance, new_id, direction)

    # Ensure every candidate has a numeric value for every feature.
    fmap = _feature_map(instance)
    for candidate in instance.get("candidates", []):
        feats = candidate.setdefault("features", {})
        for fid, fdef in fmap.items():
            if fid in feats and isinstance(feats[fid], (int, float)):
                continue
            mn, mx = _range_for_feature(fdef)
            # Default to mid-range for determinism.
            feats[fid] = round((mn + mx) / 2.0, 6)


def expand_providers(instance: Dict[str, Any], count: int) -> None:
    providers = instance.setdefault("providers", [])
    used_provider_ids = _id_set(providers)

    # Shared provider ensures SAME_PROVIDER dependency constraints are feasible.
    if "p_gen_shared" not in used_provider_ids:
        providers.append({"id": "p_gen_shared", "name": "Generated Shared Provider"})
        used_provider_ids.add("p_gen_shared")

    for _ in range(count):
        pid = _unique_id("p_gen_", used_provider_ids)
        providers.append({"id": pid, "name": f"Generated Provider {pid}"})


def _candidate_template_for_task(instance: Dict[str, Any], task_id: str) -> Dict[str, Any]:
    for c in instance.get("candidates", []):
        if c.get("task_id") == task_id:
            return c
    # Fallback minimal candidate (should be rare; schema expects candidates)
    providers = [p["id"] for p in instance.get("providers", [])]
    provider_id = providers[0] if providers else "p_gen_shared"
    return {"id": f"tmpl_{task_id}", "task_id": task_id, "provider_id": provider_id, "name": task_id, "features": {}}


def _generate_feature_values_from_base(
    base_features: Dict[str, Any], fmap: Dict[str, Dict[str, Any]], rng: random.Random
) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for fid, fdef in fmap.items():
        mn, mx = _range_for_feature(fdef)
        base_val = base_features.get(fid)
        if isinstance(base_val, (int, float)):
            # Mild perturbation keeps values realistic and within bounds.
            jitter = rng.uniform(0.97, 1.03)
            v = float(base_val) * jitter
        else:
            # Deterministic-ish random around mid-range.
            v = (mn + mx) / 2.0 + rng.uniform(-0.05, 0.05) * (mx - mn)
        v = _clamp(v, mn, mx)
        # Keep ratios with higher precision; costs/latencies to 2 decimals.
        out[fid] = round(v, 6 if mx <= 1.0 else 2)
    return out


def ensure_min_candidates_per_task(
    instance: Dict[str, Any], min_per_task: int, rng: random.Random
) -> None:
    tasks = [t["id"] for t in instance.get("tasks", [])]
    if not tasks:
        return

    candidates = instance.setdefault("candidates", [])
    used_candidate_ids = _id_set(candidates)
    fmap = _feature_map(instance)
    provider_ids = [p["id"] for p in instance.get("providers", [])]
    if not provider_ids:
        expand_providers(instance, EXTRA_PROVIDERS_PER_SCENARIO)
        provider_ids = [p["id"] for p in instance.get("providers", [])]

    # Ensure at least 1 shared-provider candidate per task.
    shared_provider_id = "p_gen_shared"
    for task_id in tasks:
        has_shared = any(
            c.get("task_id") == task_id and c.get("provider_id") == shared_provider_id
            for c in candidates
        )
        if not has_shared:
            base = _candidate_template_for_task(instance, task_id)
            cid = _unique_id(f"{task_id}_gen_", used_candidate_ids)
            candidates.append(
                {
                    "id": cid,
                    "task_id": task_id,
                    "provider_id": shared_provider_id,
                    "name": f"{base.get('name', task_id)} (Gen Shared)",
                    "features": _generate_feature_values_from_base(base.get("features", {}), fmap, rng),
                }
            )

    # Grow each task up to min_per_task candidates, round-robin over providers.
    providers_cycle = [pid for pid in provider_ids if pid != shared_provider_id]
    if not providers_cycle:
        providers_cycle = [shared_provider_id]

    for task_id in tasks:
        existing = [c for c in candidates if c.get("task_id") == task_id]
        if not existing:
            existing = [_candidate_template_for_task(instance, task_id)]
        base = existing[0]

        while len([c for c in candidates if c.get("task_id") == task_id]) < min_per_task:
            provider_id = providers_cycle[len(used_candidate_ids) % len(providers_cycle)]
            cid = _unique_id(f"{task_id}_gen_", used_candidate_ids)
            candidates.append(
                {
                    "id": cid,
                    "task_id": task_id,
                    "provider_id": provider_id,
                    "name": f"{base.get('name', task_id)} (Gen {provider_id})",
                    "features": _generate_feature_values_from_base(base.get("features", {}), fmap, rng),
                }
            )


def ensure_binding_space_gt(instance: Dict[str, Any], target: int, rng: random.Random) -> None:
    tasks = [t["id"] for t in instance.get("tasks", [])]
    if not tasks:
        return

    # Uniform lower bound per task keeps instances compact while guaranteeing product.
    t = len(tasks)
    min_per_task = int(math.ceil(target ** (1.0 / t)))
    min_per_task = max(min_per_task, 2)
    ensure_min_candidates_per_task(instance, min_per_task, rng)

    # If still short due to uneven distributions, top-up deterministically.
    while calculate_binding_space(instance) < target:
        counts: Dict[str, int] = {tid: 0 for tid in tasks}
        for c in instance.get("candidates", []):
            tid = c.get("task_id")
            if tid in counts:
                counts[tid] += 1
        tid_to_grow = min(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]
        ensure_min_candidates_per_task(instance, counts[tid_to_grow] + 1, rng)

def _quantile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    if q <= 0:
        return float(min(values))
    if q >= 1:
        return float(max(values))
    vs = sorted(float(v) for v in values)
    idx = (len(vs) - 1) * q
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return vs[lo]
    frac = idx - lo
    return vs[lo] * (1 - frac) + vs[hi] * frac


def _candidates_by_task(instance: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    by_task: Dict[str, List[Dict[str, Any]]] = {}
    for c in instance.get("candidates", []) or []:
        tid = c.get("task_id")
        if not isinstance(tid, str):
            continue
        by_task.setdefault(tid, []).append(c)
    for task_id in by_task:
        by_task[task_id].sort(key=lambda cand: str(cand.get("id", "")))
    return by_task


def _candidate_lookup(instance: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {str(c.get("id")): c for c in (instance.get("candidates", []) or []) if "id" in c}


def _default_for(feature_id: str, features: Dict[str, Any], agg_policies: Dict[str, Any]) -> float:
    policy = agg_policies.get(feature_id, {})
    if "neutral" in policy and isinstance(policy.get("neutral"), (int, float)):
        return float(policy["neutral"])
    feat = features.get(feature_id, {})
    direction = feat.get("direction")
    vr = feat.get("valid_range") or {}
    if direction in ("maximize", "MAXIMIZE"):
        return float(vr.get("min", 0.0))
    return float(vr.get("max", 0.0))


def _agg_fn(fn: str, values: List[float], weights: List[float] = None) -> float:
    if not values:
        return 0.0
    fn_lower = (fn or "").lower()
    if fn_lower in ("weighted_sum",):
        ws = weights or [1.0] * len(values)
        return sum(v * w for v, w in zip(values, ws))
    if fn_lower == "sum":
        if weights is not None:
            return sum(v * w for v, w in zip(values, weights))
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
    selected_by_task: Dict[str, Dict[str, Any]],
    features: Dict[str, Any],
    agg_policies: Dict[str, Any],
) -> float:
    kind = node.get("kind")
    policy = agg_policies.get(feature_id, {})
    compose = policy.get("compose", {})

    if kind == "TASK":
        task_id = node.get("task_id")
        cand = selected_by_task.get(task_id)
        if cand is None:
            return _default_for(feature_id, features, agg_policies)
        return float((cand.get("features", {}) or {}).get(feature_id, _default_for(feature_id, features, agg_policies)))

    if kind in ("SEQ", "AND"):
        children = node.get("children", []) or []
        values = [_compose_value(c, feature_id, selected_by_task, features, agg_policies) for c in children]
        fn = compose.get("seq" if kind == "SEQ" else "and", {}).get("fn")
        return _agg_fn(fn or ("sum" if kind == "SEQ" else "max"), values)

    if kind == "XOR":
        branches = node.get("branches", []) or []
        values = [_compose_value((b or {}).get("child", {}), feature_id, selected_by_task, features, agg_policies) for b in branches]
        probs = [float((b or {}).get("p", 0.0)) for b in branches]
        fn = compose.get("xor", {}).get("fn")
        if fn in (None, "sum", "weighted_sum", "scaled_sum", "SCALED_SUM"):
            return _agg_fn("weighted_sum", values, probs)
        return _agg_fn(fn, values)

    if kind == "LOOP":
        body = node.get("body", {}) or {}
        body_val = _compose_value(body, feature_id, selected_by_task, features, agg_policies)
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


def _compute_aggregated_qos(instance: Dict[str, Any], binding: Dict[str, str]) -> Dict[str, float]:
    root = (instance.get("composition", {}) or {}).get("root", {})
    features = {f["id"]: f for f in (instance.get("features", []) or [])}
    agg_policies = instance.get("aggregation_policies", {}) or {}
    by_id = _candidate_lookup(instance)
    selected_by_task = {
        task_id: by_id[cand_id]
        for task_id, cand_id in binding.items()
        if cand_id in by_id
    }
    out: Dict[str, float] = {}
    for fid in features.keys():
        out[fid] = _compose_value(root, fid, selected_by_task, features, agg_policies)
    return out


def _check_bound(current: float, op: str, rhs: float) -> bool:
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
    if op == "!=":
        return abs(current - rhs) > 1e-9
    return True


def _binding_satisfies_hard_constraints(instance: Dict[str, Any], binding: Dict[str, str]) -> bool:
    by_id = _candidate_lookup(instance)
    selected_by_task = {
        task_id: by_id[cid]
        for task_id, cid in binding.items()
        if cid in by_id
    }
    aggregated_qos = _compute_aggregated_qos(instance, binding)

    for c in (instance.get("constraints", []) or []):
        if c.get("hard", True) is False:
            continue
        kind = str(c.get("kind", "")).upper()

        if kind == "ATTRIBUTE_BOUND":
            fid = c.get("attribute_id")
            op = c.get("op")
            val = c.get("value")
            if not fid or not isinstance(val, (int, float)):
                continue
            rhs = float(val)
            scope = str(c.get("scope", "GLOBAL")).upper()

            if scope == "LOCAL":
                for task_id in (c.get("tasks", []) or []):
                    cand = selected_by_task.get(task_id)
                    if cand is None:
                        return False
                    current = float((cand.get("features", {}) or {}).get(fid, 0.0))
                    if not _check_bound(current, op, rhs):
                        return False
            else:
                current = float(aggregated_qos.get(fid, 0.0))
                if not _check_bound(current, op, rhs):
                    return False

        elif kind == "DEPENDENCY":
            dep_type = str(c.get("type", "")).upper()
            tasks = [t for t in (c.get("tasks", []) or []) if isinstance(t, str)]
            if len(tasks) < 2:
                continue
            providers: List[str] = []
            for task_id in tasks:
                cand = selected_by_task.get(task_id)
                if cand is None:
                    return False
                providers.append(str(cand.get("provider_id", "")))

            if dep_type == "SAME_PROVIDER":
                if len(set(providers)) != 1:
                    return False
            elif dep_type == "DIFFERENT_PROVIDER":
                if len(set(providers)) != len(providers):
                    return False

    return True


def _build_fallback_binding(instance: Dict[str, Any]) -> Dict[str, str]:
    tasks = [t["id"] for t in instance.get("tasks", [])]
    by_task = _candidates_by_task(instance)
    binding: Dict[str, str] = {}
    shared_pid = "p_gen_shared"

    for task_id in tasks:
        options = by_task.get(task_id, [])
        if not options:
            continue
        shared = next((c for c in options if c.get("provider_id") == shared_pid), None)
        chosen = shared or options[0]
        binding[task_id] = str(chosen["id"])

    if len(tasks) >= 3:
        pivot = tasks[-1]
        options = by_task.get(pivot, [])
        current = binding.get(pivot)
        current_provider = None
        if current is not None:
            current_provider = str(_candidate_lookup(instance).get(current, {}).get("provider_id", ""))
        alternative = next(
            (c for c in options if str(c.get("provider_id", "")) != current_provider),
            None,
        )
        if alternative is not None:
            binding[pivot] = str(alternative["id"])

    return binding


def _find_hard_feasible_binding(instance: Dict[str, Any], rng: random.Random, attempts: int = 4000) -> Dict[str, str]:
    tasks = [t["id"] for t in instance.get("tasks", [])]
    by_task = _candidates_by_task(instance)
    if any(not by_task.get(tid) for tid in tasks):
        return {}

    fallback = _build_fallback_binding(instance)
    if fallback and _binding_satisfies_hard_constraints(instance, fallback):
        return fallback

    for _ in range(attempts):
        binding = {
            task_id: str(rng.choice(by_task[task_id])["id"])
            for task_id in tasks
        }
        if _binding_satisfies_hard_constraints(instance, binding):
            return binding

    return {}


def _find_same_provider_tasks(binding: Dict[str, str], instance: Dict[str, Any]) -> List[str]:
    by_id = _candidate_lookup(instance)
    tasks = sorted(binding.keys())
    provider_by_task = {
        t: str((by_id.get(binding[t], {}) or {}).get("provider_id", ""))
        for t in tasks
    }
    groups: Dict[str, List[str]] = {}
    for task_id, pid in provider_by_task.items():
        groups.setdefault(pid, []).append(task_id)
    best = []
    for group in groups.values():
        if len(group) >= 2 and len(group) > len(best):
            best = sorted(group)
    return best[:2]


def _find_different_provider_tasks(binding: Dict[str, str], instance: Dict[str, Any]) -> List[str]:
    by_id = _candidate_lookup(instance)
    tasks = sorted(binding.keys())
    provider_by_task = {
        t: str((by_id.get(binding[t], {}) or {}).get("provider_id", ""))
        for t in tasks
    }
    for a, b in itertools.combinations(tasks, 2):
        if provider_by_task.get(a) != provider_by_task.get(b):
            return [a, b]
    return []


def _pick_attribute_for_constraints(feature_defs: List[Dict[str, Any]]) -> str:
    # Prefer non-ratio MINIMIZE attributes for bounds; else fall back.
    for f in feature_defs:
        if f.get("direction") == "MINIMIZE":
            return f["id"]
    return feature_defs[0]["id"]


def _value_precision(mx: float) -> int:
    return 6 if mx <= 1.0 else 2


def _slack_amount(mn: float, mx: float) -> float:
    span = max(0.0, mx - mn)
    if span <= 0.0:
        return 0.0
    if span <= 1.0:
        return max(1e-6, 0.02 * span)
    return max(0.01, 0.005 * span)


def _relaxed_bound(value: float, direction: str, mn: float, mx: float) -> float:
    delta = _slack_amount(mn, mx)
    if direction == "MAXIMIZE":
        return _clamp(value - delta, mn, mx)
    return _clamp(value + delta, mn, mx)


def _pick_local_task_and_attribute(
    binding: Dict[str, str],
    instance: Dict[str, Any],
) -> Tuple[str, str]:
    by_id = _candidate_lookup(instance)
    by_task = _candidates_by_task(instance)
    fmap = _feature_map(instance)

    best_choice: Optional[Tuple[float, str, str]] = None
    fallback_task = sorted(binding.keys())[0]
    fallback_attr = sorted(fmap.keys())[0]

    for task_id in sorted(binding.keys()):
        selected = by_id.get(binding[task_id], {})
        selected_feats = selected.get("features", {}) or {}
        task_candidates = by_task.get(task_id, [])
        if not task_candidates:
            continue

        for attr in sorted(fmap.keys()):
            if attr not in selected_feats:
                continue
            sval = selected_feats.get(attr)
            if not isinstance(sval, (int, float)):
                continue

            fdef = fmap[attr]
            direction = str(fdef.get("direction", "MINIMIZE"))
            mn, mx = _range_for_feature(fdef)
            bound = _relaxed_bound(float(sval), direction, mn, mx)

            sat = 0
            total = 0
            for cand in task_candidates:
                cval = (cand.get("features", {}) or {}).get(attr)
                if not isinstance(cval, (int, float)):
                    continue
                total += 1
                if direction == "MAXIMIZE":
                    sat += 1 if float(cval) >= bound else 0
                else:
                    sat += 1 if float(cval) <= bound else 0

            if total == 0:
                continue

            ratio = sat / total
            if 0.2 <= ratio <= 0.8:
                score = abs(0.5 - ratio)
                if best_choice is None or score < best_choice[0]:
                    best_choice = (score, task_id, attr)

            if task_id == fallback_task and attr == fallback_attr:
                continue
            if best_choice is None:
                score = abs(0.5 - ratio)
                fallback_task = task_id
                fallback_attr = attr
                best_choice = (score + 10.0, task_id, attr)

    if best_choice is not None:
        return best_choice[1], best_choice[2]
    return fallback_task, fallback_attr


def generate_additional_constraints(
    instance: Dict[str, Any], hard: bool, rng: random.Random
) -> List[Dict[str, Any]]:
    """Add schema-consistent constraints that are feasible by construction.

    We first obtain a witness binding that satisfies all *existing hard* constraints,
    then derive GLOBAL/LOCAL/DEPENDENCY constraints from that witness.
    """

    tasks = [t["id"] for t in instance.get("tasks", [])]
    feature_defs = instance.get("features", [])
    if not tasks or not feature_defs:
        return []

    existing_ids = _id_set(instance.get("constraints", []))
    fmap = _feature_map(instance)
    by_id = _candidate_lookup(instance)
    constraints: List[Dict[str, Any]] = []

    binding = _find_hard_feasible_binding(instance, rng)
    if not binding:
        return constraints

    aggregated = _compute_aggregated_qos(instance, binding)

    # 1) GLOBAL ATTRIBUTE_BOUND from witness aggregated value.
    global_attr = _pick_attribute_for_constraints(feature_defs)
    gdef = fmap[global_attr]
    gdir = str(gdef.get("direction", "MINIMIZE"))
    gvalue = float(aggregated.get(global_attr, 0.0))
    gmn, gmx = _range_for_feature(gdef)
    gbound = _relaxed_bound(gvalue, gdir, gmn, gmx)
    constraints.append(
        {
            "id": _unique_id(f"gen_c_global_{global_attr}_", existing_ids),
            "kind": "ATTRIBUTE_BOUND",
            "scope": "GLOBAL",
            "attribute_id": global_attr,
            "op": "<=" if gdir == "MINIMIZE" else ">=",
            "value": round(gbound, _value_precision(gmx)),
            "hard": hard,
        }
    )

    # 2) LOCAL ATTRIBUTE_BOUND from witness selected candidate feature.
    local_task, local_attr = _pick_local_task_and_attribute(binding, instance)
    ldef = fmap[local_attr]
    ldir = str(ldef.get("direction", "MINIMIZE"))
    selected_cand = by_id.get(binding[local_task], {})
    lraw = float((selected_cand.get("features", {}) or {}).get(local_attr, 0.0))
    lmn, lmx = _range_for_feature(ldef)
    lvalue = _clamp(lraw, lmn, lmx) if lmn <= lmx else lraw
    lbound = _relaxed_bound(lvalue, ldir, lmn, lmx)
    constraints.append(
        {
            "id": _unique_id(f"gen_c_local_{local_task}_{local_attr}_", existing_ids),
            "kind": "ATTRIBUTE_BOUND",
            "scope": "LOCAL",
            "tasks": [local_task],
            "attribute_id": local_attr,
            "op": "<=" if ldir == "MINIMIZE" else ">=",
            "value": round(lbound, _value_precision(lmx)),
            "hard": hard,
        }
    )

    # 3) SAME_PROVIDER dependency from witness.
    same_tasks = _find_same_provider_tasks(binding, instance)
    if len(same_tasks) >= 2:
        constraints.append(
            {
                "id": _unique_id("gen_c_dep_same_", existing_ids),
                "kind": "DEPENDENCY",
                "type": "SAME_PROVIDER",
                "tasks": same_tasks,
                "hard": hard,
            }
        )

    # 4) DIFFERENT_PROVIDER dependency from witness.
    diff_tasks = _find_different_provider_tasks(binding, instance)
    if len(diff_tasks) >= 2:
        constraints.append(
            {
                "id": _unique_id("gen_c_dep_diff_", existing_ids),
                "kind": "DEPENDENCY",
                "type": "DIFFERENT_PROVIDER",
                "tasks": diff_tasks,
                "hard": hard,
            }
        )

    return constraints


def _constraint_kind_family(constraint: Dict[str, Any]) -> str:
    kind = str(constraint.get("kind", "")).upper()
    if kind == "ATTRIBUTE_BOUND":
        return "attribute_bound"
    if kind == "DEPENDENCY":
        return "dependency"
    return "other"


def _count_constraints_by_family(constraints: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    counts = {"attribute_bound": 0, "dependency": 0, "other": 0}
    for constraint in constraints:
        family = _constraint_kind_family(constraint)
        counts[family] = counts.get(family, 0) + 1
    return counts


def _select_additional_constraints_for_hard_variant(
    base_constraints: Sequence[Dict[str, Any]],
    generated_constraints: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Select generated constraints so hard variants stay within configured caps.

    Base constraints are preserved as-is. Caps apply to how many *new* constraints
    are accepted for each family, based on remaining slots after base constraints.
    """

    base_counts = _count_constraints_by_family(base_constraints)
    max_by_family = {
        "attribute_bound": MAX_HARD_ATTRIBUTE_BOUNDS_PER_INSTANCE,
        "dependency": MAX_HARD_DEPENDENCIES_PER_INSTANCE,
    }
    remaining_slots = {
        family: max(0, max_allowed - base_counts.get(family, 0))
        for family, max_allowed in max_by_family.items()
    }

    selected: List[Dict[str, Any]] = []
    selected_counts = {"attribute_bound": 0, "dependency": 0}

    for constraint in generated_constraints:
        family = _constraint_kind_family(constraint)
        if family not in remaining_slots:
            continue
        if selected_counts[family] >= remaining_slots[family]:
            continue
        selected.append(copy.deepcopy(constraint))
        selected_counts[family] += 1

    return selected

def _normalize_weights_2dp_sum1(targets: List[str], raw_weights: Dict[str, float]) -> Dict[str, float]:
    if not targets: return {}
    values = [max(float(raw_weights.get(t, 0.0)), 0.0) for t in targets]
    total = sum(values)
    if total <= 0:
        values = [1.0] * len(targets)
        total = float(len(targets))

    exact_cents = [(v / total) * 100.0 for v in values]
    base_cents = [int(math.floor(c)) for c in exact_cents]
    remainders = [c - b for c, b in zip(exact_cents, base_cents)]
    cents = base_cents[:]
    leftover = 100 - sum(cents)

    if leftover > 0:
        indices = sorted(range(len(targets)), key=lambda i: remainders[i], reverse=True)
        for i in indices[:leftover]: cents[i] += 1
    elif leftover < 0:
        indices = sorted(range(len(targets)), key=lambda i: remainders[i])
        for i in indices:
            if leftover == 0: break
            if cents[i] > 0:
                cents[i] -= 1
                leftover += 1

    return {t: round(c / 100.0, 2) for t, c in zip(targets, cents)}

def _objective_mono_one(all_features: List[str]) -> Dict[str, Any]:
    target = all_features[0]
    return {
        "type": "MONO",
        "targets": [target],
        "weights": {target: 1.0},
        "weights_sum_to_one": True,
    }


def _objective_mono_utility(all_features: List[str]) -> Dict[str, Any]:
    # Utility / weighted sum across multiple attributes (keep type MONO as requested).
    targets = list(all_features)
    weights = _normalize_weights_2dp_sum1(targets, {t: 1.0 for t in targets})
    return {
        "type": "MONO",
        "targets": targets,
        "weights": weights,
        "weights_sum_to_one": True,
    }


def _objective_multi(all_features: List[str]) -> Dict[str, Any]:
    n = 3 if len(all_features) >= 3 else 2
    targets = all_features[:n]
    return {
        "type": "MULTI",
        "targets": targets,
        "weights": _normalize_weights_2dp_sum1(targets, {t: 1.0 for t in targets}),
        "weights_sum_to_one": True,
    }


def _objective_many(all_features: List[str]) -> Dict[str, Any]:
    targets = list(all_features)
    if len(targets) < 3:
        # Should not happen after feature expansion, but keep schema-valid.
        targets = (targets * 3)[:3]
    return {
        "type": "MANY",
        "targets": targets,
        "weights": _normalize_weights_2dp_sum1(targets, {t: 1.0 for t in targets}),
        "weights_sum_to_one": True,
    }


def _expected_behavior_by_engine(objective_type: str, hard_constraints: bool) -> Dict[str, str]:
    objective = str(objective_type).upper()

    if objective == "MANY":
        return {
            "many-heuristic": "ANY_COMPLETED",
            "minizinc-csp": "VALIDATION_ERROR",
            "random-search": "VALIDATION_ERROR",
        }

    if objective == "MONO":
        if hard_constraints:
            return {
                "many-heuristic": "VALIDATION_ERROR",
                "minizinc-csp": "FEASIBLE",
                "random-search": "ANY_COMPLETED",
            }
        return {
            "many-heuristic": "VALIDATION_ERROR",
            "minizinc-csp": "VALIDATION_ERROR",
            "random-search": "ANY_COMPLETED",
        }

    if objective == "MULTI":
        return {
            "many-heuristic": "VALIDATION_ERROR",
            "minizinc-csp": "VALIDATION_ERROR",
            "random-search": "VALIDATION_ERROR",
        }

    return {
        "many-heuristic": "VALIDATION_ERROR",
        "minizinc-csp": "VALIDATION_ERROR",
        "random-search": "VALIDATION_ERROR",
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _seed_for(*parts: str) -> int:
    # Stable across runs; avoid Python's randomized hash.
    s = "|".join(parts)
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return int((h + RANDOM_SEED) & 0xFFFFFFFF)


def build_scaled_base_instance(base: Dict[str, Any]) -> Dict[str, Any]:
    instance = copy.deepcopy(base)

    # Ensure optional keys exist.
    instance.setdefault("constraints", [])

    # Expand features/providers/candidates deterministically.
    rng = random.Random(_seed_for(instance["metadata"]["id"], "scale"))
    expand_providers(instance, EXTRA_PROVIDERS_PER_SCENARIO)
    expand_features(instance, EXTRA_FEATURES_PER_SCENARIO)
    ensure_aggregation_policies_complete(instance)
    ensure_binding_space_gt(instance, TARGET_BINDING_SPACE, rng)
    return instance


def build_variant(
    base_scaled: Dict[str, Any],
    objective: Dict[str, Any],
    hard_constraints: bool,
    variant_suffix: str,
) -> Dict[str, Any]:
    inst = copy.deepcopy(base_scaled)
    inst["objective"] = objective

    base_constraints = list(inst.get("constraints", []))
    objective_type = str((objective or {}).get("type", "")).upper()
    certification_attempts: Optional[int] = None
    used_unconstrained_fallback = False

    if hard_constraints:
        hardened: List[Dict[str, Any]] = []
        for attempt in range(1, MAX_HARD_VARIANT_RETRIES + 1):
            rng = random.Random(
                _seed_for(base_scaled["metadata"]["id"], variant_suffix, "constraints", str(attempt))
            )
            additional = generate_additional_constraints(inst, hard=True, rng=rng)
            limited_additional = _select_additional_constraints_for_hard_variant(
                base_constraints,
                additional,
            )
            inst_constraints = base_constraints + limited_additional

            candidate_hardened: List[Dict[str, Any]] = []
            for c in inst_constraints:
                c2 = copy.deepcopy(c)
                c2["hard"] = True
                candidate_hardened.append(c2)

            candidate = copy.deepcopy(inst)
            candidate["constraints"] = candidate_hardened
            witness_rng = random.Random(
                _seed_for(base_scaled["metadata"]["id"], variant_suffix, "witness", str(attempt))
            )
            witness = _find_hard_feasible_binding(candidate, witness_rng)
            if witness:
                hardened = candidate_hardened
                certification_attempts = attempt
                break

        if not hardened:
            unconstrained_base = copy.deepcopy(inst)
            unconstrained_base["constraints"] = []

            for attempt in range(1, MAX_HARD_VARIANT_RETRIES + 1):
                rng = random.Random(
                    _seed_for(
                        base_scaled["metadata"]["id"],
                        variant_suffix,
                        "constraints_unconstrained",
                        str(attempt),
                    )
                )
                additional = generate_additional_constraints(unconstrained_base, hard=True, rng=rng)
                limited_additional = _select_additional_constraints_for_hard_variant(
                    [],
                    additional,
                )
                inst_constraints = list(limited_additional)

                candidate_hardened: List[Dict[str, Any]] = []
                for c in inst_constraints:
                    c2 = copy.deepcopy(c)
                    c2["hard"] = True
                    candidate_hardened.append(c2)

                candidate = copy.deepcopy(unconstrained_base)
                candidate["constraints"] = candidate_hardened
                witness_rng = random.Random(
                    _seed_for(base_scaled["metadata"]["id"], variant_suffix, "witness_unconstrained", str(attempt))
                )
                witness = _find_hard_feasible_binding(candidate, witness_rng)
                if witness:
                    hardened = candidate_hardened
                    certification_attempts = attempt
                    used_unconstrained_fallback = True
                    break

        if not hardened:
            raise RuntimeError(
                f"Could not certify hard-feasible variant after {MAX_HARD_VARIANT_RETRIES} attempts "
                f"(primary + unconstrained fallback): {base_scaled['metadata']['id']}::{variant_suffix}"
            )

        inst["constraints"] = hardened
        if any(c.get("hard", True) is False for c in inst["constraints"]):
            raise ValueError("Hard variant contains soft constraints after hardening")
        constraint_mode = "hard"
    else:
        rng = random.Random(_seed_for(base_scaled["metadata"]["id"], variant_suffix, "constraints"))
        additional = generate_additional_constraints(inst, hard=True, rng=rng)
        inst_constraints = base_constraints + additional
        softened: List[Dict[str, Any]] = []
        for c in inst_constraints:
            c2 = copy.deepcopy(c)
            c2["hard"] = False
            softened.append(c2)
        inst["constraints"] = softened
        constraint_mode = "soft"

    # Update metadata.
    base_id = base_scaled["metadata"]["id"].split("_scaled_")[0]
    inst["metadata"] = copy.deepcopy(base_scaled.get("metadata", {}))
    inst["metadata"]["id"] = f"{base_id}_{variant_suffix}_{constraint_mode}"
    inst["metadata"]["name"] = f"{inst['metadata'].get('name', base_id)} [{variant_suffix}, {constraint_mode}]"
    inst["metadata"]["created_at"] = _now_iso()

    experiments_meta = inst["metadata"].setdefault("experiments", {})
    experiments_meta["expected_feasibility_by_engine"] = _expected_behavior_by_engine(
        objective_type=objective_type,
        hard_constraints=hard_constraints,
    )
    if hard_constraints:
        experiments_meta["hard_feasible_witness_found"] = True
        experiments_meta["hard_feasible_witness_attempts"] = certification_attempts or 0
        experiments_meta["hard_constraints_from_unconstrained_fallback"] = used_unconstrained_fallback

    return inst

def main():
    output_dir = DEFAULT_OUTPUT_DIR
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Using seed: {RANDOM_SEED}")

    for filename in SCENARIOS:
        try:
            base_instance = load_scenario(filename)
        except FileNotFoundError:
            print(f"Scenario not found: {filename}")
            continue

        base_id = base_instance["metadata"]["id"]
        print(f"Processing {base_id}...")

        scaled = build_scaled_base_instance(base_instance)
        all_features = [f["id"] for f in scaled.get("features", [])]
        # Deterministic ordering for objective selection.
        all_features = sorted(all_features)

        variants: List[Tuple[str, Dict[str, Any]]] = [
            ("mono_one", _objective_mono_one(all_features)),
            ("mono_utility", _objective_mono_utility(all_features)),
            ("multi", _objective_multi(all_features)),
            ("many", _objective_many(all_features)),
        ]

        for variant_name, objective in variants:
            # Hard
            inst_hard = build_variant(
                scaled,
                objective,
                hard_constraints=True,
                variant_suffix=variant_name,
            )
            save_instance(inst_hard, output_dir, f"{base_id}_{variant_name}_hard.json")

            # Soft
            inst_soft = build_variant(
                scaled,
                objective,
                hard_constraints=False,
                variant_suffix=variant_name,
            )
            save_instance(inst_soft, output_dir, f"{base_id}_{variant_name}_soft.json")

if __name__ == "__main__":
    main()
