"""Problem semantics, one module per element of the BIM tuple.

The paper defines a placement-aware instance as I' = (M_A, M'_C, Delta, O)
with M_A = (T, G, Lambda) and M'_C = (P, C, F, R, L). The modules here follow
that decomposition, so each part can be read, tested and reused on its own:

    application.py    G       composition reading and XOR scenario expansion
    aggregation.py    Lambda  how features compose along the workflow
    placement.py      R, L    pools, capacities, and network latency
    constraints.py    Delta   what a binding must satisfy
    objective.py      O       the canonical objective
    desugar.py                authoring shorthands, expanded once at the door
    evaluator.py              the four of them, applied to one binding
    canonicalization.py       the response every engine's answer becomes
"""

from .aggregation import (
    apply_sharing,
    build_selected_candidate_by_task,
    compute_aggregated_qos,
    compute_objective_value,
    normalize_qos,
    share_counts,
)
from .application import build_scenarios, composition_task_ids
from .canonicalization import canonicalize_result_data
from .constraints import check_bound
from .desugar import desugar_instance, sharing_of
from .errors import DesugarError, PlacementError
from .evaluator import evaluate_solution
from .objective import (
    canonical_bounds,
    canonical_loss,
    canonical_objective,
    declares_normalization,
)
from .placement import PlacementModel

__all__ = [
    "DesugarError",
    "PlacementError",
    "PlacementModel",
    "apply_sharing",
    "build_scenarios",
    "build_selected_candidate_by_task",
    "canonical_bounds",
    "canonical_loss",
    "canonical_objective",
    "canonicalize_result_data",
    "check_bound",
    "composition_task_ids",
    "compute_aggregated_qos",
    "compute_objective_value",
    "declares_normalization",
    "desugar_instance",
    "evaluate_solution",
    "normalize_qos",
    "share_counts",
    "sharing_of",
]
