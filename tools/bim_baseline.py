"""Deterministic semantic baseline of the BIM v1 corpus, its contracts and its negative cases.

The extraction of BIM into its own repository changes ``compilerDigest``, ``irDigest`` and the
bundled versions, so those cannot prove that the meaning survived.  This tool records what must
not move instead: the semantic digest of every package (the document the IR carries minus
``profile``/``dialects``/``instance``/``sourceMap``, as pinned by ``tests/test_b5_golden.py``),
the result of the canonical evaluator on its bindings, Engine mode compatibility, diagnostics of
negative cases, result re-evaluation vectors and the protocol/schema digests.

Everything is written as JSON with sorted keys and no timestamps.  Whatever is expected to change
with the toolchain lives under a ``toolchain`` key, which :func:`comparable` removes and
``tests/test_bim_baseline.py`` never compares.  No dataset content is stored, only digests and
numeric summaries derived from evaluations.

Regenerate the goldens (from the repository root)::

    uv run --project openbinding-gateway --locked python tools/bim_baseline.py
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
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
sys.path.insert(0, str(ROOT / "openbinding-gateway" / "src"))
# The same offline environment the gateway test suite runs in (tests/conftest.py).
for _name, _value in {
    "SCHEMAS_DIR": str(ROOT / "schemas"),
    "GENERAL_SCHEMA_PATH": str(ROOT / "schemas" / "general" / "schema.json"),
    "GATEWAY_JWT_SECRET": "test-secret-not-used-anywhere-real",
    "JOB_DISPATCH_MODE": "inline",
    "SPHERE_ENABLED": "false",
}.items():
    os.environ.setdefault(_name, _value)

from openbinding_gateway.v1.canonical import digest, digest_bytes  # noqa: E402
from openbinding_gateway.v1.compiler import (  # noqa: E402
    BindingProblem,
    CompileError,
    compile_instance,
    compiler_bundle_digest,
    installed_dialect_manifests,
    installed_profile_manifests,
    manifest_reference,
)
from openbinding_gateway.v1.expressions import ExpressionError, compile_expression  # noqa: E402
from openbinding_gateway.v1.package import InstancePackage, load_package  # noqa: E402

SEED = 20261012
EXHAUSTIVE_LIMIT = 2000
SAMPLE_SIZE = 16
INLINE_LIMIT = 64
BLOCK_SIZE = 64
DIGEST_PREFIX = 16

GOLDEN_DIR = ROOT / "openbinding-gateway" / "tests" / "golden" / "bim_baseline"
GOLDEN_FILES = ("corpus.json", "negatives.json", "compat.json", "vectors.json", "protocol.json")
DEMO = ROOT / "examples" / "demo" / "01_simple_seq"
SCHEMA_DIR = ROOT / "schemas" / "bim" / "v1"
MANIFEST_DIR = SCHEMA_DIR / "manifests"
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})


# --- serialization ---------------------------------------------------------------------------


def dump(document: Any) -> bytes:
    """The one byte representation of a golden: sorted keys, one-space indent, LF, no NaN."""
    text = json.dumps(document, sort_keys=True, indent=1, ensure_ascii=False, allow_nan=False)
    return (text + "\n").encode("utf-8")


def comparable(value: Any) -> Any:
    """Drop every ``toolchain`` field: informative, expected to change with the extraction."""
    if isinstance(value, dict):
        return {key: comparable(child) for key, child in value.items() if key != "toolchain"}
    if isinstance(value, list):
        return [comparable(child) for child in value]
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


def package_directories() -> list[Path]:
    """The corpus exactly as ``tools/check_bim_corpus.py`` discovers it."""
    path = ROOT / "tools" / "check_bim_corpus.py"
    spec = importlib.util.spec_from_file_location("check_bim_corpus", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.package_directories()


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
        return problem.evaluate(normalized)
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


def engine_manifests() -> dict[str, dict[str, Any]]:
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(MANIFEST_DIR.glob("*.json"))}


def _compatibility_code(diagnostic: dict[str, Any]) -> str:
    parts = [diagnostic["code"], diagnostic.get("category") or diagnostic.get("limit") or ""]
    unsupported = diagnostic.get("unsupported")
    if unsupported:
        parts.append(",".join(unsupported))
    return ":".join(parts)


def compatibility(problem: BindingProblem, manifests: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """``mode_compatibility`` of one problem against every mode of every Engine manifest."""
    from openbinding_gateway.services.engines import mode_compatibility

    result: dict[str, Any] = {}
    for name, manifest in manifests.items():
        modes: dict[str, Any] = {}
        for mode in manifest["spec"]["modes"]:
            diagnostics = mode_compatibility(problem, mode)
            modes[mode["id"]] = {
                "compatible": not diagnostics,
                "codes": [_compatibility_code(item) for item in diagnostics],
                "digest": digest(diagnostics),
            }
        result[name] = modes
    return result


def analyze_directory(directory: Path) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Compile one package once; return its corpus entry and its compatibility entry."""
    relative = directory.relative_to(ROOT).as_posix()
    try:
        problem = compile_instance(load_package(directory))
    except Exception as exc:  # a package that stops compiling must show up in the baseline
        return {"path": relative, "status": "error", "error": f"{type(exc).__name__}: {exc}"}, None
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
        return entry, None
    breakdown = problem.binding_space_breakdown
    entry["tasks"] = {"total": len(spec["application"]["tasks"]), "service": len(breakdown)}
    entry["bindingSpace"] = {
        "cardinality": str(problem.binding_space_cardinality),
        "log10": round(problem.binding_space_log10, 9),
        "candidatesPerServiceTask": list(breakdown.values()),
    }
    entry["evaluation"] = evaluate_package(problem)
    return entry, compatibility(problem, engine_manifests())


def build_corpus(directories: list[Path], jobs: int = 1) -> tuple[dict[str, Any], dict[str, Any]]:
    """The ``corpus.json`` and ``compat.json`` documents for ``directories``."""
    if jobs <= 1:
        results = [analyze_directory(directory) for directory in directories]
    else:
        with ProcessPoolExecutor(max_workers=jobs) as executor:
            results = list(executor.map(analyze_directory, directories))
    manifests = engine_manifests()
    corpus = {
        "schema": "bim-baseline/corpus/1",
        "seed": SEED,
        "exhaustiveLimit": EXHAUSTIVE_LIMIT,
        "sampleSize": SAMPLE_SIZE,
        "inlineLimit": INLINE_LIMIT,
        "blockSize": BLOCK_SIZE,
        "digestPrefix": DIGEST_PREFIX,
        "packageCount": len(results),
        "packages": {entry["path"]: entry for entry, _ in results},
        "toolchain": {"compilerDigest": compiler_bundle_digest()},
    }
    compat = {
        "schema": "bim-baseline/compat/1",
        "engines": {
            name: {
                "manifestDigest": digest(manifest),
                "modes": sorted(mode["id"] for mode in manifest["spec"]["modes"]),
            }
            for name, manifest in manifests.items()
        },
        "packages": {entry["path"]: found for entry, found in results if found is not None},
    }
    return corpus, compat


# --- negative cases --------------------------------------------------------------------------


def _demo_files() -> dict[str, bytes]:
    return dict(load_package(DEMO).files)


def _edit(files: dict[str, bytes], name: str, change: Callable[[dict[str, Any]], None]) -> dict[str, bytes]:
    document = json.loads(files[name])
    change(document)
    files[name] = json.dumps(document, allow_nan=False).encode()
    return files


def _with_latency(value: Any) -> dict[str, bytes]:
    def change(catalog: dict[str, Any]) -> None:
        catalog["spec"]["candidates"]["c1a"]["features"]["latency"] = value

    return _edit(_demo_files(), "candidates.json", change)


def _with_constant(bound: str, constant: str) -> dict[str, bytes]:
    files = _with_latency({"min": 1, "max": 2, bound: "__constant__"})
    files["candidates.json"] = files["candidates.json"].replace(b'"__constant__"', constant.encode())
    return files


def _xor_files(routing: dict[str, Any] | None) -> dict[str, bytes]:
    """The demo with an exclusive workflow; ``routing`` is the RoutingOverlay spec, if any."""
    files = _demo_files()

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


def _demo_edit(name: str, change: Callable[[dict[str, Any]], None]) -> dict[str, bytes]:
    return _edit(_demo_files(), name, change)


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


def _without_catalog() -> dict[str, bytes]:
    files = _demo_files()
    del files["candidates.json"]
    return files


def _without_instance() -> dict[str, bytes]:
    files = _demo_files()
    del files["instance.json"]
    return files


def compile_cases() -> dict[str, tuple[str, Callable[[], dict[str, bytes]]]]:
    """In-memory packages that must fail (or, as controls, compile); source names the test they mirror."""
    language = "tests/test_v1_language.py"
    ranges = "tests/test_b5_open_ranges.py"
    cases: dict[str, tuple[str, Callable[[], dict[str, bytes]]]] = {
        "workflow_unknown_property": (language, lambda: _demo_edit("application.json", _add_workflow_property)),
        "xor_routing_absent": (language, lambda: _xor_files(None)),
        "xor_routing_empty_entries": (language, lambda: _xor_files({"entries": []})),
        "xor_routing_partial": (language, lambda: _xor_files(_routing_entries(1, None))),
        "xor_routing_sum_not_one": (language, lambda: _xor_files(_routing_entries(0.4, 0.5))),
        "xor_routing_uniform_control": (language, lambda: _xor_files({"uniform": True})),
        "instance_unknown_property": ("constructed", lambda: _demo_edit("instance.json", _add_instance_property)),
        "instance_missing": ("constructed", _without_instance),
        "profile_unsupported": ("constructed", lambda: _demo_edit("instance.json", _set_profile)),
        "catalog_resource_missing": ("constructed", _without_catalog),
        "task_without_provider": ("constructed", lambda: _demo_edit("application.json", _retarget_task)),
        "criterion_unknown_feature": (
            "constructed", lambda: _demo_edit("optimization.json", _unknown_criterion_feature)
        ),
        "range_min_above_max": (ranges, lambda: _with_latency({"min": 9, "max": 3})),
        "range_negative_min_above_max": (ranges, lambda: _with_latency({"min": 0, "max": -1})),
        "range_numeric_string": (ranges, lambda: _with_latency({"min": "1", "max": 2})),
        "range_bool_end": (ranges, lambda: _with_latency({"min": True, "max": 2})),
        "range_missing_key": (ranges, lambda: _with_latency({"min": 1})),
        "range_open_control": (ranges, lambda: _with_latency({"min": 100, "max": None})),
        "range_both_open_control": (ranges, lambda: _with_latency({"min": None, "max": None})),
        "scalar_list": (ranges, lambda: _with_latency([1, 2])),
        "scalar_string": (ranges, lambda: _with_latency("5")),
        "scalar_bool": (ranges, lambda: _with_latency(True)),
        "scalar_null": (ranges, lambda: _with_latency(None)),
        "constant_nan_min": (ranges, lambda: _with_constant("min", "NaN")),
        "constant_infinity_max": (ranges, lambda: _with_constant("max", "Infinity")),
        "constant_negative_infinity_min": (ranges, lambda: _with_constant("min", "-Infinity")),
    }
    return cases


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


def binding_cases() -> dict[str, dict[str, Any]]:
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


def build_negatives() -> dict[str, Any]:
    cases: dict[str, Any] = {}
    for name, (source, build) in compile_cases().items():
        cases[name] = {"kind": "compile", "source": source, **_outcome(lambda build=build: compile_instance(InstancePackage(build())))}
    for name, data in {
        "package_zip_path_traversal": _zip_with("../instance.json"),
        "package_zip_absolute_path": _zip_with("/instance.json"),
        "package_zip_not_an_archive": b"not a zip archive",
    }.items():
        cases[name] = {"kind": "package", "source": "tests/test_v1_language.py", **_outcome(lambda data=data: load_package(data))}
    for name, (source, value, options) in expression_cases().items():
        cases[name] = {"kind": "expression", "source": source, **_outcome(lambda v=value, o=options: compile_expression(v, **o))}
    problem = compile_instance(load_package(DEMO))
    for name, binding in binding_cases().items():
        cases[name] = {"kind": "binding", "source": "constructed", **_outcome(lambda b=binding: problem.validate_binding(b))}
    return {"schema": "bim-baseline/negatives/1", "cases": cases}


# --- reevaluation vectors --------------------------------------------------------------------


def _solution(problem: BindingProblem, binding: dict[str, Any]) -> dict[str, Any]:
    evaluation = problem.evaluate(binding)
    penalties = problem.document["spec"]["optimization"].get("penalties", [])
    return {
        "decision": {"kind": "binding", "binding": binding},
        "features": evaluation["features"],
        "objectives": evaluation["objectives"],
        "penalties": [0.0 for _ in penalties],
        "violations": evaluation["violations"],
    }


def vector_inputs() -> list[dict[str, Any]]:
    """Synthetic Engine answers for the demo problem; ``allowed`` None means the default."""
    problem = compile_instance(load_package(DEMO))

    def binding(first: str, resource: str = "catalog") -> dict[str, Any]:
        return {
            "t1": {"resource": resource, "id": first},
            "t2": {"resource": "catalog", "id": "c2a"},
            "t3": {"resource": "catalog", "id": "c3a"},
        }

    best, other = _solution(problem, binding("c1a")), _solution(problem, binding("c1b"))
    wrong = copy.deepcopy(best)
    wrong["features"] = {"latency": 1.0}
    wrong["objectives"]["score"] = 0.0
    wrong["objectives"]["components"][0].update({"value": 1.0, "loss": 0.0})
    not_eligible = _solution(problem, binding("c1a"))
    not_eligible["decision"]["binding"]["t1"] = {"resource": "catalog", "id": "c2a"}
    malformed = {key: value for key, value in best.items() if key != "penalties"}
    everything = ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]
    return [
        {"id": "optimal_declared", "result": {"termination": "OPTIMAL", "solutions": [best], "provenance": {"engine": "synthetic"}}, "allowed": everything},
        {"id": "feasible_default_terminations", "result": {"termination": "FEASIBLE", "solutions": [other]}, "allowed": None},
        {"id": "optimal_not_declared", "result": {"termination": "OPTIMAL", "solutions": [best]}, "allowed": None},
        {"id": "infeasible_declared", "result": {"termination": "INFEASIBLE", "solutions": []}, "allowed": everything},
        {"id": "infeasible_with_solution", "result": {"termination": "INFEASIBLE", "solutions": [best]}, "allowed": everything},
        {"id": "unknown_without_solutions", "result": {"termination": "UNKNOWN", "solutions": []}, "allowed": None},
        {"id": "feasible_without_solutions", "result": {"termination": "FEASIBLE", "solutions": []}, "allowed": everything},
        {"id": "binding_not_eligible", "result": {"termination": "FEASIBLE", "solutions": [not_eligible]}, "allowed": everything},
        {"id": "objective_miscomputed", "result": {"termination": "OPTIMAL", "solutions": [wrong]}, "allowed": everything},
        {"id": "invalid_shape_missing_penalties", "result": {"termination": "FEASIBLE", "solutions": [malformed]}, "allowed": everything},
    ]


def build_vectors() -> dict[str, Any]:
    """Run ``reevaluate_result`` and ``v1.remote._validate_result`` on each synthetic answer."""
    from openbinding_gateway.services.execution import reevaluate_result
    from openbinding_gateway.v1.remote import RemoteEngineError, _validate_result

    problem = compile_instance(load_package(DEMO))
    vectors = []
    for case in vector_inputs():
        result, allowed = case["result"], case["allowed"]
        arguments = (problem, copy.deepcopy(result), None) + (() if allowed is None else (allowed,))
        try:
            _validate_result(copy.deepcopy(result))
            validation: dict[str, Any] = {"valid": True}
        except RemoteEngineError as exc:
            validation = {"valid": False, "error": str(exc)}
        vectors.append({
            "id": case["id"],
            "input": {"result": result, "allowedTerminations": allowed},
            "reevaluate": reevaluate_result(*arguments),
            "validate": validation,
        })
    return {"schema": "bim-baseline/vectors/1", "problem": DEMO.relative_to(ROOT).as_posix(), "vectors": vectors}


# --- protocol --------------------------------------------------------------------------------


def build_protocol() -> dict[str, Any]:
    from openbinding_gateway.services import engines
    from openbinding_gateway.v1 import compiler

    vendor = Path(compiler.__file__).parent / "vendor"
    return {
        "schema": "bim-baseline/protocol/1",
        "protocolDigest": engines.protocol_digest(),
        "engineContract": {
            "openapiBytes": digest_bytes(engines.ENGINE_PROTOCOL_PATH.read_bytes()),
            "openapiDocument": digest(engines.protocol_document()),
        },
        "schemas": {path.name: digest_bytes(path.read_bytes()) for path in sorted(SCHEMA_DIR.glob("*.schema.json"))},
        "manifests": {name: digest(manifest) for name, manifest in engine_manifests().items()},
        "vendor": {
            path.relative_to(vendor).as_posix(): digest_bytes(path.read_bytes())
            for path in sorted(vendor.rglob("*"))
            if path.is_file() and "__pycache__" not in path.parts
        },
        "toolchain": {
            "compilerDigest": compiler_bundle_digest(),
            "profiles": sorted(manifest_reference(item)["digest"] for item in installed_profile_manifests()),
            "dialects": sorted(manifest_reference(item)["digest"] for item in installed_dialect_manifests()),
        },
    }


# --- command line ----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write the semantic BIM baseline goldens")
    parser.add_argument("--output", type=Path, default=GOLDEN_DIR)
    parser.add_argument("--expected", type=int, default=82)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args(argv)

    directories = package_directories()
    corpus, compat = build_corpus(directories, args.jobs)
    failures = {path: entry["error"] for path, entry in corpus["packages"].items() if entry["status"] != "compiled"}
    if len(directories) != args.expected:
        failures["corpus"] = f"expected {args.expected} packages, found {len(directories)}"
    if failures:
        for path, error in sorted(failures.items()):
            print(f"{path}: {error}", file=sys.stderr)
        return 1

    documents = {
        "corpus.json": corpus,
        "negatives.json": build_negatives(),
        "compat.json": compat,
        "vectors.json": build_vectors(),
        "protocol.json": build_protocol(),
    }
    args.output.mkdir(parents=True, exist_ok=True)
    for name in GOLDEN_FILES:
        data = dump(documents[name])
        (args.output / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes")
    print(f"BIM baseline: {len(directories)} packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
