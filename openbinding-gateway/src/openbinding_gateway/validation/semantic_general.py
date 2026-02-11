from typing import Dict, Any, List, Set
from ..models.api import ValidationViolation

class GeneralSemanticValidator:
    def validate(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        # 1. ID Uniqueness Checks
        ids_seen = set()
        task_ids = set()
        for i, t in enumerate(instance.get('tasks', [])):
            if t['id'] in ids_seen:
                violations.append(ValidationViolation(
                    message=f"Duplicate ID found: '{t['id']}'",
                    path=f"tasks[{i}].id",
                    code="duplicate_id_error"
                ))
            ids_seen.add(t['id'])
            task_ids.add(t['id'])

        provider_ids = set()
        for i, p in enumerate(instance.get('providers', [])):
            if p['id'] in ids_seen:
                 violations.append(ValidationViolation(
                    message=f"Duplicate ID found: '{p['id']}'",
                    path=f"providers[{i}].id",
                    code="duplicate_id_error"
                ))
            ids_seen.add(p['id'])
            provider_ids.add(p['id'])

        feature_ids = set()
        for i, f in enumerate(instance.get('features', [])):
             if f['id'] in ids_seen:
                 violations.append(ValidationViolation(
                    message=f"Duplicate ID found: '{f['id']}'",
                    path=f"features[{i}].id",
                    code="duplicate_id_error"
                ))
             ids_seen.add(f['id'])
             feature_ids.add(f['id'])

        # 2. Referential Integrity
        
        # Candidates refer to tasks and providers
        for idx, cand in enumerate(instance.get('candidates', [])):
            if cand.get('task_id') not in task_ids:
                violations.append(ValidationViolation(
                    message=f"Candidate '{cand.get('id')}' refers to unknown task '{cand.get('task_id')}'",
                    path=f"candidates[{idx}].task_id",
                    code="referential_integrity_error"
                ))
            if cand.get('provider_id') not in provider_ids:
                violations.append(ValidationViolation(
                    message=f"Candidate '{cand.get('id')}' refers to unknown provider '{cand.get('provider_id')}'",
                    path=f"candidates[{idx}].provider_id",
                    code="referential_integrity_error"
                ))

        # Composition integrity
        comp = instance.get('composition', {})
        if comp.get('type') == 'structured':
            violations.extend(self._validate_structured(comp.get('root', {}), task_ids))
        elif comp.get('type') == 'dag':
            violations.extend(self._validate_dag(instance.get('composition', {}), task_ids))

        # 3. Objective Validation
        obj = instance.get("objective") or {}
        if isinstance(obj, dict) and obj.get("type") in {"SINGLE", "MULTI", "MANY"}:
            weights = obj.get("weights") or {}
            total_w = 0.0
            if isinstance(weights, dict):
                for feat_id, w in weights.items():
                    if feat_id not in feature_ids:
                        violations.append(
                            ValidationViolation(
                                message=f"Objective refers to unknown feature '{feat_id}'",
                                path=f"objective.weights.{feat_id}",
                                code="referential_integrity_error",
                            )
                        )
                    try:
                        total_w += float(w)
                    except (TypeError, ValueError):
                        # Structural schema should prevent this, but keep it safe.
                        violations.append(
                            ValidationViolation(
                                message=f"Objective weight for '{feat_id}' must be a number",
                                path=f"objective.weights.{feat_id}",
                                code="semantic_invariant_error",
                            )
                        )

            # If `weights_sum_to_one` is missing, it is treated as True (schema default).
            if obj.get("weights_sum_to_one", True):
                if abs(total_w - 1.0) > 1e-6:
                    violations.append(
                        ValidationViolation(
                            message=f"Objective weights must sum to 1.0 when weights_sum_to_one=true, got {total_w}",
                            path="objective.weights",
                            code="semantic_invariant_error",
                        )
                    )

        return violations

    def _validate_structured(self, node: Dict[str, Any], task_ids: Set[str]) -> List[ValidationViolation]:
        violations = []
        kind = node.get('kind')
        
        if kind == 'TASK':
            if node.get('task_id') not in task_ids:
                violations.append(ValidationViolation(
                    message=f"Composition node '{node.get('id')}' refers to unknown task '{node.get('task_id')}'",
                    path=f"composition...[id={node.get('id')}]",
                    code="referential_integrity_error"
                ))
        
        # XOR sum check
        if kind == 'XOR':
            total_p = 0.0
            for branch in node.get('branches', []):
                p = branch.get('p', 0.0)
                if not (0 <= p <= 1):
                     violations.append(ValidationViolation(
                        message=f"XOR branch probability must be in [0,1], got {p}",
                        path=f"composition...[id={node.get('id')}]",
                        code="semantic_invariant_error"
                    ))
                total_p += p
                violations.extend(self._validate_structured(branch.get('child', {}), task_ids))
            
            # Tolerance check
            if abs(total_p - 1.0) > 1e-6:
                violations.append(ValidationViolation(
                    message=f"XOR branches probabilities must sum to 1.0, got {total_p}",
                    path=f"composition...[id={node.get('id')}]",
                    code="semantic_invariant_error"
                ))
        
        # Recursion for other types
        if kind in ['SEQ', 'AND']:
            for child in node.get('children', []):
                violations.extend(self._validate_structured(child, task_ids))
        
        if kind == 'LOOP':
            violations.extend(self._validate_structured(node.get('body', {}), task_ids))

        return violations

    def _validate_dag(self, comp: Dict[str, Any], task_ids: Set[str]) -> List[ValidationViolation]:
        violations = []
        node_ids = {n['id'] for n in comp.get('nodes', [])}
        
        # Node integrity
        for n in comp.get('nodes', []):
            if n.get('kind') == 'TASK' and n.get('task_id') not in task_ids:
                 violations.append(ValidationViolation(
                    message=f"DAG node '{n.get('id')}' refers to unknown task '{n.get('task_id')}'",
                    path=f"composition.nodes[id={n.get('id')}]",
                    code="referential_integrity_error"
                ))
        
        # Edge integrity
        for edge in comp.get('edges', []):
            if edge.get('from') not in node_ids:
                 violations.append(ValidationViolation(
                    message=f"Edge refers to unknown from-node '{edge.get('from')}'",
                    path=f"composition.edges",
                    code="referential_integrity_error"
                ))
            if edge.get('to') not in node_ids:
                 violations.append(ValidationViolation(
                    message=f"Edge refers to unknown to-node '{edge.get('to')}'",
                    path=f"composition.edges",
                    code="referential_integrity_error"
                ))
        
        # Acyclicity check (simple DFS)
        # Build adjacency
        adj = {nid: [] for nid in node_ids}
        for edge in comp.get('edges', []):
            if edge['from'] in adj:
                adj[edge['from']].append(edge['to'])
        
        visited = set()
        recursion_stack = set()
        
        def has_cycle(u):
            visited.add(u)
            recursion_stack.add(u)
            for v in adj[u]:
                if v not in visited:
                    if has_cycle(v): return True
                elif v in recursion_stack:
                    return True
            recursion_stack.remove(u)
            return False
            
        for node_id in node_ids:
            if node_id not in visited:
                if has_cycle(node_id):
                    violations.append(ValidationViolation(
                        message="DAG contains a cycle",
                        path="composition.edges",
                        code="semantic_invariant_error"
                    ))
                    break
                    
        return violations
