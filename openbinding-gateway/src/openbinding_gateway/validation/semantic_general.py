from typing import Any, Dict, Iterator, List, Set
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
            if 'task_ids' not in cand and 'task_id' in cand:
                violations.append(ValidationViolation(
                    message=(
                        f"Candidate '{cand.get('id')}' declares 'task_id'; a candidate now "
                        "lists every task it serves under 'task_ids'"
                    ),
                    path=f"candidates[{idx}].task_id",
                    code="referential_integrity_error"
                ))
            served = cand.get('task_ids') or []
            if not served:
                violations.append(ValidationViolation(
                    message=f"Candidate '{cand.get('id')}' serves no task",
                    path=f"candidates[{idx}].task_ids",
                    code="referential_integrity_error"
                ))
            for j, tid in enumerate(served):
                if tid not in task_ids:
                    violations.append(ValidationViolation(
                        message=f"Candidate '{cand.get('id')}' refers to unknown task '{tid}'",
                        path=f"candidates[{idx}].task_ids[{j}]",
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
        if isinstance(obj, dict) and obj.get("type") in {"MONO", "MULTI", "MANY"}:
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

        # Placement extensions. Both are optional blocks, so the rules below
        # iterate over them instead of branching on their presence: an instance
        # without them yields nothing and the very same rules run unchanged.
        pool_ids = self._pool_ids(instance)
        violations.extend(self._validate_resource_model(instance, candidate_ids))
        violations.extend(self._validate_latency_model(instance, task_ids, feature_ids, pool_ids))
        violations.extend(self._validate_pool_dependencies(instance, pool_ids))
        violations.extend(self._validate_candidate_dependencies(instance))
        violations.extend(self._validate_sharing(instance, feature_map))

        return violations

    def _validate_candidate_dependencies(
        self,
        instance: Dict[str, Any],
    ) -> List[ValidationViolation]:
        """A hard SAME_CANDIDATE needs a candidate that serves all of its tasks.

        Whether one exists is a property of the instance, not of the search, so
        an instance that asks for the impossible says so here rather than after
        an engine has exhausted the space looking for it.
        """
        violations: List[ValidationViolation] = []
        candidates = instance.get('candidates', []) or []

        for idx, constraint in enumerate(instance.get('constraints', []) or []):
            if str(constraint.get('type') or '').upper() != 'SAME_CANDIDATE':
                continue
            tasks = [t for t in (constraint.get('tasks') or [])]
            if len(tasks) < 2:
                continue
            shared = {
                cand.get('id')
                for cand in candidates
                if set(tasks).issubset(set(cand.get('task_ids') or []))
            }
            if shared:
                continue
            # A soft constraint that can never hold still leaves the instance
            # solvable - every binding simply pays its penalty - so only a hard
            # one is an error here.
            if not bool(constraint.get('hard', True)):
                continue
            violations.append(ValidationViolation(
                message=(
                    f"Constraint '{constraint.get('id')}' requires tasks "
                    f"{', '.join(tasks)} to share one candidate, but no candidate serves "
                    "all of them"
                ),
                path=f"constraints[{idx}].tasks",
                code="unsatisfiable_constraint"
            ))
        return violations

    def _validate_sharing(
        self,
        instance: Dict[str, Any],
        feature_map: Dict[str, Any],
    ) -> List[ValidationViolation]:
        """Where dividing a feature between tasks would not mean anything.

        DIVIDE says k tasks split one value between them. That only reads as
        arithmetic when the value is non-negative and composes additively, and
        it says nothing at all about a latency the scheduling model computes
        from the placement rather than from the candidate.
        """
        violations: List[ValidationViolation] = []
        divided = [
            fid for fid, feature in feature_map.items()
            if str((feature or {}).get('sharing') or 'REPLICATE').upper() == 'DIVIDE'
        ]
        if not divided:
            return violations

        policies = instance.get('aggregation_policies') or {}
        latency_attr = (
            ((instance.get('latency_model') or {}).get('global_latency') or {}).get('attribute_id')
        )

        for fid in divided:
            index = next(
                (i for i, f in enumerate(instance.get('features', []) or []) if f.get('id') == fid),
                0,
            )
            path = f"features[{index}].sharing"

            if fid == latency_attr:
                violations.append(ValidationViolation(
                    message=(
                        f"Feature '{fid}' is the end-to-end latency the latency model "
                        "computes, which every task pays in full; it cannot be DIVIDE"
                    ),
                    path=path,
                    code="semantic_invariant_error"
                ))

            valid_range = (feature_map[fid] or {}).get('valid_range') or {}
            minimum = valid_range.get('min')
            if isinstance(minimum, (int, float)) and minimum < 0:
                violations.append(ValidationViolation(
                    message=(
                        f"Feature '{fid}' admits negative values, so splitting it between "
                        "tasks does not shrink it; it cannot be DIVIDE"
                    ),
                    path=path,
                    code="semantic_invariant_error"
                ))

            compose = ((policies.get(fid) or {}).get('compose') or {})
            product_slots = [
                slot for slot, spec in compose.items()
                if str((spec or {}).get('fn') or '').upper() in ('PRODUCT', 'SCALED_PRODUCT')
            ]
            if product_slots:
                violations.append(ValidationViolation(
                    message=(
                        f"Feature '{fid}' composes multiplicatively ({', '.join(sorted(product_slots))}), "
                        "where a share of the value is not a share of the result; it cannot be DIVIDE"
                    ),
                    path=path,
                    code="semantic_invariant_error"
                ))

        return violations

    @staticmethod
    def _optional_block(instance: Dict[str, Any], name: str) -> Iterator[Dict[str, Any]]:
        """Yield an optional top-level block, or nothing when it is absent."""
        block = instance.get(name)
        if isinstance(block, dict) and block:
            yield block

    def _pool_ids(self, instance: Dict[str, Any]) -> Set[str]:
        return {
            pool.get('id')
            for resource_model in self._optional_block(instance, 'resource_model')
            for pool in (resource_model.get('pools') or [])
        }

    def _validate_pool_dependencies(
        self,
        instance: Dict[str, Any],
        pool_ids: Set[str],
    ) -> List[ValidationViolation]:
        """Pool dependencies need a resource model to name pools.

        Without one the constraint could never be evaluated, so it is rejected
        here rather than silently ignored at solving time.
        """
        violations: List[ValidationViolation] = []
        for idx, constraint in enumerate(instance.get('constraints', []) or []):
            dep_type = str(constraint.get('type') or '').upper()
            if dep_type in ('SAME_POOL', 'DIFFERENT_POOL') and not pool_ids:
                violations.append(ValidationViolation(
                    message=f"Constraint of type '{dep_type}' requires a resource_model declaring pools",
                    path=f"constraints[{idx}].type",
                    code="referential_integrity_error"
                ))
        return violations

    def _validate_resource_model(
        self,
        instance: Dict[str, Any],
        candidate_ids: Set[str],
    ) -> List[ValidationViolation]:
        violations: List[ValidationViolation] = []

        for resource_model in self._optional_block(instance, 'resource_model'):
            declared_resources = set(resource_model.get('resources', []) or [])
            pool_ids: Set[str] = set()
            for i, pool in enumerate(resource_model.get('pools', []) or []):
                pid = pool.get('id')
                if pid in pool_ids:
                    violations.append(ValidationViolation(
                        message=f"Duplicate pool id '{pid}'",
                        path=f"resource_model.pools[{i}].id",
                        code="duplicate_id_error"
                    ))
                pool_ids.add(pid)
                for resource in (pool.get('capacity') or {}).keys():
                    if resource not in declared_resources:
                        violations.append(ValidationViolation(
                            message=f"Pool '{pid}' declares capacity for undeclared resource '{resource}'",
                            path=f"resource_model.pools[{i}].capacity.{resource}",
                            code="referential_integrity_error"
                        ))

            bound_candidates: Set[str] = set()
            for i, cb in enumerate(resource_model.get('candidate_bindings', []) or []):
                cand_id = cb.get('candidate_id')
                pool_id = cb.get('pool_id')
                if cand_id not in candidate_ids:
                    violations.append(ValidationViolation(
                        message=f"Candidate binding refers to unknown candidate '{cand_id}'",
                        path=f"resource_model.candidate_bindings[{i}].candidate_id",
                        code="referential_integrity_error"
                    ))
                if pool_id not in pool_ids:
                    violations.append(ValidationViolation(
                        message=f"Candidate binding refers to unknown pool '{pool_id}'",
                        path=f"resource_model.candidate_bindings[{i}].pool_id",
                        code="referential_integrity_error"
                    ))
                if cand_id in bound_candidates:
                    violations.append(ValidationViolation(
                        message=f"Candidate '{cand_id}' has more than one pool binding",
                        path=f"resource_model.candidate_bindings[{i}].candidate_id",
                        code="duplicate_id_error"
                    ))
                bound_candidates.add(cand_id)
                for resource in (cb.get('demand') or {}).keys():
                    if resource not in declared_resources:
                        violations.append(ValidationViolation(
                            message=f"Candidate '{cand_id}' declares demand for undeclared resource '{resource}'",
                            path=f"resource_model.candidate_bindings[{i}].demand.{resource}",
                            code="referential_integrity_error"
                        ))

            unbound = candidate_ids - bound_candidates
            if unbound:
                sample = ', '.join(sorted(unbound)[:5])
                violations.append(ValidationViolation(
                    message=f"{len(unbound)} candidate(s) have no pool binding (e.g. {sample})",
                    path="resource_model.candidate_bindings",
                    code="missing_pool_binding"
                ))

            for i, rc in enumerate(resource_model.get('constraints', []) or []):
                for resource in rc.get('resources', []) or []:
                    if resource not in declared_resources:
                        violations.append(ValidationViolation(
                            message=f"Resource constraint refers to undeclared resource '{resource}'",
                            path=f"resource_model.constraints[{i}].resources",
                            code="referential_integrity_error"
                        ))

        return violations

    def _validate_latency_model(
        self,
        instance: Dict[str, Any],
        task_ids: Set[str],
        feature_ids: Set[str],
        pool_ids: Set[str],
    ) -> List[ValidationViolation]:
        violations: List[ValidationViolation] = []

        for latency_model in self._optional_block(instance, 'latency_model'):
            event_pools = latency_model.get('event_generator_pools') or {}
            event_latency = latency_model.get('event_latency_matrix_ms') or {}
            for event_id, pool_id in event_pools.items():
                if pool_ids and pool_id not in pool_ids:
                    violations.append(ValidationViolation(
                        message=f"Event generator '{event_id}' refers to unknown pool '{pool_id}'",
                        path=f"latency_model.event_generator_pools.{event_id}",
                        code="referential_integrity_error"
                    ))

            for i, tc in enumerate(latency_model.get('transition_constraints', []) or []):
                to_task = tc.get('to_task')
                if to_task not in task_ids:
                    violations.append(ValidationViolation(
                        message=f"Transition constraint refers to unknown task '{to_task}'",
                        path=f"latency_model.transition_constraints[{i}].to_task",
                        code="referential_integrity_error"
                    ))
                from_task = tc.get('from_task')
                if from_task is not None and from_task not in task_ids:
                    violations.append(ValidationViolation(
                        message=f"Transition constraint refers to unknown task '{from_task}'",
                        path=f"latency_model.transition_constraints[{i}].from_task",
                        code="referential_integrity_error"
                    ))
                from_event = tc.get('from_event')
                if from_event is not None and from_event not in event_pools and from_event not in event_latency:
                    violations.append(ValidationViolation(
                        message=f"Transition constraint refers to unknown event '{from_event}'",
                        path=f"latency_model.transition_constraints[{i}].from_event",
                        code="referential_integrity_error"
                    ))

            global_latency = latency_model.get('global_latency') or {}
            lat_attr = global_latency.get('attribute_id')
            if lat_attr is not None and lat_attr not in feature_ids:
                violations.append(ValidationViolation(
                    message=f"global_latency refers to unknown feature '{lat_attr}'",
                    path="latency_model.global_latency.attribute_id",
                    code="referential_integrity_error"
                ))
            if str(global_latency.get('and_semantics') or 'MAX').upper() != 'MAX':
                violations.append(ValidationViolation(
                    message="Only and_semantics=MAX is supported by the latency semantics",
                    path="latency_model.global_latency.and_semantics",
                    code="semantic_invariant_error"
                ))

            # The latency model interprets the composition as a precedence DAG:
            # LOOP nodes and repeated task occurrences are not supported.
            occurrences: Dict[str, int] = {}

            def walk(node: Dict[str, Any]) -> None:
                kind = node.get('kind')
                if kind == 'TASK':
                    tid = node.get('task_id')
                    occurrences[tid] = occurrences.get(tid, 0) + 1
                elif kind == 'LOOP':
                    violations.append(ValidationViolation(
                        message="LOOP nodes are not supported when a latency_model is present",
                        path=f"composition...[id={node.get('id')}]",
                        code="semantic_invariant_error"
                    ))
                    walk(node.get('body', {}) or {})
                elif kind in ('SEQ', 'AND'):
                    for child in node.get('children', []) or []:
                        walk(child)
                elif kind == 'XOR':
                    for branch in node.get('branches', []) or []:
                        walk(branch.get('child', {}) or {})

            walk((instance.get('composition') or {}).get('root') or {})
            for tid, count in occurrences.items():
                if count > 1:
                    violations.append(ValidationViolation(
                        message=f"Task '{tid}' appears {count} times in the composition; "
                                "the latency model requires a single occurrence per task",
                        path="composition",
                        code="semantic_invariant_error"
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
