"""Resumable experiment runner for the BIM v1 placement campaign.

The corpus contains three applications and 35 infrastructure sizes for dataset
seed 146588263.  Its profile is weighted QoS with placement, so the campaign
selects the exact MiniZinc lane plus seeded random search and elitist genetic
search.  The many-objective engine accepts Pareto problems and is therefore
not a compatible lane for this weighted corpus.

Every run is bounded by the same wall-clock budget and by 1,000 evaluations.
The gateway validates the returned decision and replaces all engine-reported
metrics, objectives, penalties, and violations with its authoritative BIM v1
evaluation.  The CSV records immutable digests and the effective mode,
algorithm, and options needed to reproduce the run.  Rows are appended
incrementally and completed run ids are skipped.
"""

from __future__ import annotations

import csv
import hashlib
import json
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from openbinding_gateway.v1.package import InstancePackage, load_package

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = REPO_ROOT / "experimentation/icsoc/out/bim-v1/instances"
DEFAULT_RESULTS = REPO_ROOT / "experimentation/icsoc/out/results"
DEFAULT_GATEWAY = "http://localhost:8000"

# Wall-clock stopping criterion shared by every algorithm.
TIME_BUDGET_MS = 300_000
# Evaluation cap shared by the heuristic lanes.
HEURISTIC_EVALUATIONS = 1_000
HEURISTIC_SEEDS = tuple(range(1, 11))
GA_POPULATION = 20

RUN_FIELDS = [
    "run_id", "application", "infra_size", "dataset_seed", "instance_id",
    "engine", "mode", "algorithm", "seed", "options",
    "status", "termination", "feasible",
    "objective_value", "penalty", "hard_violations", "soft_violations",
    "cost", "latency", "security",
    "engine_execution_time_ms", "engine_evaluations", "wall_time_s",
    "instance_digest", "package_digest", "ir_digest", "engine_digest",
    "profile_digest", "protocol_digest", "compiler_digest", "evaluator_digest",
    "n_tasks", "n_candidates", "error",
]
CORPUS_FIELDS = [
    "instance_id", "application", "infra_size", "dataset_seed",
    "n_tasks", "n_candidates", "n_pools", "n_features",
    "n_constraints_local", "n_constraints_global", "n_constraints_dependency",
    "n_resource_capacity", "n_transitions", "n_budget_constraints",
    "log10_binding_space", "global_budget",
]


@dataclass
class RunSpec:
    engine: str
    seed: int | None
    options: dict[str, Any]

    @property
    def label(self) -> str:
        return self.engine if self.seed is None else f"{self.engine}#seed{self.seed}"


@dataclass(frozen=True)
class LoadedInstance:
    package: InstancePackage
    root: dict[str, Any]
    resources: dict[str, list[dict[str, Any]]]


def campaign_specs(time_budget_ms: int = TIME_BUDGET_MS) -> list[RunSpec]:
    specs = [RunSpec("minizinc-csp", None, {
        "solver": "gecode",
        "time_budget_ms": time_budget_ms,
    })]
    for seed in HEURISTIC_SEEDS:
        specs.append(RunSpec("random-search", seed, {
            "iterations": HEURISTIC_EVALUATIONS,
            "seed": seed,
            "time_budget_ms": time_budget_ms,
        }))
    for seed in HEURISTIC_SEEDS:
        specs.append(RunSpec("evolutionary-heuristics", seed, {
            "population_size": GA_POPULATION,
            "max_evaluations": HEURISTIC_EVALUATIONS,
            "seed": seed,
            "time_budget_ms": time_budget_ms,
        }))
    return specs


def iter_instances(corpus: Path = DEFAULT_CORPUS) -> Iterator[Path]:
    yield from sorted(corpus.glob("*/*/infrastructure_*/instance.json"))


def instance_meta(instance: LoadedInstance, path: Path) -> dict[str, Any]:
    md = instance.root.get("metadata", {})
    size = path.parent.name.replace("infrastructure_", "")
    return {
        "instance_id": md.get("name", path.parent.name),
        "application": path.parts[-4],
        "dataset_seed": path.parts[-3],
        "infra_size": int(size),
    }


def v1_resource(instance: LoadedInstance, kind: str) -> dict[str, Any]:
    values = instance.resources.get(kind, [])
    return values[0] if values else {}


def load_instance(path: Path) -> LoadedInstance:
    """Load a grouped BIM package without mutating its strict root index."""
    package = load_package(path.parent)
    root = package.instance()
    if root.get("apiVersion") != "bim/v1" or root.get("kind") != "Instance":
        raise ValueError(f"{path}: expected a bim/v1 Instance")
    groups = root.get("spec", {}).get("resources")
    if not isinstance(groups, dict):
        raise TypeError(f"{path}: Instance.spec.resources must be a grouped object")
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for group in groups.values():
        if not isinstance(group, dict):
            raise TypeError(f"{path}: every resource group must be an object")
        for resource_id, target in group.items():
            if not isinstance(target, str):
                raise TypeError(f"{path}: campaign requires local resource {resource_id!r}")
            document = package.json(target)
            kind = document.get("kind")
            if not isinstance(kind, str):
                raise TypeError(f"{path}: {target} has no resource kind")
            by_kind.setdefault(kind, []).append(document)
    return LoadedInstance(package=package, root=root, resources=by_kind)


def corpus_summary_row(instance: LoadedInstance, path: Path) -> dict[str, Any]:
    import math

    meta = instance_meta(instance, path)
    per_task: dict[str, int] = {}
    application = v1_resource(instance, "Application")
    catalog = v1_resource(instance, "CandidateCatalog")
    constraints = v1_resource(instance, "ConstraintSet")
    placement = v1_resource(instance, "Placement")
    tasks = application.get("spec", {}).get("tasks", {})
    candidates = catalog.get("spec", {}).get("candidates", {})
    eligibility: dict[str, int] = {}
    for task_id, task in tasks.items():
        if isinstance(task, dict) and task.get("kind") == "local":
            continue
        requirement = task if isinstance(task, str) else task.get("requires")
        required = (
            requirement
            if isinstance(requirement, str)
            else requirement.get("type") if isinstance(requirement, dict) else None
        )
        eligibility[task_id] = sum(
            1
            for candidate in candidates.values()
            if required in {
                capability if isinstance(capability, str) else capability.get("type")
                for capability in (
                    candidate.get("provides", [])
                    if isinstance(candidate.get("provides"), list)
                    else [candidate.get("provides")]
                )
            }
        )
    per_task.update(eligibility)
    log10_space = sum(math.log10(max(1, n)) for n in per_task.values())

    counts = {"LOCAL": 0, "GLOBAL": 0, "DEPENDENCY": 0, "BUDGET": 0}
    global_budget = None
    for constraint_id, c in constraints.get("spec", {}).get("constraints", {}).items():
        assertion = c.get("assert")
        if isinstance(assertion, str) and assertion.startswith("tasks."):
            counts["LOCAL"] += 1
        else:
            counts["GLOBAL"] += 1
        if str(constraint_id).startswith("budget"):
            counts["BUDGET"] += 1
        if str(constraint_id).startswith("budget_global") and isinstance(assertion, str):
            try:
                global_budget = float(assertion.rsplit(" ", 1)[-1])
            except ValueError:
                global_budget = None
    capacity_rules = placement.get("spec", {}).get("capacityRules", [])
    counts["DEPENDENCY"] = len(capacity_rules)

    return {
        **meta,
        "n_tasks": len(tasks),
        "n_candidates": len(candidates),
        "n_pools": len(placement.get("spec", {}).get("pools", [])),
        "n_features": len(application.get("spec", {}).get("metrics", [])),
        "n_constraints_local": counts["LOCAL"],
        "n_constraints_global": counts["GLOBAL"],
        "n_constraints_dependency": counts["DEPENDENCY"],
        "n_resource_capacity": len(capacity_rules),
        "n_transitions": len(placement.get("spec", {}).get("transitions", [])),
        "n_budget_constraints": counts["BUDGET"],
        "log10_binding_space": round(log10_space, 3),
        "global_budget": global_budget,
    }


ENGINE_MODES = {
    "minizinc-csp": "exact-weighted",
    "random-search": "seeded",
    "evolutionary-heuristics": "elitist-genetic",
    "many-heuristic": "pareto-sampling",
}


def solve_via_gateway(
    base_url: str,
    engine_id: str,
    instance: LoadedInstance,
    options: dict[str, Any],
    poll_interval: float = 2.0,
    max_poll_s: float = 1800.0,
) -> tuple[dict[str, Any], float]:
    started = time.time()
    archive = instance.package.to_zip()
    options_digest = hashlib.sha256(
        json.dumps(options, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    idempotency_key = (
        f"icsoc-{instance.package.package_digest.removeprefix('sha256-')[:24]}-"
        f"{engine_id}-{options_digest[:24]}"
    )
    with httpx.Client(timeout=max(960.0, max_poll_s)) as client:
        snapshot_response = client.post(
            f"{base_url}/v1/instances",
            content=archive,
            headers={"Content-Type": "application/vnd.bim+zip"},
        )
        if snapshot_response.status_code != 201:
            return {
                "error": f"snapshot HTTP {snapshot_response.status_code}: {snapshot_response.text[:300]}"
            }, time.time() - started
        snapshot_id = snapshot_response.json().get("id")
        if not isinstance(snapshot_id, str) or not snapshot_id:
            return {"error": "snapshot response omitted id"}, time.time() - started
        response = client.post(
            f"{base_url}/v1/jobs",
            headers={"Idempotency-Key": idempotency_key},
            json={
                "engine": engine_id,
                "mode": ENGINE_MODES[engine_id],
                "snapshot": snapshot_id,
                "options": options,
            },
        )
        if response.status_code != 202:
            return {"error": f"HTTP {response.status_code}: {response.text[:300]}"}, time.time() - started
        data = response.json()
        job_id = data.get("id")
        while data.get("status") in ("queued", "running"):
            if time.time() - started > max_poll_s:
                return {"error": f"polling timed out after {max_poll_s}s"}, time.time() - started
            time.sleep(poll_interval)
            data = client.get(f"{base_url}/v1/jobs/{job_id}").json()
    return data, time.time() - started


def _append_csv(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        if new_file:
            writer.writeheader()
        writer.writerows(rows)


def _completed_run_ids(runs_csv: Path) -> set[str]:
    if not runs_csv.exists():
        return set()
    with runs_csv.open(encoding="utf-8") as fh:
        return {row["run_id"] for row in csv.DictReader(fh) if row.get("status") == "ok"}


def _run_row(
    run_id: str,
    meta: dict[str, Any],
    spec: RunSpec,
    instance: LoadedInstance,
    data: dict[str, Any],
    wall_s: float,
) -> dict[str, Any]:
    """Flatten one authoritative BIM v1 job result for the campaign CSV."""
    application = v1_resource(instance, "Application")
    catalog = v1_resource(instance, "CandidateCatalog")
    row: dict[str, Any] = {
        "run_id": run_id,
        **meta,
        "engine": spec.engine,
        "seed": spec.seed,
        "options": json.dumps(spec.options, sort_keys=True),
        "wall_time_s": round(wall_s, 3),
        "n_tasks": len(application.get("spec", {}).get("tasks", [])),
        "n_candidates": len(catalog.get("spec", {}).get("candidates", [])),
    }

    if data.get("error") and not data.get("result"):
        row.update({"status": "error", "error": str(data.get("error"))[:300]})
        return row

    result = data.get("result") or {}
    provenance = result.get("provenance") or {}
    engine_reported = provenance.get("engineReported") or {}
    termination = str(result.get("termination") or "UNKNOWN").upper()
    row.update({
        "termination": termination,
        "mode": provenance.get("mode") or ENGINE_MODES.get(spec.engine),
        "algorithm": provenance.get("algorithm") or engine_reported.get("algorithm"),
        "options": json.dumps(provenance.get("options", spec.options), sort_keys=True),
        "engine_execution_time_ms": engine_reported.get("elapsed_ms"),
        "engine_evaluations": engine_reported.get("evaluations"),
        "instance_digest": provenance.get("instanceDigest"),
        "package_digest": provenance.get("packageDigest"),
        "ir_digest": provenance.get("irDigest"),
        "engine_digest": provenance.get("engineDigest"),
        "profile_digest": provenance.get("profileDigest"),
        "protocol_digest": provenance.get("protocolDigest"),
        "compiler_digest": provenance.get("compilerDigest"),
        "evaluator_digest": provenance.get("evaluatorDigest"),
    })

    solutions = result.get("solutions") or []
    if not solutions:
        row["status"] = "ok" if not result.get("error") else "error"
        row["feasible"] = False
        row["error"] = str(
            result.get("error") or data.get("error") or engine_reported.get("error") or ""
        )[:300]
    else:
        solution = solutions[0]
        violations = solution.get("violations") or []
        feasible = termination in {"OPTIMAL", "FEASIBLE"} and not any(
            item.get("enforcement") == "hard" for item in violations
        )
        objectives = solution.get("objectives") or {}
        metrics = solution.get("metrics") or {}
        objective_value = objectives.get("score")
        if isinstance(objective_value, (dict, list)):
            objective_value = json.dumps(objective_value, sort_keys=True, separators=(",", ":"))
        penalties = solution.get("penalties") or []
        row.update({
            "status": "ok",
            "feasible": feasible,
            "objective_value": objective_value,
            "penalty": sum(float(value) for value in penalties),
            "hard_violations": sum(
                1 for item in violations if item.get("enforcement") == "hard"
            ),
            "soft_violations": sum(
                1 for item in violations if item.get("enforcement") == "soft"
            ),
            "cost": metrics.get("cost"),
            "latency": metrics.get("latency"),
            "security": metrics.get("security"),
        })
    return row


def print_status(
    corpus: Path = DEFAULT_CORPUS,
    results_dir: Path = DEFAULT_RESULTS,
) -> None:
    """Progress report: completed runs per engine, error counts, rough ETA."""
    runs_csv = results_dir / "runs.csv"
    n_instances = len(list(iter_instances(corpus)))
    expected = {
        "minizinc-csp": n_instances,
        "random-search": n_instances * len(HEURISTIC_SEEDS),
        "evolutionary-heuristics": n_instances * len(HEURISTIC_SEEDS),
    }
    if not runs_csv.exists():
        print(f"No runs recorded yet ({runs_csv} missing). "
              f"Expected total: {sum(expected.values())} runs over {n_instances} instances.")
        return

    with runs_csv.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    print(f"{len(rows)}/{sum(expected.values())} runs recorded in {runs_csv}")
    for engine, total in expected.items():
        engine_rows = [r for r in rows if r.get("engine") == engine]
        ok = [r for r in engine_rows if r.get("status") == "ok"]
        errors = len(engine_rows) - len(ok)
        walls = [float(r["wall_time_s"]) for r in ok if r.get("wall_time_s")]
        mean_wall = sum(walls) / len(walls) if walls else 0.0
        remaining = total - len(ok)
        eta_h = remaining * mean_wall / 3600 if walls else float("nan")
        feasible = sum(1 for r in ok if r.get("feasible") == "True")
        print(
            f"  {engine:26s} {len(ok):5d}/{total:<5d} ok "
            f"({feasible} feasible, {errors} errors) "
            f"mean {mean_wall:6.1f}s/run  ETA lane ~{eta_h:5.1f} h"
        )


def write_corpus_summary(
    corpus: Path = DEFAULT_CORPUS,
    results_dir: Path = DEFAULT_RESULTS,
) -> Path:
    rows = []
    for path in iter_instances(corpus):
        instance = load_instance(path)
        rows.append(corpus_summary_row(instance, path))
    out = results_dir / "corpus_summary.csv"
    if out.exists():
        out.unlink()
    _append_csv(out, CORPUS_FIELDS, rows)
    return out


def run_campaign(
    corpus: Path = DEFAULT_CORPUS,
    results_dir: Path = DEFAULT_RESULTS,
    base_url: str = DEFAULT_GATEWAY,
    applications: set[str] | None = None,
    sizes: set[int] | None = None,
    engines: set[str] | None = None,
    time_budget_ms: int = TIME_BUDGET_MS,
    verbose: bool = True,
) -> None:
    """Run (or resume) the campaign; skips run ids already recorded as ok."""
    runs_csv = results_dir / "runs.csv"
    done = _completed_run_ids(runs_csv)
    specs = campaign_specs(time_budget_ms)

    for path in iter_instances(corpus):
        instance = load_instance(path)
        meta = instance_meta(instance, path)
        if applications and meta["application"] not in applications:
            continue
        if sizes and meta["infra_size"] not in sizes:
            continue

        for spec in specs:
            if engines and spec.engine not in engines:
                continue
            run_id = f"{meta['instance_id']}|{spec.label}"
            if run_id in done:
                continue
            data, wall_s = solve_via_gateway(
                base_url, spec.engine, instance, spec.options,
                max_poll_s=time_budget_ms / 1000 + 900,
            )
            row = _run_row(run_id, meta, spec, instance, data, wall_s)
            _append_csv(runs_csv, RUN_FIELDS, [row])
            done.add(run_id)
            if verbose:
                print(
                    f"{run_id}: status={row.get('status')} feasible={row.get('feasible')} "
                    f"termination={row.get('termination')} obj={row.get('objective_value')} "
                    f"wall={row.get('wall_time_s')}s",
                    flush=True,
                )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run the OpenBinding4Placement (CLASP-FaaS) campaign")
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    parser.add_argument("--results", default=str(DEFAULT_RESULTS))
    parser.add_argument("--gateway", default=DEFAULT_GATEWAY)
    parser.add_argument("--applications", default=None, help="comma-separated app ids")
    parser.add_argument("--sizes", default=None, help="comma-separated infra sizes")
    parser.add_argument("--engines", default=None, help="comma-separated engine ids")
    parser.add_argument("--time-budget-ms", type=int, default=TIME_BUDGET_MS,
                        help="wall-clock stopping criterion shared by all algorithms")
    parser.add_argument("--status", action="store_true",
                        help="print campaign progress and exit")
    args = parser.parse_args()

    if args.status:
        print_status(corpus=Path(args.corpus), results_dir=Path(args.results))
        raise SystemExit(0)

    run_campaign(
        corpus=Path(args.corpus),
        results_dir=Path(args.results),
        base_url=args.gateway,
        applications={a.strip() for a in args.applications.split(",")} if args.applications else None,
        sizes={int(s) for s in args.sizes.split(",")} if args.sizes else None,
        engines={e.strip() for e in args.engines.split(",")} if args.engines else None,
        time_budget_ms=args.time_budget_ms,
    )
