"""Writing an instance as separate files, one per element of the tuple.

An instance is I' = (M_A, M'_C, Delta, O). Written whole, a corpus of 105
instances built from 3 applications over 35 infrastructures repeats each
application model 35 times. Written in parts, the application model is written
once and referenced by all of them.

The wire format does not change: ``/v1/solve`` takes a whole instance, and
``compose`` is what produces one. ``split`` is the inverse, so an existing
instance can be taken apart.

Composition is a merge of disjoint keys - a key appearing in two parts is an
error, not a silent overwrite - with one deliberate exception. The
normalization bounds of the aggregation policies are per-instance data derived
from that instance's candidates, so they live in their own overlay rather than
forcing an otherwise reusable application model to be rewritten per instance.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Mapping

#: One file per component of the tuple, not merely per model: the paper
#: decomposes M_A into (T, G, Lambda) and M'_C into (P, C, F, R, L), and those
#: components vary independently. Splitting at the model level would tie the
#: task set to the aggregation policies, and a corpus whose policies depend on
#: the infrastructure could then share neither.
PART_KEYS: Dict[str, tuple] = {
    "metadata": ("metadata",),
    # M_A = (T, G, Lambda)
    "tasks": ("tasks",),
    "composition": ("composition",),
    "aggregation-policies": ("aggregation_policies",),
    # M'_C = (P, C, F, R, L)
    "providers": ("providers",),
    "candidates": ("candidates",),
    "features": ("features",),
    "resource-model": ("resource_model",),
    "latency-model": ("latency_model",),
    # Delta and O
    "constraints": ("constraints",),
    "objective": ("objective",),
}

#: The models of the tuple, as groupings of the parts above.
TUPLE_MODELS: Dict[str, tuple] = {
    "M_A": ("tasks", "composition", "aggregation-policies"),
    "M_C": ("providers", "candidates", "features", "resource-model", "latency-model"),
    "Delta": ("constraints",),
    "O": ("objective",),
}

#: Overlay applied on top of the application model; see the module docstring.
NORMALIZATION_PART = "normalization"


class PartsError(ValueError):
    """Raised when a set of parts cannot make one instance."""


def compose(parts: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    """Build one instance from its parts.

    ``parts`` maps a part name to its content, as read from the files. The
    optional ``normalization`` part maps a feature id to the ``normalize``
    block to graft onto that feature's aggregation policy.
    """
    unknown = set(parts) - set(PART_KEYS) - {NORMALIZATION_PART}
    if unknown:
        raise PartsError(f"Unknown part(s): {', '.join(sorted(unknown))}")

    instance: Dict[str, Any] = {}
    provenance: Dict[str, str] = {}
    for part_name, content in parts.items():
        if part_name == NORMALIZATION_PART:
            continue
        allowed = set(PART_KEYS[part_name])
        for key, value in content.items():
            if key not in allowed:
                raise PartsError(
                    f"'{key}' does not belong to the {part_name} part; "
                    f"it belongs to {_owner_of(key) or 'no part'}"
                )
            if key in instance:
                raise PartsError(
                    f"'{key}' is given by both {provenance[key]} and {part_name}"
                )
            instance[key] = copy.deepcopy(value)
            provenance[key] = part_name

    normalization = parts.get(NORMALIZATION_PART)
    if normalization:
        policies = instance.get("aggregation_policies")
        if not isinstance(policies, dict):
            raise PartsError("A normalization overlay needs an application model to apply to")
        for feature_id, normalize in normalization.items():
            if feature_id not in policies:
                raise PartsError(
                    f"Normalization is given for '{feature_id}', which has no aggregation policy"
                )
            policies[feature_id] = {**policies[feature_id], "normalize": copy.deepcopy(normalize)}

    return instance


def split(instance: Mapping[str, Any], *, extract_normalization: bool = True) -> Dict[str, Dict[str, Any]]:
    """Take an instance apart into its parts.

    With ``extract_normalization`` the normalize blocks are lifted out of the
    aggregation policies into their own part, which is what makes the
    application model identical across instances that differ only in their
    per-instance bounds.
    """
    parts: Dict[str, Dict[str, Any]] = {}
    for part_name, keys in PART_KEYS.items():
        content = {key: copy.deepcopy(instance[key]) for key in keys if key in instance}
        if content:
            parts[part_name] = content

    unclaimed = set(instance) - {key for keys in PART_KEYS.values() for key in keys}
    if unclaimed:
        raise PartsError(f"No part owns: {', '.join(sorted(unclaimed))}")

    if extract_normalization:
        policies = parts.get("aggregation-policies", {}).get("aggregation_policies") or {}
        normalization = {
            feature_id: policy.pop("normalize")
            for feature_id, policy in policies.items()
            if isinstance(policy, dict) and "normalize" in policy
        }
        if normalization:
            parts[NORMALIZATION_PART] = normalization

    return parts


def _owner_of(key: str) -> str:
    for part_name, keys in PART_KEYS.items():
        if key in keys:
            return part_name
    return ""
