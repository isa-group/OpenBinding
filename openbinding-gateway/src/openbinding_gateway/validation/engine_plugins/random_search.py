import os
from typing import List, Dict, Any, Tuple
import httpx
from .base import EngineValidationPlugin, missing_candidate_violations
from ...models.api import ValidationViolation

class RandomSearchEnginePlugin(EngineValidationPlugin):
    engine_id = "random-search"


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


    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        violations.extend(missing_candidate_violations(instance))

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
        options_payload: Dict[str, Any] = {"max_iterations": options.get("iterations_count", 1000)}
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
        """Map Random-Search response to General Solution."""
        # Engine response: { status, selection: {task_id -> service_id}, qos: {...}, error }
        
        if engine_response.get("error"):
             return {"error": engine_response["error"]}

        selection = engine_response.get("selection") or {}

        # Metrics are not this plugin's business: canonicalize_result_data runs
        # the reference evaluator over the binding for every engine alike. The
        # engine's own objective is passed through so it can be recorded
        # alongside the canonical one.
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
            "objective_value": engine_response.get("objective_value"),
            "binding": selection,
        }
        
        return {
            "solutions": [new_sol],
            "provenance": provenance
        }
