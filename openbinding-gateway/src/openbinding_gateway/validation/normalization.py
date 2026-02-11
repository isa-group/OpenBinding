from __future__ import annotations

from typing import Any, Dict


SUPPORTED_OBJECTIVE_TYPES = {"SINGLE", "MULTI", "MANY"}


def apply_objective_defaults(instance: Dict[str, Any]) -> None:
    """Apply semantic defaults that JSON Schema `default` does not materialize.

    Currently:
    - `objective.weights_sum_to_one` defaults to `True` for SINGLE/MULTI/MANY objectives.

    Mutates `instance` in place.
    """
    obj = instance.get("objective")
    if not isinstance(obj, dict):
        return

    if obj.get("type") not in SUPPORTED_OBJECTIVE_TYPES:
        return

    if "weights_sum_to_one" not in obj:
        obj["weights_sum_to_one"] = True
