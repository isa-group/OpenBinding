import os
from typing import List, Dict, Any, Optional, Tuple
import httpx
from .aggregation import (
    build_selected_candidate_by_task,
    compute_aggregated_qos,
    normalize_qos,
    compute_objective_value,
)
from .reference_evaluator import build_placement_payload
from .base import EngineValidationPlugin
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

        # BIM' instances take the placement-native path: the engine consumes
        # the raw instance plus the precomputed placement payload, so that the
        # placement semantics live in a single evaluator implementation.
        placement = build_placement_payload(instance)
        if placement is not None:
            # iterations_count is the minimum evaluation budget; when
            # time_budget_ms is set the search runs until the wall-clock
            # budget expires (never below the minimum).
            config: Dict[str, Any] = {
                "max_iterations": options.get("iterations_count", 1000)
            }
            if options.get("seed") is not None:
                config["seed"] = int(options["seed"])
            if options.get("time_budget_ms") is not None:
                config["time_budget_ms"] = int(options["time_budget_ms"])
            return {
                "id": instance.get("metadata", {}).get("id", "req-1"),
                "instance": instance,
                "placement": placement,
                "config": config,
            }, warnings

        # 1. Composition
        def map_node(node):
            res = {
                "id": node.get("id"),
                "kind": node.get("kind")
            }
            if node["kind"] == "TASK":
                res["task_id"] = node.get("task_id")
            elif node["kind"] in ["SEQ", "AND"]:
                res["children"] = [map_node(c) for c in node.get("children", [])]
            elif node["kind"] == "XOR":
                res["branches"] = [
                    {"p": float(b["p"]), "child": map_node(b["child"])} 
                    for b in node.get("branches", [])
                ]
            elif node["kind"] == "LOOP":
                res["body"] = map_node(node.get("body"))
                if "expected_iterations" in node and node.get("expected_iterations") is not None:
                    res["expected_iterations"] = float(node.get("expected_iterations"))
                elif "bounds" in node:
                    defaults = node["bounds"]
                    mn = defaults.get("min", 0)
                    mx = defaults.get("max", 0)
                    res["expected_iterations"] = (mn + mx) / 2.0
            return res

        composition = {
            "type": "structured",
            "root": map_node(instance["composition"]["root"])
        }

        # 2. Market
        market = {}
        for c in instance.get("candidates", []):
            tid = c["task_id"]
            if tid not in market:
                market[tid] = {"services": []}
            
            # Ensure QoS values are floats
            qos_map = {k: float(v) for k, v in c.get("features", {}).items()}
            
            svc = {
                "id": c["id"],
                "name": c.get("name", c["id"]),
                "provider_id": c.get("provider_id"),
                "features": qos_map
            }
            market[tid]["services"].append(svc)


        # 3. QoS Model
        qos_props = {}
        features = instance.get("features", [])
        
        qos_weights = {}
        obj = instance.get("objective", {})
        if obj.get("type") == "MONO" and len(obj.get("weights", {}).keys()) > 0:
            qos_weights = {k: float(v) for k, v in (obj.get("weights", {}) or {}).items()}

        # Engine requires weights for all properties (use 0.0 for omitted attributes).
        # Normalization bounds: prefer the instance-declared canonical bounds
        # (aggregation_policies[fid].normalize.bounds) so the engine's internal
        # fitness matches the gateway's reference objective; fall back to the
        # feature valid_range otherwise.
        declared_policies = instance.get("aggregation_policies", {}) or {}
        for f in features:
             fid = f["id"]
             vr = f.get("valid_range") or {}
             norm_bounds = ((declared_policies.get(fid) or {}).get("normalize") or {}).get("bounds") or {}
             qos_props[fid] = {
                 "direction": f["direction"].lower(),
                 "min": float(norm_bounds.get("min", vr.get("min", 0.0))),
                 "max": float(norm_bounds.get("max", vr.get("max", 1.0)))
             }
             if fid not in qos_weights:
                qos_weights[fid] = 0.0
        
        qos_aggregation = {}
        agg_policies = instance.get("aggregation_policies", {})
        for attr, policy in agg_policies.items():
            compose = policy.get("compose", {})

            def map_fn(fn: str, operator: str) -> str:
                # Engine's aggregation is driven by (values, ponderations).
                # - XOR probabilities and LOOP iterations are passed as ponderations.
                # - Using 'sum' produces weighted_sum and scale_by_c semantics.
                if not fn:
                    return "sum"
                fn_lower = fn.lower()
                
                # XOR/LOOP specialized mappings
                if operator == "xor" and fn_lower == "weighted_sum":
                    return "sum"
                if operator == "loop" and fn_lower == "scale_by_c":
                    return "scaled_sum"
                if operator == "loop" and fn_lower == "scaled_sum":
                    return "scaled_sum"
                if operator == "loop" and fn_lower == "scaled_product":
                    return "product"

                if operator == "xor" and fn_lower == "sum":
                    return "sum"
                if operator == "loop" and fn_lower == "sum":
                    return "sum"
                
                return fn_lower

            pol = {
                "seq": map_fn(compose.get("seq", {}).get("fn", "sum"), "seq"),
                "flow": map_fn(compose.get("and", {}).get("fn", "max"), "and"), # Map 'and' to 'flow'
                "branch": map_fn(compose.get("xor", {}).get("fn", "sum"), "xor"),
                "loop": map_fn(compose.get("loop", {}).get("fn", "sum"), "loop")
            }
            qos_aggregation[attr] = pol

        # 4. Constraints
        constraints_out = []
        for c in (instance.get("constraints", []) or []):
            kind = c.get("kind")
            if kind == "DEPENDENCY":
                # Pass dependency constraints
                constraints_out.append({
                    "id": c.get("id"),
                    "kind": "dependency",
                    "type": c.get("type"),
                    "tasks": c.get("tasks", []),
                    "hard": bool(c.get("hard", True))
                })
                continue

            if (c.get("kind") or "").lower() != "attribute_bound":
                continue
            scope = (c.get("scope") or "").lower()
            if c.get("op") == "in_range" or c.get("op") == "IN_RANGE":
                # Handle IN_RANGE: pass value as object {min, max} (or transform if needed by engine)
                # The engine's RangeGlobalQoSWSCompositionConstraint expects min/max separately in constructor?
                # Check Controller.java:
                # if (BinaryOperator.IN_RANGE.equals(op)) {
                #     problem.getConstraints().add(new RangeGlobalQoSWSCompositionConstraint(problem, prop, c.min, c.max, hard));
                # }
                # So we need to flatten the value object or pass it as is if the DTO handles it.
                # SolveRequest.java Constraint DTO has min/max fields?
                # Let's assume the "value" in the instance is an object {min, max}.
                # But Controller.java uses c.min and c.max from the DTO, not c.value.
                # transform_request needs to map value.min/max to constraint.min/max
                pass
            if not isinstance(c.get("value"), (int, float)):
                continue
            con_dto = {
                "id": c.get("id"),
                "kind": "attribute_bound",
                "scope": scope,
                "attribute_id": c.get("attribute_id"),
                "op": c.get("op"),
                "hard": bool(c.get("hard", True)),
            }
            
            # For LOCAL constraints, include the tasks list
            if scope == "local" and c.get("tasks"):
                con_dto["tasks"] = c.get("tasks")
            
            val = c.get("value")
            if isinstance(val, (int, float)):
                con_dto["value"] = float(val)
            elif isinstance(val, dict) and (c.get("op") == "IN_RANGE" or c.get("op") == "in_range"):
                con_dto["min"] = float(val.get("min", 0))
                con_dto["max"] = float(val.get("max", 0))
                # Controller.java expects min/max in the Constraint object
            
            constraints_out.append(con_dto)

        config = {
            "max_iterations": options.get("iterations_count", 1000)
        }
        if options.get("seed") is not None:
            config["seed"] = int(options["seed"])

        payload = {
            "id": instance.get("metadata", {}).get("id", "req-1"),
            "composition": composition,
            "market": market,
            "features": {
                "properties": qos_props,
                "weights": qos_weights,
                "aggregation": qos_aggregation
            },
            "constraints": constraints_out,
            "config": config
        }

        return payload, warnings

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

        # Prefer the engine's own internal search objective (BIM' path) so
        # the canonicalization step can audit it; the legacy "goodness"
        # recomputation remains as a fallback for the legacy DTO path.
        engine_objective = engine_response.get("objective_value")
        if engine_objective is not None:
            objective_value = float(engine_objective)
        else:
            obj = original_request.get("objective", {}) or {}
            objective_value = compute_objective_value(obj, normalized_qos)

        # Evaluate constraints for reporting
        violations = []
        
        def _check_bound(current: float, op: str, rhs_f: float):
            """Return (ok, slack) for a bound check."""
            if op == "<=":
                return current <= rhs_f, rhs_f - current
            elif op == "<":
                return current < rhs_f, rhs_f - current
            elif op == ">=":
                return current >= rhs_f, current - rhs_f
            elif op == ">":
                return current > rhs_f, current - rhs_f
            elif op == "==":
                return abs(current - rhs_f) <= 1e-9, rhs_f - current
            elif op == "!=":
                ok = abs(current - rhs_f) > 1e-9
                return ok, (0.0 if ok else -1.0)
            return True, 0.0

        for c in (original_request.get("constraints", []) or []):
            kind = (c.get("kind") or "").upper()
            scope = (c.get("scope") or "").upper()
            if kind != "ATTRIBUTE_BOUND":
                continue
            fid = c.get("attribute_id")
            if not fid:
                continue
            op = c.get("op")
            rhs = c.get("value")
            if not isinstance(rhs, (int, float)):
                continue
            rhs_f = float(rhs)
            
            if scope == "LOCAL":
                # For LOCAL constraints, check the raw feature of the selected candidate
                constraint_tasks = c.get("tasks", []) or []
                for task_id in constraint_tasks:
                    cand = selected_candidate_by_task.get(task_id)
                    if cand is None:
                        continue
                    current = float((cand.get("features", {}) or {}).get(fid, 0.0))
                    ok, slack = _check_bound(current, op, rhs_f)
                    if not ok:
                        violations.append({
                            "constraint_id": c.get("id"),
                            "slack": float(slack),
                            "penalty_applied": 0
                        })
                continue
            
            # GLOBAL scope
            current = float(aggregated_qos.get(fid, 0.0))
            ok, slack = _check_bound(current, op, rhs_f)

            if not ok:
                violations.append({
                    "constraint_id": c.get("id"),
                    "slack": float(slack),
                    "penalty_applied": 0
                })

        # Transform violations to new schema
        new_violations = []
        for v in violations:
             new_violations.append({
                "constraint_id": v.get("constraint_id"),
                "message": f"Constraint {v.get('constraint_id')} violated",
                "code": "constraint_violation",
                "penalty": v.get("penalty_applied", 0),
                "description": f"Slack: {v.get('slack')}"
            })

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
            "violations": new_violations
        }
        
        return {
            "solutions": [new_sol],
            "provenance": provenance
        }
