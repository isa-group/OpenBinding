"""Transform 10,000 Hugging Face AI service composition workflows into BIM v1 packages.

Extracts workflows, requirements, normalized model metrics, and optimal solutions from
datasets/sources/hsc. Embeds LLM natural language user requirement
descriptions into instance metadata annotations. Sharded into 10 batches of 1,000 instances
(batch_0000_0999/, etc.) to comply with directory size limits.
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

FEAT_META = {
    "normalized_downloads": {"dir": "maximize", "parallel": "sum", "hsc_key": "average number of downloads"},
    "normalized_likes": {"dir": "maximize", "parallel": "sum", "hsc_key": "average number of likes"},
    "normalized_response_times": {"dir": "minimize", "parallel": "max", "hsc_key": "average response time"},
    "normalized_waiting_times": {"dir": "minimize", "parallel": "max", "hsc_key": "average waiting time"},
    "reliabilities": {"dir": "maximize", "parallel": "min", "hsc_key": "reliability", "geometric": True},
    "successabilities": {"dir": "maximize", "parallel": "min", "hsc_key": "successability", "geometric": True},
}


def _sequence_aggregation(level_count: int, geometric: bool) -> dict:
    reduction = {"op": "product" if geometric else "sum", "args": [{"path": "values"}]}
    expression = (
        {"op": "pow", "left": reduction, "right": 1.0 / level_count}
        if geometric
        else {"op": "div", "left": reduction, "right": level_count}
    )
    return {"expression": expression}


def transform_hsc_instances(
    source_path: Path = DEFAULT_SOURCE,
    target_dir: Path = DEFAULT_TARGET,
    limit: int | None = None,
    verify_sample: int = 20,
    jobs: int = 16,
) -> int:
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"Loading HSC dataset from {source_path}...")

    if source_path.is_dir():
        workflows = json.loads((source_path / "workflow.json").read_text(encoding="utf-8"))
        requirements = json.loads((source_path / "requirements.json").read_text(encoding="utf-8"))
        models = json.loads((source_path / "normalized_model.json").read_text(encoding="utf-8"))
        best_solutions = json.loads((source_path / "best_solution.json").read_text(encoding="utf-8"))
    elif source_path.is_file():
        with zipfile.ZipFile(source_path) as z:
            names = z.namelist()

            def read_json_from_zip(fname: str) -> dict | list:
                if fname in names:
                    return json.loads(z.read(fname).decode("utf-8"))
                nested = f"HSC-main/{fname}"
                if nested in names:
                    return json.loads(z.read(nested).decode("utf-8"))
                target = next((n for n in names if n.endswith(f"/{fname}") and not n.startswith("__MACOSX")), None)
                if target:
                    return json.loads(z.read(target).decode("utf-8"))
                raise FileNotFoundError(f"Cannot find {fname} in {source_path}")

            workflows = read_json_from_zip("workflow.json")
            requirements = read_json_from_zip("requirements.json")
            models = read_json_from_zip("normalized_model.json")
            best_solutions = read_json_from_zip("best_solution.json")
    else:
        raise FileNotFoundError(f"HSC source not found at {source_path}")

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
        bs = best_solutions[idx] if idx < len(best_solutions) else {"best_value": 0.0, "best_solution": []}

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
        for activity_index, (_stage_index, category) in enumerate(activities):
            tid = f"task_{activity_index + 1}"
            opt_model_idx = bs.get("best_solution", [])[activity_index] if activity_index < len(bs.get("best_solution", [])) else None
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
                    "features": {
                        "normalized_downloads": round(float(m.get("normalized_downloads", 0.5)), 4),
                        "normalized_likes": round(float(m.get("normalized_likes", 0.5)), 4),
                        "normalized_response_times": round(float(m.get("normalized_response_times", 0.5)), 4),
                        "normalized_waiting_times": round(float(m.get("normalized_waiting_times", 0.5)), 4),
                        "reliabilities": round(float(m.get("reliabilities", 0.9)), 4),
                        "successabilities": round(float(m.get("successabilities", 0.9)), 4),
                    },
                }
                if model_index == opt_model_idx:
                    reference_binding[tid] = {"resource": "catalog", "id": cid}

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

        constraints = {}
        for f_id, v in FEAT_META.items():
            val = float(wf.get("cons", {}).get(v["hsc_key"], 0.0))
            if val > 0:
                op = "<=" if v["dir"] == "minimize" else ">="
                constraints[f_id] = {"assert": f"features.{f_id} {op} {val}", "enforcement": "hard"}

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
                    "normalize": {"min": 0.0, "max": 1.0, "clamp": True},
                })
                objective_weights[f_id] = w
        if not criteria:
            criteria.append({
                "id": "normalized_response_times",
                "feature": {"resource": "application", "id": "normalized_response_times"},
                "direction": "minimize",
                "normalize": {"min": 0.0, "max": 1.0, "clamp": True},
            })
            objective_weights["normalized_response_times"] = 1.0

        opt_doc = {
            "apiVersion": "qos-binding/v1",
            "kind": "Optimization",
            "metadata": {"name": f"{inst_name}_optimization"},
            "spec": {"criteria": criteria},
        }

        inst_doc = {
            "apiVersion": "bim/v1",
            "kind": "Instance",
            "metadata": {
                "name": inst_name,
                "version": "1.0.0",
                "description": "HSC Hugging Face AI service composition workflow instance",
                "annotations": {
                    "source": "HSC Dataset (Hugging Face AI Service Composition)",
                    "workflow_index": idx,
                    "user_requirement": req,
                    "best_value": bs.get("best_value", 0.0),
                    "reference_binding": reference_binding,
                    "source_task_count": len(activities),
                    "source_level_count": len(stages),
                    "objective_weights": objective_weights,
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
                compile_instance(load_package(p))
            except Exception as exc:
                print(f"Verification failure on {p.name}: {exc}")
                return 1
        print("Sample verification passed successfully.")

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
