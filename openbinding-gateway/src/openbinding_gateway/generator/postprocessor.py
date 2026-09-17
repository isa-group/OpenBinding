"""Postprocessor transforming intermediate QACO problem representations into strict BIM v1 packages."""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from ..v1.package import InstancePackage
from ..v1.compiler import compile_instance
from .compatibility import TargetCapabilities
from .legacy_parser import LegacyProblem, StructureNode


def normalize_probabilities(probs: list[float], precision: int = 4) -> list[float]:
    """Normalize a list of probabilities so their string representations sum exactly to Decimal(1)."""
    if not probs:
        return []
    total = sum(probs)
    if total <= 0:
        raw = [1.0 / len(probs)] * len(probs)
    else:
        raw = [p / total for p in probs]

    d_raw = [Decimal(str(round(p, precision))) for p in raw[:-1]]
    remainder = Decimal(1) - sum(d_raw, Decimal(0))
    if remainder <= Decimal(0):
        step = Decimal(f"1e-{precision}")
        q = (Decimal(1) / Decimal(len(probs))).quantize(step)
        d_raw = [q] * (len(probs) - 1)
        remainder = Decimal(1) - sum(d_raw, Decimal(0))

    d_raw.append(remainder)
    return [float(d) for d in d_raw]


def _clean_id(raw: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in str(raw))
    cleaned = cleaned.lower().strip("_")
    if not cleaned or not cleaned[0].isalpha():
        cleaned = f"t_{cleaned}"
    return cleaned


class BIMPostprocessor:
    """Transforms a parsed or synthesized LegacyProblem into a valid BIM v1 InstancePackage."""

    def __init__(
        self,
        name: str = "generated_instance",
        profile: str = "qos-binding/v1",
        dialects: list[str] | None = None,
        capabilities: TargetCapabilities | None = None,
        guarantee_feasibility: bool = True,
        tension: float = 0.7,
        repair_empty_branches: bool = True,
    ):
        self.name = _clean_id(name)
        self.profile = profile
        self.dialects = dialects or ["qos-binding/v1"]
        self.capabilities = capabilities or TargetCapabilities(target_engines=[])
        self.guarantee_feasibility = guarantee_feasibility
        self.tension = max(0.0, min(1.0, tension))
        self.repair_empty_branches = repair_empty_branches

        self.branch_counter = 0
        self.routing_entries: list[dict[str, Any]] = []

    def _normalize_feature_name(self, raw_name: str) -> str:
        name_lower = raw_name.lower().strip()
        mapping = {
            "exectime": "latency",
            "time": "latency",
            "executiontime": "latency",
            "cost": "cost",
            "availability": "availability",
            "reliability": "reliability",
            "security": "security",
            "carbon": "carbon",
            "trust": "trust",
        }
        return mapping.get(name_lower, name_lower)

    _normalize_metric_name = _normalize_feature_name

    def _build_workflow_node(
        self,
        node: StructureNode,
        available_tasks: list[str],
        placed_tasks: set[str],
    ) -> dict[str, Any]:
        if node.kind == "task":
            t_id = _clean_id(node.id or "task")
            placed_tasks.add(t_id)
            return {"task": {"resource": "application", "id": t_id}}

        if node.kind == "sequence":
            children: list[dict[str, Any]] = []
            for child in node.children:
                c_node = self._build_workflow_node(child, available_tasks, placed_tasks)
                children.append(c_node)
            if not children:
                if self.repair_empty_branches:
                    unplaced = [t for t in available_tasks if t not in placed_tasks]
                    if unplaced:
                        chosen = unplaced[0]
                        placed_tasks.add(chosen)
                        return {"task": {"resource": "application", "id": chosen}}
                return {"empty": True}
            if len(children) == 1:
                return children[0]
            return {"sequence": children}

        if node.kind == "flow":
            children = [
                self._build_workflow_node(child, available_tasks, placed_tasks)
                for child in node.children
            ]
            if not children:
                return {"empty": True}
            if len(children) == 1:
                return children[0]
            return {"parallel": children}

        if node.kind == "loop":
            body: dict[str, Any]
            if not node.children:
                unplaced = [t for t in available_tasks if t not in placed_tasks]
                chosen = unplaced[0] if unplaced else (available_tasks[0] if available_tasks else "task_default")
                placed_tasks.add(chosen)
                body = {"task": {"resource": "application", "id": chosen}}
            elif len(node.children) == 1:
                body = self._build_workflow_node(node.children[0], available_tasks, placed_tasks)
            else:
                body = {
                    "sequence": [
                        self._build_workflow_node(c, available_tasks, placed_tasks)
                        for c in node.children
                    ]
                }
            count = max(1, min(node.iterations, 50))
            return {"repeat": {"body": body, "count": count}}

        if node.kind == "branch":
            branches: list[dict[str, Any]] = []
            probs = normalize_probabilities(
                node.probabilities or [1.0] * max(len(node.children), 2)
            )

            # Ensure at least 2 branches for exclusive
            children = list(node.children)
            while len(children) < 2:
                children.append(StructureNode(kind="empty"))
            if len(probs) != len(children):
                probs = normalize_probabilities([1.0] * len(children))

            for b_idx, child in enumerate(children):
                self.branch_counter += 1
                branch_id = f"flow_branch_{self.branch_counter}"
                prob = probs[b_idx]
                flow_node = self._build_workflow_node(child, available_tasks, placed_tasks)
                branches.append({
                    "id": branch_id,
                    "flow": flow_node,
                })
                self.routing_entries.append({
                    "target": {"resource": "application", "id": branch_id},
                    "probability": prob,
                })

            return {"exclusive": branches}

        return {"empty": True}

    def process(self, problem: LegacyProblem) -> InstancePackage:
        """Convert LegacyProblem to a complete BIM v1 InstancePackage."""
        self.branch_counter = 0
        self.routing_entries.clear()

        # 1. Normalize tasks
        tasks_map: dict[str, str] = {}
        all_task_ids: list[str] = []

        # Collect all abstract tasks from structure and candidates
        raw_task_names = list(problem.abstract_services)
        for t in problem.candidates.keys():
            if t not in raw_task_names:
                raw_task_names.append(t)

        def _collect_tasks(node: StructureNode):
            if node.kind == "task" and node.id:
                if node.id not in raw_task_names:
                    raw_task_names.append(node.id)
            for ch in node.children:
                _collect_tasks(ch)

        _collect_tasks(problem.structure)

        if not raw_task_names:
            raw_task_names = ["t1", "t2"]

        for raw_t in raw_task_names:
            clean_t = _clean_id(raw_t)
            tasks_map[raw_t] = clean_t
            if clean_t not in all_task_ids:
                all_task_ids.append(clean_t)

        # 2. Build Workflow
        placed_tasks: set[str] = set()
        workflow_root = self._build_workflow_node(problem.structure, all_task_ids, placed_tasks)

        # If any tasks were never placed in the workflow, wrap in an outer sequence
        unplaced = [t for t in all_task_ids if t not in placed_tasks]
        if unplaced:
            unplaced_nodes = [{"task": {"resource": "application", "id": t}} for t in unplaced]
            if "sequence" in workflow_root:
                workflow_root["sequence"].extend(unplaced_nodes)
            else:
                workflow_root = {"sequence": [workflow_root, *unplaced_nodes]}

        # If root is still empty or single task, ensure valid structure
        if "empty" in workflow_root:
            workflow_root = {"sequence": [{"task": {"resource": "application", "id": all_task_ids[0]}}]}

        # 3. Build Features
        features_dict: dict[str, Any] = {}
        feature_key_map: dict[str, str] = {}

        # Default properties if none found
        raw_props = problem.qos_properties
        if not raw_props:
            from .legacy_parser import QoSPropertySpec
            raw_props = {
                "Cost": QoSPropertySpec(name="Cost", direction="minimize", domain_min=0.0, domain_max=100.0, weight=0.3),
                "ExecTime": QoSPropertySpec(name="ExecTime", direction="minimize", domain_min=0.0, domain_max=500.0, weight=0.3),
                "Availability": QoSPropertySpec(name="Availability", direction="maximize", domain_min=0.0, domain_max=1.0, weight=0.2),
                "Reliability": QoSPropertySpec(name="Reliability", direction="maximize", domain_min=0.0, domain_max=1.0, weight=0.2),
            }

        is_minizinc = "minizinc-csp" in self.capabilities.target_engines

        for raw_name, prop_spec in raw_props.items():
            norm_name = self._normalize_feature_name(raw_name)
            feature_key_map[raw_name] = norm_name

            direction = prop_spec.direction
            scope = "invocation" if norm_name == "latency" else "selectedCandidate"
            unit = "ms" if norm_name == "latency" else ("EUR" if norm_name == "cost" else "1")

            # Standard aggregations compatible with MiniZinc and Heuristics
            if norm_name in ("latency", "cost"):
                aggr = {
                    "sequence": "sum",
                    "parallel": "max" if norm_name == "latency" else "sum",
                    "exclusive": "weightedSum",
                    "repeat": "scale",
                    "selection": "sum",
                }
            else:
                # Reliability / Availability / Security / Trust
                if is_minizinc:
                    aggr = {
                        "sequence": "min",
                        "parallel": "min",
                        "exclusive": "min",
                        "repeat": "identity",
                        "selection": "min",
                    }
                else:
                    aggr = {
                        "sequence": "product",
                        "parallel": "product",
                        "exclusive": "weightedSum",
                        "repeat": "power",
                        "selection": "product",
                    }

            seq_op = aggr.get("sequence", "sum")
            dom_min = float(prop_spec.domain_min)
            dom_max = float(prop_spec.domain_max)
            if seq_op == "sum":
                dom_min = min(0.0, dom_min)
                neutral = 0.0
            elif seq_op == "product":
                dom_max = max(1.0, dom_max)
                dom_min = min(0.0, dom_min)
                neutral = 1.0
            elif seq_op == "min":
                neutral = dom_max
            elif seq_op == "max":
                neutral = dom_min
            else:
                neutral = 0.0

            features_dict[norm_name] = {
                "unit": unit,
                "direction": direction,
                "scope": scope,
                "aggregation": aggr,
                "neutral": neutral,
                "domain": {
                    "kind": "real",
                    "minimum": dom_min,
                    "maximum": dom_max,
                },
            }

        # 4. Build Candidate Catalog
        providers = {
            "provider-core": {
                "name": "Core Provider",
                "properties": {"tier": "standard", "region": "eu-west"},
            }
        }
        feature_bindings = {
            m_id: {"resource": "application", "id": m_id}
            for m_id in features_dict
        }

        candidates_dict: dict[str, Any] = {}
        witness_solution: dict[str, str] = {}  # task_id -> candidate_id

        for raw_task, c_list in problem.candidates.items():
            clean_task = tasks_map.get(raw_task, _clean_id(raw_task))
            if not c_list:
                continue
            for c_idx, cws in enumerate(c_list):
                c_id = _clean_id(f"{clean_task}_{cws.name or c_idx}")
                c_features: dict[str, float] = {}
                for r_prop, val in (cws.features if hasattr(cws, "features") and cws.features else cws.metrics).items():
                    n_prop = feature_key_map.get(r_prop, self._normalize_feature_name(r_prop))
                    if n_prop in features_dict:
                        c_features[n_prop] = float(val)

                # Ensure all features have a value
                for m_id, m_spec in features_dict.items():
                    if m_id not in c_features:
                        c_features[m_id] = 0.5 * (m_spec["domain"]["minimum"] + m_spec["domain"]["maximum"])

                candidates_dict[c_id] = {
                    "provides": f"service/{clean_task}",
                    "provider": {"resource": "catalog", "id": "provider-core"},
                    "features": c_features,
                }
                if clean_task not in witness_solution:
                    witness_solution[clean_task] = c_id

        # Fallback for tasks with no declared candidates
        for t_id in all_task_ids:
            if t_id not in witness_solution:
                for c_idx in range(2):
                    c_id = f"cand_{t_id}_{c_idx + 1}"
                    c_features = {}
                    for m_id, m_spec in features_dict.items():
                        c_features[m_id] = round(0.5 * (m_spec["domain"]["minimum"] + m_spec["domain"]["maximum"]), 4)
                    candidates_dict[c_id] = {
                        "provides": f"service/{t_id}",
                        "provider": {"resource": "catalog", "id": "provider-core"},
                        "features": c_features,
                    }
                    if t_id not in witness_solution:
                        witness_solution[t_id] = c_id

        # 5. Witness Solution Evaluation & Feasibility Control
        def _eval_witness(wnode: dict[str, Any], m_id: str) -> float:
            aggr = features_dict[m_id]["aggregation"]
            if "task" in wnode:
                t_id = wnode["task"]["id"]
                cand_id = witness_solution.get(t_id)
                cand = candidates_dict.get(cand_id, {})
                return cand.get("features", {}).get(m_id, 0.0)

            if "sequence" in wnode:
                vals = [_eval_witness(ch, m_id) for ch in wnode["sequence"]]
                op = aggr.get("sequence", "sum")
                if op == "sum":
                    return sum(vals)
                if op == "product":
                    p = 1.0
                    for v in vals:
                        p *= v
                    return p
                if op == "min":
                    return min(vals, default=0.0)
                if op == "max":
                    return max(vals, default=0.0)
                return sum(vals)

            if "parallel" in wnode:
                vals = [_eval_witness(ch, m_id) for ch in wnode["parallel"]]
                op = aggr.get("parallel", "max")
                if op == "max":
                    return max(vals, default=0.0)
                if op == "sum":
                    return sum(vals)
                if op == "product":
                    p = 1.0
                    for v in vals:
                        p *= v
                    return p
                if op == "min":
                    return min(vals, default=0.0)
                return max(vals, default=0.0)

            if "repeat" in wnode:
                val = _eval_witness(wnode["repeat"]["body"], m_id)
                cnt = wnode["repeat"].get("count", 1)
                op = aggr.get("repeat", "scale")
                if op == "scale":
                    return val * cnt
                if op == "power":
                    return val ** cnt
                if op == "identity":
                    return val
                return val * cnt

            if "exclusive" in wnode:
                branches = wnode["exclusive"]
                probs_map = {
                    e["target"]["id"]: e["probability"]
                    for e in self.routing_entries
                }
                op = aggr.get("exclusive", "weightedSum")
                if op == "weightedSum":
                    return sum(
                        probs_map.get(b["id"], 1.0 / len(branches)) * _eval_witness(b["flow"], m_id)
                        for b in branches
                    )
                if op == "min":
                    return min((_eval_witness(b["flow"], m_id) for b in branches), default=0.0)
                if op == "max":
                    return max((_eval_witness(b["flow"], m_id) for b in branches), default=0.0)
                return sum(_eval_witness(b["flow"], m_id) for b in branches) / len(branches)

            return 0.0

        witness_values: dict[str, float] = {
            m_id: _eval_witness(workflow_root, m_id)
            for m_id in features_dict
        }

        # 6. Build Constraints
        constraints_spec: dict[str, Any] = {}
        c_index = 0

        # Include constraints from LegacyProblem
        for constr in problem.constraints:
            norm_prop = feature_key_map.get(constr.property_name, self._normalize_feature_name(constr.property_name))
            if norm_prop not in features_dict:
                continue
            c_index += 1
            direction = features_dict[norm_prop]["direction"]
            v_witness = witness_values[norm_prop]
            m_domain = features_dict[norm_prop]["domain"]

            bound_val = constr.value
            if self.guarantee_feasibility:
                if direction == "minimize":
                    # bound >= v_witness
                    max_val = max(m_domain["maximum"] * len(all_task_ids), v_witness * 1.5)
                    bound_val = v_witness + (1.0 - self.tension) * (max_val - v_witness)
                    op = "<="
                else:
                    # bound <= v_witness
                    min_val = min(m_domain["minimum"], v_witness * 0.5)
                    bound_val = v_witness - (1.0 - self.tension) * (v_witness - min_val)
                    op = ">="
            else:
                op = constr.operator

            bound_rounded = round(bound_val, 4)
            constraints_spec[f"c_{c_index}_{norm_prop}"] = {
                "assert": f"features.{norm_prop} {op} {bound_rounded}",
                "enforcement": "hard",
            }

        # 7. Build Optimization
        opt_mode = self.capabilities.default_optimization
        obj_type = self.capabilities.default_objective_type

        # Select features for optimization terms
        terms = []
        for m_id, m_spec in list(features_dict.items())[:max(1, self.capabilities.min_objectives)]:
            term: dict[str, Any] = {
                "feature": {"resource": "application", "id": m_id},
                "normalize": {
                    "min": m_spec["domain"]["minimum"],
                    "max": m_spec["domain"]["maximum"],
                    "clamp": True,
                },
            }
            if opt_mode == "weighted":
                weight = 1.0 / max(1, min(len(features_dict), self.capabilities.min_objectives))
                term["weight"] = round(weight, 4)
            terms.append(term)

        # Ensure weighted terms sum to 1.0 if weighted
        if opt_mode == "weighted" and terms:
            w_sum = sum(t.get("weight", 0.0) for t in terms[:-1])
            terms[-1]["weight"] = round(1.0 - w_sum, 4)

        n_terms = len(terms)
        if n_terms >= 3:
            eff_type = "MANY" if obj_type == "MANY" else "MULTI"
        elif n_terms == 2:
            eff_type = "MULTI"
        else:
            eff_type = "MONO"

        opt_spec: dict[str, Any] = {
            "mode": opt_mode,
            "type": eff_type,
            "terms": terms,
        }

        # 8. Assemble Documents
        instance_doc = {
            "apiVersion": "bim/v1",
            "kind": "Instance",
            "metadata": {
                "name": self.name,
                "version": "1.0.0",
                "description": f"Generated QACO problem instance {self.name}",
                "annotations": {
                    "generator": "openbinding-bim-generator/v1",
                    "guarantee_feasibility": str(self.guarantee_feasibility).lower(),
                    "tension": str(self.tension),
                },
            },
            "spec": {
                "profile": self.profile,
                "resources": {
                    "application": {
                        "application": "application.json",
                        "routing": "routing.json",
                    },
                    "candidateCatalog": {
                        "catalog": "candidates.json",
                    },
                    "constraintSet": {
                        "constraints": "constraints.json",
                    },
                    "optimization": {
                        "optimization": "optimization.json",
                    },
                },
            },
        }

        app_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "Application",
            "metadata": {"name": f"{self.name}_application"},
            "spec": {
                "tasks": {t_id: f"service/{t_id}" for t_id in all_task_ids},
                "features": features_dict,
                "workflow": workflow_root,
            },
        }

        routing_spec: dict[str, Any]
        if self.routing_entries:
            routing_spec = {"entries": self.routing_entries}
        else:
            routing_spec = {"uniform": True}

        routing_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "RoutingOverlay",
            "metadata": {"name": f"{self.name}_routing"},
            "spec": routing_spec,
        }

        candidates_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "CandidateCatalog",
            "metadata": {"name": f"{self.name}_catalog"},
            "spec": {
                "providers": providers,
                "featureBindings": feature_bindings,
                "candidates": candidates_dict,
            },
        }

        constraints_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "ConstraintSet",
            "metadata": {"name": f"{self.name}_constraints"},
            "spec": {
                "constraints": constraints_spec,
            },
        }

        optimization_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "Optimization",
            "metadata": {"name": f"{self.name}_optimization"},
            "spec": opt_spec,
        }

        files = {
            "instance.json": json.dumps(instance_doc, indent=2).encode("utf-8"),
            "application.json": json.dumps(app_doc, indent=2).encode("utf-8"),
            "routing.json": json.dumps(routing_doc, indent=2).encode("utf-8"),
            "candidates.json": json.dumps(candidates_doc, indent=2).encode("utf-8"),
            "constraints.json": json.dumps(constraints_doc, indent=2).encode("utf-8"),
            "optimization.json": json.dumps(optimization_doc, indent=2).encode("utf-8"),
        }

        package = InstancePackage(files)
        # Validate that compiler can lower it without errors
        compile_instance(package)
        return package
