import os
from typing import List, Dict, Any
from .base import EngineValidationPlugin
from ...models.api import ValidationViolation

class MiniZincCSPEnginePlugin(EngineValidationPlugin):
    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "qos_features_supported": ["cost", "time", "reliability", "availability", "security"],
            "composition_nodes_supported": ["TASK", "SEQ", "AND_PAR", "XOR"],
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
                # Capabilities: TASK, SEQ, AND_PAR, XOR
                # Schema: seq, and, xor, loop
                kind_map = {
                    "seq": "SEQ",
                    "and": "AND_PAR",
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
        if kind == "SEQ" or kind == "AND_PAR":
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
