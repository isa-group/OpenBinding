import os
from typing import List, Dict, Any, Tuple
import httpx
from .base import EngineValidationPlugin
from ...models.api import ValidationViolation

class ManyHeuristicEnginePlugin(EngineValidationPlugin):
    async def check_engine_health(self, base_url: str, client: httpx.AsyncClient) -> bool:
        url = f"{base_url.rstrip('/')}/health"
        try:
            resp = await client.get(url)
            return resp.status_code == 200
        except Exception:
            return False

    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP"],
            "objective_types_supported": ["MANY"],
            "constraints_supported": [
                "attribute_bound",
                "dependency",
                "resource_capacity",
                "latency_transition",
            ],
            "type": "HEURISTIC",
            "schema_version": "v1"
        }

    def get_default_options(self) -> Dict[str, Any]:
        return {
            "iterations_count": 1000,
            "archive_size": 20
        }

    def get_specialization_schema_path(self) -> str:
        base_path = os.getenv("SCHEMAS_DIR", "/app/schemas") 
        if not os.path.exists(base_path):
             base_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../schemas"))
        return os.path.join(base_path, "specializations/many-heuristic.schema.json")

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        # 1. Composition traversal
        task_ids = set()
        def visit(node):
            if node["kind"] == "TASK":
                task_ids.add(node["task_id"])
            elif "children" in node:
                for c in node["children"]:
                    visit(c)
            elif "branches" in node:
                for b in node["branches"]:
                    visit(b["child"])
            elif "body" in node:
                visit(node["body"])
        visit(instance["composition"]["root"])

        # 2. Market coverage
        market_candidates = {c["task_id"] for c in instance.get("candidates", [])}
        missing_tasks = task_ids - market_candidates
        if missing_tasks:
            violations.append(ValidationViolation(
                code="missing_candidates",
                path="candidates",
                message=f"Missing candidates: {', '.join(missing_tasks)}"
            ))

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
        warnings = []
        valid_options = {"iterations_count", "archive_size", "seed", "time_budget_ms"}
        for k in options:
            if k not in valid_options: warnings.append(f"Option '{k}' not supported. Valid: {valid_options}")

        # The instance travels as-is: the engine derives the placement view it
        # needs and reads the composition, constraints and policies itself,
        # through the core the JVM engines share.
        config = {
            "max_iterations": options.get("iterations_count", 1000),
            "archive_size": options.get("archive_size", 20),
        }
        if options.get("seed") is not None:
            config["seed"] = int(options["seed"])
        if options.get("time_budget_ms") is not None:
            config["time_budget_ms"] = int(options["time_budget_ms"])

        return {
            "id": instance.get("metadata", {}).get("id", "req-1"),
            "instance": instance,
            "config": config,
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
