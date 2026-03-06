import os
from typing import List, Dict, Any, Optional, Tuple
import httpx
from .aggregation import build_selected_candidate_by_task, compute_aggregated_qos
from .base import EngineValidationPlugin
from ...models.api import ValidationViolation

class MiniZincCSPEnginePlugin(EngineValidationPlugin):
    _SUPPORTED_AGGREGATION_FUNCS = {
        "sum",
        "max",
        "min",
        "product",
        "weighted_sum",
        "scaled_sum",
        "scaled_product",
        "scale_by_c",
    }

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
            "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP", "ELEMENT"],
            "objective_types_supported": ["MONO"],
            "constraints_supported": ["attribute_bound", "dependency"], 
            "type": "EXACT",
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
        comp_type = str(comp.get("type", "")).upper()
        if comp_type == "STRUCTURED":
            violations.extend(self._validate_node(comp.get("root", {})))
        elif comp_type == "DAG":
             # DAG supported if nodes are supported
             nodes = comp.get("nodes", [])
             for n in nodes:
                 if n.get("kind") not in self.get_capabilities()["composition_nodes_supported"]:
                      violations.append(ValidationViolation(
                          message=f"Engine does not support node kind '{n.get('kind')}'",
                          code="engine_unsupported_feature",
                          path=f"composition.nodes[id={n.get('id')}]"
                      ))
        
        # 2. Check Objective Type
        obj_type = instance.get("objective", {}).get("type")
        if obj_type in ["MULTI", "MANY"]:
             violations.append(ValidationViolation(
                 code="unsupported_objective_type",
                 path="objective.type",
                 message=f"MiniZinc engine only supports MONO/weighted_sum objectives, got '{obj_type}'"
             ))

        # 3. Check Constraints (Hard only)
        for i, c in enumerate(instance.get("constraints", []) or []):
            if c.get("hard") is False:
                violations.append(ValidationViolation(
                    code="unsupported_soft_constraint",
                    path=f"constraints[{i}].hard",
                    message="MiniZinc engine does not support soft constraints (hard=False)"
                ))

        # 4. Validate Aggregation Policies (Operators)
        # For each QoS used in objective/constraints, check if the aggregation policy uses supported operators
        # MVP: We support what the schema supports for those QoS. 
        # This is complex to implement fully without traversing generic policies.
        # For MVP, we'll trust the specialization schema which restricts kinds, 
        # but we can scan `aggregation_policies` to see if they define 'loop' or other unsupported ops if they were present.
        
        agg_policies = instance.get("aggregation_policies", {})
        for attr, policy in agg_policies.items():
            compose = policy.get("compose", {})
            for kind, cfg in compose.items():
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

                fn = str((cfg or {}).get("fn", "")).strip().lower()
                if fn and fn not in self._SUPPORTED_AGGREGATION_FUNCS:
                    violations.append(ValidationViolation(
                        message=f"Engine does not support aggregation function '{fn}' for attribute '{attr}' in operator '{kind}'",
                        code="engine_unsupported_aggregation_function",
                        path=f"aggregation_policies.{attr}.compose.{kind}.fn"
                    ))

                # MiniZinc model treats xor=sum as weighted sum; explicit check to avoid silent mismatch
                if kind == "xor" and fn == "sum":
                    violations.append(ValidationViolation(
                        message="Use 'weighted_sum' for XOR aggregation in MiniZinc to match branch probabilities",
                        code="engine_ambiguous_xor_sum",
                        path=f"aggregation_policies.{attr}.compose.xor.fn"
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
            # Recurse into body
            violations.extend(self._validate_node(node.get("body", {})))
        
        return violations
            
    def transform_request(self, instance: Dict[str, Any], options: Dict[str, Any] = {}) -> Tuple[Dict[str, Any], List[str]]:
        warnings = []
        if options:
            for k in options.keys():
                if k not in {"debug", "solver"}:
                    warnings.append(f"Option '{k}' is not supported by MiniZinc engine")
        
        return {
            "instance": instance,
            "options": options
        }, warnings

    def transform_response(self, engine_response: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
        """Transform engine response to general solution format."""
        # MiniZinc Engine returns { status: ..., result: { solution: ... } }
        engine_result = engine_response.get("result")
        if not engine_result:
            engine_result = engine_response
        old_sol = engine_result.get("solution", {})
        raw_violations = engine_result.get("violations", []) or []
        diagnostics = engine_result.get("diagnostics") or {}

        if raw_violations:
            diagnostics = dict(diagnostics)
            diagnostics["engine_violations"] = raw_violations
        
        # If no solution found or empty
        if not old_sol:
            return {
                "solutions": [],
                "provenance": {
                    "engine_id": "minizinc-csp",
                    "execution_time_ms": 0,
                    "metadata": {}
                },
                "diagnostics": diagnostics if diagnostics else None
            }

        # Transform Selection -> Binding
        # MiniZinc solver.ts returns selection directly as {task_id: cand_id}
        selection = old_sol.get("selection") or {}
        
        # --- QoS Aggregation Logic (Ported from Random-Search) ---
        candidates_by_id = {c["id"]: c for c in (original_request.get("candidates", []) or [])}
        features = {f["id"]: f for f in (original_request.get("features", []) or [])}
        agg_policies = original_request.get("aggregation_policies", {}) or {}

        selected_candidate_by_task = build_selected_candidate_by_task(selection, candidates_by_id)

        root = (original_request.get("composition", {}) or {}).get("root", {})
        aggregated_qos = compute_aggregated_qos(root, features, selected_candidate_by_task, agg_policies)
            
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

        for v in raw_violations:
            violations.append({
                "constraint_id": v.get("constraint_id"),
                "message": v.get("message", "Engine violation"),
                "code": v.get("code", "engine_violation"),
                "penalty": v.get("penalty_applied", 0),
                "description": v.get("description")
            })
        
        # Construct new Solution
        # Construct new Solution
        if not old_sol.get("feasible", True):
            return {
                "solutions": [],
                "provenance": provenance,
                "diagnostics": diagnostics if diagnostics else None
            }

        if not selection:
            return {
                "solutions": [],
                "provenance": provenance,
                "diagnostics": diagnostics if diagnostics else None
            }

        new_sol = {
            "objective_value": old_sol.get("objective_value"),
            "binding": selection,
            "aggregated_features": aggregated_qos, # Computed in gateway
            "violations": violations
        }
        
        return {
            "solutions": [new_sol],
            "provenance": provenance,
            "diagnostics": diagnostics if diagnostics else None
        }
