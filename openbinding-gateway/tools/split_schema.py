"""Split the general schema into one file per element of the BIM tuple.

The paper defines a placement-aware instance as I' = (M_A, M'_C, Delta, O),
with M_A = (T, G, Lambda) and M'_C = (P, C, F, R, L). This turns that
decomposition into the physical layout of schemas/general/, so each model can
be referenced, reused and read on its own.

Run once from the repository root; the result is committed, not generated at
build time.

    python openbinding-gateway/tools/split_schema.py
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
GENERAL = os.path.join(REPO_ROOT, "schemas", "general")
BASE_URI = "https://openbinding.score.us.es/api/v1/schemas/general"

# Which $defs belong to which model. Every def is claimed exactly once.
MODULES: Dict[str, Dict[str, Any]] = {
    "common": {
        "title": "Shared value objects",
        "description": "Primitives every model draws on.",
        "defs": ["identifier", "numeric_range"],
        "properties": [],
    },
    "application-model": {
        "title": "Application model (M_A = (T, G, Lambda))",
        "description": (
            "What the application is, independently of who can run it: its abstract "
            "tasks (T), the orchestration that composes them (G), and the policies "
            "that say how a quality attribute aggregates along that composition "
            "(Lambda). Reusable across every infrastructure the application can be "
            "deployed on."
        ),
        "defs": [
            "structured_tree", "node", "task_node", "element_node", "seq_node",
            "and_node", "xor_node", "loop_node", "aggregation_policy",
            "normalization", "compose_fn",
        ],
        "properties": ["tasks", "composition", "aggregation_policies"],
    },
    "candidate-model": {
        "title": "Candidate model (M'_C = (P, C, F, R, L))",
        "description": (
            "What can actually run the application: the providers (P), their "
            "candidate implementations (C) with local quality attributes (F), and "
            "the deployment infrastructure - node resources (R) and network "
            "latency (L). Reusable across every application deployed on it."
        ),
        "defs": ["resource_model", "resource_pool", "candidate_resource_binding", "latency_model"],
        "properties": ["providers", "candidates", "features", "resource_model", "latency_model"],
    },
    "constraints": {
        "title": "Constraints (Delta)",
        "description": "What a binding must satisfy to be eligible.",
        "defs": [
            "constraint", "attr_bound_constraint", "dependency_constraint",
            "resource_constraint", "latency_constraint",
        ],
        "properties": ["constraints"],
    },
    "objective": {
        "title": "Objective (O)",
        "description": "How eligible bindings are ranked against each other.",
        "defs": ["objective", "mono", "multi", "many", "weights"],
        "properties": ["objective"],
    },
}


def rewrite_refs(node: Any, home: Dict[str, str]) -> Any:
    """Point every ``#/$defs/x`` at the file that now owns ``x``."""
    if isinstance(node, dict):
        result = {}
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str) and value.startswith("#/$defs/"):
                name = value[len("#/$defs/"):]
                result[key] = f"{home[name]}#/$defs/{name}"
            else:
                result[key] = rewrite_refs(value, home)
        return result
    if isinstance(node, list):
        return [rewrite_refs(item, home) for item in node]
    return node


def main() -> None:
    with open(os.path.join(GENERAL, "schema.json")) as handle:
        schema = json.load(handle)

    defs = schema["$defs"]
    claimed = [name for module in MODULES.values() for name in module["defs"]]
    assert sorted(claimed) == sorted(defs), (
        f"every $def must belong to exactly one model; "
        f"unclaimed={sorted(set(defs) - set(claimed))} twice={sorted({n for n in claimed if claimed.count(n) > 1})}"
    )

    home = {
        name: ("" if module_name == "root" else f"{module_name}.schema.json")
        for module_name, module in MODULES.items()
        for name in module["defs"]
    }

    for module_name, module in MODULES.items():
        document = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"{BASE_URI}/{module_name}.schema.json",
            "title": module["title"],
            "description": module["description"],
            "$defs": {name: rewrite_refs(defs[name], home) for name in module["defs"]},
        }
        if module["properties"]:
            document["properties"] = {
                name: rewrite_refs(schema["properties"][name], home)
                for name in module["properties"]
            }
        path = os.path.join(GENERAL, f"{module_name}.schema.json")
        with open(path, "w") as handle:
            json.dump(document, handle, indent=2)
            handle.write("\n")
        print(f"wrote {module_name}.schema.json ({len(module['defs'])} defs)")

    # The root keeps metadata, the required list and additionalProperties, and
    # composes the rest by reference.
    root: Dict[str, Any] = {
        "$schema": schema["$schema"],
        "$id": schema["$id"],
        "title": schema["title"],
        "description": (
            "A binding problem instance, I' = (M_A, M'_C, Delta, O). Each element of "
            "the tuple is defined in its own file so that it can be reused on its "
            "own: the same application model over different infrastructures, or the "
            "same infrastructure under different objectives."
        ),
        "type": "object",
        "required": schema["required"],
        "additionalProperties": False,
        "properties": {},
    }
    for name in schema["properties"]:
        owner = next(
            (module_name for module_name, module in MODULES.items() if name in module["properties"]),
            None,
        )
        if owner is None:
            root["properties"][name] = rewrite_refs(schema["properties"][name], home)
        else:
            root["properties"][name] = {"$ref": f"{owner}.schema.json#/properties/{name}"}

    with open(os.path.join(GENERAL, "schema.json"), "w") as handle:
        json.dump(root, handle, indent=2)
        handle.write("\n")
    print(f"wrote schema.json (root, {len(root['properties'])} properties by reference)")


if __name__ == "__main__":
    main()
