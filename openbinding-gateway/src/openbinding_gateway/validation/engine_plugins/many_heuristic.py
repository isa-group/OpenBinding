import os
from typing import List, Dict, Any, Tuple
import httpx
from .base import EngineValidationPlugin, missing_candidate_violations
from ...models.api import ValidationViolation

class ManyHeuristicEnginePlugin(EngineValidationPlugin):
    engine_id = "many-heuristic"


    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        violations.extend(missing_candidate_violations(instance))

        # 3. Objective Type
        obj_type = instance.get("objective", {}).get("type")
        if obj_type != "MANY":
             violations.append(ValidationViolation(
                 code="unsupported_objective_type",
                 path="objective.type",
                 message=f"Many-Heuristic only supports MANY objectives, got '{obj_type}'"
             ))

        # 4. Constraints
        for i, c in enumerate(instance.get("constraints", []) or []):
            kind = (c.get("kind") or "").upper()
            if kind == "DEPENDENCY": continue
            if kind != "ATTRIBUTE_BOUND":
                violations.append(ValidationViolation(
                    code="unsupported_constraint",
                    path=f"constraints[{i}].kind",
                    message="Supports 'attribute_bound' and 'dependency' constraints"
                ))

        return violations

    def transform_request(self, instance: Dict[str, Any], options: Dict[str, Any] = {}) -> Tuple[Dict[str, Any], List[str]]:
        warnings = self.unsupported_option_warnings(options)

        # The instance travels as-is: the engine derives the placement view it
        # needs and reads the composition, constraints and policies itself,
        # through the core the JVM engines share.
        options_payload = {
            "max_iterations": options.get("iterations_count", 1000),
            "archive_size": options.get("archive_size", 20),
        }
        if options.get("seed") is not None:
            options_payload["seed"] = int(options["seed"])
        if options.get("time_budget_ms") is not None:
            options_payload["time_budget_ms"] = int(options["time_budget_ms"])

        return {
            "id": instance.get("metadata", {}).get("id", "req-1"),
            "instance": instance,
            "options": options_payload,
        }, warnings

    def transform_response(self, engine_response: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
        if engine_response.get("error"): return {"error": engine_response["error"]}

        raw_solutions = engine_response.get("solutions", [])
        if not raw_solutions and engine_response.get("selection"):
            raw_solutions = [engine_response]

        # Metrics are filled in by canonicalize_result_data, which runs the
        # reference evaluator for every engine alike. Reporting an empty
        # violation list here is how this plugin used to claim every solution
        # satisfied every constraint.
        mapped_solutions = [
            {
                "binding": sol.get("selection") or {},
                "objective_value": sol.get("objective_value"),
            }
            for sol in raw_solutions
        ]

        return {
            "solutions": mapped_solutions,
            "provenance": {
                "engine_id": "many-heuristic", 
                "execution_time_ms": engine_response.get("execution_time", 0),
                "metadata": {"iterations_count": engine_response.get("iterations_count"), "archive_size": engine_response.get("archive_size")}
            }
        }
