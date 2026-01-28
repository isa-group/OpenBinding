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
