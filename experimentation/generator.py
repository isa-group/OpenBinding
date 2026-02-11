import json
import os
import random
import copy
import argparse
import math
import time
from typing import List, Dict, Any

# Configuration
LITERATURE_DIR = "examples/literature"
DEFAULT_OUTPUT_DIR = "experimentation/instances"
SCENARIOS = [
    "benatallah.json", "bultan.json", "cremaschi.json", 
    "netedu.json", "pautasso.json", "zhang.json"
]

TARGET_BUCKETS = [128, 1024, 4096, 65536, 131072, 262144, 524288, 1048576]

def load_scenario(filename: str) -> Dict[str, Any]:
    with open(os.path.join(LITERATURE_DIR, filename), 'r') as f:
        return json.load(f)

def save_instance(instance: Dict[str, Any], output_dir: str, name: str):
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
    filepath = os.path.join(output_dir, name)
    with open(filepath, 'w') as f:
        json.dump(instance, f, indent=2)
    print(f"Generated: {filepath}")

def calculate_binding_space(instance: Dict[str, Any]) -> int:
    task_candidates = {}
    for c in instance["candidates"]:
        t_id = c["task_id"]
        task_candidates[t_id] = task_candidates.get(t_id, 0) + 1
    
    space = 1
    if not task_candidates:
        return 0
    for count in task_candidates.values():
        space *= count
    return space

def vary_candidates(instance: Dict[str, Any], target_space: int) -> List[Dict[str, Any]]:
    current_space = calculate_binding_space(instance)
    if current_space >= target_space:
        return instance["candidates"]
    
    tasks = [t["id"] for t in instance["tasks"]]
    if not tasks:
        return instance["candidates"]
    
    needed_growth = target_space / max(current_space, 1)
    
    new_candidates = copy.deepcopy(instance["candidates"])
    start_time = time.time()
    feature_map = {f["id"]: f for f in instance["features"]}

    while calculate_binding_space({"candidates": new_candidates, "tasks": instance["tasks"]}) < target_space:
        if time.time() - start_time > 10: 
            print(f"Warning: Timeout reaching target space {target_space} for {instance['metadata']['id']}")
            break

        t_id = random.choice(tasks)
        existing = [c for c in new_candidates if c["task_id"] == t_id]
        if not existing: continue 
            
        base_c = random.choice(existing)
        new_c = copy.deepcopy(base_c)
        new_c["id"] = f"{base_c['id']}_copy_{len(new_candidates)}"
        new_c["name"] = f"{base_c['name']} (Allocated)"
        
        for feat, val in new_c["features"].items():
             if isinstance(val, (int, float)):
                 perturb = random.uniform(0.95, 1.05)
                 new_val = val * perturb
                 f_def = feature_map.get(feat)
                 if f_def and "valid_range" in f_def:
                     vr = f_def["valid_range"]
                     mn = vr.get("min", float("-inf"))
                     mx = vr.get("max", float("inf"))
                     new_val = max(mn, min(new_val, mx))
                 new_c["features"][feat] = round(new_val, 2)
        
        new_candidates.append(new_c)
        
    return new_candidates

def generate_constraints(instance: Dict[str, Any], features: List[str], complexity: str):
    constraints = []
    tasks = [t["id"] for t in instance["tasks"]]
    feature_map = {f["id"]: f for f in instance["features"]}
    
    if not features: return []

    # 1. Global Attribute Bounds
    num_global = random.randint(1, len(features)) if complexity == "high" else 1
    selected_feats = random.sample(features, num_global)
    
    for f in selected_feats:
        feat_def = feature_map[f]
        vr_min = feat_def["valid_range"]["min"]
        vr_max = feat_def["valid_range"]["max"]
        direction = feat_def["direction"]
        
        is_hard = random.random() < 0.7 
        
        if direction == "MINIMIZE":
            op = "<="
            val = vr_min + (vr_max - vr_min) * random.uniform(0.5, 0.9)
        else:
            op = ">="
            val = vr_min + (vr_max - vr_min) * random.uniform(0.1, 0.5)

        constraints.append({
            "id": f"c_global_{f}_{len(constraints)}",
            "kind": "ATTRIBUTE_BOUND",
            "scope": "GLOBAL",
            "attribute_id": f,
            "op": op,
            "value": round(val, 2),
            "hard": is_hard
        })

    # 2. Local Constraints
    if complexity == "high" or random.random() < 0.5:
        target_tasks = random.sample(tasks, min(len(tasks), 2))
        for t in target_tasks:
             f = random.choice(features)
             feat_def = feature_map[f]
             vr_min = feat_def["valid_range"]["min"]
             vr_max = feat_def["valid_range"]["max"]
             direction = feat_def["direction"]
             
             if direction == "MINIMIZE":
                op = "<="
                val = vr_min + (vr_max - vr_min) * random.uniform(0.6, 0.95)
             else:
                op = ">="
                val = vr_min + (vr_max - vr_min) * random.uniform(0.05, 0.4)

             constraints.append({
                "id": f"c_local_{t}_{f}_{len(constraints)}",
                "kind": "ATTRIBUTE_BOUND",
                "scope": "LOCAL",
                "tasks": [t],
                "attribute_id": f,
                "op": op,
                "value": round(val, 2),
                "hard": random.random() < 0.8
             })

    # 3. Dependency Constraints
    if len(tasks) >= 2:
        if complexity == "high" or random.random() < 0.3:
            providers_by_task = {}
            for c in instance.get("candidates", []):
                tid = c["task_id"]
                if tid not in providers_by_task: providers_by_task[tid] = set()
                if c.get("provider_id"):
                    providers_by_task[tid].add(c.get("provider_id"))

            t_pair = random.sample(tasks, 2)
            p1 = providers_by_task.get(t_pair[0], set())
            p2 = providers_by_task.get(t_pair[1], set())

            same_possible = len(p1 & p2) > 0
            diff_possible = len(p1 | p2) >= len(t_pair) and len(p1) > 0 and len(p2) > 0

            if same_possible or diff_possible:
                if same_possible and diff_possible:
                    dep_type = random.choice(["SAME_PROVIDER", "DIFFERENT_PROVIDER"])
                elif same_possible:
                    dep_type = "SAME_PROVIDER"
                else:
                    dep_type = "DIFFERENT_PROVIDER"

                constraints.append({
                    "id": f"c_dep_{t_pair[0]}_{t_pair[1]}_{len(constraints)}",
                    "kind": "DEPENDENCY",
                    "type": dep_type,
                    "tasks": t_pair,
                    "hard": True
                })

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

def set_objective(instance: Dict[str, Any], obj_cat: str, selected_features: List[str]):
    obj = {}
    num_features = len(selected_features)
    
    # Logic adjustment: Fallback if not enough features
    if num_features < 2 and obj_cat in ["multi", "many"]:
        obj_cat = "single"
    elif num_features < 3 and obj_cat == "many":
        obj_cat = "multi"

    if obj_cat == "single":
        obj["type"] = "SINGLE"
        targets = random.sample(selected_features, 1)
        obj["targets"] = targets
        obj["weights"] = {targets[0]: 1.0}
        
    elif obj_cat == "multi":
        obj["type"] = "MULTI"
        n = random.randint(2, min(num_features, 3))
        targets = random.sample(selected_features, n)
        obj["targets"] = targets
        obj["weights"] = _normalize_weights_2dp_sum1(targets, {t: 1.0 for t in targets})
        
    elif obj_cat == "many":
        obj["type"] = "MANY"
        n = random.randint(3, num_features)
        targets = random.sample(selected_features, n)
        obj["targets"] = targets
        obj["weights"] = _normalize_weights_2dp_sum1(targets, {t: 1.0 for t in targets})
        
    instance["objective"] = obj
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate composition instances.")
    parser.add_argument("--scenarios", nargs="+", default=SCENARIOS, help="Scenarios to process")
    parser.add_argument("--num-instances", type=int, default=1, help="Instances per bucket per scenario")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="Output directory")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.output_dir):
        os.makedirs(args.output_dir)
        
    random.seed(42)

    for filename in args.scenarios:
        if filename not in SCENARIOS: continue
        try:
            base_instance = load_scenario(filename)
        except FileNotFoundError:
            print(f"Scenario not found: {filename}")
            continue

        base_id = base_instance["metadata"]["id"]
        available_features = [f["id"] for f in base_instance["features"]]
        
        print(f"Processing {base_id}...")

        for bucket in TARGET_BUCKETS:
            scaled_inst = copy.deepcopy(base_instance)
            scaled_inst["candidates"] = vary_candidates(scaled_inst, bucket)
            
            for i in range(args.num_instances):
                idx = TARGET_BUCKETS.index(bucket)
                if idx % 3 == 0: obj_cat = "single"
                elif idx % 3 == 1: obj_cat = "multi"
                else: obj_cat = "many"
                
                inst = copy.deepcopy(scaled_inst)
                inst = set_objective(inst, obj_cat, available_features)
                
                complexity = "high" if random.random() < 0.5 else "low"
                inst["constraints"] = generate_constraints(inst, available_features, complexity)
                
                suffix = f"{bucket}_{obj_cat}_{i}"
                inst["metadata"]["id"] = f"{base_id}_{suffix}"
                inst["metadata"]["name"] = f"{base_instance['metadata']['name']} ({bucket} space, {obj_cat})"
                
                save_instance(inst, args.output_dir, f"{base_id}_{suffix}.json")

if __name__ == "__main__":
    main()
