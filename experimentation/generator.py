import copy
import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Set, Tuple

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

TARGET_BINDING_SPACE = 1024
EXTRA_FEATURES_PER_SCENARIO = 3
EXTRA_PROVIDERS_PER_SCENARIO = 5

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


def _pick_attribute_for_constraints(feature_defs: List[Dict[str, Any]]) -> str:
    # Prefer non-ratio MINIMIZE attributes for bounds; else fall back.
    for f in feature_defs:
        if f.get("direction") == "MINIMIZE":
            return f["id"]
    return feature_defs[0]["id"]


def generate_additional_constraints(instance: Dict[str, Any], hard: bool) -> List[Dict[str, Any]]:
    """Add constraints covering all types, keeping them *feasible-ish* and schema-consistent.

    Types covered:
      - ATTRIBUTE_BOUND GLOBAL
      - ATTRIBUTE_BOUND LOCAL (tasks-based)
      - DEPENDENCY SAME_PROVIDER (inclusion)
      - DEPENDENCY DIFFERENT_PROVIDER (exclusion)
    """

    tasks = [t["id"] for t in instance.get("tasks", [])]
    feature_defs = instance.get("features", [])
    if not tasks or not feature_defs:
        return []

    existing_ids = _id_set(instance.get("constraints", []))
    fmap = _feature_map(instance)
    constraints: List[Dict[str, Any]] = []

    # 1) Global attribute bound (choose a lenient but consistent bound).
    global_attr = _pick_attribute_for_constraints(feature_defs)
    fdef = fmap[global_attr]
    mn, mx = _range_for_feature(fdef)
    direction = fdef.get("direction")
    if direction == "MINIMIZE":
        op = "<="
        val = mn + 0.90 * (mx - mn)
    else:
        op = ">="
        val = mn + 0.10 * (mx - mn)
    constraints.append(
        {
            "id": _unique_id(f"gen_c_global_{global_attr}_", existing_ids),
            "kind": "ATTRIBUTE_BOUND",
            "scope": "GLOBAL",
            "attribute_id": global_attr,
            "op": op,
            "value": round(val, 6 if mx <= 1.0 else 2),
            "hard": hard,
        }
    )

    # 2) Local attribute bound (pick a task and a feature; choose value based on candidate distribution).
    local_task = tasks[0]
    local_attr = feature_defs[min(1, len(feature_defs) - 1)]["id"]
    lfdef = fmap[local_attr]
    lmn, lmx = _range_for_feature(lfdef)
    ldir = lfdef.get("direction")

    values = [
        float(c.get("features", {}).get(local_attr))
        for c in instance.get("candidates", [])
        if c.get("task_id") == local_task and isinstance(c.get("features", {}).get(local_attr), (int, float))
    ]
    if not values:
        values = [lmn, (lmn + lmx) / 2.0, lmx]
    if ldir == "MINIMIZE":
        op2 = "<="
        val2 = _quantile(values, 0.80)
    else:
        op2 = ">="
        val2 = _quantile(values, 0.20)
    val2 = _clamp(val2, lmn, lmx)
    constraints.append(
        {
            "id": _unique_id(f"gen_c_local_{local_task}_{local_attr}_", existing_ids),
            "kind": "ATTRIBUTE_BOUND",
            "scope": "LOCAL",
            "tasks": [local_task],
            "attribute_id": local_attr,
            "op": op2,
            "value": round(val2, 6 if lmx <= 1.0 else 2),
            "hard": hard,
        }
    )

    # 3) Dependency SAME_PROVIDER (inclusion): ensure shared provider exists & candidates were created.
    same_tasks = tasks[:3] if len(tasks) >= 3 else tasks[:2]
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

    # 4) Dependency DIFFERENT_PROVIDER (exclusion)
    if len(tasks) >= 2:
        diff_tasks = [tasks[-2], tasks[-1]] if len(tasks) >= 2 else tasks
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

    # Add additional constraints (hard first); then soften if needed.
    additional = generate_additional_constraints(inst, hard=True)
    inst_constraints = list(inst.get("constraints", [])) + additional

    if hard_constraints:
        inst["constraints"] = inst_constraints
        constraint_mode = "hard"
    else:
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
