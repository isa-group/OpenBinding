"""Deterministic study expansion and small, inspectable aggregations."""

from __future__ import annotations

import itertools
from collections import defaultdict
from typing import Any

from .models.platform import StudyDefinition
from .v1.canonical import digest


def expand_study(definition: StudyDefinition) -> list[dict[str, Any]]:
    cells = []
    engines = sorted(
        definition.engines,
        key=lambda item: tuple(item[key] for key in ("namespace", "name", "version", "digest"))
        + (item.get("mode", ""),),
    )
    cases = sorted(definition.case_revision_ids, key=str)
    parameters = sorted(definition.parameter_sets, key=digest)
    seeds = sorted(definition.seeds)
    for ordinal, (case_id, engine, parameter_set, seed) in enumerate(
        itertools.product(cases, engines, parameters, seeds)
    ):
        frozen = {
            "caseRevisionId": str(case_id),
            "engine": engine,
            "parameters": parameter_set,
            "seed": seed,
        }
        cells.append({"ordinal": ordinal, "fingerprint": digest(frozen), **frozen})
    return cells


def nondominated(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a deterministic minimization Pareto front."""

    normalized = [point for point in points if point and all(isinstance(v, (int, float)) for v in point.values())]
    front = []
    for index, candidate in enumerate(normalized):
        dominated = False
        for other_index, other in enumerate(normalized):
            if index == other_index or set(other) != set(candidate):
                continue
            if all(other[key] <= candidate[key] for key in candidate) and any(
                other[key] < candidate[key] for key in candidate
            ):
                dominated = True
                break
        if not dominated:
            front.append(candidate)
    return sorted(front, key=lambda item: tuple(item[key] for key in sorted(item)))


def aggregate_metrics(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    objectives: dict[str, list[float]] = defaultdict(list)
    runtimes = []
    feasible = infeasible = failed = 0
    points = []
    by_engine: dict[str, list[tuple[float, ...]]] = defaultdict(list)
    for metric in metrics:
        status = metric.get("status")
        if status == "failed":
            failed += 1
            continue
        if metric.get("feasible") is True:
            feasible += 1
        elif metric.get("feasible") is False:
            infeasible += 1
        runtime = metric.get("runtimeSeconds")
        if isinstance(runtime, (int, float)):
            runtimes.append(float(runtime))
        values = metric.get("objectives")
        if isinstance(values, dict) and values:
            point = {str(key): float(value) for key, value in values.items() if isinstance(value, (int, float))}
            if point:
                points.append(point)
                for key, value in point.items():
                    objectives[key].append(value)
                engine = str(metric.get("engine", "unknown"))
                by_engine[engine].append(tuple(point[key] for key in sorted(point)))
    stability = {
        engine: {
            "samples": len(samples),
            "distinct": len(set(samples)),
            "repeatability": 0 if not samples else 1 - ((len(set(samples)) - 1) / len(samples)),
        }
        for engine, samples in sorted(by_engine.items())
    }
    return {
        "cells": len(metrics),
        "completed": len(metrics) - failed,
        "failed": failed,
        "feasible": feasible,
        "infeasible": infeasible,
        "objective_distributions": {key: sorted(values) for key, values in sorted(objectives.items())},
        "runtimes_s": sorted(runtimes),
        "pareto": nondominated(points),
        "stability": stability,
    }
