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

        candidate_ids = set()
        for i, c in enumerate(instance.get('candidates', [])):
            cid = c.get('id')
            if cid in ids_seen:
                violations.append(ValidationViolation(
                    message=f"Duplicate ID found: '{cid}'",
                    path=f"candidates[{i}].id",
                    code="duplicate_id_error"
                ))
            if cid:
                ids_seen.add(cid)
                candidate_ids.add(cid)

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

        # Candidate QoS completeness and ranges
        feature_map = {f.get('id'): f for f in instance.get('features', []) if f.get('id')}
        required_qos = set(feature_map.keys())
        for idx, cand in enumerate(instance.get('candidates', [])):
            qos_map = cand.get('features') or {}
            if not isinstance(qos_map, dict):
                continue
            missing_qos = required_qos - set(qos_map.keys())
            if missing_qos:
                violations.append(ValidationViolation(
                    message=f"Candidate '{cand.get('id')}' missing features: {', '.join(sorted(missing_qos))}",
                    path=f"candidates[{idx}].features",
                    code="missing_features"
                ))

            for fid, raw in qos_map.items():
                if fid not in feature_map:
                    violations.append(ValidationViolation(
                        message=f"Candidate '{cand.get('id')}' defines unknown feature '{fid}'",
                        path=f"candidates[{idx}].features.{fid}",
                        code="referential_integrity_error"
                    ))
                    continue
                vr = feature_map[fid].get('valid_range') or {}
                if isinstance(raw, (int, float)):
                    min_v = vr.get('min')
                    max_v = vr.get('max')
                    if min_v is not None and raw < min_v:
                        violations.append(ValidationViolation(
                            message=f"Value {raw} for '{fid}' is below min {min_v}",
                            path=f"candidates[{idx}].features.{fid}",
                            code="value_out_of_range"
                        ))
                    if max_v is not None and raw > max_v:
                        violations.append(ValidationViolation(
                            message=f"Value {raw} for '{fid}' is above max {max_v}",
                            path=f"candidates[{idx}].features.{fid}",
                            code="value_out_of_range"
                        ))

        # Composition integrity
        comp = instance.get('composition', {})
        comp_type = (comp.get('type') or '').lower()
        if comp_type == 'structured':
            node_ids = set()
            violations.extend(self._validate_structured(comp.get('root', {}), task_ids, node_ids))
        elif comp_type == 'dag':
            violations.extend(self._validate_dag(instance.get('composition', {}), task_ids))

        # 3. Objective Validation
        obj = instance.get("objective") or {}
        if isinstance(obj, dict) and obj.get("type") in {"SINGLE", "MULTI", "MANY"}:
            targets = obj.get("targets") or []
            for tid in targets:
                if tid not in feature_ids:
                    violations.append(
                        ValidationViolation(
                            message=f"Objective refers to unknown feature '{tid}'",
                            path="objective.targets",
                            code="referential_integrity_error",
                        )
                    )

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
                    if targets and feat_id not in targets:
                        violations.append(
                            ValidationViolation(
                                message=f"Objective weight '{feat_id}' is not in objective targets",
                                path=f"objective.weights.{feat_id}",
                                code="semantic_invariant_error",
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

        # Aggregation policy keys must correspond to known features.
        aggregation_policies = instance.get('aggregation_policies', {}) or {}
        if isinstance(aggregation_policies, dict):
            for attr_id in aggregation_policies.keys():
                if attr_id not in feature_ids:
                    violations.append(ValidationViolation(
                        message=f"Aggregation policy refers to unknown feature '{attr_id}'",
                        path=f"aggregation_policies.{attr_id}",
                        code="referential_integrity_error"
                    ))

        # Constraint references: attribute_id, tasks, candidates.
        for idx, c in enumerate(instance.get('constraints', []) or []):
            attr_id = c.get('attribute_id')
            if attr_id and attr_id not in feature_ids:
                violations.append(ValidationViolation(
                    message=f"Constraint refers to unknown feature '{attr_id}'",
                    path=f"constraints[{idx}].attribute_id",
                    code="referential_integrity_error"
                ))
            for tid in c.get('tasks', []) or []:
                if tid not in task_ids:
                    violations.append(ValidationViolation(
                        message=f"Constraint refers to unknown task '{tid}'",
                        path=f"constraints[{idx}].tasks",
                        code="referential_integrity_error"
                    ))
            for cid in c.get('candidates', []) or []:
                if cid not in candidate_ids:
                    violations.append(ValidationViolation(
                        message=f"Constraint refers to unknown candidate '{cid}'",
                        path=f"constraints[{idx}].candidates",
                        code="referential_integrity_error"
                    ))

        return violations

    def _validate_structured(self, node: Dict[str, Any], task_ids: Set[str], node_ids: Set[str]) -> List[ValidationViolation]:
        violations = []
        kind = node.get('kind')
        node_id = node.get('id')
        if node_id:
            if node_id in node_ids:
                violations.append(ValidationViolation(
                    message=f"Duplicate node id '{node_id}' in composition",
                    path=f"composition...[id={node_id}]",
                    code="duplicate_id_error"
                ))
            node_ids.add(node_id)
        
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
                violations.extend(self._validate_structured(branch.get('child', {}), task_ids, node_ids))
            
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
                violations.extend(self._validate_structured(child, task_ids, node_ids))
        
        if kind == 'LOOP':
            violations.extend(self._validate_structured(node.get('body', {}), task_ids, node_ids))

        return violations

    def _validate_dag(self, comp: Dict[str, Any], task_ids: Set[str]) -> List[ValidationViolation]:
        violations = []
        node_ids: Set[str] = set()
        for i, n in enumerate(comp.get('nodes', [])):
            node_id = n.get('id')
            if node_id in node_ids:
                violations.append(ValidationViolation(
                    message=f"Duplicate node id '{node_id}' in composition",
                    path=f"composition.nodes[{i}].id",
                    code="duplicate_id_error"
                ))
            if node_id:
                node_ids.add(node_id)
        
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
