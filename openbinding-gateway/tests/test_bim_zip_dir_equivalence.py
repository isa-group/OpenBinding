"""A BIM package compiled from its directory and from its ZIP: the 82 packages of the corpus.

The goldens of ``tests/golden/bim_baseline`` are generated from directories, while the platform compiles ZIP
archives.  For every package this module packs the directory in four ways and compares what the toolchain
says about each: (a) the semantic digest, (b) the canonical IR, (c) ``irDigest``, (d) ``packageDigest`` and
(e) the order of the eligibility lists.

* ``directory``: ``load_package(directory)``.
* ``gateway-zip``: ``integrations.packages.zip_directory``, the archive the platform builds (raw bytes).
* ``reversed-zip``: the same raw bytes, entries written in reverse order (no medium-dependent order).
* ``canonical-zip``: ``InstancePackage.to_zip()``, the portable form (JSON in RFC 8785 form, keys sorted).

Measured cause (``docs/qa/BIM_EQUIVALENCE.md``): neither the enumeration order of the file system nor the order
of the ZIP entries matters.  ``to_zip()`` sorts the members of every JSON object, and the compiler builds
several IR lists by iterating objects in document order (eligible candidates, constraints, placement demands),
so a package that declares its members out of alphabetical order has another IR (another ``irDigest`` and
semantic digest) once it is in canonical form.  ``packageDigest`` is not affected: it is the digest of the
canonical form for every input.

The divergence is **not fixed**: a canonical order would change the semantic digest, and the enumeration order of
the evaluations, that ``golden/bim_baseline`` records for the 64 packages in ``KNOWN_DIVERGENT`` (stop rule, see
the document).  Their canonical-ZIP test is a strict ``xfail``: it fails the day the code changes, so the change
cannot go unnoticed.  Setting ``BIM_ZIP_DIR_REPORT=<file>`` writes the measurements as JSON.

The corpus is required.  Without it the module fails; it is skipped only with ``BIM_ZIP_DIR_ALLOW_NO_CORPUS=1``.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import zipfile
from pathlib import Path
from typing import Any

import pytest

from _repo import REPO_ROOT
from bim_core import canonical_json, compile_instance, digest, load_package
from openbinding_gateway.integrations import packages

GOLDEN = json.loads(
    (Path(__file__).resolve().parent / "golden" / "bim_baseline" / "corpus.json").read_text(encoding="utf-8")
)
PATHS = sorted(GOLDEN["packages"])
EXPECTED_PACKAGES = 82
ALLOW_NO_CORPUS = os.environ.get("BIM_ZIP_DIR_ALLOW_NO_CORPUS") == "1"
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
METRICS = ("semantic", "ir", "irDigest", "packageDigest", "eligibility")
#: Sections of the IR that list things in the order the package declares them.
ORDERED_SECTIONS = frozenset({"spec.eligibility", "spec.constraints", "spec.placement"})
#: Provenance: its keys embed the position of the list items above.
PROVENANCE_SECTIONS = frozenset({"spec.sourceMap"})

ICWS_FAMILIES = (
    "benatallah2002-selfserv-travel-solution-cts-itas",
    "bultan2003-warehouse-example",
    "cremaschi2018-textbook-access",
    "netedu2020-transport-agency",
    "pautasso2009-restful-ecommerce",
    "zhang2014-entertainment-planner-running-example",
)
ICWS_VARIANTS = tuple(
    f"{objective}_{kind}" for objective in ("many", "mono_one", "mono_utility", "multi") for kind in ("hard", "soft")
)

#: Packages whose canonical-ZIP IR differs from the IR of their directory (measured on 2026-10-13, 64 of 82).
KNOWN_DIVERGENT: frozenset[str] = frozenset(
    [
        f"examples/demo/{name}"
        for name in (
            "05_multi_obj", "05_single_obj_various", "13_fms", "14_shared_candidates", "15_bpmn_complete",
            "16_json_complete", "17_analysis_tradeoffs", "18_analysis_constraints", "19_analysis_journey",
        )  # fmt: skip
    ]
    + [f"examples/placement/{name}" for name in ("01_small_placement", "02_stock_market_sample", "03_cloud_only", "04_edge_heavy")]
    + ["engines/minizinc-csp/tests/fixtures/placement", "examples/literature/pautasso", "examples/literature/zhang"]
    + [f"experimentation/icws/instances/{family}_{variant}" for family in ICWS_FAMILIES for variant in ICWS_VARIANTS]
)

#: Of those, the ones whose sampled evaluation (16 seeded draws) changes its summary: the draw picks other bindings.
SAMPLED_SUMMARY_MOVES: frozenset[str] = frozenset(
    ["examples/placement/02_stock_market_sample"]
    + [
        f"experimentation/icws/instances/{family}_{variant}"
        for family in ICWS_FAMILIES
        if family.startswith(("benatallah", "cremaschi", "netedu", "zhang"))
        for variant in ICWS_VARIANTS
    ]
)
#: The only divergent package whose evaluation digests (in enumeration order) do not move.
ROLLUP_UNCHANGED = frozenset({"examples/literature/zhang"})

CAUSE = (
    "to_zip() writes JSON with sorted object members (bim_core/package.py:77-80, 347-350) and the compiler builds "
    "eligibility, constraints and placement by iterating objects in document order (bim_core/compiler.py:1476-1487, "
    "2048-2149, 2798-2800, 2971-2993); a canonical order moves the golden semantic digest, so it is not applied "
    "(docs/qa/BIM_EQUIVALENCE.md)"
)


# --- the corpus is required ------------------------------------------------------------------------------------------


def package_directory(relative: str) -> Path:
    directory = REPO_ROOT / relative
    if not (directory / "instance.json").is_file():
        message = f"BIM corpus package {relative} is not under {REPO_ROOT}; set BIM_ZIP_DIR_ALLOW_NO_CORPUS=1 to skip"
        if ALLOW_NO_CORPUS:
            pytest.skip(message)
        pytest.fail(message)
    return directory


def baseline_tool() -> Any:
    path = REPO_ROOT / "bim-toolchain" / "tools" / "baseline_core.py"
    if not path.is_file():
        message = f"{path} is missing; set BIM_ZIP_DIR_ALLOW_NO_CORPUS=1 to skip"
        if ALLOW_NO_CORPUS:
            pytest.skip(message)
        pytest.fail(message)
    spec = importlib.util.spec_from_file_location("baseline_core_zip_dir", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- packing and observing -------------------------------------------------------------------------------------------


def reversed_zip(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(files, reverse=True):
            archive.writestr(path, files[path])
    return output.getvalue()


def semantic_of(document: dict[str, Any]) -> str:
    return digest({key: value for key, value in document["spec"].items() if key not in NON_SEMANTIC})


def observe(package: Any) -> dict[str, Any]:
    problem = compile_instance(package)
    document = problem.document
    return {
        "semantic": semantic_of(document),
        "ir": canonical_json(document),
        "irDigest": problem.digest,
        "packageDigest": package.package_digest,
        "eligibility": document["spec"]["eligibility"],
        "document": document,
    }


def differing(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    return [metric for metric in METRICS if left[metric] != right[metric]]


def unordered(value: Any) -> Any:
    """``value`` with every list replaced by the sorted canonical forms of its items (order forgotten)."""
    if isinstance(value, dict):
        return {key: unordered(child) for key, child in value.items()}
    if isinstance(value, list):
        return sorted(canonical_json(unordered(child)).decode("utf-8") for child in value)
    return value


def first_difference(left: Any, right: Any, pointer: str = "") -> str | None:
    """JSON pointer of the first member where two documents differ (lists element by element)."""
    if type(left) is not type(right):
        return pointer or "/"
    if isinstance(left, dict):
        if set(left) != set(right):
            return f"{pointer}/{{{','.join(sorted(set(left) ^ set(right)))}}}"
        for key in sorted(left):
            found = first_difference(left[key], right[key], f"{pointer}/{key}")
            if found is not None:
                return found
        return None
    if isinstance(left, list):
        if len(left) != len(right):
            return f"{pointer}[length {len(left)} != {len(right)}]"
        for index, (before, after) in enumerate(zip(left, right)):
            found = first_difference(before, after, f"{pointer}[{index}]")
            if found is not None:
                return found
        return None
    return None if left == right else pointer


def differing_sections(left: dict[str, Any], right: dict[str, Any]) -> dict[str, str | None]:
    """Sections of two IR documents whose canonical form differs, with the first differing pointer."""
    result: dict[str, str | None] = {}
    for key in sorted(set(left) | set(right)):
        if key == "spec":
            for name in sorted(set(left[key]) | set(right[key])):
                before, after = left[key].get(name), right[key].get(name)
                if canonical_json(before) != canonical_json(after):
                    result[f"spec.{name}"] = first_difference(before, after)
        elif canonical_json(left.get(key)) != canonical_json(right.get(key)):
            result[key] = first_difference(left.get(key), right.get(key))
    return result


def section(document: dict[str, Any], name: str) -> Any:
    return document["spec"].get(name.removeprefix("spec."))


_REPORT: dict[str, dict[str, Any]] = {}


def compare(relative: str) -> dict[str, Any]:
    """Pack ``relative`` four ways, compile each and say what differs from the directory (cached)."""
    if relative in _REPORT:
        return _REPORT[relative]
    directory = package_directory(relative)
    files = packages.directory_files(directory)
    reference_package = load_package(directory)
    reference = observe(reference_package)
    forms = {
        "gateway-zip": load_package(packages.zip_directory(directory)),
        "reversed-zip": load_package(reversed_zip(files)),
        "canonical-zip": load_package(reference_package.to_zip()),
    }
    seen = {name: observe(package) for name, package in forms.items()}
    canonical = seen["canonical-zip"]
    sections = differing_sections(reference["document"], canonical["document"])
    golden_semantic = GOLDEN["packages"][relative]["semanticDigest"]
    result = {
        "kept": {name: differing(reference, seen[name]) for name in ("gateway-zip", "reversed-zip")},
        "canonical": differing(reference, canonical),
        "packageDigests": sorted({reference["packageDigest"], *(item["packageDigest"] for item in seen.values())}),
        "sections": sorted(sections),
        "firstDifference": sections,
        "orderOnly": all(
            unordered(section(reference["document"], name)) == unordered(section(canonical["document"], name))
            for name in sections
            if name in ORDERED_SECTIONS
        ),
        "directoryMatchesGolden": reference["semantic"] == golden_semantic,
        "canonicalMovesGolden": canonical["semantic"] != golden_semantic,
        "irDigest": {"directory": reference["irDigest"], "canonical-zip": canonical["irDigest"]},
        "semantic": {"directory": reference["semantic"], "canonical-zip": canonical["semantic"]},
    }
    _REPORT[relative] = result
    return result


_EVALUATION: dict[str, dict[str, Any]] = {}


def evaluation_of_canonical_zip(relative: str) -> dict[str, Any]:
    """The baseline evaluation of the canonical ZIP of ``relative`` against the golden evaluation."""
    if relative not in _EVALUATION:
        tool = baseline_tool()
        problem = compile_instance(load_package(load_package(package_directory(relative)).to_zip()))
        found = tool.evaluate_package(problem)
        golden = GOLDEN["packages"][relative]["evaluation"]
        order_keys = ("bindingDigests", "blockDigests")
        _EVALUATION[relative] = {
            "mode": found["mode"],
            "count": found["count"],
            "rollupSame": found["rollupDigest"] == golden["rollupDigest"],
            "orderDigestsSame": {key: found.get(key) for key in order_keys} == {key: golden.get(key) for key in order_keys},
            "summaryDiffers": sorted(key for key in found["summary"] if found["summary"][key] != golden["summary"].get(key)),
        }
    return _EVALUATION[relative]


def summary(relative: str) -> str:
    found = compare(relative)
    return f"{relative}[{','.join(found['sections'])}; orderOnly={found['orderOnly']}]"


# --- tests -----------------------------------------------------------------------------------------------------------


def test_the_corpus_is_the_82_packages_of_the_baseline() -> None:
    assert len(PATHS) == EXPECTED_PACKAGES
    assert KNOWN_DIVERGENT <= set(PATHS) and len(KNOWN_DIVERGENT) == 64
    for relative in PATHS:
        package_directory(relative)


@pytest.mark.parametrize("relative", PATHS)
def test_a_zip_that_keeps_the_declared_representation_is_the_directory(relative: str) -> None:
    """The archive the platform builds, and the same archive with its entries in reverse order, compile to the
    same semantic digest, IR, ``irDigest``, ``packageDigest`` and eligibility order as the directory."""
    assert compare(relative)["kept"] == {"gateway-zip": [], "reversed-zip": []}


@pytest.mark.parametrize("relative", PATHS)
def test_the_package_digest_does_not_depend_on_the_form(relative: str) -> None:
    assert len(compare(relative)["packageDigests"]) == 1


@pytest.mark.parametrize(
    "relative",
    [
        pytest.param(
            relative,
            id=relative,
            marks=pytest.mark.xfail(strict=True, raises=AssertionError, reason=CAUSE) if relative in KNOWN_DIVERGENT else (),
        )
        for relative in PATHS
    ],
)
def test_the_canonical_zip_is_the_directory(relative: str) -> None:
    """(a) semantic digest, (b) IR, (c) ``irDigest``, (d) ``packageDigest`` and (e) eligibility order."""
    assert compare(relative)["canonical"] == []


@pytest.mark.parametrize("relative", PATHS)
def test_the_canonical_zip_differs_only_in_the_order_of_lists_built_from_objects(relative: str) -> None:
    """Nothing but the order of the eligibility, constraints and placement lists (and the provenance that indexes
    them) differs: with the order forgotten, those sections are equal."""
    found = compare(relative)
    assert set(found["sections"]) <= ORDERED_SECTIONS | PROVENANCE_SECTIONS, found["firstDifference"]
    assert found["orderOnly"], found["firstDifference"]


def test_the_divergent_packages_are_exactly_the_known_ones() -> None:
    measured = sorted(relative for relative in PATHS if compare(relative)["canonical"])
    report = os.environ.get("BIM_ZIP_DIR_REPORT")
    if report:
        Path(report).write_text(json.dumps(_REPORT, indent=1, sort_keys=True), encoding="utf-8")
    assert measured == sorted(KNOWN_DIVERGENT), (
        f"{len(measured)} of {len(PATHS)} divergent: " + " | ".join(summary(relative) for relative in measured)
    )


def test_a_canonical_order_would_move_the_golden_of_exactly_the_divergent_packages() -> None:
    """The stop rule: the IR of the canonical ZIP is the IR a canonical order would give the directory; its semantic
    digest is not the one the goldens record for these packages (and equals it for the other 18)."""
    assert all(compare(relative)["directoryMatchesGolden"] for relative in PATHS)
    moved = sorted(relative for relative in PATHS if compare(relative)["canonicalMovesGolden"])
    assert moved == sorted(KNOWN_DIVERGENT), f"{len(moved)} would move: {moved}"


def test_the_evaluation_of_a_divergent_package_moves_only_as_measured() -> None:
    """Exhaustive evaluations keep every summary (the same bindings are evaluated, in another order, so the digests
    in enumeration order move); sampled ones draw other bindings, so 33 of them change their summary."""
    summary_moves: set[str] = set()
    rollup_same: set[str] = set()
    for relative in sorted(KNOWN_DIVERGENT):
        found = evaluation_of_canonical_zip(relative)
        if found["summaryDiffers"]:
            summary_moves.add(relative)
        if found["rollupSame"]:
            rollup_same.add(relative)
        if found["mode"] == "exhaustive":
            assert found["summaryDiffers"] == [], relative
    assert summary_moves == set(SAMPLED_SUMMARY_MOVES) and len(summary_moves) == 33
    assert rollup_same == set(ROLLUP_UNCHANGED)
