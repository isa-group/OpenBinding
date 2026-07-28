from __future__ import annotations

import os

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

from .utils import load_json, write_json


@dataclass
class Violation:
    code: str
    path: str
    message: str
    stage: str = "semantic"

    def as_dict(self) -> dict[str, str]:
        return {"stage": self.stage, "code": self.code, "path": self.path, "message": self.message}


def validate_instance(instance: dict[str, Any], schema_path: str | Path | None = None) -> list[Violation]:
    violations: list[Violation] = []
    if schema_path is not None:
        violations.extend(validate_json_schema(instance, schema_path))
    violations.extend(validate_semantics(instance))
    return violations


def validate_json_schema(instance: dict[str, Any], schema_path: str | Path) -> list[Violation]:
    try:
        import jsonschema
    except ModuleNotFoundError:
        return [
            Violation(
                stage="schema",
                code="jsonschema_not_installed",
                path="$",
                message="jsonschema is not installed; semantic BIM' validation was still executed",
            )
        ]

    # The general schema is split one file per element of the tuple, so it has
    # to be assembled before it can validate anything. The gateway owns that
    # assembly; loading the root document on its own would leave every
    # cross-file reference dangling.
    try:
        from openbinding_gateway.validation.schema_bundle import load_general_schema

        os.environ.setdefault("GENERAL_SCHEMA_PATH", str(schema_path))
        schema = load_general_schema()
    except ImportError:
        schema = load_json(schema_path)
    validator = jsonschema.Draft202012Validator(schema)
    violations = []
    for error in sorted(validator.iter_errors(instance), key=lambda e: list(e.path)):
        path = "$" + "".join(f"[{p!r}]" if isinstance(p, str) else f"[{p}]" for p in error.path)
        violations.append(Violation(stage="schema", code="json_schema_error", path=path, message=error.message))
    return violations


def validate_semantics(instance: dict[str, Any]) -> list[Violation]:
    violations: list[Violation] = []
    features = {f.get("id") for f in instance.get("features", [])}
    tasks = {t.get("id") for t in instance.get("tasks", [])}
    providers = {p.get("id") for p in instance.get("providers", [])}
    candidates = {c.get("id") for c in instance.get("candidates", [])}
    pools = {p.get("id") for p in instance.get("resource_model", {}).get("pools", [])}
    resources = set(instance.get("resource_model", {}).get("resources", []))

    for section, values in (("features", features), ("tasks", tasks), ("providers", providers), ("candidates", candidates), ("resource_model.pools", pools)):
        if None in values:
            violations.append(Violation("missing_id", section, f"{section} contains an item without id"))
        check_duplicate_ids(instance, section, violations)

    for idx, candidate in enumerate(instance.get("candidates", [])):
        cid = candidate.get("id")
        if candidate.get("task_id") not in tasks:
            violations.append(Violation("unknown_task", f"candidates[{idx}].task_id", f"Candidate {cid} references unknown task {candidate.get('task_id')}"))
        if candidate.get("provider_id") not in providers:
            violations.append(Violation("unknown_provider", f"candidates[{idx}].provider_id", f"Candidate {cid} references unknown provider {candidate.get('provider_id')}"))
        cand_features = set((candidate.get("features") or {}).keys())
        missing = features - cand_features
        unknown = cand_features - features
        if missing:
            violations.append(Violation("missing_candidate_features", f"candidates[{idx}].features", f"Candidate {cid} misses features: {', '.join(sorted(missing))}"))
        if unknown:
            violations.append(Violation("unknown_candidate_features", f"candidates[{idx}].features", f"Candidate {cid} defines unknown features: {', '.join(sorted(unknown))}"))

    candidates_by_task: dict[str, int] = {}
    for candidate in instance.get("candidates", []):
        task_id = candidate.get("task_id")
        if task_id:
            candidates_by_task[task_id] = candidates_by_task.get(task_id, 0) + 1
    for task_id in sorted(tasks):
        if candidates_by_task.get(task_id, 0) == 0:
            violations.append(Violation("missing_task_candidates", "candidates", f"Task {task_id} has no candidates"))

    composition_tasks = collect_composition_tasks(instance.get("composition", {}).get("root"))
    for task_id in composition_tasks - tasks:
        violations.append(Violation("unknown_composition_task", "composition", f"Composition references unknown task {task_id}"))

    for idx, constraint in enumerate(instance.get("constraints", []) or []):
        attr = constraint.get("attribute_id")
        if attr and attr not in features:
            violations.append(Violation("unknown_constraint_feature", f"constraints[{idx}].attribute_id", f"Constraint references unknown feature {attr}"))
        for task_id in constraint.get("tasks", []) or []:
            if task_id not in tasks:
                violations.append(Violation("unknown_constraint_task", f"constraints[{idx}].tasks", f"Constraint references unknown task {task_id}"))
        for candidate_id in constraint.get("candidates", []) or []:
            if candidate_id not in candidates:
                violations.append(Violation("unknown_constraint_candidate", f"constraints[{idx}].candidates", f"Constraint references unknown candidate {candidate_id}"))

    seen_candidate_bindings: set[str] = set()
    for idx, binding in enumerate(instance.get("resource_model", {}).get("candidate_bindings", [])):
        cid = binding.get("candidate_id")
        pool_id = binding.get("pool_id")
        if cid not in candidates:
            violations.append(Violation("unknown_resource_candidate", f"resource_model.candidate_bindings[{idx}].candidate_id", f"Resource binding references unknown candidate {cid}"))
        if pool_id not in pools:
            violations.append(Violation("unknown_resource_pool", f"resource_model.candidate_bindings[{idx}].pool_id", f"Resource binding references unknown pool {pool_id}"))
        if cid in seen_candidate_bindings:
            violations.append(Violation("duplicate_resource_binding", f"resource_model.candidate_bindings[{idx}].candidate_id", f"Candidate {cid} has multiple resource bindings"))
        seen_candidate_bindings.add(cid)
        for resource in (binding.get("demand") or {}).keys():
            if resource not in resources:
                violations.append(Violation("unknown_demand_resource", f"resource_model.candidate_bindings[{idx}].demand", f"Demand uses undeclared resource {resource}"))
    missing_bindings = candidates - seen_candidate_bindings
    if missing_bindings:
        violations.append(Violation("missing_resource_bindings", "resource_model.candidate_bindings", f"Missing resource bindings for candidates: {', '.join(sorted(missing_bindings)[:20])}"))

    pools_by_id = {p.get("id"): p for p in instance.get("resource_model", {}).get("pools", [])}
    for idx, constraint in enumerate(instance.get("resource_model", {}).get("constraints", [])):
        for resource in constraint.get("resources", []) or []:
            if resource not in resources:
                violations.append(Violation("unknown_resource_constraint_resource", f"resource_model.constraints[{idx}].resources", f"Resource constraint references undeclared resource {resource}"))
        affected = affected_pools(constraint, pools_by_id)
        for pool in affected:
            for resource in constraint.get("resources", []) or []:
                if resource not in (pool.get("capacity") or {}):
                    violations.append(Violation("missing_pool_capacity", f"resource_model.pools.{pool.get('id')}.capacity", f"Pool {pool.get('id')} lacks capacity for {resource}"))

    latency_model = instance.get("latency_model", {})
    matrix = latency_model.get("pool_latency_matrix_ms", {}) or {}
    for pool_id in pools:
        if pool_id not in matrix:
            violations.append(Violation("missing_latency_row", "latency_model.pool_latency_matrix_ms", f"Missing latency row for pool {pool_id}"))
            continue
        missing_targets = pools - set(matrix.get(pool_id, {}).keys())
        if missing_targets:
            violations.append(Violation("incomplete_latency_row", f"latency_model.pool_latency_matrix_ms.{pool_id}", f"Latency row {pool_id} misses {len(missing_targets)} pool(s)"))

    events = set((latency_model.get("event_generator_pools") or {}).keys())
    for event_id, pool_id in (latency_model.get("event_generator_pools") or {}).items():
        if pool_id not in pools:
            violations.append(Violation("unknown_event_pool", f"latency_model.event_generator_pools.{event_id}", f"Event generator maps to unknown pool {pool_id}"))
    for event_id, row in (latency_model.get("event_latency_matrix_ms") or {}).items():
        if event_id not in events:
            violations.append(Violation("unknown_event_latency_row", f"latency_model.event_latency_matrix_ms.{event_id}", f"Latency row for unknown event {event_id}"))
        missing_targets = pools - set((row or {}).keys())
        if missing_targets:
            violations.append(Violation("incomplete_event_latency_row", f"latency_model.event_latency_matrix_ms.{event_id}", f"Event latency row {event_id} misses {len(missing_targets)} pool(s)"))

    for idx, constraint in enumerate(latency_model.get("transition_constraints", []) or []):
        from_task = constraint.get("from_task")
        from_event = constraint.get("from_event")
        to_task = constraint.get("to_task")
        if from_task and from_task not in tasks:
            violations.append(Violation("unknown_latency_from_task", f"latency_model.transition_constraints[{idx}].from_task", f"Latency constraint references unknown task {from_task}"))
        if from_event and from_event not in events:
            violations.append(Violation("unknown_latency_from_event", f"latency_model.transition_constraints[{idx}].from_event", f"Latency constraint references unknown event {from_event}"))
        if to_task not in tasks:
            violations.append(Violation("unknown_latency_to_task", f"latency_model.transition_constraints[{idx}].to_task", f"Latency constraint references unknown task {to_task}"))

    return violations


def check_duplicate_ids(instance: dict[str, Any], section: str, violations: list[Violation]) -> None:
    current: Any = instance
    for part in section.split("."):
        current = current.get(part, {}) if isinstance(current, dict) else {}
    if not isinstance(current, list):
        return
    seen: set[str] = set()
    for idx, item in enumerate(current):
        item_id = item.get("id") if isinstance(item, dict) else None
        if item_id in seen:
            violations.append(Violation("duplicate_id", f"{section}[{idx}].id", f"Duplicate id {item_id} in {section}"))
        if item_id:
            seen.add(item_id)


def collect_composition_tasks(node: dict[str, Any] | None) -> set[str]:
    if not node:
        return set()
    kind = node.get("kind")
    if kind == "TASK":
        return {node.get("task_id")}
    if kind in {"SEQ", "AND"}:
        out: set[str] = set()
        for child in node.get("children", []) or []:
            out |= collect_composition_tasks(child)
        return out
    if kind == "XOR":
        out = set()
        for branch in node.get("branches", []) or []:
            out |= collect_composition_tasks(branch.get("child"))
        return out
    if kind == "LOOP":
        return collect_composition_tasks(node.get("body"))
    return set()


def affected_pools(constraint: dict[str, Any], pools_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    if constraint.get("scope") == "POOL_KIND":
        kinds = set(constraint.get("pool_kinds", []) or [])
        return [pool for pool in pools_by_id.values() if pool.get("kind") in kinds]
    return list(pools_by_id.values())


def validate_paths(instances: str | Path, schema: str | Path, report: str | Path) -> dict[str, Any]:
    root = Path(instances)
    files = sorted(root.rglob("*.json"))
    results = []
    valid = 0
    for path in files:
        instance = json.loads(path.read_text(encoding="utf-8"))
        violations = validate_instance(instance, schema)
        hard_violations = [v for v in violations if v.code != "jsonschema_not_installed"]
        if not hard_violations:
            valid += 1
        results.append(
            {
                "path": str(path),
                "valid": not hard_violations,
                "violations": [v.as_dict() for v in violations],
            }
        )
    summary = {"total": len(files), "valid": valid, "invalid": len(files) - valid, "results": results}
    write_json(report, summary)
    return summary
