"""Regenerate the canonicalization golden snapshots.

The snapshots pin the exact numbers the gateway produces for every bundled
example instance, so that refactors of the post-processing pipeline can be
proven not to move them.

For each instance a small set of deterministic bindings is built (the
first candidate of every task, plus seeded pseudo-random ones) and the two
code paths that produce solution metrics are recorded:

  * ``canonicalize_result_data`` - what a client actually receives
  * ``evaluate_solution``        - the reference evaluator

Bindings are stored inside the snapshots, so the tests never depend on this
script or on the random seed.

Usage (from the repository root):

    PYTHONPATH=openbinding-gateway/src python openbinding-gateway/tests/golden/regenerate.py
"""

from __future__ import annotations

import copy
import json
import os
import random
from typing import Any, Dict, List

from openbinding_gateway.validation.engine_plugins.aggregation import canonicalize_result_data
from openbinding_gateway.validation.engine_plugins.bimstar import evaluate_solution, is_bimstar

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
EXAMPLE_DIRS = ("demo", "literature", "placement")
BINDINGS_PER_INSTANCE = 5
SEED = 20260728

# Engines report their own objective value; keeping it non-null is what
# exercises the branch that leaves a MONO objective untouched.
ENGINE_REPORTED_OBJECTIVE = 0.5


def instance_files() -> List[str]:
    files: List[str] = []
    for name in EXAMPLE_DIRS:
        directory = os.path.join(REPO_ROOT, "examples", name)
        for entry in sorted(os.listdir(directory)):
            if entry.endswith(".json"):
                files.append(os.path.join(directory, entry))
    return files


def bindings_for(instance: Dict[str, Any]) -> List[Dict[str, str]]:
    by_task: Dict[str, List[str]] = {}
    for candidate in instance.get("candidates") or []:
        by_task.setdefault(candidate["task_id"], []).append(candidate["id"])
    for candidate_ids in by_task.values():
        candidate_ids.sort()

    task_ids = sorted(by_task)
    if not task_ids:
        return []

    bindings = [{task: by_task[task][0] for task in task_ids}]
    rng = random.Random(SEED)
    for _ in range(BINDINGS_PER_INSTANCE - 1):
        bindings.append({task: rng.choice(by_task[task]) for task in task_ids})
    return bindings


def snapshot(path: str) -> Dict[str, Any]:
    with open(path) as handle:
        instance = json.load(handle)

    objective = instance.get("objective") or {}
    policies = instance.get("aggregation_policies") or {}
    targets = list(objective.get("targets") or [])

    entry: Dict[str, Any] = {
        "instance": os.path.relpath(path, REPO_ROOT),
        "placement": is_bimstar(instance),
        "objective_type": objective.get("type"),
        "objective_targets": sorted(targets),
        "normalized_targets": sorted(t for t in targets if (policies.get(t) or {}).get("normalize")),
        "cases": [],
    }

    for index, binding in enumerate(bindings_for(instance)):
        reported = {"solutions": [{"binding": binding, "objective_value": ENGINE_REPORTED_OBJECTIVE}]}
        gateway = canonicalize_result_data(copy.deepcopy(reported), instance)["solutions"][0]

        blank = {"solutions": [{"binding": binding}]}
        gateway_blank = canonicalize_result_data(copy.deepcopy(blank), instance)["solutions"][0]

        reference = evaluate_solution(instance, binding)

        entry["cases"].append(
            {
                "index": index,
                "binding": binding,
                "engine_reported_objective": ENGINE_REPORTED_OBJECTIVE,
                "gateway": {
                    "aggregated_features": gateway.get("aggregated_features"),
                    "objective_value": gateway.get("objective_value"),
                    "engine_objective_value": gateway.get("engine_objective_value"),
                    "feasible": gateway.get("feasible"),
                    "violations": gateway.get("violations"),
                },
                "gateway_without_engine_objective": {
                    "objective_value": gateway_blank.get("objective_value"),
                },
                "reference_evaluator": {
                    "aggregated_features": reference["aggregated_features"],
                    "objective_value": reference["objective_value"],
                    "feasible": reference["feasible"],
                    "violations": reference["violations"],
                },
            }
        )

    return entry


def main() -> None:
    for path in instance_files():
        entry = snapshot(path)
        name = entry["instance"].replace("/", "__").replace(".json", "")
        with open(os.path.join(HERE, f"{name}.json"), "w") as handle:
            json.dump(entry, handle, indent=2, sort_keys=True)
            handle.write("\n")
        print(f"wrote {name}.json ({len(entry['cases'])} bindings)")


if __name__ == "__main__":
    main()
