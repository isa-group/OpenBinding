"""Engine capability intersection and compatibility validation for BIM v1 generation."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ..v1.compiler import _schema_root


class IncompatibleTargetEnginesError(ValueError):
    """Raised when the specified target engines have mutually exclusive capability requirements."""

    def __init__(self, message: str, conflicts: list[dict[str, Any]] | None = None):
        super().__init__(message)
        self.message = message
        self.conflicts = conflicts or []


@dataclass
class TargetCapabilities:
    target_engines: list[str]
    allowed_optimizations: list[str] = field(default_factory=lambda: ["weighted", "pareto"])
    default_optimization: str = "weighted"
    allowed_objective_types: list[str] = field(default_factory=lambda: ["MONO", "MANY"])
    default_objective_type: str = "MONO"
    min_objectives: int = 1
    max_tasks: int = 10000
    allowed_workflow_nodes: set[str] = field(default_factory=lambda: {"task", "empty", "sequence", "parallel", "exclusive.probabilistic", "repeat.count"})
    allowed_aggregations: set[str] = field(default_factory=lambda: {
        "sequence.sum", "sequence.min", "sequence.max",
        "parallel.sum", "parallel.min", "parallel.max",
        "exclusive.weightedSum", "exclusive.min", "exclusive.max",
        "repeat.scale", "repeat.identity",
        "selection.sum", "selection.min", "selection.max",
    })
    mode_by_engine: dict[str, str] = field(default_factory=dict)


def _load_engine_manifest(name: str) -> dict[str, Any] | None:
    manifest_dir = _schema_root() / "manifests"
    path = manifest_dir / f"{name}.json"
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def resolve_engine_capabilities(target_engines: list[str] | None) -> TargetCapabilities:
    """Compute the strict intersection of capabilities for the given target engines.

    Raises IncompatibleTargetEnginesError if requirements are disjoint.
    """
    if not target_engines:
        return TargetCapabilities(target_engines=[])

    unique_engines = list(dict.fromkeys(target_engines))
    manifests: dict[str, dict[str, Any]] = {}

    for engine in unique_engines:
        m = _load_engine_manifest(engine)
        if m is None:
            raise IncompatibleTargetEnginesError(
                f"Unknown or uninstalled engine: {engine!r}",
                conflicts=[{"engine": engine, "reason": "manifest_not_found"}],
            )
        manifests[engine] = m

    # For each engine, collect candidate (mode, capabilities, limits) tuples
    engine_modes: dict[str, list[dict[str, Any]]] = {}
    for engine, manifest in manifests.items():
        modes = manifest.get("spec", {}).get("modes", [])
        if not modes:
            raise IncompatibleTargetEnginesError(
                f"Engine {engine!r} has no declared modes",
                conflicts=[{"engine": engine, "reason": "no_modes"}],
            )
        engine_modes[engine] = modes

    # Find common optimization modes across all engines
    # An engine supports an optimization mode if at least one of its modes supports it
    engine_opts: dict[str, set[str]] = {}
    engine_obj_types: dict[str, set[str]] = {}
    engine_min_objs: dict[str, int] = {}

    for engine, modes in engine_modes.items():
        opts: set[str] = set()
        objs: set[str] = set()
        min_obj = 1
        for mode in modes:
            caps = mode.get("capabilities", {})
            opt_spec = caps.get("optimization", {})
            if opt_spec.get("selector") == "all":
                opts.update(["weighted", "pareto", "satisfy", "lexicographic"])
            else:
                opts.update(opt_spec.get("values", []))

            obj_spec = caps.get("objectiveTypes", {})
            if obj_spec.get("selector") == "all":
                objs.update(["MONO", "MANY"])
            else:
                objs.update(obj_spec.get("values", []))

            limits = mode.get("limits", {})
            if "minObjectives" in limits:
                min_obj = max(min_obj, limits["minObjectives"])

        engine_opts[engine] = opts
        engine_obj_types[engine] = objs
        engine_min_objs[engine] = min_obj

    # Intersect optimization modes
    common_opts = set.intersection(*engine_opts.values()) if engine_opts else set()
    common_objs = set.intersection(*engine_obj_types.values()) if engine_obj_types else set()

    conflicts: list[dict[str, Any]] = []
    if not common_opts:
        for engine, opts in engine_opts.items():
            conflicts.append({
                "engine": engine,
                "dimension": "optimization",
                "supported": sorted(opts),
            })
    if not common_objs:
        for engine, objs in engine_obj_types.items():
            conflicts.append({
                "engine": engine,
                "dimension": "objectiveTypes",
                "supported": sorted(objs),
            })

    if conflicts:
        details = "; ".join(
            f"{c['engine']} requires {c['dimension']} in {c['supported']}"
            for c in conflicts
        )
        raise IncompatibleTargetEnginesError(
            f"Incompatible target engines [{', '.join(unique_engines)}]: {details}",
            conflicts=conflicts,
        )

    # Intersect aggregations
    all_aggregations: list[set[str]] = []
    for _engine, modes in engine_modes.items():
        aggr_set: set[str] = set()
        for mode in modes:
            caps = mode.get("capabilities", {})
            aggr_spec = caps.get("aggregations", {})
            if aggr_spec.get("selector") == "all":
                aggr_set.update([
                    "sequence.sum", "sequence.product", "sequence.min", "sequence.max",
                    "parallel.sum", "parallel.product", "parallel.min", "parallel.max",
                    "exclusive.weightedSum", "exclusive.weightedProduct", "exclusive.min", "exclusive.max",
                    "repeat.scale", "repeat.identity", "repeat.power",
                    "selection.sum", "selection.min", "selection.max",
                ])
            else:
                aggr_set.update(aggr_spec.get("values", []))
        all_aggregations.append(aggr_set)

    common_aggrs = set.intersection(*all_aggregations) if all_aggregations else set()

    # Determine default optimization & objective type
    default_opt = "weighted" if "weighted" in common_opts else next(iter(sorted(common_opts)))
    default_obj = "MONO" if "MONO" in common_objs and default_opt == "weighted" else next(iter(sorted(common_objs)))
    req_min_objs = max(engine_min_objs.values()) if engine_min_objs else 1

    # If pareto is chosen or default, objectiveType should be MANY if supported, and min_objectives >= 2 (or >= 3 if many-heuristic)
    if default_opt == "pareto":
        if "MANY" in common_objs:
            default_obj = "MANY"
        req_min_objs = max(req_min_objs, 3 if "many-heuristic" in unique_engines else 2)

    # Determine default mode per engine
    mode_by_engine: dict[str, str] = {}
    for engine, modes in engine_modes.items():
        for m in modes:
            caps = m.get("capabilities", {})
            opt_values = caps.get("optimization", {}).get("values", [])
            if caps.get("optimization", {}).get("selector") == "all" or default_opt in opt_values:
                mode_by_engine[engine] = m.get("id", "default")
                break
        if engine not in mode_by_engine and modes:
            mode_by_engine[engine] = modes[0].get("id", "default")

    return TargetCapabilities(
        target_engines=unique_engines,
        allowed_optimizations=sorted(common_opts),
        default_optimization=default_opt,
        allowed_objective_types=sorted(common_objs),
        default_objective_type=default_obj,
        min_objectives=req_min_objs,
        allowed_aggregations=common_aggrs or {
            "sequence.sum", "sequence.min", "sequence.max",
            "parallel.sum", "parallel.min", "parallel.max",
            "exclusive.weightedSum", "exclusive.min", "exclusive.max",
            "repeat.scale", "repeat.identity",
            "selection.sum", "selection.min", "selection.max",
        },
        mode_by_engine=mode_by_engine,
    )
