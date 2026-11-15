"""Deterministic study expansion and small, inspectable aggregations."""

from __future__ import annotations

import csv
import io
import itertools
import json
from collections import defaultdict
from collections.abc import Iterable, Iterator, Mapping
from typing import Any

from .models.platform import StudyDefinition
from bim_core.canonical import digest


#: The ``apiVersion`` of the definition a study run freezes.
STUDY_RUN_API_VERSION = "openbinding/study-run/v1"


def expand_study(
    definition: StudyDefinition,
    compilations: Mapping[str, str],
    engines: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """The cells of ``definition``, in a fixed order; ``compilations`` maps each revision id to the
    compilation id its cells run, which is part of every cell's fingerprint (D7). ``engines`` are the
    definition's engines with every preset expanded (``study_jobs.study_engines``); the definition's own by
    default."""
    cells = []
    engines = sorted(
        definition.engines if engines is None else engines,
        key=lambda item: tuple(item[key] for key in ("namespace", "name", "version", "digest"))
        + (
            item.get("mode", ""),
            item.get("optimization", {}).get("scalarization", ""),
            digest(item.get("options") or {}),
        ),
    )
    revisions = sorted(definition.revision_ids, key=str)
    parameters = sorted(definition.parameter_sets, key=digest)
    seeds = sorted(definition.seeds)
    for ordinal, (revision_id, engine, parameter_set, seed) in enumerate(
        itertools.product(revisions, engines, parameters, seeds)
    ):
        frozen = {
            "caseRevisionId": str(revision_id),
            "compilationId": compilations[str(revision_id)],
            "engine": engine,
            "parameters": parameter_set,
            "seed": seed,
        }
        cells.append({"ordinal": ordinal, "fingerprint": digest(frozen), **frozen})
    return cells


def frozen_definition(
    definition: StudyDefinition, problems: list[dict[str, Any]], engines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The ``openbinding/study-run/v1`` document a study run freezes (D7).

    ``problems`` holds one entry per revision: ``revisionId``, ``problemId``, ``revision``,
    ``packageDigest`` and the pinned ``compilationId``, ``compilationDigest`` and ``irDigest``. ``engines`` are
    the expanded engines (``expand_study``), each ``{namespace, name, version, digest, mode, optimization,
    options, preset}``; the definition's own by default.
    """
    return {
        "apiVersion": STUDY_RUN_API_VERSION,
        "problems": sorted(problems, key=lambda item: item["revisionId"]),
        "engines": definition.model_dump(mode="json")["engines"] if engines is None else engines,
        "parameterSets": definition.parameter_sets,
        "seeds": definition.seeds,
    }


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
        "stability": stability,
    }


def pareto_fronts(cells: Iterable[Mapping[str, Any]], problems: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The Pareto front of each problem revision and objective set of a study run (minimisation).

    ``cells`` holds, in cell order, ``cellId``, ``jobId``, ``revisionId`` and the cell's ``metrics``; ``problems``
    maps the id of every revision the cells run to ``{"slug", "revision"}``. Only feasible solutions of completed
    cells count. Cells whose objectives are named alike are compared, so a revision has one front per
    objective-name set. Fronts are ordered by problem slug, revision number and objective names; points by their
    objective values (in name order), then by cell order.
    """
    groups: dict[tuple[str, tuple[str, ...]], list[tuple[dict[str, float], dict[str, Any]]]] = defaultdict(list)
    for cell in cells:
        metrics = cell.get("metrics") or {}
        if metrics.get("status") != "completed" or metrics.get("feasible") is not True or not cell.get("jobId"):
            continue
        values = metrics.get("objectives")
        if not isinstance(values, dict):
            continue
        point = {
            str(key): float(value)
            for key, value in values.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
        if not point or len(point) != len(values):
            continue
        index = metrics.get("solutionIndex")
        groups[(str(cell["revisionId"]), tuple(sorted(point)))].append((point, {
            "cell_id": str(cell["cellId"]),
            "job_id": str(cell["jobId"]),
            "solution_index": index if isinstance(index, int) else 0,
            "engine": str(metrics.get("engine", "unknown")),
            "objectives": point,
        }))
    fronts = []
    for (revision_id, names), entries in groups.items():
        by_point = {id(point): entry for point, entry in entries}
        problem = problems[revision_id]
        fronts.append({
            "revision_id": revision_id,
            "problem": {"slug": problem["slug"]},
            "revision": problem["revision"],
            "objectives": list(names),
            "points": [by_point[id(point)] for point in nondominated([point for point, _ in entries])],
        })
    return sorted(fronts, key=lambda front: (front["problem"]["slug"], front["revision"], front["objectives"]))


#: The fixed leading columns of a study run's CSV export, in order; ``objective.<name>`` and ``metric.<name>``
#: columns follow, each group sorted by name.
EXPORT_COLUMNS = (
    "cell_id", "problem", "revision", "engine_namespace", "engine_name", "engine_version", "mode", "parameters",
    "seed", "status", "feasible", "runtime_seconds",
)
#: Cell metrics that have a column of their own (or are the objectives): not repeated as ``metric.<name>``.
_COLUMN_METRICS = frozenset({"status", "feasible", "runtimeSeconds", "objectives", "engine", "seed"})


def _cell_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def export_csv(cells: list[Mapping[str, Any]]) -> Iterator[str]:
    """A study run's cells as CSV (RFC 4180, header first), one row per cell in cell order.

    Each cell is an export cell (``export_cells``). Its ``status`` is the cell's state; ``feasible`` and
    ``runtime_seconds`` come from its metrics; ``objective.<name>`` columns hold its objectives and
    ``metric.<name>`` columns its other metrics, for every name any cell has. A value a cell lacks is empty.
    """
    objectives = sorted({str(name) for cell in cells for name in (cell["metrics"].get("objectives") or {})})
    metrics = sorted({str(name) for cell in cells for name in cell["metrics"] if name not in _COLUMN_METRICS})
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")

    def line(values: list[Any]) -> str:
        writer.writerow([_cell_value(value) for value in values])
        text = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate()
        return text

    yield line([
        *EXPORT_COLUMNS, *(f"objective.{name}" for name in objectives), *(f"metric.{name}" for name in metrics),
    ])
    for cell in cells:
        engine, measured = cell["engine"], cell["metrics"]
        values = measured.get("objectives") if isinstance(measured.get("objectives"), dict) else {}
        yield line([
            cell["id"], cell["problem"], cell["revision"], engine.get("namespace"), engine.get("name"),
            engine.get("version"), engine.get("mode"), cell["parameters"], cell["seed"], cell["state"],
            measured.get("feasible"), measured.get("runtimeSeconds"),
            *(values.get(name) for name in objectives),
            *(measured.get(name) for name in metrics),
        ])


def export_json(head: Mapping[str, Any], cells: list[Mapping[str, Any]]) -> Iterator[str]:
    """A study run as one JSON document, ``{study, run, definition, cells}``, written a cell at a time.

    ``head`` holds ``study``, ``run`` and ``definition``; every value is JSON already.
    """
    opening = json.dumps(dict(head), sort_keys=True)
    yield opening[:-1] + ', "cells": ['
    for index, cell in enumerate(cells):
        yield ("," if index else "") + json.dumps(dict(cell), sort_keys=True)
    yield "]}"
