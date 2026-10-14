"""Directory, raw ZIP, canonical ZIP and permuted members of the 82 corpus packages, measured by ``bim_core`` alone.

The same comparison as ``openbinding-gateway/tests/test_bim_zip_dir_equivalence.py`` (another owner), kept here so the
behaviour of ``bim_core`` is pinned by its own tests.

* directory: ``load_package(directory)``.
* raw ZIP: the files of the loaded package in a STORED archive sorted by path (as ``zip_directory`` of the gateway builds
  it) and in reverse order.
* canonical ZIP: ``InstancePackage.to_zip()`` (JSON members sorted).
* permuted: the files with the members of every JSON object shuffled, for each of two seeds.

All of them have the directory's ``irDigest``, ``packageDigest``, canonical IR, semantic digest and list order (82/82), and
evaluate the same bindings to the same evaluations, including the order and the text of the violations.  Until the IR was
normalised (``docs/qa/IR_NORMALIZATION.md``) 64 of the 82 differed from the directory in the canonical ZIP: those cases
were strict ``xfail``.

``data/zip_divergent_packages.json`` keeps the names of those 64 packages. The gate test requires the packages whose
semantic digest is not the one ``golden/bim_baseline`` (the previous toolchain) records to be exactly that set.

Each package is compiled once per form and only a small summary is kept, so the 82 IRs are never held at the same time.
The corpus is looked up as in the other tests (``BIM_CORPUS_ROOT``): the tests skip with the reason when it is
absent and fail with ``BIM_REQUIRE_CORPUS=1``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from core_support import GOLDEN_DIR, corpus_root, require_corpus_path

from bim_core import canonical_json, compile_instance, digest, digest_bytes, load_package

DATA_FILE = Path(__file__).resolve().parent / "data" / "zip_divergent_packages.json"
FROZEN = json.loads((GOLDEN_DIR / "corpus.json").read_text(encoding="utf-8"))["packages"]
PATHS = sorted(FROZEN)
MOVED = frozenset(json.loads(DATA_FILE.read_text(encoding="utf-8"))["packages"])
EXPECTED_PACKAGES = 82
EXPECTED_MOVED = 64
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
METRICS = ("semantic", "ir", "irDigest", "packageDigest", "eligibility")
FORMS = ("raw", "reversed", "canonical", "permuted-1", "permuted-2")


def observe(package: Any) -> tuple[dict[str, Any], Any]:
    """What the toolchain says about ``package``, and the compiled problem."""
    problem = compile_instance(package)
    document = problem.document
    return {
        "semantic": digest({key: value for key, value in document["spec"].items() if key not in NON_SEMANTIC}),
        "ir": digest_bytes(canonical_json(document)),
        "irDigest": problem.digest,
        "packageDigest": package.package_digest,
        "eligibility": digest(document["spec"]["eligibility"]),
    }, problem


def order_problems(document: dict[str, Any]) -> list[str]:
    """Where the IR does not list a set in the canonical order, or a source map index points at another member."""
    found: list[str] = []
    spec = document["spec"]
    source_map = spec["sourceMap"]
    for task, references in spec["eligibility"].items():
        keys = [(ref["resource"], ref["id"]) for ref in references]
        if keys != sorted(keys):
            found.append(f"eligibility/{task}")
    constraints = [(item["ref"]["resource"], item["ref"]["id"]) for item in spec["constraints"]]
    if constraints != sorted(constraints):
        found.append("constraints")
    for index, (resource, constraint_id) in enumerate(constraints):
        location = source_map.get(f"/spec/constraints/{index}", {})
        if (location.get("resource"), location.get("pointer")) != (resource, f"/spec/constraints/{constraint_id}"):
            found.append(f"sourceMap/constraints/{index}")
    models = spec["placement"]
    if [model["resource"] for model in models] != sorted(model["resource"] for model in models):
        found.append("placement")
    for index, model in enumerate(models):
        demands = [(item["candidate"]["resource"], item["candidate"]["id"]) for item in model["demands"]]
        transitions = [(item["ref"]["resource"], item["ref"]["id"]) for item in model["transitions"]]
        if demands != sorted(demands):
            found.append(f"placement/{index}/demands")
        if transitions != sorted(transitions):
            found.append(f"placement/{index}/transitions")
        for pool in model["pools"]:
            if source_map.get(f"/spec/placement/{index}/pools/{pool}", {}).get("resource") != model["resource"]:
                found.append(f"sourceMap/placement/{index}/pools/{pool}")
    indexed = {int(key.split("/")[3]) for key in source_map if key.startswith("/spec/placement/")}
    if indexed and max(indexed) >= len(models):
        found.append("sourceMap/placement/extra")
    return found


_CACHE: dict[str, dict[str, Any]] = {}


def analysis(relative: str, baseline_tool) -> dict[str, Any]:
    """Every form of ``relative`` against its directory: metrics, evaluations and canonical order (cached, small)."""
    if relative not in _CACHE:
        package = load_package(require_corpus_path(relative))
        stored = baseline_tool.stored_zip
        sources = {
            "raw": stored(package.files),
            "reversed": stored(package.files, reverse=True),
            "canonical": package.to_zip(),
            **{f"permuted-{seed}": stored(baseline_tool.permute_members(package.files, seed)) for seed in baseline_tool.PERMUTATION_SEEDS},
        }
        reference, problem = observe(package)
        bindings = baseline_tool.identifier_bindings(problem.document["spec"], relative)
        expected = [baseline_tool.evaluate_binding(problem, binding) for binding in bindings]
        metrics: dict[str, list[str]] = {}
        evaluation: list[str] = []
        for name, data in sources.items():
            other, other_problem = observe(load_package(data))
            differences = [metric for metric in METRICS if reference[metric] != other[metric]]
            if differences:
                metrics[name] = differences
            if [baseline_tool.evaluate_binding(other_problem, binding) for binding in bindings] != expected:
                evaluation.append(name)
        entry = FROZEN[relative]
        sections = {
            key: baseline_tool._short(digest(value))
            for key, value in problem.document["spec"].items()
            if key not in NON_SEMANTIC
        }
        _CACHE[relative] = {
            "metrics": metrics,
            "evaluation": evaluation,
            "order": order_problems(problem.document),
            "bindings": len(bindings),
            "moved": (
                sorted(key for key in sections if sections[key] != entry["sectionDigests"].get(key))
                if baseline_tool.semantic_digest(problem) != entry["semanticDigest"]
                else None
            ),
        }
    return _CACHE[relative]


def test_the_corpus_is_the_82_packages_of_the_baseline() -> None:
    assert len(PATHS) == EXPECTED_PACKAGES
    assert MOVED <= set(PATHS) and len(MOVED) == EXPECTED_MOVED


def test_the_discovered_packages_are_the_keys_of_corpus_json(baseline_tool) -> None:
    require_corpus_path(PATHS[0])
    root = corpus_root()
    discovered = [directory.relative_to(root).as_posix() for directory in baseline_tool.package_directories(root)]
    assert discovered == PATHS


@pytest.mark.parametrize("relative", PATHS)
def test_every_form_of_a_package_is_the_directory(baseline_tool, relative: str) -> None:
    """irDigest, packageDigest, canonical IR, semantic digest and eligibility order are those of the directory.

    The canonical ZIP of 64 packages was a strict ``xfail`` before the normalisation; permuted members are new."""
    assert analysis(relative, baseline_tool)["metrics"] == {}


@pytest.mark.parametrize("relative", PATHS)
def test_every_form_of_a_package_evaluates_the_same_bindings_identically(baseline_tool, relative: str) -> None:
    """Exact equality of the evaluation of bindings chosen by identifier: values, order and text of the violations.

    Includes the message of a transition violation, which printed ``6.0`` from a directory and ``6`` from the
    canonical form before integral numbers were read as integers."""
    found = analysis(relative, baseline_tool)
    assert found["bindings"] > 0
    assert found["evaluation"] == []


@pytest.mark.parametrize("relative", PATHS)
def test_the_ir_of_a_package_lists_its_sets_in_the_canonical_order(baseline_tool, relative: str) -> None:
    """Eligibility by (catalog id, candidate id); constraints by ref; placement by resource id, demands by candidate and
    transitions by ref; every ``sourceMap`` index points at the member it indexes."""
    assert analysis(relative, baseline_tool)["order"] == []


def test_the_packages_that_moved_are_exactly_the_recorded_ones(baseline_tool) -> None:
    """Gate: the semantic digest of a package is the frozen baseline's unless the package is one of the 64 recorded.

    ``golden/bim_baseline`` is the previous toolchain (document order). A package whose sets were already in
    canonical order keeps every digest; the 64 others change in ``eligibility``, ``constraints`` and ``placement``
    only. The set is not self-healing: if the compiler changes it, this test fails and the file is reviewed."""
    moved = {relative: found["moved"] for relative in PATHS if (found := analysis(relative, baseline_tool))["moved"] is not None}
    assert sorted(moved) == sorted(MOVED), (
        f"{len(moved)} moved, {len(MOVED)} recorded; new: {sorted(set(moved) - MOVED)}; "
        f"unchanged now: {sorted(MOVED - set(moved))}"
    )
    assert {section for sections in moved.values() for section in sections} <= {"eligibility", "constraints", "placement"}
