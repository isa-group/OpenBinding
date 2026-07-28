import os
from typing import List, Dict, Any, Optional, Tuple
import httpx
from .aggregation import (
    build_selected_candidate_by_task,
    compute_aggregated_qos,
    normalize_qos,
    compute_objective_value,
)
from .base import EngineValidationPlugin
from .reference_evaluator import declares_normalization, evaluate_solution
from ...models.api import ValidationViolation

class RandomSearchEnginePlugin(EngineValidationPlugin):
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
            "objective_types_supported": ["MONO"],
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
            "seed": 1,
            "time_budget_ms": None,
        }

    def get_specialization_schema_path(self) -> str:
        base_path = os.getenv("SCHEMAS_DIR", "/app/schemas") 
        if not os.path.exists(base_path):
             base_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../schemas"))
        return os.path.join(base_path, "specializations/random-search.schema.json")

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        # 1. Collect all task IDs from composition
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

        # 2. Check market coverage
        market_candidates = {c["task_id"] for c in instance.get("candidates", [])}
        missing_tasks = task_ids - market_candidates
        if missing_tasks:
            violations.append(ValidationViolation(
                code="missing_candidates",
                path="candidates",
                message=f"Missing candidates for tasks: {', '.join(missing_tasks)}"
            ))

        # 3. Check QoS completeness
        required_qos = {f["id"] for f in instance.get("features", [])}
        for i, c in enumerate(instance.get("candidates", [])):
            provided_qos = set(c.get("features", {}).keys())
            missing_qos = required_qos - provided_qos
            if missing_qos:
                violations.append(ValidationViolation(
                    code="missing_features",
                    path=f"candidates[{i}].features",
                    message=f"Candidate {c['id']} for task {c['task_id']} missing features: {', '.join(missing_qos)}"
                ))

        # 4. Check Aggregation Policies
        supported_funcs = {"sum", "max", "min", "product", "weighted_sum", "scale_by_c", "scaled_sum", "scaled_product", "mean", "scaled_min", "scaled_max"}
        for attr, policy in instance.get("aggregation_policies", {}).items():
            compose = policy.get("compose", {})
            for op in ["seq", "and", "xor", "loop"]:
                fn = compose.get(op, {}).get("fn")
                if fn:
                    fn_lower = fn.lower()
                    if fn_lower not in supported_funcs:
                        violations.append(ValidationViolation(
                            code="unsupported_aggregation",
                            path=f"aggregation_policies.{attr}.compose.{op}.fn",
                            message=f"Unsupported aggregation function '{fn}'. supported: {supported_funcs}"
                        ))

        # 5. Check Objective Type
        obj_type = instance.get("objective", {}).get("type")
        if obj_type in ["MULTI", "MANY"]:
             violations.append(ValidationViolation(
                 code="unsupported_objective_type",
                 path="objective.type",
                 message=f"Random-Search engine only supports MONO/weighted_sum objectives, got '{obj_type}'"
             ))

        # 6. Check constraints subset
        for i, c in enumerate(instance.get("constraints", []) or []):
            kind = c.get("kind")
            # Check constraint kind (Schema ensures UPPERCASE)
            kind_upper = kind.upper() if kind else ""
            if kind_upper == "DEPENDENCY":
                # Dependency is now supported
                continue
                
            if kind_upper != "ATTRIBUTE_BOUND":
                violations.append(ValidationViolation(
                    code="unsupported_constraint",
                    path=f"constraints[{i}].kind",
                    message="Random-Search supports 'attribute_bound' and 'dependency' constraints"
                ))
                continue
            
            # Check Attribute Bound specific restrictions if needed
            # (Scope can be global or local now)
            # if c.get("scope") != "global": ... (Now supported)
            
            if c.get("op") == "IN_RANGE" or c.get("op") == "in_range":
                # Supported via transformation
                pass
                
            # If value is present, it should be numeric (unless range)
            # If value is present, it should be numeric (unless range)
            val = c.get("value")
            if val is not None and not isinstance(val, (int, float)) and not isinstance(val, dict):
                 violations.append(ValidationViolation(
                    code="invalid_value",
                    path=f"constraints[{i}].value",
                    message="Random-Search requires a numeric or range 'value' for attribute_bound"
                ))
            
            if not c.get("attribute_id"):
                violations.append(ValidationViolation(
                    code="missing_attribute",
                    path=f"constraints[{i}].attribute_id",
                    message="Missing attribute_id in attribute_bound constraint"
                ))

        return violations

    def transform_request(self, instance: Dict[str, Any], options: Dict[str, Any] = {}) -> Tuple[Dict[str, Any], List[str]]:
        """Map General JSON to Random-Search API DTO structure."""

        warnings = []
        supported_options = {"iterations_count", "seed", "time_budget_ms"}
        if options:
            for k in options.keys():
                if k not in supported_options:
                    warnings.append(f"Option '{k}' is not supported by Random-Search engine")

        # The instance travels as-is. The engine derives from it whatever
        # placement view it needs, so there is one request shape and one
        # evaluator regardless of whether the instance carries placement.
        #
        # iterations_count is the minimum evaluation budget; when
        # time_budget_ms is set the search runs until the wall-clock budget
        # expires (never below the minimum).
        config: Dict[str, Any] = {"max_iterations": options.get("iterations_count", 1000)}
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
        """Map Random-Search response to General Solution."""
        # Engine response: { status, selection: {task_id -> service_id}, qos: {...}, error }
        
        if engine_response.get("error"):
             return {"error": engine_response["error"]}

        selection = engine_response.get("selection") or {}

        # Recompute aggregated + normalized QoS in gateway to avoid information loss and
        # align with general semantics.
        candidates_by_id = {c["id"]: c for c in (original_request.get("candidates", []) or [])}
        features = {f["id"]: f for f in (original_request.get("features", []) or [])}
        agg_policies = original_request.get("aggregation_policies", {}) or {}

        selected_candidate_by_task = build_selected_candidate_by_task(selection, candidates_by_id)

        root = (original_request.get("composition", {}) or {}).get("root", {})
        aggregated_qos = compute_aggregated_qos(root, features, selected_candidate_by_task, agg_policies)
        normalized_qos = normalize_qos(aggregated_qos, features, agg_policies)

        # The engine always searches on the canonical normalized loss, which is
        # only the convention the instance asked for when it declares
        # normalization for every objective target. Adopting it otherwise would
        # report a loss where the instance's own convention is a weighted sum of
        # normalized goodness - the same solution with the opposite orientation.
        engine_objective = engine_response.get("objective_value")
        if engine_objective is not None and declares_normalization(original_request):
            objective_value = float(engine_objective)
        else:
            obj = original_request.get("objective", {}) or {}
            objective_value = compute_objective_value(obj, normalized_qos)

        # Constraint checking is the reference evaluator's job. Re-implementing
        # it here is how this plugin ended up ignoring candidate-scoped bounds,
        # IN_RANGE values and dependency constraints, and reporting a solution
        # as feasible while listing a hard violation of it.
        evaluation = evaluate_solution(original_request, selection)
        new_violations = evaluation["violations"]
        feasible = evaluation["feasible"]

        provenance = {
             "engine_id": "random-search",
             "execution_time_ms": engine_response.get("execution_time", 0),
             "metadata": {
                 "solver": "Random-Search",
                 "version": "0.0.1-SNAPSHOT",
                 "iterations_count": engine_response.get("iterations_count")
             }
        }
        if engine_response.get("seed") is not None:
            provenance["metadata"]["seed"] = engine_response.get("seed")
        if engine_response.get("trace") is not None:
            provenance["metadata"]["trace"] = engine_response.get("trace")

        new_sol = {
            "objective_value": objective_value,
            "binding": selection,
            "aggregated_features": aggregated_qos,
            "violations": new_violations,
            "feasible": feasible,
        }
        
        return {
            "solutions": [new_sol],
            "provenance": provenance
        }
