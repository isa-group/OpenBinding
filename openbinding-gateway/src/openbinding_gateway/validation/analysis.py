from typing import Dict, Any, List, Optional
import math
from ..models.api import BindingSpaceSummary, AnalyzeWarning

def compute_binding_space_summary(instance: Dict[str, Any]) -> BindingSpaceSummary:
    """
    Computes the binding space summary from the problem instance.
    """
    tasks = instance.get("tasks", [])
    candidates = instance.get("candidates", [])
    
    # Map task_id to count. Initialize with 0 for all tasks.
    task_counts: Dict[str, int] = {t.get("id"): 0 for t in tasks if t.get("id")}
    
    # Count candidates per task
    for cand in candidates:
        t_id = cand.get("task_id")
        if t_id in task_counts:
            task_counts[t_id] += 1
            
    per_task_counts = task_counts
    empty_tasks = [tid for tid, count in per_task_counts.items() if count == 0]
    
    # Compute cardinality
    # Use python int for arbitrary precision
    cardinality_val = 1
    log10_val = 0.0
    
    if not per_task_counts:
        cardinality_val = 0
        log10_val = 0.0
    elif empty_tasks:
        cardinality_val = 0
        # log10(0) is undefined, but for our purpose if binding space is 0, practically log10 doesn't make sense 
        # or we can treat as -inf. But let's keeping it 0.0 or handle gracefully.
        # If there are empty tasks, the space is empty.
        log10_val = 0.0 
    else:
        for count in per_task_counts.values():
            cardinality_val *= count
            log10_val += math.log10(count)
            
    return BindingSpaceSummary(
        cardinality=str(cardinality_val),
        log10_cardinality=log10_val,
        per_task_counts=per_task_counts,
        empty_tasks=empty_tasks
    )

def generate_warnings(summary: BindingSpaceSummary) -> List[AnalyzeWarning]:
    warnings = []
    
    # 1. Empty Tasks
    if summary.empty_tasks:
        warnings.append(AnalyzeWarning(
            code="EMPTY_TASK",
            message=f"Found {len(summary.empty_tasks)} tasks with 0 candidates. The binding space is empty.",
            details={"empty_task_ids": summary.empty_tasks}
        ))
        
    # 2. Combinatorial Explosion
    # Threshold: e.g. 10^8 or 10^10. Let's say log10 >= 9 (1 billion)
    if summary.log10_cardinality >= 9.0:
        warnings.append(AnalyzeWarning(
            code="COMBINATORIAL_EXPLOSION",
            message="The binding space is very large. Solvers may time out or run out of memory.",
            details={
                "log10_cardinality": summary.log10_cardinality,
                "cardinality": summary.cardinality
            }
        ))
        
    return warnings

def generate_binding_space_subset(instance: Dict[str, Any], offset: int, limit: int) -> Dict[str, Any]:
    """
    Generates a subset of the binding space for the given instance,
    starting at 'offset' and returning at most 'limit' bindings.
    
    Returns a dictionary containing:
    - total_combinations: str
    - offset: int
    - limit: int
    - bindings: List[Dict[str, str]]
    """
    tasks = instance.get("tasks", [])
    candidates = instance.get("candidates", [])
    
    # 1. Organize candidates by task
    # task_candidates: List of (task_id, [candidate_ids])
    task_map = {} # task_id -> list of candidate_ids
    for t in tasks:
        t_id = t.get("id")
        if t_id:
            task_map[t_id] = []
            
    for cand in candidates:
        t_id = cand.get("task_id")
        c_id = cand.get("id")
        if t_id in task_map and c_id:
            task_map[t_id].append(c_id)
            
    # Filter out tasks that have 0 candidates? 
    # If any task has 0 candidates, the cartesian product is empty.
    # However, 'tasks' list order matters for consistent indexing.
    # We will use the order of tasks as defined in 'tasks' list.
    
    ordered_tasks = []
    for t in tasks:
        t_id = t.get("id")
        if t_id:
            cands = task_map.get(t_id, [])
            if not cands:
                # Empty space
                return {
                    "total_combinations": "0",
                    "offset": offset,
                    "limit": limit,
                    "bindings": []
                }
            ordered_tasks.append((t_id, cands))
            
    if not ordered_tasks:
        return {
            "total_combinations": "0",
            "offset": offset,
            "limit": limit,
            "bindings": []
        }

    # 2. Calculate Total Size and Strides
    # We want to map a linear index 'k' to a combination.
    # We can use a mixed-radix representation.
    # Let N_i be the number of candidates for task i.
    # Total = N_0 * N_1 * ... * N_{m-1}
    
    # To handle potentially huge numbers, we use python's arbitrary precision ints.
    total_combinations = 1
    for _, cands in ordered_tasks:
        total_combinations *= len(cands)
        
    if offset >= total_combinations:
         return {
            "total_combinations": str(total_combinations),
            "offset": offset,
            "limit": limit,
            "bindings": []
        }
    
    # Calculate strides for decoding.
    # For tasks T0, T1, ..., Tm-1 with counts C0, C1, ..., Cm-1
    # Index idx can be decoded.
    # We prefer the layout where the LAST task changes fastest (successive indices differ by last task).
    # This is equivalent to "Row-major" or similar.
    # Let's say we have 2 tasks: T1 (2 opts), T2 (2 opts).
    # 0 -> T1:0, T2:0
    # 1 -> T1:0, T2:1
    # 2 -> T1:1, T2:0
    # ...
    # So Stride for Tm-1 is 1.
    # Stride for T i is Product(C_{j}) for j > i.
    
    num_tasks = len(ordered_tasks)
    strides = [1] * num_tasks
    current_stride = 1
    # We iterate backwards to calculate strides
    for i in range(num_tasks - 1, -1, -1):
        strides[i] = current_stride
        current_stride *= len(ordered_tasks[i][1])
        
    # 3. Generate Subset
    generated_bindings = []
    
    end_index = min(offset + limit, total_combinations)
    
    for k in range(offset, end_index):
        binding = {}
        for i in range(num_tasks):
            t_id, cands = ordered_tasks[i]
            count = len(cands)
            stride = strides[i]
            
            # The index for this task at global index k is:
            # (k // stride) % count
            candidate_idx = (k // stride) % count
            binding[t_id] = cands[candidate_idx]
            
        generated_bindings.append(binding)
        
    return {
        "total_combinations": str(total_combinations),
        "offset": offset,
        "limit": limit,
        "bindings": generated_bindings
    }
