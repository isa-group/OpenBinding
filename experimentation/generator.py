import json
import os
import random
import copy
import argparse
import math
from typing import List, Dict, Any

# Configuration
LITERATURE_DIR = "examples/literature"
DEFAULT_OUTPUT_DIR = "experimentation/instances"
SCENARIOS = [
    "benatallah.json", "bultan.json", "cremaschi.json", 
    "netedu.json", "parejo.json", "pautasso.json", "zhang.json"
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

    # Calculate required multiplier per task to reach target
    # current_space * (multiplier ^ num_tasks) = target_space
    # multiplier = (target / current) ^ (1/num_tasks)
    
    needed_growth = target_space / max(current_space, 1)
    per_task_multiplier = math.pow(needed_growth, 1.0 / len(tasks))
    
    # We'll distribute the growth. 
    # For simplicity, we iterate tasks and add candidates until we reach target.
    # To avoid exploding one task, we try to keep them balanced.
    
    new_candidates = copy.deepcopy(instance["candidates"])
    import time
    start_time = time.time()
    
    # Build feature map for ranges
    feature_map = {f["id"]: f for f in instance["features"]}

    # Naive approach: round robin addition
    while calculate_binding_space({"candidates": new_candidates, "tasks": instance["tasks"]}) < target_space:
        # Check timeout to avoid infinite loops if something is wrong
        if time.time() - start_time > 10: 
            print(f"Warning: Timeout reaching target space {target_space} for {instance['metadata']['id']}")
            break

        # Pick a random task to scale
        t_id = random.choice(tasks)
        
        # Find existing candidates for this task
        existing = [c for c in new_candidates if c["task_id"] == t_id]
        if not existing: 
            continue # Should not happen if scenario is valid
            
        # Pick one to clone
        base_c = random.choice(existing)
        
        # Clone and perturb
        new_c = copy.deepcopy(base_c)
        new_c["id"] = f"{base_c['id']}_copy_{len(new_candidates)}"
        new_c["name"] = f"{base_c['name']} (Allocated)"
        
        # Perturb QoS features slightly (±5%) and clamp
        for feat, val in new_c["features"].items():
             if isinstance(val, (int, float)):
                 perturb = random.uniform(0.95, 1.05)
                 new_val = val * perturb
                 
                 # Clamp to valid range
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
    
    # Decision: Mix of Hard/Soft?
    # We will generate a mix.
    
    # 1. Global Attribute Bounds
    num_global = random.randint(1, len(features)) if complexity == "high" else 1
    selected_feats = random.sample(features, num_global)
    
    for f in selected_feats:
        feat_def = feature_map[f]
        vr_min = feat_def["valid_range"]["min"]
        vr_max = feat_def["valid_range"]["max"]
        direction = feat_def["direction"]
        
        is_hard = random.random() < 0.7 # 70% hard
        
        # Determine operator and value based on direction to ensure feasibility logic
        # If minimize, usually we want <= bound. Bound should be reasonably high (near max) to allow solutions.
        # If maximize, usually we want >= bound. Bound should be reasonably low (near min).
        
        if direction == "MINIMIZE":
            op = "<="
            # Random value in upper half of range
            val = vr_min + (vr_max - vr_min) * random.uniform(0.5, 0.9)
        else:
            op = ">="
            # Random value in lower half of range
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

    # 3. Dependency Constraints (mix of same/diff provider)
    if len(tasks) >= 2:
        # Dependency constraints are strictly hard usually
        # Add dependency if complexity high or random chance
        if complexity == "high" or random.random() < 0.3:
            # Build provider sets per task for feasibility checking
            providers_by_task: Dict[str, set] = {}
            for c in instance.get("candidates", []):
                tid = c["task_id"]
                if tid not in providers_by_task:
                    providers_by_task[tid] = set()
                providers_by_task[tid].add(c.get("provider_id"))

            t_pair = random.sample(tasks, 2)
            dep_type = random.choice(["SAME_PROVIDER", "DIFFERENT_PROVIDER"])

            # For SAME_PROVIDER, verify the two tasks share at least one provider
            if dep_type == "SAME_PROVIDER":
                p1 = providers_by_task.get(t_pair[0], set())
                p2 = providers_by_task.get(t_pair[1], set())
                if not p1 & p2:
                    # No shared providers — SAME_PROVIDER would be infeasible
                    dep_type = "DIFFERENT_PROVIDER"

            constraints.append({
                "id": f"c_dep_{t_pair[0]}_{t_pair[1]}_{len(constraints)}",
                "kind": "DEPENDENCY",
                "type": dep_type,
                "tasks": t_pair,
                "hard": True 
            })

    return constraints

def set_objective(instance: Dict[str, Any], obj_type: str, selected_features: List[str]):
    # 'obj_type' passed here is just a hint/category. 
    # We always set type="SINGLE" (which means weighted sum in our engine context) 
    # but vary the NUMBER of features included in the weighted sum.
    
    obj = {"type": "SINGLE"} 
    
    if obj_type == "single":
        # 'single' refers to 1 specific feature being dominant or exclusive
        # But user asked: "single does not imply ... only a unique feature"
        # So we pick 1 to 3 features, but maybe give one much higher weight?
        # Or just pick 1 feature?
        # Let's interpret "single" category here as "focused optimization".
        # We will pick 1 to all features, but typically fewer for 'single' category?
        # WAIT, the instruction says: "when type SINGLE ... does not imply ... only a unique feature ... can indicate different objectives ... givin weights"
        # So it seems 'single' in the generator logic meant "single feature", but I should change it to allow multi-feature weighted sum.
        
        # Let's randomize: 
        # 50% chance: really just 1 feature
        # 50% chance: 2+ features
        
        n_feats = random.randint(1, len(selected_features))
        targets = random.sample(selected_features, n_feats)
        
        # Random weights
        weights = {}
        for t in targets:
            weights[t] = random.uniform(0.1, 1.0)
            
        # Normalize weights? Not strictly necessary but good practice
        total_w = sum(weights.values())
        obj["targets"] = targets
        obj["weights"] = {k: round(v, 2) for k, v in weights.items()}
        
    elif obj_type == "multi":
        # 'multi' category in generator (legacy)
        # We can map this to SINGLE type but with balanced weights on 2-3 features
        n = min(len(selected_features), 3)
        if n < 2: n = len(selected_features)
        
        targets = random.sample(selected_features, n)
        obj["targets"] = targets
        obj["weights"] = {t: round(1.0/n, 2) for t in targets}
        
    elif obj_type == "many":
        # 'many' category in generator (legacy)
        # Map to SINGLE type with many features
        targets = selected_features
        obj["targets"] = targets
        obj["weights"] = {t: round(1.0/len(targets), 2) for t in targets}
        
    instance["objective"] = obj
    return instance

def main():
    parser = argparse.ArgumentParser(description="Generate composition instances.")
    parser.add_argument("--scenarios", nargs="+", default=SCENARIOS, help="Scenarios to process")
    parser.add_argument("--num-instances", type=int, default=15, help="Instances per bucket per scenario")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="Output directory")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.output_dir):
        os.makedirs(args.output_dir)
        
    random.seed(42)

    for filename in args.scenarios:
        if filename not in SCENARIOS:
             print(f"Skipping unknown scenario: {filename}")
             continue
             
        try:
            base_instance = load_scenario(filename)
        except FileNotFoundError:
            print(f"Scenario file not found: {filename}")
            continue

        base_id = base_instance["metadata"]["id"]
        available_features = [f["id"] for f in base_instance["features"]]
        
        print(f"Processing {base_id}...")

        for bucket in TARGET_BUCKETS:
            # Scale candidates ONCE for this bucket size to avoid re-computing too much
            
            # Create a base scaled instance
            scaled_inst = copy.deepcopy(base_instance)
            scaled_inst["candidates"] = vary_candidates(scaled_inst, bucket)
            
            # Now generate variations
            for i in range(args.num_instances):
                # Randomize Objective Category (affects weight distribution strategy)
                # Weighted choice: single (focused) vs multi/many (balanced)
                obj_cat = random.choices(["single", "multi", "many"], weights=[0.5, 0.3, 0.2])[0]
                
                inst = copy.deepcopy(scaled_inst)
                inst = set_objective(inst, obj_cat, available_features)
                
                # Randomize Constraints
                complexity = "high" if random.random() < 0.5 else "low"
                inst["constraints"] = generate_constraints(inst, available_features, complexity)
                
                # Metadata
                suffix = f"{bucket}_{obj_cat}_{i}"
                inst["metadata"]["id"] = f"{base_id}_{suffix}"
                inst["metadata"]["name"] = f"{base_instance['metadata']['name']} ({bucket} space, {obj_cat})"
                
                save_instance(inst, args.output_dir, f"{base_id}_{suffix}.json")

if __name__ == "__main__":
    main()
