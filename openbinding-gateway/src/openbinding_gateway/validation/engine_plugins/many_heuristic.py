import os
from typing import List, Dict, Any, Tuple, Optional
import httpx
from .aggregation import (
    build_selected_candidate_by_task,
    compute_aggregated_qos,
    normalize_qos,
    compute_objective_value,
)
from .base import EngineValidationPlugin
from ...models.api import ValidationViolation

class ManyHeuristicEnginePlugin(EngineValidationPlugin):
    def _objective_weights(self, instance: Dict[str, Any]) -> Dict[str, float]:
        weights: Dict[str, float] = {}
        objective = instance.get("objective", {}) or {}

        for feature_id, weight in (objective.get("weights", {}) or {}).items():
            weights[str(feature_id)] = float(weight)

        for target in objective.get("targets", []) or []:
            weights.setdefault(str(target), 1.0)

        return weights

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
            "constraints_supported": ["attribute_bound", "dependency"],
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
             base_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../../schemas"))
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
        valid_options = {"iterations_count", "archive_size"}
        for k in options:
            if k not in valid_options: warnings.append(f"Option '{k}' not supported. Valid: {valid_options}")

        # Composition mapping
        def map_node(node):
            res = {"id": node.get("id"), "kind": node.get("kind")}
            if node["kind"] == "TASK": res["task_id"] = node.get("task_id")
            elif node["kind"] in ["SEQ", "AND"]: res["children"] = [map_node(c) for c in node.get("children", [])]
            elif node["kind"] == "XOR": res["branches"] = [{"p": float(b["p"]), "child": map_node(b["child"])} for b in node.get("branches", [])]
            elif node["kind"] == "LOOP":
                res["body"] = map_node(node.get("body"))
                if "expected_iterations" in node: res["expected_iterations"] = float(node.get("expected_iterations"))
                elif "bounds" in node: res["expected_iterations"] = (node["bounds"]["min"] + node["bounds"]["max"]) / 2.0
            return res

        composition = {"type": "structured", "root": map_node(instance["composition"]["root"])}

        # Market mapping
        market = {}
        for c in instance.get("candidates", []):
            tid = c["task_id"]
            if tid not in market: market[tid] = {"services": []}
            market[tid]["services"].append({
                "id": c["id"], "name": c.get("name", c["id"]),
                "provider_id": c.get("provider_id"),
                "features": {k: float(v) for k, v in c.get("features", {}).items()}
            })

        # QoS Model
        qos_props = {}
        qos_weights = self._objective_weights(instance)
        for f in instance.get("features", []):
            vr = f.get("valid_range") or {}
            qos_props[f["id"]] = {
                "direction": f["direction"].lower(),
                "min": float(vr.get("min", 0.0)),
                "max": float(vr.get("max", 1.0)),
            }
            if f["id"] not in qos_weights:
                qos_weights[f["id"]] = 0.0
        
        agg_policies = instance.get("aggregation_policies", {})
        qos_aggregation = {}
        for attr, policy in agg_policies.items():
            compose = policy.get("compose", {})
            def map_fn(fn, op):
                if not fn: return "sum"
                fn = fn.lower()
                if op == "xor" and fn == "weighted_sum": return "sum"
                if op == "loop" and fn in ["scale_by_c", "scaled_sum"]: return "scaled_sum"
                if op == "loop" and fn == "scaled_product": return "product"
                return fn
            qos_aggregation[attr] = {
                "seq": map_fn(compose.get("seq", {}).get("fn", "sum"), "seq"),
                "flow": map_fn(compose.get("and", {}).get("fn", "max"), "and"),
                "branch": map_fn(compose.get("xor", {}).get("fn", "sum"), "xor"),
                "loop": map_fn(compose.get("loop", {}).get("fn", "sum"), "loop")
            }

        # Constraints
        constraints_out = []
        for c in (instance.get("constraints", []) or []):
            kind = (c.get("kind") or "").upper()
            if kind == "DEPENDENCY":
                constraints_out.append({"id": c.get("id"), "kind": "dependency", "type": c.get("type"), "tasks": c.get("tasks", []), "hard": bool(c.get("hard", True))})
                continue
            if kind != "ATTRIBUTE_BOUND": continue
            
            val = c.get("value")
            con_dto = {"id": c.get("id"), "kind": "attribute_bound", "scope": (c.get("scope") or "").lower(), "attribute_id": c.get("attribute_id"), "op": c.get("op"), "hard": bool(c.get("hard", True))}
            if con_dto["scope"] == "local": con_dto["tasks"] = c.get("tasks")
            
            if isinstance(val, (int, float)): con_dto["value"] = float(val)
            elif isinstance(val, dict):
                con_dto["min"] = float(val.get("min", 0))
                con_dto["max"] = float(val.get("max", 0))
            constraints_out.append(con_dto)

        config = {"max_iterations": options.get("iterations_count", 1000), "archive_size": options.get("archive_size", 20)}

        return {
            "id": instance.get("metadata", {}).get("id", "req-1"),
            "composition": composition, "market": market,
            "features": {"properties": qos_props, "weights": qos_weights, "aggregation": qos_aggregation},
            "constraints": constraints_out, "config": config
        }, warnings

    def transform_response(self, engine_response: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
        if engine_response.get("error"): return {"error": engine_response["error"]}

        raw_solutions = engine_response.get("solutions", [])
        if not raw_solutions and engine_response.get("selection"): raw_solutions = [engine_response]
        
        mapped_solutions = []
        candidates = {c["id"]: c for c in original_request.get("candidates", [])}
        features = {f["id"]: f for f in original_request.get("features", [])}
        agg_policies = original_request.get("aggregation_policies", {})
        root = original_request.get("composition", {}).get("root")
        objective = original_request.get("objective", {}) or {}

        for sol in raw_solutions:
            sel = sol.get("selection") or {}
            sel_cand = build_selected_candidate_by_task(sel, candidates)
            agg_qos = compute_aggregated_qos(root, features, sel_cand, agg_policies)
            normalized_qos = normalize_qos(agg_qos, features, agg_policies)
            objective_value = sol.get("objective_value")
            if objective_value is None:
                objective_value = compute_objective_value(objective, normalized_qos)
            
            mapped_solutions.append({
                "binding": sel,
                "aggregated_features": agg_qos, "violations": [], "objective_value": objective_value
            })

        return {
            "solutions": mapped_solutions,
            "provenance": {
                "engine_id": "many-heuristic", 
                "execution_time_ms": engine_response.get("execution_time", 0),
                "metadata": {"iterations_count": engine_response.get("iterations_count"), "archive_size": engine_response.get("archive_size")}
            }
        }
