"""Objective (O of I' = (M_A, M'_C, Delta, O)).

The canonical objective: a weighted mean of per-feature losses normalized
with instance-declared bounds, so that every engine optimizes and reports the
same number. Whether an instance uses it is decided by whether it declares
those bounds for every target.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple


def declares_normalization(instance: Dict[str, Any]) -> bool:
    """Whether the instance normalizes every one of its objective targets.

    This is what selects the canonical objective convention (a weighted mean
    of normalized losses, computed here and authoritative over whatever an
    engine reports). Instances that declare no normalization keep the plain
    weighted sum of their aggregated features and the engine's own value.

    The choice is a property of how the objective is declared, not of whether
    the instance carries placement blocks.
    """
    objective = instance.get("objective") or {}
    targets = objective.get("targets") or []
    policies = instance.get("aggregation_policies") or {}
    return bool(targets) and all(
        (policies.get(target) or {}).get("normalize") for target in targets
    )


def canonical_bounds(instance: Dict[str, Any], feature_id: str) -> Tuple[float, float]:
    """Normalization bounds for a feature: declared normalize bounds, else valid_range."""
    policy = (instance.get("aggregation_policies") or {}).get(feature_id) or {}
    norm = policy.get("normalize") or {}
    bounds = norm.get("bounds")
    if isinstance(bounds, dict) and "min" in bounds and "max" in bounds:
        return float(bounds["min"]), float(bounds["max"])

    feature = next(
        (f for f in instance.get("features", []) or [] if f.get("id") == feature_id), {}
    )
    vr = feature.get("valid_range") or {}
    return float(vr.get("min", 0.0)), float(vr.get("max", 1.0))


def canonical_loss(instance: Dict[str, Any], feature_id: str, value: float) -> float:
    """Per-feature loss in [0, 1]: 0 is best, 1 is worst."""
    mn, mx = canonical_bounds(instance, feature_id)
    if mx <= mn:
        return 0.0
    normalized = (float(value) - mn) / (mx - mn)
    normalized = min(1.0, max(0.0, normalized))

    feature = next(
        (f for f in instance.get("features", []) or [] if f.get("id") == feature_id), {}
    )
    direction = str(feature.get("direction") or "MINIMIZE").upper()
    return normalized if direction == "MINIMIZE" else 1.0 - normalized


def canonical_objective(instance: Dict[str, Any], aggregated: Dict[str, float]) -> float:
    """Weighted MEAN of losses over objective targets (lower is better).

    Dividing by the total weight makes the convention uniform across the
    reference evaluator, the Java engines and the MiniZinc model (identical
    to the plain weighted sum when the weights sum to one, as enforced by
    the gateway validation).
    """
    objective = instance.get("objective") or {}
    targets = objective.get("targets") or []
    weights = objective.get("weights") or {}

    total = 0.0
    total_weight = 0.0
    for target in targets:
        weight = float(weights.get(target, 1.0))
        total += weight * canonical_loss(instance, target, float(aggregated.get(target, 0.0)))
        total_weight += weight
    if total_weight <= 0.0:
        return 0.0
    return total / total_weight
