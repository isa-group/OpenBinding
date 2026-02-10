import json
import os
import random
import copy
from typing import List, Dict, Any

# Configuration
LITERATURE_DIR = "examples/literature"
OUTPUT_DIR = "experimentation/instances"
SCENARIOS = [
    "benatallah.json", "bultan.json", "cremaschi.json", 
    "netedu.json", "parejo.json", "pautasso.json", "zhang.json"
]

def load_scenario(filename: str) -> Dict[str, Any]:
    with open(os.path.join(LITERATURE_DIR, filename), 'r') as f:
        return json.load(f)

def save_instance(instance: Dict[str, Any], name: str):
    filepath = os.path.join(OUTPUT_DIR, name)
    with open(filepath, 'w') as f:
        json.dump(instance, f, indent=2)
    print(f"Generated: {filepath}")

def subset_features(instance: Dict[str, Any], n: int) -> List[str]:
    all_features = [f["id"] for f in instance["features"]]
    if n >= len(all_features):
        return all_features
    return sorted(random.sample(all_features, n))

def vary_candidates(instance: Dict[str, Any], scale_factor: float = 1.0) -> List[Dict[str, Any]]:
    # Simple logic: duplicate candidates if scale > 1, or just keep as is.
    # For this task, we'll keep it simple: just use original candidates.
    # Implementing "random subsets" might make some tasks unsolvable if we remove the only candidate.
    # So we will just clone and maybe perturb QoS values slightly if we wanted scaling, 
    # but let's stick to original set for semantic consistency first.
    return instance["candidates"]

def generate_constraints(instance: Dict[str, Any], features: List[str], complexity: str, allow_soft: bool):
    constraints = []
    
    # helper
    tasks = [t["id"] for t in instance["tasks"]]
    
    # 1. Global Attribute Bounds
    for f in features:
        # 50% chance to add a bound
        if random.random() < 0.5:
            # Find range from features valid_range
            feat_def = next(ft for ft in instance["features"] if ft["id"] == f)
            vr_min = feat_def["valid_range"]["min"]
            vr_max = feat_def["valid_range"]["max"]
            
            # Simple bound
            constraints.append({
                "id": f"c_global_{f}",
                "kind": "ATTRIBUTE_BOUND",
                "scope": "GLOBAL",
                "attribute_id": f,
                "op": "<=" if feat_def["direction"] == "MINIMIZE" else ">=",
                "value": vr_max * 0.8 if feat_def["direction"] == "MINIMIZE" else vr_min * 1.2,
                "hard": True
            })

            # IN_RANGE (Rare)
            if random.random() < 0.2:
                 constraints.append({
                    "id": f"c_global_range_{f}",
                    "kind": "ATTRIBUTE_BOUND",
                    "scope": "GLOBAL",
                    "attribute_id": f,
                    "op": "IN_RANGE",
                    "value": {"min": vr_min, "max": vr_max},
                    "hard": True
                })

    # 2. Local Constraints
    if complexity in ["medium", "high"]:
        # Pick 1-2 random tasks
        target_tasks = random.sample(tasks, min(len(tasks), 2))
        for t in target_tasks:
             f = random.choice(features)
             feat_def = next(ft for ft in instance["features"] if ft["id"] == f)
             vr_min = feat_def["valid_range"]["min"]
             vr_max = feat_def["valid_range"]["max"]
             
             constraints.append({
                "id": f"c_local_{t}_{f}",
                "kind": "ATTRIBUTE_BOUND",
                "scope": "LOCAL",
                "tasks": [t],
                "attribute_id": f,
                "op": "<=" if feat_def["direction"] == "MINIMIZE" else ">=",
                "value": vr_max if feat_def["direction"] == "MINIMIZE" else vr_min,
                "hard": True 
             })
             
    # 3. Dependency Constraints
    if complexity == "high" and len(tasks) >= 2:
        # Same Provider
        t_pair = random.sample(tasks, 2)
        constraints.append({
            "id": f"c_dep_same_{t_pair[0]}_{t_pair[1]}",
            "kind": "DEPENDENCY",
            "type": "SAME_PROVIDER",
            "tasks": t_pair,
            "hard": True
        })

    # 4. Input Soft Constraints
    if allow_soft and constraints:
        # Make ~30% of constraints soft
        for c in constraints:
            if random.random() < 0.3:
                c["hard"] = False

    return constraints

def set_objective(instance: Dict[str, Any], obj_type: str, selected_features: List[str]):
    obj = {"type": obj_type.upper()}
    
    if obj_type == "single":
        # Use ALL available features as a single utility function (weighted sum)
        targets = selected_features
        obj["targets"] = targets
        # Equal weights
        obj["weights"] = {t: 1.0/len(targets) for t in targets}
        
    elif obj_type == "multi":
        # Pick 2-3 features
        n = min(len(selected_features), 3)
        if n < 2: return None # Can't do multi with < 2 features
        targets = selected_features[:n]
        obj["targets"] = targets
        obj["weights"] = {t: 1.0/n for t in targets}
        
    elif obj_type == "many":
        # Needs >3 features. If not enough, we can't generate TRUE many.
        # But we can try to use all.
        if len(selected_features) <= 3:
            return None
        targets = selected_features
        obj["targets"] = targets
        obj["weights"] = {t: 1.0/len(targets) for t in targets}
        
    instance["objective"] = obj
    return instance

def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    random.seed(42) # Reproducibility

    for filename in SCENARIOS:
        base_instance = load_scenario(filename)
        base_id = base_instance["metadata"]["id"]
        
        # 1. Analyze available features
        available_features = [f["id"] for f in base_instance["features"]]
        
        # Generate variants
        
        # A. Baseline Single Objective (All features, basic constraints)
        inst = copy.deepcopy(base_instance)
        inst["metadata"]["id"] = f"{base_id}_single_baseline"
        inst = set_objective(inst, "single", available_features)
        save_instance(inst, f"{base_id}_single.json")
        
        # B. Multi Objective (if possible)
        if len(available_features) >= 2:
            inst = copy.deepcopy(base_instance)
            inst["metadata"]["id"] = f"{base_id}_multi"
            inst = set_objective(inst, "multi", available_features)
            save_instance(inst, f"{base_id}_multi.json")
            
        # C. Many Objective (if possible)
        if len(available_features) > 3:
            inst = copy.deepcopy(base_instance)
            inst["metadata"]["id"] = f"{base_id}_many"
            inst = set_objective(inst, "many", available_features)
            save_instance(inst, f"{base_id}_many.json")
            
        # D. Soft Constraints (Single Obj) - Valid for RS
        inst = copy.deepcopy(base_instance)
        inst["metadata"]["id"] = f"{base_id}_soft"
        inst = set_objective(inst, "single", available_features)
        # Force add a soft constraint
        if inst.get("constraints"):
             inst["constraints"][0]["hard"] = False
        else:
             # Generate one
             inst["constraints"] = generate_constraints(inst, available_features, "low", True)
             # Ensure at least one is soft
             if inst["constraints"]:
                 inst["constraints"][0]["hard"] = False
        save_instance(inst, f"{base_id}_soft.json")

        # E. Distinct constraints (Local, Range, Dep) - Single Obj
        inst = copy.deepcopy(base_instance)
        inst["metadata"]["id"] = f"{base_id}_complex_constraints"
        inst = set_objective(inst, "single", available_features)
        inst["constraints"] = generate_constraints(inst, available_features, "high", False)
        # Ensure we have local/dep/range if possible. Generator tries to add them based on complexity="high".
        save_instance(inst, f"{base_id}_complex.json")

if __name__ == "__main__":
    main()
