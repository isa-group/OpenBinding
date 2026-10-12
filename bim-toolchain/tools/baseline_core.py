"""Semantic baseline of the BIM v1 corpus and its negative cases, computed with ``bim_core`` only.

``compilerDigest`` and ``irDigest`` change whenever the toolchain bytes change, so they cannot prove
that the meaning survived.  This tool records what must not move instead: the semantic digest of every
package (the IR document minus ``profile``/``dialects``/``instance``/``sourceMap``), the result of the
canonical evaluator on its bindings, and the diagnostics of the negative cases.  Whatever is expected
to change with the toolchain lives under a ``toolchain`` key, which :func:`comparable` removes.

It adapts ``tools/bim_baseline.py`` of OpenBinding.  Engine compatibility, re-evaluation vectors and
the protocol section need platform code and are left for a later step.

The corpus is not part of this directory.  It is looked up under ``BIM_CORPUS_ROOT`` (default: the
directory that contains ``bim-toolchain/``).  Golden paths are relative to that root.

Compare against the goldens::

    python bim-toolchain/tools/baseline_core.py --check

Regenerate them (only when a change of meaning is intended and reviewed)::

    python bim-toolchain/tools/baseline_core.py
"""

from __future__ import annotations

import argparse
import hashlib
import io
import itertools
import json
import os
import random
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_SRC = ROOT / "packages" / "bim-core" / "src"
if PACKAGE_SRC.is_dir():
    sys.path.insert(0, str(PACKAGE_SRC))

from bim_core import (  # noqa: E402
    BindingProblem,
    CompileError,
    ExpressionError,
    InstancePackage,
    compile_instance,
    compiler_bundle_digest,
    digest,
    load_package,
)
from bim_core.expressions import compile_expression  # noqa: E402

SEED = 20261012
EXHAUSTIVE_LIMIT = 2000
SAMPLE_SIZE = 16
INLINE_LIMIT = 64
BLOCK_SIZE = 64
DIGEST_PREFIX = 16

GOLDEN_DIR = ROOT / "golden" / "bim_baseline"
GOLDEN_FILES = ("corpus.json", "negatives.json")
DEMO_RELATIVE = Path("examples") / "demo" / "01_simple_seq"
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
SKIPPED_DIRECTORIES = {".git", ".pnpm-store", "node_modules", "target", "dist", ".venv", "__pycache__"}


# --- corpus location -------------------------------------------------------------------------


def default_corpus_root() -> Path:
    configured = os.environ.get("BIM_CORPUS_ROOT")
    return Path(configured) if configured else ROOT.parent


def corpus_available(corpus_root: Path) -> bool:
    return (corpus_root / DEMO_RELATIVE / "instance.json").is_file()


def package_directories(corpus_root: Path) -> list[Path]:
    """Every directory with an ``instance.json``, discovered as OpenBinding's corpus check does."""
    derived = {
        corpus_root / "experimentation" / "icsoc" / "out" / "bim-v1",
        corpus_root / "datasets",
        # Frontend test fixtures are not part of the checked-in corpus.
        corpus_root / "frontend",
        ROOT,
    }
    excluded = {path.resolve() for path in derived}
    roots: list[Path] = []
    for directory, subdirectories, filenames in os.walk(corpus_root):
        current = Path(directory)
        subdirectories[:] = [
            name
            for name in subdirectories
            if name not in SKIPPED_DIRECTORIES and (current / name).resolve() not in excluded
        ]
        if "instance.json" in filenames:
            roots.append(current)
            subdirectories[:] = []
    return sorted(roots)


# --- serialization ---------------------------------------------------------------------------


def dump(document: Any) -> bytes:
    """The one byte representation of a golden: sorted keys, one-space indent, LF, no NaN."""
    text = json.dumps(document, sort_keys=True, indent=1, ensure_ascii=False, allow_nan=False)
    return (text + "\n").encode("utf-8")


def comparable(value: Any) -> Any:
    """Drop every ``toolchain`` field: informative, expected to change with the toolchain."""
    if isinstance(value, dict):
        return {key: comparable(child) for key, child in value.items() if key != "toolchain"}
    if isinstance(value, list):
        return [comparable(child) for child in value]
    return value


def stable(value: Any) -> Any:
    """Round every float to 12 significant digits (``float(format(x, '.12g'))``, shortest ``repr``).

    Evaluations are digested and summarized after this, so the last bits of a float, which depend on
    the libm/platform build and on summation order, cannot change a golden.
    """
    if isinstance(value, float):
        return float(format(value, ".12g"))
    if isinstance(value, dict):
        return {key: stable(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [stable(child) for child in value]
    return value


def _short(value: str) -> str:
    return value.removeprefix("sha256-")[:DIGEST_PREFIX]


def _outcome(call: Callable[[], Any]) -> dict[str, Any]:
    """Run ``call`` and describe how it ended; unexpected exceptions are data here, not failures."""
    try:
        call()
    except CompileError as exc:
        return {"outcome": "CompileError", "diagnostics": [_diagnostic(item) for item in exc.diagnostics]}
    except ExpressionError as exc:
        return {"outcome": "ExpressionError", "message": str(exc), "span": exc.span}
    except Exception as exc:
        return {"outcome": type(exc).__name__, "message": str(exc)}
    return {"outcome": "ok"}


def _diagnostic(item: Any) -> dict[str, Any]:
    """Codes and locations only: messages embed jsonschema wording that is not ours to pin."""
    data = item.as_dict()
    return {key: data[key] for key in ("code", "resource", "pointer", "span", "bpmnElement", "irPath") if key in data}


# --- corpus ----------------------------------------------------------------------------------


def semantic_digest(problem: Any) -> str:
    spec = problem.document["spec"]
    return digest({key: value for key, value in spec.items() if key not in NON_SEMANTIC})


def candidate_total(spec: dict[str, Any]) -> int:
    catalogs = spec.get("candidates", {})
    return sum(
        len(catalog["candidates"])
        for catalog in catalogs.values()
        if isinstance(catalog, dict) and isinstance(catalog.get("candidates"), dict)
    )


def _widen(bucket: dict[str, dict[str, float]], key: str, value: float) -> None:
    current = bucket.get(key)
    if current is None:
        bucket[key] = {"min": value, "max": value}
    else:
        current["min"] = min(current["min"], value)
        current["max"] = max(current["max"], value)


class _Summary:
    """Ranges and counts over the evaluations of one package; no binding is stored."""

    def __init__(self) -> None:
        self.evaluated = 0
        self.errors: dict[str, int] = {}
        self.features: dict[str, dict[str, float]] = {}
        self.criteria: dict[str, dict[str, float]] = {}
        self.penalty: dict[str, dict[str, float]] = {}
        self.score: dict[str, dict[str, float]] = {}
        self.score_vectors = 0
        self.objectives: set[str] = set()
        self.violations: dict[str, int] = {}
        self.hard = 0
        self.soft = 0

    def add(self, outcome: dict[str, Any]) -> None:
        self.evaluated += 1
        if "error" in outcome:
            kind = outcome["error"].split(":", 1)[0]
            self.errors[kind] = self.errors.get(kind, 0) + 1
            return
        for feature_id, value in outcome["features"].items():
            _widen(self.features, feature_id, value)
        objectives = outcome["objectives"]
        self.objectives.add(f"{objectives['type']}/{objectives['scalarization']}")
        for component in objectives["components"]:
            _widen(self.criteria, component["criteria"], component["loss"])
        _widen(self.penalty, "penalty", objectives["penalty"])
        if isinstance(objectives["score"], list):
            self.score_vectors += 1
        else:
            _widen(self.score, "score", objectives["score"])
        enforcements = set()
        for violation in outcome["violations"]:
            reference = violation["constraint"]
            key = f"{reference['resource']}/{reference['id']}:{violation['enforcement']}"
            self.violations[key] = self.violations.get(key, 0) + 1
            enforcements.add(violation["enforcement"])
        self.hard += "hard" in enforcements
        self.soft += "soft" in enforcements

    def as_dict(self) -> dict[str, Any]:
        return {
            "evaluated": self.evaluated,
            "errors": self.errors,
            "feasible": self.evaluated - sum(self.errors.values()) - self.hard,
            "bindingsWithHardViolation": self.hard,
            "bindingsWithSoftViolation": self.soft,
            "violationsByConstraint": self.violations,
            "features": self.features,
            "criteriaLoss": self.criteria,
            "penalty": self.penalty.get("penalty"),
            "score": self.score.get("score"),
            "scoreVectors": self.score_vectors,
            "objectives": sorted(self.objectives),
        }


def evaluate_binding(problem: BindingProblem, binding: dict[str, Any]) -> dict[str, Any]:
    """The canonical evaluation of one binding, or the exception it ends in."""
    try:
        normalized = problem.validate_binding(binding)
        return stable(problem.evaluate(normalized))
    except Exception as exc:  # a binding the evaluator rejects is part of the baseline
        return {"error": f"{type(exc).__name__}: {exc}"}


def evaluate_package(problem: BindingProblem) -> dict[str, Any]:
    """Every binding when |S| <= 2000, otherwise 16 seeded draws; digests and summaries only."""
    breakdown = problem.binding_space_breakdown
    eligibility = problem.document["spec"].get("eligibility", {})
    task_ids = list(breakdown)
    if problem.binding_space_cardinality <= EXHAUSTIVE_LIMIT:
        mode = "exhaustive"
        bindings = [
            {task_id: dict(reference) for task_id, reference in zip(task_ids, combination, strict=True)}
            for combination in itertools.product(*(eligibility.get(task_id, []) for task_id in task_ids))
        ]
    else:
        mode = "sample"
        rng = random.Random(SEED)
        bindings = [
            {task_id: dict(rng.choice(eligibility[task_id])) for task_id in task_ids}
            for _ in range(SAMPLE_SIZE)
        ]
    summary = _Summary()
    digests: list[str] = []
    for binding in bindings:
        outcome = evaluate_binding(problem, binding)
        summary.add(outcome)
        digests.append(digest({"binding": binding, "outcome": outcome}))
    result: dict[str, Any] = {
        "mode": mode,
        "count": len(bindings),
        "rollupDigest": digest(digests),
        "summary": summary.as_dict(),
    }
    if mode == "sample":
        result["seed"] = SEED
    if len(digests) <= INLINE_LIMIT:
        result["bindingDigests"] = [_short(item) for item in digests]
    else:
        result["blockSize"] = BLOCK_SIZE
        result["blockDigests"] = [
            _short(digest(digests[start:start + BLOCK_SIZE])) for start in range(0, len(digests), BLOCK_SIZE)
        ]
    return result


def analyze_directory(directory: Path, corpus_root: Path) -> dict[str, Any]:
    """Compile one package once and return its corpus entry (path relative to ``corpus_root``)."""
    relative = directory.relative_to(corpus_root).as_posix()
    try:
        problem = compile_instance(load_package(directory))
    except Exception as exc:  # a package that stops compiling must show up in the baseline
        return {"path": relative, "status": "error", "error": f"{type(exc).__name__}: {exc}"}
    spec = problem.document["spec"]
    entry: dict[str, Any] = {
        "path": relative,
        "status": "compiled",
        "semanticDigest": semantic_digest(problem),
        "sectionDigests": {
            key: _short(digest(value)) for key, value in spec.items() if key not in NON_SEMANTIC
        },
        "candidates": candidate_total(spec),
        "toolchain": {"compilerDigest": compiler_bundle_digest(), "irDigest": problem.digest},
    }
    if not isinstance(problem, BindingProblem):
        return entry
    breakdown = problem.binding_space_breakdown
    entry["tasks"] = {"total": len(spec["application"]["tasks"]), "service": len(breakdown)}
    entry["bindingSpace"] = {
        "cardinality": str(problem.binding_space_cardinality),
        "log10": round(problem.binding_space_log10, 9),
        "candidatesPerServiceTask": list(breakdown.values()),
    }
    entry["evaluation"] = evaluate_package(problem)
    return entry


def build_corpus(directories: list[Path], corpus_root: Path, jobs: int = 1) -> dict[str, Any]:
    """The ``corpus.json`` document for ``directories``."""
    if jobs <= 1:
        results = [analyze_directory(directory, corpus_root) for directory in directories]
    else:
        with ProcessPoolExecutor(max_workers=jobs) as executor:
            results = list(executor.map(analyze_directory, directories, itertools.repeat(corpus_root)))
    return {
        "schema": "bim-baseline/corpus/1",
        "seed": SEED,
        "exhaustiveLimit": EXHAUSTIVE_LIMIT,
        "sampleSize": SAMPLE_SIZE,
        "inlineLimit": INLINE_LIMIT,
        "blockSize": BLOCK_SIZE,
        "digestPrefix": DIGEST_PREFIX,
        "packageCount": len(results),
        "packages": {entry["path"]: entry for entry in results},
        "toolchain": {"compilerDigest": compiler_bundle_digest()},
    }


# --- negative cases --------------------------------------------------------------------------

Files = dict[str, bytes]


def _edit(files: Files, name: str, change: Callable[[dict[str, Any]], None]) -> Files:
    document = json.loads(files[name])
    change(document)
    files[name] = json.dumps(document, allow_nan=False).encode()
    return files


def _with_latency(base: Files, value: Any) -> Files:
    def change(catalog: dict[str, Any]) -> None:
        catalog["spec"]["candidates"]["c1a"]["features"]["latency"] = value

    return _edit(dict(base), "candidates.json", change)


def _with_constant(base: Files, bound: str, constant: str) -> Files:
    files = _with_latency(base, {"min": 1, "max": 2, bound: "__constant__"})
    files["candidates.json"] = files["candidates.json"].replace(b'"__constant__"', constant.encode())
    return files


def _xor_files(base: Files, routing: dict[str, Any] | None) -> Files:
    """The demo with an exclusive workflow; ``routing`` is the RoutingOverlay spec, if any."""
    files = dict(base)

    def link(instance: dict[str, Any]) -> None:
        if routing is not None:
            instance["spec"]["resources"]["candidateCatalog"]["routing"] = "routing.json"

    def workflow(application: dict[str, Any]) -> None:
        application["spec"]["workflow"] = {
            "exclusive": [
                {"id": "left", "flow": {"task": {"resource": "application", "id": "t1"}}},
                {
                    "id": "right",
                    "flow": {
                        "sequence": [
                            {"task": {"resource": "application", "id": "t2"}},
                            {"task": {"resource": "application", "id": "t3"}},
                        ]
                    },
                },
            ]
        }

    _edit(files, "instance.json", link)
    _edit(files, "application.json", workflow)
    if routing is not None:
        files["routing.json"] = json.dumps({
            "apiVersion": "qos-binding/v1",
            "kind": "RoutingOverlay",
            "metadata": {"name": "routing"},
            "spec": routing,
        }).encode()
    return files


def _routing_entries(left: float, right: float | None) -> dict[str, Any]:
    targets = [("left", left), ("right", right)]
    return {
        "entries": [
            {"target": {"resource": "application", "id": name}, "probability": probability}
            for name, probability in targets
            if probability is not None
        ]
    }


def _zip_with(name: str) -> bytes:
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr(name, "{}")
    return data.getvalue()


def _set_profile(instance: dict[str, Any]) -> None:
    instance["spec"]["profile"] = "no-such-profile/v1"


def _add_instance_property(instance: dict[str, Any]) -> None:
    instance["spec"]["unexpected"] = True


def _add_workflow_property(application: dict[str, Any]) -> None:
    application["spec"]["workflow"]["unexpected"] = True


def _retarget_task(application: dict[str, Any]) -> None:
    application["spec"]["tasks"]["t1"] = "service/nobody-provides-this"


def _unknown_criterion_feature(optimization: dict[str, Any]) -> None:
    optimization["spec"]["criteria"][0]["feature"]["id"] = "no_such_feature"


def _without(base: Files, name: str) -> Files:
    files = dict(base)
    del files[name]
    return files


def compile_cases(base: Files) -> dict[str, tuple[str, Callable[[], Files]]]:
    """In-memory packages that must fail (or, as controls, compile); source names the test they mirror."""
    language = "tests/test_v1_language.py"
    ranges = "tests/test_b5_open_ranges.py"

    def edit(name: str, change: Callable[[dict[str, Any]], None]) -> Callable[[], Files]:
        return lambda: _edit(dict(base), name, change)

    def latency(value: Any) -> Callable[[], Files]:
        return lambda: _with_latency(base, value)

    def constant(bound: str, text: str) -> Callable[[], Files]:
        return lambda: _with_constant(base, bound, text)

    def xor(routing: dict[str, Any] | None) -> Callable[[], Files]:
        return lambda: _xor_files(base, routing)

    return {
        "workflow_unknown_property": (language, edit("application.json", _add_workflow_property)),
        "xor_routing_absent": (language, xor(None)),
        "xor_routing_empty_entries": (language, xor({"entries": []})),
        "xor_routing_partial": (language, xor(_routing_entries(1, None))),
        "xor_routing_sum_not_one": (language, xor(_routing_entries(0.4, 0.5))),
        "xor_routing_uniform_control": (language, xor({"uniform": True})),
        "instance_unknown_property": ("constructed", edit("instance.json", _add_instance_property)),
        "instance_missing": ("constructed", lambda: _without(base, "instance.json")),
        "profile_unsupported": ("constructed", edit("instance.json", _set_profile)),
        "catalog_resource_missing": ("constructed", lambda: _without(base, "candidates.json")),
        "task_without_provider": ("constructed", edit("application.json", _retarget_task)),
        "criterion_unknown_feature": ("constructed", edit("optimization.json", _unknown_criterion_feature)),
        "range_min_above_max": (ranges, latency({"min": 9, "max": 3})),
        "range_negative_min_above_max": (ranges, latency({"min": 0, "max": -1})),
        "range_numeric_string": (ranges, latency({"min": "1", "max": 2})),
        "range_bool_end": (ranges, latency({"min": True, "max": 2})),
        "range_missing_key": (ranges, latency({"min": 1})),
        "range_open_control": (ranges, latency({"min": 100, "max": None})),
        "range_both_open_control": (ranges, latency({"min": None, "max": None})),
        "scalar_list": (ranges, latency([1, 2])),
        "scalar_string": (ranges, latency("5")),
        "scalar_bool": (ranges, latency(True)),
        "scalar_null": (ranges, latency(None)),
        "constant_nan_min": (ranges, constant("min", "NaN")),
        "constant_infinity_max": (ranges, constant("max", "Infinity")),
        "constant_negative_infinity_min": (ranges, constant("min", "-Infinity")),
    }


def expression_cases() -> dict[str, tuple[str, Any, dict[str, Any]]]:
    nested: Any = {"op": "not", "value": True}
    for _ in range(40):
        nested = {"op": "not", "value": nested}
    metrics = {"allowed_roots": {"metrics": "object"}, "path_types": {"metrics.latency": "number"}}
    closed = {"allowed_roots": {"metrics": "closed-object"}}
    source = "tests/test_v1_language.py"
    return {
        "expression_call_injection": (source, "__import__('os').system('id')", {}),
        "expression_too_long": (source, "true || " + "false || " * 1000 + "true", {"expected_type": "bool"}),
        "expression_comprehension": (source, "[x for x in values]", {}),
        "expression_undeclared_path": (source, "metrics.__class__", closed),
        "expression_too_deep": (source, nested, {"expected_type": "bool"}),
        "expression_syntax_error": (source, "  true && && false  ", {"expected_type": "bool"}),
        "expression_unterminated_string": (source, "metrics.latency == 'oops", {}),
        "expression_type_mismatch": (
            source, "  metrics.latency + 'slow' <= 50  ", {**metrics, "expected_type": "bool"}
        ),
        "expression_root_not_allowed": (
            source, "metrics.latency <= secrets.limit", {**metrics, "expected_type": "bool"}
        ),
        "expression_valid_control": (
            source, "metrics.latency <= 50", {**metrics, "expected_type": "bool"}
        ),
    }


def binding_cases() -> dict[str, Any]:
    def ref(identifier: str) -> dict[str, Any]:
        return {"resource": "catalog", "id": identifier}

    good = {"t1": ref("c1a"), "t2": ref("c2a"), "t3": ref("c3a")}
    return {
        "binding_valid_control": good,
        "binding_missing_task": {key: good[key] for key in ("t1", "t2")},
        "binding_extra_task": {**good, "t4": ref("c3a")},
        "binding_not_an_object": ["t1", "t2", "t3"],
        "binding_value_missing_id": {**good, "t1": {"resource": "catalog"}},
        "binding_value_id_not_string": {**good, "t1": {"resource": "catalog", "id": 1}},
        "binding_value_extra_key": {**good, "t1": {**ref("c1a"), "extra": "x"}},
        "binding_candidate_not_eligible": {**good, "t1": ref("c2a")},
        "binding_candidate_unknown": {**good, "t1": ref("c9z")},
        "binding_other_resource": {**good, "t1": {"resource": "application", "id": "c1a"}},
    }


def build_negatives(corpus_root: Path) -> dict[str, Any]:
    demo = corpus_root / DEMO_RELATIVE
    base = dict(load_package(demo).files)
    cases: dict[str, Any] = {}
    for name, (source, build) in compile_cases(base).items():
        cases[name] = {"kind": "compile", "source": source, **_outcome(lambda build=build: compile_instance(InstancePackage(build())))}
    for name, data in {
        "package_zip_path_traversal": _zip_with("../instance.json"),
        "package_zip_absolute_path": _zip_with("/instance.json"),
        "package_zip_not_an_archive": b"not a zip archive",
    }.items():
        cases[name] = {"kind": "package", "source": "tests/test_v1_language.py", **_outcome(lambda data=data: load_package(data))}
    for name, (source, value, options) in expression_cases().items():
        cases[name] = {"kind": "expression", "source": source, **_outcome(lambda v=value, o=options: compile_expression(v, **o))}
    problem = compile_instance(load_package(demo))
    for name, binding in binding_cases().items():
        cases[name] = {"kind": "binding", "source": "constructed", **_outcome(lambda b=binding: problem.validate_binding(b))}
    return {"schema": "bim-baseline/negatives/1", "cases": cases}


# --- command line ----------------------------------------------------------------------------


def _golden(directory: Path, name: str) -> Any:
    return json.loads((directory / name).read_text(encoding="utf-8"))


def mismatches(corpus: dict[str, Any], negatives: dict[str, Any], golden_dir: Path) -> list[str]:
    """Names of the packages and cases whose comparable content differs from the goldens."""
    expected_corpus = _golden(golden_dir, "corpus.json")
    expected_negatives = _golden(golden_dir, "negatives.json")
    found = [
        f"package {path}"
        for path in sorted(set(corpus["packages"]) | set(expected_corpus["packages"]))
        if comparable(corpus["packages"].get(path)) != comparable(expected_corpus["packages"].get(path))
    ]
    found.extend(
        f"negative {name}"
        for name in sorted(set(negatives["cases"]) | set(expected_negatives["cases"]))
        if comparable(negatives["cases"].get(name)) != comparable(expected_negatives["cases"].get(name))
    )
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compute the semantic BIM baseline with bim_core only")
    parser.add_argument("--corpus-root", type=Path, default=default_corpus_root())
    parser.add_argument("--output", type=Path, default=GOLDEN_DIR)
    parser.add_argument("--expected", type=int, default=82)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--check", action="store_true", help="compare with the goldens instead of writing")
    args = parser.parse_args(argv)

    corpus_root = args.corpus_root
    if not corpus_available(corpus_root):
        print(f"corpus not found under {corpus_root}; set BIM_CORPUS_ROOT or --corpus-root", file=sys.stderr)
        return 2
    directories = package_directories(corpus_root)
    corpus = build_corpus(directories, corpus_root, args.jobs)
    failures = {path: entry["error"] for path, entry in corpus["packages"].items() if entry["status"] != "compiled"}
    if len(directories) != args.expected:
        failures["corpus"] = f"expected {args.expected} packages, found {len(directories)}"
    if failures:
        for path, error in sorted(failures.items()):
            print(f"{path}: {error}", file=sys.stderr)
        return 1
    negatives = build_negatives(corpus_root)

    if args.check:
        differences = mismatches(corpus, negatives, args.output)
        for item in differences:
            print(f"differs: {item}", file=sys.stderr)
        print(f"BIM baseline check: {len(directories)} packages, {len(differences)} differences")
        return 1 if differences else 0

    args.output.mkdir(parents=True, exist_ok=True)
    for name, document in {"corpus.json": corpus, "negatives.json": negatives}.items():
        data = dump(document)
        (args.output / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes sha256={hashlib.sha256(data).hexdigest()}")
    print(f"BIM baseline: {len(directories)} packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
