import os
from typing import Any, Dict, List, Tuple

import httpx

from .base import EngineValidationPlugin
from ...models.api import ValidationViolation


class EvolutionaryHeuristicsEnginePlugin(EngineValidationPlugin):
    engine_id = "evolutionary-heuristics"


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
        warnings = self.unsupported_option_warnings(options)
        accepted = self.accepted_option_names()
        filtered_options = {
            name: value
            for name, value in options.items()
            if name in accepted and value is not None
        }
        # The instance travels as-is: the engine derives the placement view it
        # needs from resource_model / latency_model itself.
        return {"instance": instance, "options": filtered_options}, warnings

    def transform_response(
        self, engine_response: Dict[str, Any], original_request: Dict[str, Any]
    ) -> Dict[str, Any]:
        return engine_response
