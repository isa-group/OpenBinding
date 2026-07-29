"""Authoring shorthands, expanded into the one form everything else reads.

An instance can be written the long way or the short way, and the two say
exactly the same thing. This module turns the short way into the long way, once,
at the door: everything downstream - the semantic checks, the reference
evaluator, every engine - sees the canonical form and never has to know which
spelling the author used.

The rules are deliberately boring. Each one has a single expansion, no
guessing, and refuses rather than picks when an instance is ambiguous (some XOR
branches with a probability and some without, a candidate whose placement is
written twice). Expanding an already-canonical instance changes nothing, so
applying this twice is the same as applying it once.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set

from .errors import DesugarError

#: The counterpart a compact policy uses for XOR and LOOP, where the value is
#: weighted by a probability or repeated by an iteration count. Only the
#: accumulating functions have one: a sum over branches becomes an expectation
#: and a product becomes a power, while the worst or best of several branches
#: is still the worst or best however likely each of them is.
_SCALED_FN = {
    "SUM": "SCALED_SUM",
    "PRODUCT": "SCALED_PRODUCT",
}

_CHILD_KINDS = ("SEQ", "AND")


def desugar_instance(instance: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the canonical form of ``instance``.

    Pure and idempotent: the argument is not modified, and desugaring the
    result again returns an equal document. An instance that is already
    canonical is returned as it came, so callers that evaluate thousands of
    bindings against one instance do not pay for a copy each time.
    """
    if not isinstance(instance, Mapping):
        return instance  # type: ignore[return-value]

    if not has_shorthand(instance):
        return instance  # type: ignore[return-value]

    out = copy.deepcopy(dict(instance))

    _expand_composition(out)
    _expand_aggregation_policies(out)
    _expand_objective_weights(out)
    _expand_placement(out)

    return out


def has_shorthand(instance: Mapping[str, Any]) -> bool:
    """Whether anything in ``instance`` still has to be expanded.

    Cheap enough to ask before every evaluation, which is what lets the
    canonical case skip the copy entirely.
    """
    if _node_has_shorthand((instance.get("composition") or {}).get("root")):
        return True

    policies = instance.get("aggregation_policies")
    if isinstance(policies, dict):
        if any(isinstance(p, dict) and "fn" in p for p in policies.values()):
            return True

    objective = instance.get("objective")
    if isinstance(objective, dict) and objective.get("targets") and not objective.get("weights"):
        return True

    candidates = instance.get("candidates")
    if isinstance(candidates, list):
        if any(isinstance(c, dict) and "placement" in c for c in candidates):
            return True

    resource_model = instance.get("resource_model")
    if isinstance(resource_model, dict):
        if not resource_model.get("resources"):
            return True
        if resource_model.get("constraints") is None:
            return True
        for constraint in resource_model.get("constraints") or []:
            if isinstance(constraint, dict) and (
                not constraint.get("resources") or "hard" not in constraint
            ):
                return True
        if "candidate_bindings" not in resource_model:
            return True

    return False


def _node_has_shorthand(node: Any) -> bool:
    if isinstance(node, str):
        return True
    if not isinstance(node, dict):
        return False
    for child in node.get("children") or []:
        if _node_has_shorthand(child):
            return True
    for branch in node.get("branches") or []:
        if not isinstance(branch, dict):
            continue
        if branch.get("p") is None:
            return True
        if _node_has_shorthand(branch.get("child")):
            return True
    if "body" in node and _node_has_shorthand(node.get("body")):
        return True
    return False


# --- G: bare task ids as composition leaves, uniform XOR probabilities -------


def _expand_composition(instance: Dict[str, Any]) -> None:
    composition = instance.get("composition")
    if not isinstance(composition, dict) or "root" not in composition:
        return

    used_ids: Set[str] = set()
    _collect_node_ids(composition.get("root"), used_ids)
    composition["root"] = _expand_node(composition.get("root"), used_ids)


def _collect_node_ids(node: Any, out: Set[str]) -> None:
    """Ids an author wrote by hand, so generated ones can avoid them."""
    if not isinstance(node, dict):
        return
    node_id = node.get("id")
    if isinstance(node_id, str):
        out.add(node_id)
    for child in node.get("children") or []:
        _collect_node_ids(child, out)
    for branch in node.get("branches") or []:
        if isinstance(branch, dict):
            _collect_node_ids(branch.get("child"), out)
    if "body" in node:
        _collect_node_ids(node.get("body"), out)


def _generated_node_id(task_id: str, used_ids: Set[str]) -> str:
    candidate = f"n_{task_id}"
    if candidate not in used_ids:
        used_ids.add(candidate)
        return candidate
    suffix = 2
    while f"{candidate}_{suffix}" in used_ids:
        suffix += 1
    generated = f"{candidate}_{suffix}"
    used_ids.add(generated)
    return generated


def _expand_node(node: Any, used_ids: Set[str]) -> Any:
    if isinstance(node, str):
        return {"id": _generated_node_id(node, used_ids), "kind": "TASK", "task_id": node}
    if not isinstance(node, dict):
        return node

    kind = str(node.get("kind") or "").upper()

    if kind in _CHILD_KINDS and isinstance(node.get("children"), list):
        node["children"] = [_expand_node(child, used_ids) for child in node["children"]]
    elif kind == "XOR" and isinstance(node.get("branches"), list):
        node["branches"] = _expand_branches(node, used_ids)
    elif kind == "LOOP" and "body" in node:
        node["body"] = _expand_node(node.get("body"), used_ids)

    return node


def _expand_branches(node: Dict[str, Any], used_ids: Set[str]) -> List[Any]:
    branches = [b for b in node.get("branches") or []]
    declared = [isinstance(b, dict) and b.get("p") is not None for b in branches]

    if any(declared) and not all(declared):
        node_id = node.get("id") or "XOR"
        raise DesugarError(
            f"Exclusive choice '{node_id}' declares a probability for some branches "
            "and not others; give one for every branch or for none of them"
        )

    expanded: List[Any] = []
    uniform = 1.0 / len(branches) if branches and not any(declared) else None
    for branch in branches:
        if not isinstance(branch, dict):
            expanded.append(branch)
            continue
        branch = dict(branch)
        if uniform is not None:
            branch["p"] = uniform
        branch["child"] = _expand_node(branch.get("child"), used_ids)
        expanded.append(branch)
    return expanded


# --- Lambda: one function for every operator --------------------------------


def _expand_aggregation_policies(instance: Dict[str, Any]) -> None:
    policies = instance.get("aggregation_policies")
    if not isinstance(policies, dict):
        return

    for feature_id, policy in policies.items():
        if not isinstance(policy, dict) or "fn" not in policy:
            continue
        if policy.get("compose"):
            raise DesugarError(
                f"Aggregation policy for '{feature_id}' gives both a compact 'fn' and "
                "an explicit 'compose'; keep one of them"
            )
        fn = str(policy.pop("fn") or "").upper()
        scaled = _SCALED_FN.get(fn, fn)
        policy["compose"] = {
            "seq": {"fn": fn},
            "and": {"fn": fn},
            "xor": {"fn": scaled},
            "loop": {"fn": scaled},
        }


# --- O: every target weighs the same ----------------------------------------


def _expand_objective_weights(instance: Dict[str, Any]) -> None:
    objective = instance.get("objective")
    if not isinstance(objective, dict) or objective.get("weights"):
        return
    targets = [str(t) for t in objective.get("targets") or []]
    if not targets:
        return
    objective["weights"] = {target: 1.0 / len(targets) for target in targets}


# --- R: inline placement, inferred resources, the default capacity check ----


def _expand_placement(instance: Dict[str, Any]) -> None:
    candidates = instance.get("candidates")
    inline = _take_inline_placements(candidates)

    resource_model = instance.get("resource_model")
    if not isinstance(resource_model, dict):
        if inline:
            raise DesugarError(
                "Candidates declare a placement but the instance has no resource_model "
                "to place them in"
            )
        return

    _merge_inline_bindings(resource_model, inline)
    _infer_resources(resource_model)
    _inject_capacity_constraint(resource_model)


def _take_inline_placements(candidates: Any) -> List[Dict[str, Any]]:
    """Lift each candidate's own placement out into a binding."""
    bindings: List[Dict[str, Any]] = []
    if not isinstance(candidates, list):
        return bindings
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        placement = candidate.pop("placement", None)
        if not isinstance(placement, dict):
            continue
        bindings.append(
            {
                "candidate_id": candidate.get("id"),
                "pool_id": placement.get("pool"),
                "demand": dict(placement.get("demand") or {}),
            }
        )
    return bindings


def _merge_inline_bindings(
    resource_model: Dict[str, Any], inline: List[Dict[str, Any]]
) -> None:
    existing = resource_model.get("candidate_bindings")
    if not isinstance(existing, list):
        existing = []
    already_bound = {
        b.get("candidate_id") for b in existing if isinstance(b, dict)
    }
    for binding in inline:
        if binding["candidate_id"] in already_bound:
            raise DesugarError(
                f"Candidate '{binding['candidate_id']}' declares a placement of its own "
                "and also has a candidate_bindings entry; keep one of them"
            )
    if inline or "candidate_bindings" not in resource_model:
        resource_model["candidate_bindings"] = list(existing) + inline


def _infer_resources(resource_model: Dict[str, Any]) -> None:
    if resource_model.get("resources"):
        return
    names: List[str] = []
    seen: Set[str] = set()

    def add(keys: Iterable[Any]) -> None:
        for key in keys:
            name = str(key)
            if name not in seen:
                seen.add(name)
                names.append(name)

    for pool in resource_model.get("pools") or []:
        if isinstance(pool, dict):
            add((pool.get("capacity") or {}).keys())
    for binding in resource_model.get("candidate_bindings") or []:
        if isinstance(binding, dict):
            add((binding.get("demand") or {}).keys())

    if names:
        resource_model["resources"] = names


def _inject_capacity_constraint(resource_model: Dict[str, Any]) -> None:
    """An absent constraint list means the obvious check; an empty one means none."""
    constraints = resource_model.get("constraints")
    resources = list(resource_model.get("resources") or [])

    if constraints is None:
        if not resources:
            resource_model["constraints"] = []
            return
        resource_model["constraints"] = [
            {
                "id": "resource_capacity",
                "kind": "DEPENDENCY",
                "type": "RESOURCE_CAPACITY",
                "scope": "ALL_POOLS",
                "resources": resources,
                "hard": True,
            }
        ]
        return

    for constraint in constraints:
        if not isinstance(constraint, dict):
            continue
        if not constraint.get("resources") and resources:
            constraint["resources"] = list(resources)
        constraint.setdefault("hard", True)


def sharing_of(feature: Optional[Mapping[str, Any]]) -> str:
    """How a feature accounts for a candidate serving several tasks at once."""
    if not isinstance(feature, Mapping):
        return "REPLICATE"
    return str(feature.get("sharing") or "REPLICATE").upper()
