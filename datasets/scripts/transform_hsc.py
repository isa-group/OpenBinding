"""Transform the 10,000 HSC (Hugging Face Service Composition) requirements into BIM v1 packages.

Source: X. Wang, D. Rong, H. Xu, X. He, Z. Wang, "HSC: An Artificial Intelligence Service Composition
Dataset from Hugging Face", Service-Oriented Computing -- ICSOC 2024, LNCS 15405, pp. 225-239 (2025). Files: workflow.json (flows, objective weights, constraint values),
requirements.json (natural-language requirements), normalized_model.json (15,463 Hugging Face
models with min-max normalised QoS), best_solution.json (reference compositions and objective
values). Sharded into 10 batches of 1,000 instances (batch_0000_0999/, ...).

Fidelity to the source semantics (Section 3.3 of the paper):

* **Aggregations (Table 3).** Downloads/likes: sum over a parallel level, mean over the sequence of
  levels. Response/waiting time: max over a parallel level, mean over levels. Reliability and
  successability: min over a parallel level, geometric mean over levels. Means and geometric means
  are expressed as BIM aggregation expressions over the ``values`` of the sequence (the number of
  levels is known per instance).
* **Objective (Eq. 1).** ``f(x) = sum_{i in {3,4}} w_i f_i(x) + sum_{i in {1,2,5,6}} w_i (1 - f_i(x))``
  with the requirement's weights ``w_i`` (they sum to one). BIM criteria use the identity
  normalisation ``[0, 1]`` without clamping, so the normalised loss is exactly ``f_i`` for the two
  minimised attributes and ``1 - f_i`` for the four maximised ones; the weights travel in the
  instance annotation ``objective_weights`` (the campaign passes them as execution weights).
* **Constraints (Eq. 2).** The paper treats every constraint as soft and adds the squared violation
  ``(max(0, g_j - c_j))^2`` (minimised attributes) or ``(min(0, g_j - c_j))^2`` (maximised
  attributes) to the objective; the released ``cons`` values are already multiplied by the scale
  coefficients ``p_j``. Each constraint is therefore a soft BIM constraint whose penalty is
  ``K * (g_j - c_j)^2`` where ``K`` is the number of constraints of the instance: the compiler
  normalises penalty weights to ``1/K``, so the weighted penalty sum is exactly the paper's
  ``sum_j (g_j - c_j)^2`` and the BIM score equals ``f~(x)``.
* **Values.** Model attributes are copied at full precision. ``best_solution.json`` is kept as the
  ``reference_binding`` / ``reference_value`` annotations: these are the authors' solutions and
  objective values, which the released ``normalized_model.json`` does not reproduce exactly for most
  requirements (see ``datasets/sources/hsc/README.md``); they are provenance, not ground truth.
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "openbinding-gateway" / "src"))

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package

DEFAULT_SOURCE = ROOT / "datasets" / "sources" / "hsc"
DEFAULT_TARGET = ROOT / "datasets" / "03_hsc_llm"

PAPER = {
    "authors": "X. Wang, D. Rong, H. Xu, X. He, Z. Wang",
    "title": "HSC: An Artificial Intelligence Service Composition Dataset from Hugging Face",
    "venue": "Service-Oriented Computing -- ICSOC 2024, LNCS 15405",
    "pages": "225-239",
    "year": 2025,
    "doi": "10.1007/978-981-96-0808-9_17",
}

# Paper ordering i = 1..6: downloads, likes, response time, waiting time, reliability, successability.
FEAT_META = {
    "normalized_downloads": {"dir": "maximize", "parallel": "sum", "hsc_key": "average number of downloads", "default": 0.5},
    "normalized_likes": {"dir": "maximize", "parallel": "sum", "hsc_key": "average number of likes", "default": 0.5},
    "normalized_response_times": {"dir": "minimize", "parallel": "max", "hsc_key": "average response time", "default": 0.5},
    "normalized_waiting_times": {"dir": "minimize", "parallel": "max", "hsc_key": "average waiting time", "default": 0.5},
    "reliabilities": {"dir": "maximize", "parallel": "min", "hsc_key": "reliability", "geometric": True, "default": 0.9},
    "successabilities": {"dir": "maximize", "parallel": "min", "hsc_key": "successability", "geometric": True, "default": 0.9},
}


def _sequence_aggregation(level_count: int, geometric: bool) -> dict:
    reduction = {"op": "product" if geometric else "sum", "args": [{"path": "values"}]}
    expression = (
        {"op": "pow", "left": reduction, "right": 1.0 / level_count}
        if geometric
        else {"op": "div", "left": reduction, "right": level_count}
    )
    return {"expression": expression}


def paper_objective(wf: dict, models: list[dict], binding_models: list[int]) -> float:
    """Eq. (1) + Eq. (2) of the HSC paper evaluated directly on the source data (Table 3 aggregations)."""
    objective, penalty = paper_objective_components(wf, models, binding_models)
    return objective + penalty


def paper_objective_components(wf: dict, models: list[dict], binding_models: list[int]) -> tuple[float, float]:
    """(weighted objective of Eq. 1, squared-violation penalty of Eq. 2) for one binding."""
    stages = wf.get("flow", [])
    values: dict[str, float] = {}
    for f_id, meta in FEAT_META.items():
        level_values = []
        k = 0
        for stage in stages:
            vals = []
            for _ in stage:
                vals.append(float(models[binding_models[k]].get(f_id, meta["default"])))
                k += 1
            level_values.append({"sum": sum, "max": max, "min": min}[meta["parallel"]](vals) if len(vals) > 1 else vals[0])
        n = max(1, len(stages))
        if meta.get("geometric"):
            prod = 1.0
            for v in level_values:
                prod *= v
            values[f_id] = prod ** (1.0 / n)
        else:
            values[f_id] = sum(level_values) / n
    objective = 0.0
    penalty = 0.0
    for f_id, meta in FEAT_META.items():
        w = float(wf.get("obj_func", {}).get(meta["hsc_key"], 0.0))
        objective += w * (values[f_id] if meta["dir"] == "minimize" else 1.0 - values[f_id])
        c = float(wf.get("cons", {}).get(meta["hsc_key"], 0.0))
        if c > 0:
            gap = values[f_id] - c
            violation = max(0.0, gap) if meta["dir"] == "minimize" else min(0.0, gap)
            penalty += violation * violation
    return objective, penalty


def _load_source(source_path: Path) -> tuple[list, list, list, list]:
    if source_path.is_dir():
        read = lambda name: json.loads((source_path / name).read_text(encoding="utf-8"))  # noqa: E731
    elif source_path.is_file():
        archive = zipfile.ZipFile(source_path)
        names = archive.namelist()

        def read(fname: str):
            for candidate in (fname, f"HSC-main/{fname}"):
                if candidate in names:
                    return json.loads(archive.read(candidate).decode("utf-8"))
            target = next((n for n in names if n.endswith(f"/{fname}") and not n.startswith("__MACOSX")), None)
            if target:
                return json.loads(archive.read(target).decode("utf-8"))
            raise FileNotFoundError(f"Cannot find {fname} in {source_path}")
    else:
        raise FileNotFoundError(f"HSC source not found at {source_path}")
    return read("workflow.json"), read("requirements.json"), read("normalized_model.json"), read("best_solution.json")


def transform_hsc_instances(
    source_path: Path = DEFAULT_SOURCE,
    target_dir: Path = DEFAULT_TARGET,
    limit: int | None = None,
    verify_sample: int = 20,
    jobs: int = 16,
) -> int:
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"Loading HSC dataset from {source_path}...")
    workflows, requirements, models, best_solutions = _load_source(source_path)

    if limit:
        workflows = workflows[:limit]
        requirements = requirements[:limit]
        best_solutions = best_solutions[:limit]

    total_instances = len(workflows)
    print(f"Loaded {total_instances} workflows. Indexing {len(models)} models by function category...")

    models_by_func: dict[str, list[tuple[int, dict]]] = defaultdict(list)
    for model_index, model in enumerate(models):
        models_by_func[model["function"]].append((model_index, model))

    print(f"Indexed into {len(models_by_func)} distinct function categories.")
    print(f"Generating {total_instances} BIM v1 packages in sharded batches of 1,000...")

    def build_instance_package(idx: int) -> tuple[Path, bool, str | None]:
        wf = workflows[idx]
        req = requirements[idx]
        bs = best_solutions[idx] if idx < len(best_solutions) else {"best_value": None, "best_solution": []}

        batch_start = (idx // 1000) * 1000
        batch_end = batch_start + 999
        batch_dir = target_dir / f"batch_{batch_start:04d}_{batch_end:04d}"
        inst_name = f"hsc_{idx:04d}"
        pkg_dir = batch_dir / inst_name
        pkg_dir.mkdir(parents=True, exist_ok=True)

        stages = wf.get("flow", [])
        activities = [(stage_index, category) for stage_index, stage in enumerate(stages) for category in stage]
        tasks = {f"task_{index + 1}": f"service/task_{index + 1}" for index in range(len(activities))}
        stage_nodes = []
        task_index = 0
        for stage in stages:
            nodes = []
            for _category in stage:
                task_index += 1
                nodes.append({"task": {"resource": "application", "id": f"task_{task_index}"}})
            stage_nodes.append(nodes[0] if len(nodes) == 1 else {"parallel": nodes})
        level_count = max(1, len(stage_nodes))

        app_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "Application",
            "metadata": {"name": f"{inst_name}_application"},
            "spec": {
                "tasks": tasks,
                "features": {
                    k: {
                        "direction": v["dir"],
                        "scope": "invocation",
                        "aggregation": {
                            "sequence": _sequence_aggregation(level_count, v.get("geometric", False)),
                            "parallel": v["parallel"],
                        },
                        "neutral": 1.0 if v.get("geometric", False) else 0.0,
                        "domain": {"kind": "ratio", "minimum": 0.0, "maximum": 1.0},
                    }
                    for k, v in FEAT_META.items()
                },
                "workflow": {"sequence": stage_nodes},
            },
        }

        candidates = {}
        reference_binding = {}
        reference = bs.get("best_solution") or []
        for activity_index, (_stage_index, category) in enumerate(activities):
            tid = f"task_{activity_index + 1}"
            opt_model_idx = reference[activity_index] if activity_index < len(reference) else None
            matching_models = models_by_func.get(category, [])
            if not matching_models:
                raise ValueError(f"No HSC models for function category {category!r}")
            if opt_model_idx is not None and all(index != opt_model_idx for index, _model in matching_models):
                raise ValueError(f"Reference model {opt_model_idx} does not implement {category!r}")

            for model_index, m in matching_models:
                cid = f"cand_{tid}_{model_index}"
                candidates[cid] = {
                    "provides": f"service/{tid}",
                    "provider": {"resource": "catalog", "id": "provider_huggingface"},
                    "features": {k: float(m.get(k, v["default"])) for k, v in FEAT_META.items()},
                }
                if model_index == opt_model_idx:
                    reference_binding[tid] = {"resource": "catalog", "id": cid}
        if len(reference) == len(activities) and len(reference_binding) == len(activities):
            objective_part, reference_penalty = paper_objective_components(wf, models, list(reference))
            reference_objective = objective_part + reference_penalty  # the BIM score of the reference binding
        else:
            reference_objective = reference_penalty = None

        cat_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "CandidateCatalog",
            "metadata": {"name": f"{inst_name}_catalog"},
            "spec": {
                "providers": {"provider_huggingface": {}},
                "featureBindings": {k: {"resource": "application", "id": k} for k in FEAT_META},
                "candidates": candidates,
            },
        }

        # Eq. (2): every constraint is soft and contributes its squared violation. With K
        # constraints the compiler normalises the penalty weights to 1/K, hence the factor K.
        active = [(f_id, v, float(wf.get("cons", {}).get(v["hsc_key"], 0.0))) for f_id, v in FEAT_META.items()]
        active = [(f_id, v, val) for f_id, v, val in active if val > 0]
        constraint_count = len(active)
        constraints = {}
        penalties = []
        for f_id, v, val in active:
            op = "<=" if v["dir"] == "minimize" else ">="
            constraints[f_id] = {
                "assert": f"features.{f_id} {op} {val!r}",
                "enforcement": "soft",
                "penalty": f"{constraint_count} * (features.{f_id} - {val!r}) * (features.{f_id} - {val!r})",
            }
            penalties.append({"constraint": {"resource": "constraints", "id": f_id}, "weight": 1})

        cons_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "ConstraintSet",
            "metadata": {"name": f"{inst_name}_constraints"},
            "spec": {"constraints": constraints},
        }

        criteria = []
        objective_weights = {}
        for f_id, v in FEAT_META.items():
            w = float(wf.get("obj_func", {}).get(v["hsc_key"], 0.0))
            if w > 0:
                criteria.append({
                    "id": f_id,
                    "feature": {"resource": "application", "id": f_id},
                    "direction": v["dir"],
                    "normalize": {"min": 0.0, "max": 1.0, "clamp": False},
                })
                objective_weights[f_id] = w
        if not criteria:
            # No requirement in the released data lacks objectives; kept for robustness.
            criteria.append({
                "id": "normalized_response_times",
                "feature": {"resource": "application", "id": "normalized_response_times"},
                "direction": "minimize",
                "normalize": {"min": 0.0, "max": 1.0, "clamp": False},
            })
            objective_weights["normalized_response_times"] = 1.0

        opt_spec: dict = {"criteria": criteria}
        if penalties:
            opt_spec["penalties"] = penalties
        opt_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "Optimization",
            "metadata": {"name": f"{inst_name}_optimization"},
            "spec": opt_spec,
        }

        inst_doc = {
            "apiVersion": "bim/v1",
            "kind": "Instance",
            "metadata": {
                "name": inst_name,
                "version": "2.0.0",
                "description": "HSC Hugging Face AI service composition requirement (soft quadratic constraint penalties, Eq. 2 of the source paper)",
                "annotations": {
                    "source": "HSC Dataset (Hugging Face AI Service Composition), https://github.com/wangxiaohit/HSC",
                    "paper": PAPER,
                    "workflow_index": idx,
                    "user_requirement": req,
                    "objective_weights": objective_weights,
                    "constraint_values": {f_id: val for f_id, _v, val in active},
                    "constraint_semantics": "soft; penalty = squared violation (paper Eq. 2); score = f(x) + sum_j (g_j - c_j)^2",
                    "reference_binding": reference_binding,
                    "reference_value": bs.get("best_value"),
                    "reference_value_note": "best_value from best_solution.json as published by the HSC authors; not reproducible exactly from the released normalized_model.json for most requirements",
                    # Eq. (1) + Eq. (2) of the reference binding recomputed on the released data: the value a BIM
                    # engine must beat, since the BIM score of a binding equals this objective (verified below).
                    "reference_objective": reference_objective,
                    "reference_objective_penalty": reference_penalty,
                    "source_task_count": len(activities),
                    "source_level_count": len(stages),
                },
            },
            "spec": {
                "profile": "qos-binding/v1",
                "resources": {
                    "application": {"application": "application.json"},
                    "candidateCatalog": {"catalog": "candidates.json"},
                    "constraintSet": {"constraints": "constraints.json"},
                    "optimization": {"optimization": "optimization.json"},
                },
            },
        }

        docs = {
            "instance.json": inst_doc,
            "application.json": app_doc,
            "candidates.json": cat_doc,
            "constraints.json": cons_doc,
            "optimization.json": opt_doc,
        }

        for fname, d in docs.items():
            (pkg_dir / fname).write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        return pkg_dir, True, None

    created_dirs: list[Path] = []
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        for pkg_dir, ok, err in executor.map(build_instance_package, range(total_instances)):
            if ok:
                created_dirs.append(pkg_dir)
            else:
                print(f"Error on instance: {err}")

    print(f"Successfully generated {len(created_dirs)}/{total_instances} HSC LLM packages.")

    if verify_sample > 0 and created_dirs:
        print(f"Verifying compilation of {min(verify_sample, len(created_dirs))} sample instances...")
        for p in created_dirs[:verify_sample]:
            try:
                package = load_package(p)
                problem = compile_instance(package)
                # Fidelity check: the BIM score of the reference composition must equal the paper's
                # objective f~(x) computed directly on the source data.
                annotations = package.json("instance.json")["metadata"]["annotations"]
                idx = int(annotations["workflow_index"])
                binding = annotations["reference_binding"]
                if binding and len(binding) == annotations["source_task_count"]:
                    weights = annotations["objective_weights"]
                    total = sum(weights.values())
                    execution = {
                        "type": "SINGLE",
                        "scalarization": "weighted-sum",
                        "weights": [{"criteria": key, "value": value / total} for key, value in weights.items()],
                    }
                    score = float(problem.evaluate(binding, execution)["objectives"]["score"])
                    expected = paper_objective(workflows[idx], models, list(best_solutions[idx]["best_solution"]))
                    if abs(score - expected) > 1e-9:
                        raise AssertionError(f"BIM score {score!r} differs from the paper objective {expected!r}")
            except Exception as exc:
                print(f"Verification failure on {p.name}: {exc}")
                return 1
        print("Sample verification passed successfully (compilation and Eq. 1-2 fidelity).")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Transform HSC AI service composition workflows into datasets/03_hsc_llm")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Path to HSC source directory or zip")
    parser.add_argument("--zip", type=Path, dest="source", help="Alias for --source (legacy)")
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET, help="Target directory")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of workflows")
    parser.add_argument("--verify-sample", type=int, default=20, help="Number of sample packages to compile")
    parser.add_argument("--jobs", type=int, default=16, help="Worker threads for parallel generation")
    args = parser.parse_args()

    return transform_hsc_instances(
        source_path=args.source,
        target_dir=args.target,
        limit=args.limit,
        verify_sample=args.verify_sample,
        jobs=args.jobs,
    )


if __name__ == "__main__":
    raise SystemExit(main())
