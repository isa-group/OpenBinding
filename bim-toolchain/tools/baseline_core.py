"""Semantic baseline of the BIM v1 corpus, computed with ``bim_core`` only.

``compilerDigest`` and ``irDigest`` change whenever the toolchain bytes change, so they cannot prove
that the meaning survived.  This tool records what must not move instead: the semantic digest of every
package (the IR document minus ``profile``/``dialects``/``instance``/``sourceMap``), the result of the
canonical evaluator on its bindings, the diagnostics of the negative cases, the Engine mode
compatibility of every package, the re-evaluation and result-validation vectors and the protocol and
schema digests.  Whatever is expected to change with the toolchain lives under a ``toolchain`` key,
which :func:`comparable` removes.

It adapts ``tools/bim_baseline.py`` of OpenBinding and produces the same five documents
(``corpus``, ``negatives``, ``compat``, ``vectors``, ``protocol``) from ``bim_core`` alone.  Beyond them it
writes three documents that have no OpenBinding original (see ``docs/DIGESTS.md``):

* ``golden/bim_core/compat.json`` and ``golden/bim_core/protocol.json``: the same two documents computed
  with the four Engine manifests that exist in the repository.  The OpenBinding goldens also list
  ``meta-router-csp``, whose manifest is not in the repository, so those two cannot be reproduced
  byte for byte; every other byte is compared with the originals.
* ``golden/bim_core/evaluator_errors.json``: the binding negatives seen through ``bim_core.evaluator``,
  which raises ``EvaluationError`` where ``BindingProblem.validate_binding`` raises ``ValueError``.
* ``golden/vectors_extra.json``: adversarial re-evaluation and result-validation vectors.

The corpus is not part of this directory.  It is looked up under ``BIM_CORPUS_ROOT`` (default: the
directory that contains ``bim-toolchain/``).  Golden paths are relative to that root.  The Engine
manifests are test fixtures (``packages/bim-core/tests/fixtures/manifests``).

Compare against the goldens::

    python bim-toolchain/tools/baseline_core.py --check

Regenerate them (only when a change of meaning is intended and reviewed; ``compat.json`` and
``protocol.json`` of ``golden/bim_baseline`` are never rewritten)::

    python bim-toolchain/tools/baseline_core.py
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import itertools
import json
import math
import os
import random
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Any, Callable, Iterator

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_SRC = ROOT / "packages" / "bim-core" / "src"
if PACKAGE_SRC.is_dir():
    sys.path.insert(0, str(PACKAGE_SRC))

from bim_core import (  # noqa: E402
    BindingProblem,
    CompileError,
    EvaluationError,
    ExpressionError,
    InstancePackage,
    ProtocolError,
    compile_instance,
    compiler_bundle_digest,
    digest,
    digest_bytes,
    load_package,
    protocol_digest,
    protocol_document,
    reevaluate_result,
    validate_binding,
    validate_result,
)
from bim_core.assets import engine_contract_bytes, resource_root, schema_root  # noqa: E402
from bim_core.compat import mode_compatibility  # noqa: E402
from bim_core.compiler import (  # noqa: E402
    installed_dialect_manifests,
    installed_profile_manifests,
    manifest_reference,
)
from bim_core.expressions import compile_expression  # noqa: E402

SEED = 20261012
EXHAUSTIVE_LIMIT = 2000
SAMPLE_SIZE = 16
INLINE_LIMIT = 64
BLOCK_SIZE = 64
DIGEST_PREFIX = 16

GOLDEN_DIR = ROOT / "golden" / "bim_baseline"
CORE_GOLDEN_DIR = ROOT / "golden" / "bim_core"
EXTRA_VECTORS = ROOT / "golden" / "vectors_extra.json"
MANIFEST_DIR = ROOT / "packages" / "bim-core" / "tests" / "fixtures" / "manifests"
GOLDEN_FILES = ("corpus.json", "negatives.json", "vectors.json")
CORE_GOLDEN_FILES = ("compat.json", "protocol.json", "evaluator_errors.json")
#: Engines whose manifest is in the OpenBinding goldens but not in the repository.
MISSING_MANIFESTS = ("meta-router-csp",)
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


def engine_manifests(manifest_dir: Path = MANIFEST_DIR) -> dict[str, dict[str, Any]]:
    """The Engine manifests used as inputs (fixtures), by file stem."""
    if not manifest_dir.is_dir():
        raise FileNotFoundError(f"{manifest_dir} is missing: run the manifests bootstrap check first")
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(manifest_dir.glob("*.json"))
    }


def _compatibility_code(diagnostic: dict[str, Any]) -> str:
    parts = [diagnostic["code"], diagnostic.get("category") or diagnostic.get("limit") or ""]
    unsupported = diagnostic.get("unsupported")
    if unsupported:
        parts.append(",".join(unsupported))
    return ":".join(parts)


def compatibility(problem: BindingProblem, manifests: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """``mode_compatibility`` of one problem against every mode of every Engine manifest."""
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


def analyze_directory(directory: Path, corpus_root: Path) -> dict[str, Any]:
    """Compile one package once and return its corpus entry (path relative to ``corpus_root``)."""
    return analyze_package(directory, corpus_root, None)[0]


def analyze_package(
    directory: Path, corpus_root: Path, manifests: dict[str, dict[str, Any]] | None
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Compile one package once; return its corpus entry and, given Engine manifests, its compatibility entry."""
    relative = directory.relative_to(corpus_root).as_posix()
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
    return entry, None if manifests is None else compatibility(problem, manifests)


def build_corpus_and_compat(
    directories: list[Path],
    corpus_root: Path,
    jobs: int = 1,
    manifests: dict[str, dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The ``corpus.json`` and ``compat.json`` documents for ``directories`` (``manifests``: the Engine inputs)."""
    manifests = engine_manifests() if manifests is None else manifests
    if jobs <= 1:
        results = [analyze_package(directory, corpus_root, manifests) for directory in directories]
    else:
        with ProcessPoolExecutor(max_workers=jobs) as executor:
            results = list(
                executor.map(
                    analyze_package, directories, itertools.repeat(corpus_root), itertools.repeat(manifests)
                )
            )
    corpus = _corpus_document([entry for entry, _ in results])
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


def build_corpus(directories: list[Path], corpus_root: Path, jobs: int = 1) -> dict[str, Any]:
    """The ``corpus.json`` document for ``directories``."""
    if jobs <= 1:
        results = [analyze_directory(directory, corpus_root) for directory in directories]
    else:
        with ProcessPoolExecutor(max_workers=jobs) as executor:
            results = list(executor.map(analyze_directory, directories, itertools.repeat(corpus_root)))
    return _corpus_document(results)


def _corpus_document(entries: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": "bim-baseline/corpus/1",
        "seed": SEED,
        "exhaustiveLimit": EXHAUSTIVE_LIMIT,
        "sampleSize": SAMPLE_SIZE,
        "inlineLimit": INLINE_LIMIT,
        "blockSize": BLOCK_SIZE,
        "digestPrefix": DIGEST_PREFIX,
        "packageCount": len(entries),
        "packages": {entry["path"]: entry for entry in entries},
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


def build_evaluator_errors(corpus_root: Path) -> dict[str, Any]:
    """The binding negatives seen through ``bim_core.evaluator``: ``EvaluationError`` with a stable code."""
    problem = compile_instance(load_package(corpus_root / DEMO_RELATIVE))
    cases: dict[str, Any] = {}
    for name, binding in binding_cases().items():
        try:
            validate_binding(problem, binding)
        except EvaluationError as exc:
            cases[name] = {
                "outcome": type(exc).__name__,
                "code": exc.code,
                "message": str(exc),
                "isValueError": isinstance(exc, ValueError),
            }
        else:
            cases[name] = {"outcome": "ok"}
    return {
        "schema": "bim-core/evaluator-errors/1",
        "reason": (
            "bim_core.evaluator.validate_binding raises EvaluationError (a ValueError) where "
            "BindingProblem.validate_binding raises ValueError; golden/bim_baseline/negatives.json records "
            "the latter and is kept as it is. Messages are identical."
        ),
        "cases": cases,
    }


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


def _demo_binding(first: str, resource: str = "catalog") -> dict[str, Any]:
    return {
        "t1": {"resource": resource, "id": first},
        "t2": {"resource": "catalog", "id": "c2a"},
        "t3": {"resource": "catalog", "id": "c3a"},
    }


def vector_inputs(corpus_root: Path) -> list[dict[str, Any]]:
    """Synthetic Engine answers for the demo problem; ``allowed`` None means the default."""
    problem = compile_instance(load_package(corpus_root / DEMO_RELATIVE))
    best, other = _solution(problem, _demo_binding("c1a")), _solution(problem, _demo_binding("c1b"))
    wrong = copy.deepcopy(best)
    wrong["features"] = {"latency": 1.0}
    wrong["objectives"]["score"] = 0.0
    wrong["objectives"]["components"][0].update({"value": 1.0, "loss": 0.0})
    not_eligible = _solution(problem, _demo_binding("c1a"))
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


def _validation(payload: Any, **options: Any) -> dict[str, Any]:
    try:
        validate_result(copy.deepcopy(payload), **options)
    except ProtocolError as exc:
        return {"valid": False, "error": str(exc)}
    return {"valid": True}


def build_vectors(corpus_root: Path) -> dict[str, Any]:
    """Run ``reevaluate_result`` and ``validate_result`` on each synthetic answer."""
    problem = compile_instance(load_package(corpus_root / DEMO_RELATIVE))
    vectors = []
    for case in vector_inputs(corpus_root):
        result, allowed = case["result"], case["allowed"]
        arguments = (problem, copy.deepcopy(result), None) + (() if allowed is None else (allowed,))
        vectors.append({
            "id": case["id"],
            "input": {"result": stable(result), "allowedTerminations": allowed},
            "reevaluate": stable(reevaluate_result(*arguments)),
            "validate": _validation(result),
        })
    return {"schema": "bim-baseline/vectors/1", "problem": DEMO_RELATIVE.as_posix(), "vectors": vectors}


# --- adversarial vectors (no OpenBinding original) ---------------------------------------------

_NON_FINITE = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}


def encode_floats(value: Any) -> Any:
    """JSON has no NaN/Infinity: they are written as ``{"$float": "NaN"|"Infinity"|"-Infinity"}``."""
    if isinstance(value, float) and not math.isfinite(value):
        return {"$float": "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"}
    if isinstance(value, dict):
        return {key: encode_floats(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode_floats(child) for child in value]
    return value


def decode_floats(value: Any) -> Any:
    """The inverse of :func:`encode_floats`."""
    if isinstance(value, dict):
        if set(value) == {"$float"} and value["$float"] in _NON_FINITE:
            return _NON_FINITE[value["$float"]]
        return {key: decode_floats(child) for key, child in value.items()}
    if isinstance(value, list):
        return [decode_floats(child) for child in value]
    return value


def extra_vector_inputs(corpus_root: Path) -> list[dict[str, Any]]:
    """Hostile or sloppy Engine answers for the demo problem: what the platform must never believe."""
    problem = compile_instance(load_package(corpus_root / DEMO_RELATIVE))
    best = _solution(problem, _demo_binding("c1a"))
    other = _solution(problem, _demo_binding("c1b"))
    everything = ["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]

    def variant(base: dict[str, Any], change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        value = copy.deepcopy(base)
        change(value)
        return value

    def with_binding(change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        return variant(best, lambda solution: change(solution["decision"]["binding"]))

    def result(termination: Any, solutions: Any, **extra: Any) -> dict[str, Any]:
        return {"termination": termination, "solutions": solutions, **extra}

    def set_objective(key: str, value: Any) -> Callable[[dict[str, Any]], None]:
        return lambda solution: solution["objectives"].__setitem__(key, value)

    def set_component(key: str, value: Any) -> Callable[[dict[str, Any]], None]:
        return lambda solution: solution["objectives"]["components"][0].__setitem__(key, value)

    return [
        # The engine lies about the objective; the authoritative evaluation overrides every field.
        {"id": "objective_penalty_and_score_altered", "result": result("OPTIMAL", [variant(best, lambda s: s["objectives"].update({"penalty": 5.0, "score": -1.0}))]), "allowed": everything},
        {"id": "objective_component_weight_and_loss_altered", "result": result("OPTIMAL", [variant(best, lambda s: s["objectives"]["components"][0].update({"weight": 99.0, "loss": -1e9}))]), "allowed": everything},
        {"id": "objective_type_altered", "result": result("OPTIMAL", [variant(best, set_objective("type", "MANY"))]), "allowed": everything},
        {"id": "objective_scalarization_altered", "result": result("OPTIMAL", [variant(best, set_objective("scalarization", "pareto-front"))]), "allowed": everything},
        {"id": "features_altered", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("features", {"latency": 0.0}))]), "allowed": everything},
        {"id": "penalties_altered", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("penalties", [123.0]))]), "allowed": everything},
        {"id": "violations_hidden", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("violations", []))]), "allowed": everything},
        # The binding is outside the eligible space or malformed.
        {"id": "binding_unknown_candidate", "result": result("FEASIBLE", [with_binding(lambda b: b.__setitem__("t1", {"resource": "catalog", "id": "c9z"}))]), "allowed": everything},
        {"id": "binding_candidate_of_another_task", "result": result("FEASIBLE", [with_binding(lambda b: b.__setitem__("t3", {"resource": "catalog", "id": "c1a"}))]), "allowed": everything},
        {"id": "binding_missing_task", "result": result("FEASIBLE", [with_binding(lambda b: b.pop("t3"))]), "allowed": everything},
        {"id": "binding_extra_task", "result": result("FEASIBLE", [with_binding(lambda b: b.__setitem__("t4", {"resource": "catalog", "id": "c3a"}))]), "allowed": everything},
        {"id": "binding_empty", "result": result("FEASIBLE", [with_binding(lambda b: b.clear())]), "allowed": everything},
        {"id": "binding_value_extra_key", "result": result("FEASIBLE", [with_binding(lambda b: b["t1"].update({"extra": "x"}))]), "allowed": everything},
        {"id": "binding_value_not_an_object", "result": result("FEASIBLE", [with_binding(lambda b: b.__setitem__("t1", "c1a"))]), "allowed": everything},
        {"id": "binding_other_resource", "result": result("FEASIBLE", [with_binding(lambda b: b.__setitem__("t1", {"resource": "application", "id": "c1a"}))]), "allowed": everything},
        {"id": "valid_and_ineligible_in_one_answer", "result": result("FEASIBLE", [best, with_binding(lambda b: b.__setitem__("t1", {"resource": "catalog", "id": "c2a"}))]), "allowed": everything},
        {"id": "duplicate_solutions", "result": result("FEASIBLE", [best, copy.deepcopy(best)]), "allowed": everything},
        # Terminations that claim more than the solutions or the declared guarantees support.
        {"id": "unknown_with_valid_binding", "result": result("UNKNOWN", [best]), "allowed": None},
        {"id": "unknown_with_ineligible_binding", "result": result("UNKNOWN", [with_binding(lambda b: b.__setitem__("t1", {"resource": "catalog", "id": "c2a"}))]), "allowed": None},
        {"id": "infeasible_with_valid_binding_declared", "result": result("INFEASIBLE", [best]), "allowed": everything},
        {"id": "infeasible_with_valid_binding_default", "result": result("INFEASIBLE", [best]), "allowed": None},
        {"id": "infeasible_without_binding_default", "result": result("INFEASIBLE", []), "allowed": None},
        {"id": "optimal_with_default_guarantees", "result": result("OPTIMAL", [best]), "allowed": None},
        {"id": "feasible_when_only_unknown_is_declared", "result": result("FEASIBLE", [other]), "allowed": ["UNKNOWN"]},
        {"id": "termination_lowercase", "result": result("optimal", [best]), "allowed": everything},
        {"id": "termination_unhashable", "result": result(["OPTIMAL"], [best]), "allowed": everything},
        {"id": "termination_missing", "result": {"solutions": [best]}, "allowed": everything},
        {"id": "allowed_terminations_unhashable_and_unknown", "result": result("FEASIBLE", [best]), "allowed": [["FEASIBLE"], "FEASIBLE", "SOMETIMES"]},
        # Numbers that are not numbers, or not finite.
        {"id": "nan_feature", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("features", {"latency": math.nan}))]), "allowed": everything},
        {"id": "infinite_penalty", "result": result("OPTIMAL", [variant(best, set_objective("penalty", math.inf))]), "allowed": everything},
        {"id": "negative_infinite_penalty_entry", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("penalties", [-math.inf]))]), "allowed": everything},
        {"id": "nan_score", "result": result("OPTIMAL", [variant(best, set_objective("score", math.nan))]), "allowed": everything},
        {"id": "nan_component_loss", "result": result("OPTIMAL", [variant(best, set_component("loss", math.nan))]), "allowed": everything},
        {"id": "nan_in_provenance", "result": result("OPTIMAL", [best], provenance={"elapsed": math.nan}), "allowed": everything},
        {"id": "boolean_feature", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("features", {"latency": True}))]), "allowed": everything},
        {"id": "string_feature", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("features", {"latency": "1"}))]), "allowed": everything},
        {"id": "negative_penalty_entry", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("penalties", [-1.0]))]), "allowed": everything},
        {"id": "boolean_penalty_entry", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("penalties", [True]))]), "allowed": everything},
        # Keys the protocol does not define.
        {"id": "extra_key_in_result", "result": result("OPTIMAL", [best], elapsed=1.0), "allowed": everything},
        {"id": "extra_key_in_solution", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("rank", 1))]), "allowed": everything},
        {"id": "extra_key_in_decision", "result": result("OPTIMAL", [variant(best, lambda s: s["decision"].__setitem__("note", "x"))]), "allowed": everything},
        {"id": "extra_key_in_objectives", "result": result("OPTIMAL", [variant(best, set_objective("extra", 1))]), "allowed": everything},
        {"id": "extra_key_in_component", "result": result("OPTIMAL", [variant(best, set_component("extra", 1))]), "allowed": everything},
        {"id": "extra_key_in_violation", "result": result("OPTIMAL", [variant(best, lambda s: s.__setitem__("violations", [{"constraint": {"resource": "c", "id": "k"}, "enforcement": "hard", "penalty": 0, "extra": 1}]))]), "allowed": everything},
        {"id": "provenance_not_an_object", "result": result("OPTIMAL", [best], provenance="synthetic"), "allowed": everything},
        # Wrong shapes at the top.
        {"id": "solutions_not_an_array", "result": result("FEASIBLE", {"0": best}), "allowed": everything},
        {"id": "solution_not_an_object", "result": result("FEASIBLE", [1]), "allowed": everything},
        {"id": "decision_kind_not_binding", "result": result("FEASIBLE", [variant(best, lambda s: s["decision"].__setitem__("kind", "plan"))]), "allowed": everything},
        {"id": "result_is_a_list", "result": [best], "allowed": everything, "reevaluate": False},
    ]


def build_vectors_extra(corpus_root: Path) -> dict[str, Any]:
    """Run ``reevaluate_result`` and ``validate_result`` (default and ``finite=True``) on each hostile answer."""
    problem = compile_instance(load_package(corpus_root / DEMO_RELATIVE))
    vectors = []
    for case in extra_vector_inputs(corpus_root):
        payload, allowed = case["result"], case["allowed"]
        entry: dict[str, Any] = {
            "id": case["id"],
            "input": {"result": encode_floats(stable(payload)), "allowedTerminations": allowed},
            "validate": _validation(payload),
            "validateFinite": _validation(payload, finite=True),
        }
        if case.get("reevaluate", True):
            arguments = (problem, copy.deepcopy(payload), None) + (() if allowed is None else (allowed,))
            entry["reevaluate"] = encode_floats(stable(reevaluate_result(*arguments)))
        vectors.append(entry)
    return {
        "schema": "bim-core/vectors-extra/1",
        "problem": DEMO_RELATIVE.as_posix(),
        "note": "NaN and Infinity are written as {\"$float\": ...}; see tools/baseline_core.py:encode_floats",
        "vectors": vectors,
    }


# --- protocol --------------------------------------------------------------------------------


def _resource_files(node: Traversable, prefix: str = "") -> Iterator[tuple[str, bytes]]:
    for child in sorted(node.iterdir(), key=lambda item: item.name):
        if child.is_dir():
            if child.name != "__pycache__":
                yield from _resource_files(child, f"{prefix}{child.name}/")
        else:
            yield f"{prefix}{child.name}", child.read_bytes()


def build_protocol(manifests: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    manifests = engine_manifests() if manifests is None else manifests
    return {
        "schema": "bim-baseline/protocol/1",
        "protocolDigest": protocol_digest(),
        "engineContract": {
            "openapiBytes": digest_bytes(engine_contract_bytes()),
            "openapiDocument": digest(protocol_document()),
        },
        "schemas": {
            item.name: digest_bytes(item.read_bytes())
            for item in sorted(schema_root().iterdir(), key=lambda entry: entry.name)
            if item.name.endswith(".schema.json")
        },
        "manifests": {name: digest(manifest) for name, manifest in manifests.items()},
        "vendor": {
            name: digest_bytes(data) for name, data in _resource_files(resource_root().joinpath("vendor"))
        },
        "toolchain": {
            "compilerDigest": compiler_bundle_digest(),
            "profiles": sorted(manifest_reference(item)["digest"] for item in installed_profile_manifests()),
            "dialects": sorted(manifest_reference(item)["digest"] for item in installed_dialect_manifests()),
        },
    }


# --- command line ----------------------------------------------------------------------------


def without_engines(document: Any, names: tuple[str, ...] = MISSING_MANIFESTS) -> Any:
    """``document`` of ``compat``/``protocol`` without the Engines whose manifest is not in the repository."""
    if not isinstance(document, dict):
        return document
    result = copy.deepcopy(document)
    for section in ("engines", "manifests"):
        for name in names:
            result.get(section, {}).pop(name, None)
    for entry in result.get("packages", {}).values():
        for name in names:
            entry.pop(name, None)
    return result


def _golden(directory: Path, name: str) -> Any:
    return json.loads((directory / name).read_text(encoding="utf-8"))


_MISSING = object()


def _parts(document: Any) -> dict[str, Any]:
    """The comparable content of a golden split into the units a difference is reported by."""
    parts: dict[str, Any] = {}
    for key, value in comparable(document).items():
        if key in ("packages", "cases") and isinstance(value, dict):
            parts.update({f"{key}/{name}": child for name, child in value.items()})
        elif key == "vectors" and isinstance(value, list):
            parts.update({f"vectors/{item['id']}": item for item in value})
        else:
            parts[key] = value
    return parts


def differences(label: str, found: Any, expected: Any) -> list[str]:
    """Names of the units of ``found`` whose comparable content differs from ``expected``."""
    left, right = _parts(found), _parts(expected)
    return [
        f"{label} {name}"
        for name in sorted(set(left) | set(right))
        if left.get(name, _MISSING) != right.get(name, _MISSING)
    ]


def build_all(
    corpus_root: Path,
    directories: list[Path],
    jobs: int = 1,
    manifests: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Every document this tool produces, by file name, computed with ``bim_core`` only."""
    manifests = engine_manifests() if manifests is None else manifests
    corpus, compat = build_corpus_and_compat(directories, corpus_root, jobs, manifests)
    return {
        "corpus.json": corpus,
        "negatives.json": build_negatives(corpus_root),
        "vectors.json": build_vectors(corpus_root),
        "compat.json": compat,
        "protocol.json": build_protocol(manifests),
        "evaluator_errors.json": build_evaluator_errors(corpus_root),
        "vectors_extra.json": build_vectors_extra(corpus_root),
    }


def mismatches(documents: dict[str, Any], golden_dir: Path) -> list[str]:
    """What differs between ``documents`` (see :func:`build_all`) and the goldens.

    ``corpus``, ``negatives`` and ``vectors`` are compared with the OpenBinding goldens in ``golden_dir``;
    so are ``compat`` and ``protocol`` once the Engines whose manifest is not in the repository are
    removed from the originals; the documents that have no original are compared with their own goldens.
    """
    core_dir = golden_dir.parent / CORE_GOLDEN_DIR.name
    found: list[str] = []
    for name in GOLDEN_FILES:
        found.extend(differences(name, documents[name], _golden(golden_dir, name)))
    for name in ("compat.json", "protocol.json"):
        found.extend(differences(f"{name} (openbinding)", documents[name], without_engines(_golden(golden_dir, name))))
    for name in CORE_GOLDEN_FILES:
        found.extend(differences(f"bim_core/{name}", documents[name], _golden(core_dir, name)))
    found.extend(
        differences("vectors_extra.json", documents["vectors_extra.json"], _golden(golden_dir.parent, EXTRA_VECTORS.name))
    )
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compute the semantic BIM baseline with bim_core only")
    parser.add_argument("--corpus-root", type=Path, default=default_corpus_root())
    parser.add_argument("--output", type=Path, default=GOLDEN_DIR, help="directory of the OpenBinding goldens")
    parser.add_argument("--manifests", type=Path, default=MANIFEST_DIR, help="directory with the Engine manifests")
    parser.add_argument("--expected", type=int, default=82)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--check", action="store_true", help="compare with the goldens instead of writing")
    args = parser.parse_args(argv)

    corpus_root = args.corpus_root
    if not corpus_available(corpus_root):
        print(f"corpus not found under {corpus_root}; set BIM_CORPUS_ROOT or --corpus-root", file=sys.stderr)
        return 2
    directories = package_directories(corpus_root)
    documents = build_all(corpus_root, directories, args.jobs, engine_manifests(args.manifests))
    corpus = documents["corpus.json"]
    failures = {path: entry["error"] for path, entry in corpus["packages"].items() if entry["status"] != "compiled"}
    if len(directories) != args.expected:
        failures["corpus"] = f"expected {args.expected} packages, found {len(directories)}"
    if failures:
        for path, error in sorted(failures.items()):
            print(f"{path}: {error}", file=sys.stderr)
        return 1

    if args.check:
        found = mismatches(documents, args.output)
        for item in found:
            print(f"differs: {item}", file=sys.stderr)
        print(f"BIM baseline check: {len(directories)} packages, {len(found)} differences")
        return 1 if found else 0

    targets = {name: args.output / name for name in GOLDEN_FILES}
    targets.update({name: args.output.parent / CORE_GOLDEN_DIR.name / name for name in CORE_GOLDEN_FILES})
    targets["vectors_extra.json"] = args.output.parent / EXTRA_VECTORS.name
    for name, path in targets.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        data = dump(documents[name])
        path.write_bytes(data)
        print(f"{path.relative_to(args.output.parent)}: {len(data)} bytes sha256={hashlib.sha256(data).hexdigest()}")
    print(f"BIM baseline: {len(directories)} packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
