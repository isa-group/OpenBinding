"""A BIM package compiled from its directory and from its ZIP: the 82 packages of the corpus.

The goldens of ``tests/golden/bim_baseline`` are generated from directories, while the platform compiles ZIP
archives.  For every package this module packs the directory in four ways and compares what the toolchain
says about each: (a) the semantic digest, (b) the canonical IR, (c) ``irDigest``, (d) ``packageDigest`` and
(e) the order of the eligibility lists.

* ``directory``: ``load_package(directory)``.
* ``gateway-zip``: ``integrations.packages.zip_directory``, the archive the platform builds (raw bytes).
* ``reversed-zip``: the same raw bytes, entries written in reverse order (no medium-dependent order).
* ``canonical-zip``: ``InstancePackage.to_zip()``, the portable form (JSON in RFC 8785 form, keys sorted).

Since ``bim-core`` 0.2.0 (``docs/qa/IR_NORMALIZATION.md``) the compiler lists the
sets of the IR (eligible candidates, constraints, placement, demands, transitions) in one order that depends only
on identifiers, so the four forms compile to the same IR in all 82 packages.  Before, ``to_zip()`` sorted the
members of every JSON object while the compiler iterated them in document order, and 64 packages had another IR
(another ``irDigest`` and semantic digest) once in canonical form.

The golden of the gateway is now the corpus golden of the normalized toolchain
(``bim-toolchain/golden/bim_normalized/corpus.json``).  What moved from the previous baseline is compared by
identifier: ``bim-toolchain/golden/bim_baseline`` (frozen) and ``bim-toolchain/golden/ir_previous/evidence.json``
(the evaluations of the previous toolchain, bindings chosen by identifier) are the fixtures.

The corpus is required.  Without it the module fails; it is skipped only with ``BIM_ZIP_DIR_ALLOW_NO_CORPUS=1``.
Setting ``BIM_ZIP_DIR_REPORT=<file>`` writes the measurements as JSON.
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
EXPECTED_MOVED = 64
ALLOW_NO_CORPUS = os.environ.get("BIM_ZIP_DIR_ALLOW_NO_CORPUS") == "1"
NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
METRICS = ("semantic", "ir", "irDigest", "packageDigest", "eligibility")

TOOLCHAIN = REPO_ROOT / "bim-toolchain"
FROZEN_BASELINE = TOOLCHAIN / "golden" / "bim_baseline" / "corpus.json"
PREVIOUS_EVIDENCE = TOOLCHAIN / "golden" / "ir_previous" / "evidence.json"
MOVED_PACKAGES = TOOLCHAIN / "packages" / "bim-core" / "tests" / "data" / "zip_divergent_packages.json"

#: The one divergent-then package whose digests, enumeration order included, did not move with the normalization.
ROLLUP_UNCHANGED = frozenset({"examples/literature/zhang"})


# --- the corpus is required ------------------------------------------------------------------------------------------


def package_directory(relative: str) -> Path:
    directory = REPO_ROOT / relative
    if not (directory / "instance.json").is_file():
        message = f"BIM corpus package {relative} is not under {REPO_ROOT}; set BIM_ZIP_DIR_ALLOW_NO_CORPUS=1 to skip"
        if ALLOW_NO_CORPUS:
            pytest.skip(message)
        pytest.fail(message)
    return directory


def toolchain_file(path: Path) -> Path:
    if not path.is_file():
        message = f"{path} is missing; set BIM_ZIP_DIR_ALLOW_NO_CORPUS=1 to skip"
        if ALLOW_NO_CORPUS:
            pytest.skip(message)
        pytest.fail(message)
    return path


_TOOL: list[Any] = []


def baseline_tool() -> Any:
    if not _TOOL:
        path = toolchain_file(TOOLCHAIN / "tools" / "baseline_core.py")
        spec = importlib.util.spec_from_file_location("baseline_core_zip_dir", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _TOOL.append(module)
    return _TOOL[0]


def read_json(path: Path) -> Any:
    return json.loads(toolchain_file(path).read_text(encoding="utf-8"))


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
        for index, (before, after) in enumerate(zip(left, right, strict=False)):
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
        "directoryMatchesGolden": reference["semantic"] == golden_semantic,
        "canonicalMatchesGolden": canonical["semantic"] == golden_semantic,
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
        _EVALUATION[relative] = {"same": found == golden, "mode": found["mode"], "count": found["count"]}
    return _EVALUATION[relative]


def moved_packages() -> list[str]:
    """The packages whose semantic digest the normalization moved (data kept by the toolchain's tests)."""
    return sorted(read_json(MOVED_PACKAGES)["packages"])


# --- tests -----------------------------------------------------------------------------------------------------------


def test_the_corpus_is_the_82_packages_of_the_baseline() -> None:
    assert len(PATHS) == EXPECTED_PACKAGES
    moved = moved_packages()
    assert set(moved) <= set(PATHS) and len(moved) == EXPECTED_MOVED
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


@pytest.mark.parametrize("relative", PATHS)
def test_the_canonical_zip_is_the_directory(relative: str) -> None:
    """(a) semantic digest, (b) IR, (c) ``irDigest``, (d) ``packageDigest`` and (e) eligibility order."""
    found = compare(relative)
    assert found["canonical"] == [], found["firstDifference"]
    assert found["sections"] == []


def test_no_package_is_divergent() -> None:
    measured = sorted(relative for relative in PATHS if compare(relative)["canonical"])
    report = os.environ.get("BIM_ZIP_DIR_REPORT")
    if report:
        Path(report).write_text(json.dumps(_REPORT, indent=1, sort_keys=True), encoding="utf-8")
    assert measured == [], (
        f"{len(measured)} of {len(PATHS)} divergent: "
        + " | ".join(f"{relative}{compare(relative)['sections']}" for relative in measured)
    )


def test_the_directory_and_the_canonical_zip_have_the_semantic_digest_of_the_golden() -> None:
    """The golden of the gateway is the corpus golden of the normalized toolchain: every form reproduces it."""
    assert [relative for relative in PATHS if not compare(relative)["directoryMatchesGolden"]] == []
    assert [relative for relative in PATHS if not compare(relative)["canonicalMatchesGolden"]] == []


def test_the_golden_moved_from_the_previous_baseline_exactly_in_the_packages_with_a_reordered_set() -> None:
    """Against the frozen baseline (IR lists in document order): the 18 packages whose sets were already in canonical
    order keep their entry, evaluation digests included; the 64 others change their semantic digest, in the
    ``eligibility``, ``constraints`` and ``placement`` sections only, and keep the shape of the binding space."""
    frozen = read_json(FROZEN_BASELINE)["packages"]
    moved = set(moved_packages())
    changed_digest = {
        relative for relative in PATHS if GOLDEN["packages"][relative]["semanticDigest"] != frozen[relative]["semanticDigest"]
    }
    assert changed_digest == moved
    for relative in PATHS:
        old, new = frozen[relative], GOLDEN["packages"][relative]
        for key in ("path", "status", "candidates", "tasks", "bindingSpace"):
            assert new[key] == old[key], (relative, key)
        for key in ("mode", "count", "seed"):
            assert new["evaluation"].get(key) == old["evaluation"].get(key), (relative, key)
        if relative in moved:
            sections = {key for key in new["sectionDigests"] if new["sectionDigests"][key] != old["sectionDigests"][key]}
            assert sections and sections <= {"eligibility", "constraints", "placement"}, relative
        else:
            assert {k: v for k, v in new.items() if k != "toolchain"} == {k: v for k, v in old.items() if k != "toolchain"}


def test_the_evaluations_of_the_moved_packages_move_only_as_measured() -> None:
    """Exhaustive evaluations keep every summary (the same bindings are evaluated, in another order, so the digests
    in enumeration order move); the sampled ones draw from the canonical lists, so 33 of the 50 change their summary."""
    frozen = read_json(FROZEN_BASELINE)["packages"]
    moved = moved_packages()
    exhaustive = [name for name in moved if frozen[name]["evaluation"]["mode"] == "exhaustive"]
    sampled = [name for name in moved if frozen[name]["evaluation"]["mode"] == "sample"]
    assert (len(exhaustive), len(sampled)) == (14, 50)
    assert all(
        GOLDEN["packages"][name]["evaluation"]["summary"] == frozen[name]["evaluation"]["summary"] for name in exhaustive
    )
    assert {name for name in exhaustive if GOLDEN["packages"][name]["evaluation"] == frozen[name]["evaluation"]} == set(
        ROLLUP_UNCHANGED
    )
    summaries_moved = [
        name for name in sampled if GOLDEN["packages"][name]["evaluation"]["summary"] != frozen[name]["evaluation"]["summary"]
    ]
    assert len(summaries_moved) == 33


@pytest.mark.parametrize("relative", PATHS)
def test_a_package_evaluates_by_identifier_as_the_previous_baseline_did(relative: str) -> None:
    """Same members in every set of the IR, same bindings (chosen by identifier), same evaluations (violations as a
    set, messages with ``6.0`` read as ``6``) as the evidence the previous toolchain left."""
    tool = baseline_tool()
    previous = read_json(PREVIOUS_EVIDENCE)["packages"][relative]
    found = tool.package_evidence(compile_instance(load_package(package_directory(relative))), relative)

    assert found["membersDigest"] == previous["membersDigest"], "a set of the IR has other members"
    assert found["bindings"] == previous["bindings"]


def test_the_evaluation_of_the_canonical_zip_is_the_golden_evaluation() -> None:
    """Every binding the baseline evaluates (all of them, or the seeded draws of the canonical lists) has the same
    evaluation digests, in enumeration order, from the canonical ZIP as from the directory the golden records."""
    different = [relative for relative in PATHS if not evaluation_of_canonical_zip(relative)["same"]]
    assert different == []
