import os
from typing import Any, Dict, List, Tuple

import httpx

from .base import EngineValidationPlugin
from ...models.api import ValidationViolation


class EvolutionaryHeuristicsEnginePlugin(EngineValidationPlugin):
    engine_id = "evolutionary-heuristics"

    _VALID_OPTIONS = {
        "algorithm",
        "operators",
        "population_size",
        "max_evaluations",
        "crossover_probability",
        "mutation_probability",
        "distribution_index",
        "archive_size",
        "soft_penalty",
        "seed",
        "reference_divisions",
        "time_budget_ms",
    }


    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP"],
            "objective_types_supported": ["MONO", "MULTI", "MANY"],
            "constraints_supported": [
                "attribute_bound",
                "dependency",
                "resource_capacity",
                "latency_transition",
            ],
            "algorithms_supported": ["NSGAII", "NSGAIII"],
            "type": "HEURISTIC",
            "schema_version": "v1",
        }

    def get_default_options(self) -> Dict[str, Any]:
        return {
            "algorithm": "AUTO",
            "population_size": 100,
            "max_evaluations": 10000,
            "crossover_probability": 0.9,
            "mutation_probability": None,
            "distribution_index": 20.0,
            "archive_size": 100,
            "soft_penalty": 10.0,
            "seed": 1,
            "reference_divisions": 12,
        }

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations: List[ValidationViolation] = []
        task_ids = set()

        def visit(node: Dict[str, Any]) -> None:
            kind = node.get("kind")
            if kind == "TASK":
                task_ids.add(node.get("task_id"))
            for child in node.get("children", []) or []:
                visit(child)
            for branch in node.get("branches", []) or []:
                visit(branch.get("child", {}))
            if node.get("body"):
                visit(node["body"])

        visit(instance["composition"]["root"])
        candidate_tasks = {
            task
            for candidate in instance.get("candidates", [])
            for task in candidate.get("task_ids") or []
        }
        for task_id in sorted(task_ids - candidate_tasks):
            violations.append(
                ValidationViolation(
                    code="missing_candidates",
                    path="candidates",
                    message=f"Missing candidates for task '{task_id}'",
                )
            )

        features = {feature["id"] for feature in instance.get("features", [])}
        for target in instance.get("objective", {}).get("targets", []):
            if target not in features:
                violations.append(
                    ValidationViolation(
                        code="unknown_objective_target",
                        path="objective.targets",
                        message=f"Unknown objective feature '{target}'",
                    )
                )
        return violations

    def transform_request(
        self, instance: Dict[str, Any], options: Dict[str, Any] = {}
    ) -> Tuple[Dict[str, Any], List[str]]:
        warnings = [
            f"Option '{name}' is not supported by evolutionary-heuristics"
            for name in options
            if name not in self._VALID_OPTIONS
        ]
        filtered_options = {
            name: value
            for name, value in options.items()
            if name in self._VALID_OPTIONS and value is not None
        }
        # The instance travels as-is: the engine derives the placement view it
        # needs from resource_model / latency_model itself.
        return {"instance": instance, "options": filtered_options}, warnings

    def transform_response(
        self, engine_response: Dict[str, Any], original_request: Dict[str, Any]
    ) -> Dict[str, Any]:
        return engine_response
