import os
from typing import List, Dict, Any, Optional, Tuple
import httpx
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
            "objective_types_supported": ["weighted_sum"],
            "constraints_supported": ["attribute_bound"],
            "schema_version": "v1"
        }

    def get_specialization_schema_path(self) -> str:
        base_path = os.getenv("SCHEMAS_DIR", "/app/schemas") 
        if not os.path.exists(base_path):
             base_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../../schemas"))
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
        supported_funcs = {"sum", "max", "min", "product", "weighted_sum", "scale_by_c"}
        for attr, policy in instance.get("aggregation_policies", {}).items():
            compose = policy.get("compose", {})
            for op in ["seq", "and", "xor", "loop"]:
                fn = compose.get(op, {}).get("fn")
                if fn and fn not in supported_funcs:
                    violations.append(ValidationViolation(
                        code="unsupported_aggregation",
                        path=f"aggregation_policies.{attr}.compose.{op}.fn",
                        message=f"Unsupported aggregation function '{fn}'. supported: {supported_funcs}"
                    ))

        # 5. Check constraints subset (only global attribute_bound with scalar value)
        for i, c in enumerate(instance.get("constraints", []) or []):
            if c.get("kind") != "attribute_bound":
                violations.append(ValidationViolation(
                    code="unsupported_constraint",
                    path=f"constraints[{i}].kind",
                    message="Random-Search only supports 'attribute_bound' constraints"
                ))
                continue
            if c.get("scope") != "global":
                violations.append(ValidationViolation(
                    code="unsupported_scope",
                    path=f"constraints[{i}].scope",
                    message="Random-Search only supports global attribute_bound constraints"
                ))
            if c.get("op") == "in_range":
                violations.append(ValidationViolation(
                    code="unsupported_operator",
                    path=f"constraints[{i}].op",
                    message="Random-Search does not support 'in_range' operator"
                ))
            if not isinstance(c.get("value"), (int, float)):
                violations.append(ValidationViolation(
                    code="invalid_value",
                    path=f"constraints[{i}].value",
                    message="Random-Search requires a numeric 'value' for attribute_bound"
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
        if options:
            for k in options.keys():
                if k != "iterations_count":
                    warnings.append(f"Option '{k}' is not supported by Random-Search engine")

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
                "features": qos_map
            }
            market[tid]["services"].append(svc)

        # 3. QoS Model
        qos_props = {}
        features = instance.get("features", [])
        for f in features:
            qos_props[f["id"]] = {"direction": f["direction"]}

        qos_weights = {}
        obj = instance.get("objective", {})
        if obj.get("type") == "weighted_sum":
            qos_weights = {k: float(v) for k, v in (obj.get("weights", {}) or {}).items()}

        # Engine requires weights for all properties (use 0.0 for omitted attributes)
        for fid in qos_props.keys():
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
                if operator == "xor" and fn == "weighted_sum":
                    return "sum"
                if operator == "loop" and fn == "scale_by_c":
                    return "sum"
                if operator == "xor" and fn == "sum":
                    return "sum"
                if operator == "loop" and fn == "sum":
                    return "sum"
                return fn

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
            if c.get("kind") != "attribute_bound":
                continue
            if c.get("scope") != "global":
                continue
            if c.get("op") == "in_range":
                continue
            if not isinstance(c.get("value"), (int, float)):
                continue
            constraints_out.append({
                "id": c.get("id"),
                "kind": "attribute_bound",
                "scope": "global",
                "attribute_id": c.get("attribute_id"),
                "op": c.get("op"),
                "value": float(c.get("value")),
                "hard": bool(c.get("hard", True)),
            })

        return {
            "id": instance.get("metadata", {}).get("id", "req-1"),
            "composition": composition,
            "market": market,
            "features": {
                "properties": qos_props,
                "weights": qos_weights,
                "aggregation": qos_aggregation
            },
            "constraints": constraints_out,
            "config": {
                "max_iterations": options.get("iterations_count", 1000),
                "population_size": 100
            }
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

        # Pre-build task_id -> selected candidate
        selected_candidate_by_task = {}
        for task_id, cand_id in selection.items():
            cand = candidates_by_id.get(cand_id)
            if cand is not None:
                selected_candidate_by_task[task_id] = cand

        def _default_for(feature_id: str) -> float:
            policy = agg_policies.get(feature_id, {})
            if "neutral" in policy and isinstance(policy.get("neutral"), (int, float)):
                return float(policy["neutral"])
            feat = features.get(feature_id, {})
            direction = feat.get("direction")
            vr = feat.get("valid_range") or {}
            if direction == "maximize":
                return float(vr.get("min", 0.0))
            return float(vr.get("max", 0.0))

        def _agg_fn(fn: str, values: List[float], weights: Optional[List[float]] = None) -> float:
            if not values:
                return 0.0
            if fn in ("weighted_sum",):
                w = weights or [1.0] * len(values)
                return sum(v * w_i for v, w_i in zip(values, w))
            if fn == "sum":
                if weights is not None:
                    return sum(v * w_i for v, w_i in zip(values, weights))
                return sum(values)
            if fn == "product":
                res = 1.0
                for v in values:
                    res *= v
                return res
            if fn == "max":
                return max(values)
            if fn == "min":
                return min(values)
            # Fallback conservative
            return sum(values)

        def _compose_value(node: Dict[str, Any], feature_id: str) -> float:
            kind = node.get("kind")
            policy = agg_policies.get(feature_id, {})
            compose = policy.get("compose", {})

            if kind == "TASK":
                task_id = node.get("task_id")
                cand = selected_candidate_by_task.get(task_id)
                if cand is None:
                    return _default_for(feature_id)
                return float((cand.get("features", {}) or {}).get(feature_id, _default_for(feature_id)))

            if kind in ("SEQ", "AND"):
                children = node.get("children", []) or []
                values = [_compose_value(c, feature_id) for c in children]
                fn = compose.get("seq" if kind == "SEQ" else "and", {}).get("fn")
                return _agg_fn(fn or ("sum" if kind == "SEQ" else "max"), values)

            if kind == "XOR":
                branches = node.get("branches", []) or []
                values = [_compose_value(b.get("child", {}), feature_id) for b in branches]
                probs = [float(b.get("p", 0.0)) for b in branches]
                fn = compose.get("xor", {}).get("fn")
                # Interpret 'sum' as weighted sum for XOR (expected value)
                if fn in (None, "sum", "weighted_sum"):
                    return _agg_fn("weighted_sum", values, probs)
                return _agg_fn(fn, values)

            if kind == "LOOP":
                body = node.get("body", {}) or {}
                body_val = _compose_value(body, feature_id)
                fn = compose.get("loop", {}).get("fn")
                iterations = node.get("expected_iterations")
                if iterations is None:
                    bounds = node.get("bounds") or {}
                    iterations = bounds.get("max", 1)
                c = float(iterations)
                if fn in (None, "sum", "scale_by_c"):
                    return body_val * c
                if fn == "product":
                    return float(body_val ** c)
                return body_val

            return 0.0

        aggregated_qos: Dict[str, float] = {}
        for fid in features.keys():
            root = (original_request.get("composition", {}) or {}).get("root", {})
            aggregated_qos[fid] = _compose_value(root, fid)

        def _normalize_value(feature_id: str, raw: float) -> float:
            # Prefer aggregation_policies[*].normalize
            norm = (agg_policies.get(feature_id, {}) or {}).get("normalize")
            if not norm:
                return raw

            ntype = norm.get("type")
            increasing = norm.get("increasing_is_better")
            if increasing is None:
                direction = (features.get(feature_id, {}) or {}).get("direction")
                increasing = True if direction == "maximize" else False

            if ntype == "minmax":
                b = norm.get("bounds") or {}
                mn = float(b.get("min", 0.0))
                mx = float(b.get("max", 1.0))
                if mx == mn:
                    return 0.0
                v = (raw - mn) / (mx - mn)
                # clamp
                if v < 0.0:
                    v = 0.0
                if v > 1.0:
                    v = 1.0
                return v if increasing else (1.0 - v)

            if ntype == "identity" or ntype is None:
                return raw

            # piecewise/custom not supported here (engine can't execute expr either)
            return raw

        normalized_qos: Dict[str, float] = {fid: _normalize_value(fid, val) for fid, val in aggregated_qos.items()}

        obj = original_request.get("objective", {}) or {}
        objective_value = 0.0
        if obj.get("type") == "weighted_sum":
            weights = obj.get("weights", {}) or {}
            for fid, w in weights.items():
                objective_value += float(w) * float(normalized_qos.get(fid, 0.0))

        # Evaluate constraints for reporting
        feasible = True
        violations = []
        for c in (original_request.get("constraints", []) or []):
            if c.get("kind") != "attribute_bound" or c.get("scope") != "global":
                continue
            fid = c.get("attribute_id")
            if not fid:
                continue
            current = float(aggregated_qos.get(fid, 0.0))
            op = c.get("op")
            rhs = c.get("value")
            if not isinstance(rhs, (int, float)):
                continue
            rhs_f = float(rhs)

            ok = True
            slack = 0.0
            if op == "<=":
                ok = current <= rhs_f
                slack = rhs_f - current
            elif op == "<":
                ok = current < rhs_f
                slack = rhs_f - current
            elif op == ">=":
                ok = current >= rhs_f
                slack = current - rhs_f
            elif op == ">":
                ok = current > rhs_f
                slack = current - rhs_f
            elif op == "==":
                ok = abs(current - rhs_f) <= 1e-9
                slack = rhs_f - current
            elif op == "!=":
                ok = abs(current - rhs_f) > 1e-9
                slack = 0.0 if ok else -1.0

            if not ok:
                hard = bool(c.get("hard", True))
                if hard:
                    feasible = False
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

        new_sol = {
            "is_feasible": feasible,
            "objective_value": objective_value,
            "binding": selection,
            "aggregated_features": aggregated_qos,
            "violations": new_violations
        }
        
        return {
            "solutions": [new_sol],
            "provenance": provenance
        }
