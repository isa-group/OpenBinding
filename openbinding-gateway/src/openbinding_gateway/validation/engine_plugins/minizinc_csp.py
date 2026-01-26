import os
from typing import List, Dict, Any, Optional, Tuple
from .base import EngineValidationPlugin
from ...models.api import ValidationViolation

class MiniZincCSPEnginePlugin(EngineValidationPlugin):
    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "qos_features_supported": ["cost", "time", "reliability", "availability", "security"],
            "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR"],
            "objective_types_supported": ["weighted_sum"],
            "constraints_supported": [], 
            "schema_version": "v1"
        }

    def get_specialization_schema_path(self) -> str:
        # Assuming run from root or known location, better to use absolute path relative to project root
        # In Docker, schemas are at /app/schemas if mapped or copied.
        # We will assume a standard location or env var.
        base_path = os.getenv("SCHEMAS_DIR", "/app/schemas") 
        # Fallback for local dev if not in docker
        if not os.path.exists(base_path):
             # Try workspace relative
             base_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../../schemas"))
        
        return os.path.join(base_path, "specializations/minizinc-csp.schema.json")

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        # 1. Validate supported Composition Operators (Stage 4 check)
        # We traverse the composition to find any unsupported nodes (like LOOP)
        # Note: Specialization schema structural check (Stage 2) might catch this, 
        # but requirements ask to enforce explicitly via capabilities in Stage 4.
        
        comp = instance.get("composition", {})
        if comp.get("type") == "structured":
            violations.extend(self._validate_node(comp.get("root", {})))
        elif comp.get("type") == "dag":
             # DAG supported if nodes are supported
             nodes = comp.get("nodes", [])
             for n in nodes:
                 if n.get("kind") not in self.get_capabilities()["composition_nodes_supported"]:
                      violations.append(ValidationViolation(
                          message=f"Engine does not support node kind '{n.get('kind')}'",
                          code="engine_unsupported_feature",
                          path=f"composition.nodes[id={n.get('id')}]"
                      ))
        
        # 2. Validate Aggregation Policies (Operators)
        # For each QoS used in objective/constraints, check if the aggregation policy uses supported operators
        # MVP: We support what the schema supports for those QoS. 
        # This is complex to implement fully without traversing generic policies.
        # For MVP, we'll trust the specialization schema which restricts kinds, 
        # but we can scan `aggregation_policies` to see if they define 'loop' or other unsupported ops if they were present.
        
        agg_policies = instance.get("aggregation_policies", {})
        for attr, policy in agg_policies.items():
            compose = policy.get("compose", {})
            for kind in compose.keys():
                # Map schema keys (seq, and, xor, loop) to capability kinds
                # Capabilities: TASK, SEQ, AND, XOR
                # Schema: seq, and, xor, loop
                kind_map = {
                    "seq": "SEQ",
                    "and": "AND",
                    "xor": "XOR",
                    "loop": "LOOP"
                }
                mapped_kind = kind_map.get(kind)
                if mapped_kind and mapped_kind not in self.get_capabilities()["composition_nodes_supported"]:
                     violations.append(ValidationViolation(
                         message=f"Engine does not support aggregation operator '{kind}' for attribute '{attr}'",
                         code="engine_unsupported_aggregation_operator",
                         path=f"aggregation_policies.{attr}.compose.{kind}"
                     ))
        
        return violations

    def _validate_node(self, node: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        kind = node.get("kind")
        if kind not in self.get_capabilities()["composition_nodes_supported"]:
            violations.append(ValidationViolation(
                message=f"Engine does not support node kind '{kind}'",
                code="engine_unsupported_feature",
                path=f"composition...[id={node.get('id')}]"
            ))
        
        # Recurse
        if kind == "SEQ" or kind == "AND":
            for child in node.get("children", []):
                violations.extend(self._validate_node(child))
        elif kind == "XOR":
            for branch in node.get("branches", []):
                violations.extend(self._validate_node(branch.get("child", {})))
        elif kind == "LOOP":
            # LOOP not supported, so recursion might stay here, 
            # but we already reported the violation.
            pass
        
        return violations
            
    def transform_request(self, instance: Dict[str, Any], options: Dict[str, Any] = {}) -> Tuple[Dict[str, Any], List[str]]:
        warnings = []
        if options:
            for k in options.keys():
                warnings.append(f"Option '{k}' is not supported by MiniZinc engine")
        
        return {
            "instance": instance,
            "options": options
        }, warnings

    def transform_response(self, engine_response: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
        """Transform engine response to universal solution format."""
        # MiniZinc Engine returns { status: ..., result: { solution: ... } }
        engine_result = engine_response.get("result", {})
        old_sol = engine_result.get("solution", {})
        
        # If no solution found or empty
        if not old_sol:
            return {
                "solutions": [],
                "provenance": {
                    "engine_id": "minizinc-csp",
                    "execution_time_ms": 0,
                    "metadata": {}
                }
            }

        # Transform Selection -> Binding
        # MiniZinc solver.ts returns selection directly as {task_id: cand_id}
        selection = old_sol.get("selection", {})
        
        # --- QoS Aggregation Logic (Ported from Many-OBJ) ---
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
                # MiniZinc model handles XOR probabilities, but for reporting we calculate expected value
                probs = [float(b.get("p", 0.0)) for b in branches]
                fn = compose.get("xor", {}).get("fn")
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
            
        # -----------------------------------------------
        
        # Transform Provenance
        old_prov = engine_result.get("provenance", {})
        # Try different locations for time
        # Try different locations for time
        time_sec = old_prov.get("time_sec")
        if time_sec is None:
             # Try other locations
             time_sec = old_prov.get("time") # Some solvers use "time"
             
        if time_sec is None:
             stats = engine_result.get("statistics", {})
             # Minizinc JSON stats often use solveTime or time
             time_sec = stats.get("solveTime") or stats.get("time") or stats.get("flatTime")
             
        # If still None, check if it's in metadata from engine wrapper
        if time_sec is None:
             time_sec = engine_result.get("time")

        # Ensure it's a float
        try:
             time_val = float(time_sec) if time_sec is not None else 0.0
        except (ValueError, TypeError):
             time_val = 0.0
        
        provenance = {
             "engine_id": "minizinc-csp",
             "execution_time_ms": time_val * 1000,
             "metadata": old_prov # Keep original provenance data in metadata
        }
        
        # Map violations
        violations = []
        for v in old_sol.get("violations", []):
            violations.append({
                "constraint_id": v.get("constraint_id"),
                "message": f"Constraint {v.get('constraint_id')} violated",
                "code": "constraint_violation",
                "penalty": v.get("penalty_applied", 0),
                "description": f"Slack: {v.get('slack')}"
            })
        
        # Construct new Solution
        new_sol = {
            "is_feasible": old_sol.get("feasible", True), 
            "objective_value": old_sol.get("objective_value"),
            "binding": selection,
            "aggregated_features": aggregated_qos, # Computed in gateway
            "violations": violations
        }
        
        return {
            "solutions": [new_sol],
            "provenance": provenance,
            "diagnostics": engine_result.get("diagnostics") 
        }
