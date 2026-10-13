"""A BIM package compiled from its directory and from its ZIP, on synthetic packages (no corpus needed).

The 82-package corpus lives in OpenBinding (``openbinding-gateway/tests/test_bim_zip_dir_equivalence.py`` runs the
same comparison there).  This module exercises the same equivalence with small packages written by
``synthetic_packages.py``, so that the CI of this repository checks it without the corpus.  It never skips.

For each variant the package is packed as a directory, as a raw ZIP (the bytes as written, entries in any order)
and as the canonical ZIP of ``InstancePackage.to_zip()``, and five things are compared: (a) the semantic digest,
(b) the canonical IR, (c) ``irDigest``, (d) ``packageDigest`` and (e) the order of the eligibility lists.

The finding (``docs/DIGESTS.md``, "Directory, raw ZIP and canonical ZIP"): neither the enumeration order of the file
system nor the order of the ZIP entries matters, but the canonical form sorts the members of every JSON object and
the compiler builds the eligibility, constraint and placement lists by iterating objects in document order.  A package
that declares them out of alphabetical order therefore has another IR in canonical form.  Changing that is a MAJOR
change of the digest contract (it moves the semantic digest recorded in the goldens), so the canonical-ZIP comparison
of the unordered variants is a strict ``xfail`` carrying the cause.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Any

import pytest
from synthetic_packages import AFFECTED_SECTIONS, VARIANTS, files, write

from bim_core import canonical_json, compile_instance, digest, load_package

NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
METRICS = ("semantic", "ir", "irDigest", "packageDigest", "eligibility")
ORDERED_SECTIONS = frozenset({"spec.eligibility", "spec.constraints", "spec.placement"})
NAMES = sorted(VARIANTS)
UNORDERED = [name for name in NAMES if name != "ordered"]
CAUSE = (
    "to_zip() writes JSON with sorted object members (bim_core/package.py: _canonical_resource_bytes, to_zip) and the "
    "compiler builds eligibility, constraints and placement by iterating objects in document order "
    "(bim_core/compiler.py: _normalize_candidates, _constraints, _placement); a canonical order moves the golden "
    "semantic digest (MAJOR by docs/DIGESTS.md), so it is not applied"
)


def raw_zip(contents: dict[str, bytes], *, reverse: bool = False) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(contents, reverse=reverse):
            archive.writestr(name, contents[name])
    return output.getvalue()


def observe(package: Any) -> dict[str, Any]:
    problem = compile_instance(package)
    document = problem.document
    spec = document["spec"]
    return {
        "semantic": digest({key: value for key, value in spec.items() if key not in NON_SEMANTIC}),
        "ir": canonical_json(document),
        "irDigest": problem.digest,
        "packageDigest": package.package_digest,
        "eligibility": spec["eligibility"],
        "document": document,
    }


def differing(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    return [metric for metric in METRICS if left[metric] != right[metric]]


def sections_differing(left: dict[str, Any], right: dict[str, Any]) -> set[str]:
    result = {
        key
        for key in set(left) | set(right)
        if key != "spec" and canonical_json(left.get(key)) != canonical_json(right.get(key))
    }
    for name in set(left["spec"]) | set(right["spec"]):
        if canonical_json(left["spec"].get(name)) != canonical_json(right["spec"].get(name)):
            result.add(f"spec.{name}")
    return result


def unordered(value: Any) -> Any:
    """``value`` with every list replaced by the sorted canonical forms of its items (order forgotten)."""
    if isinstance(value, dict):
        return {key: unordered(child) for key, child in value.items()}
    if isinstance(value, list):
        return sorted(canonical_json(unordered(child)).decode("utf-8") for child in value)
    return value


@pytest.fixture(scope="module")
def built(tmp_path_factory) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name in NAMES:
        package = load_package(write(tmp_path_factory.mktemp(name), name))
        result[name] = {
            "package": package,
            "observed": observe(package),
            "canonical": observe(load_package(package.to_zip())),
        }
    return result


# --- what does not matter ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", NAMES)
def test_a_raw_zip_in_any_entry_order_is_the_directory(built, name: str) -> None:
    """The ZIP of the bytes as written, with its entries in either order, is the directory in all five respects."""
    contents = files(name)
    for reverse in (False, True):
        other = observe(load_package(raw_zip(contents, reverse=reverse)))
        assert differing(built[name]["observed"], other) == [], f"reverse={reverse}"


@pytest.mark.parametrize("name", NAMES)
def test_the_creation_order_of_the_files_does_not_matter(built, name: str, tmp_path: Path) -> None:
    """A directory whose files were created in the opposite order may enumerate differently; it compiles the same."""
    other = write(tmp_path / "reversed", name, reverse_creation=True)
    assert differing(built[name]["observed"], observe(load_package(other))) == []


@pytest.mark.parametrize("name", NAMES)
def test_the_package_digest_is_the_digest_of_the_canonical_form_of_every_input(built, name: str) -> None:
    package = built[name]["package"]
    canonical = package.to_zip()
    assert load_package(canonical).to_zip() == canonical  # a fixed point
    assert load_package(raw_zip(files(name))).package_digest == package.package_digest
    assert built[name]["canonical"]["packageDigest"] == built[name]["observed"]["packageDigest"]


# --- what does ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        pytest.param(
            name,
            marks=pytest.mark.xfail(strict=True, raises=AssertionError, reason=CAUSE) if name != "ordered" else (),
        )
        for name in NAMES
    ],
)
def test_the_canonical_zip_is_the_directory(built, name: str) -> None:
    """(a) semantic digest, (b) IR, (c) ``irDigest``, (d) ``packageDigest`` and (e) eligibility order."""
    assert differing(built[name]["observed"], built[name]["canonical"]) == []


@pytest.mark.parametrize("name", UNORDERED)
def test_what_differs_is_the_semantic_digest_the_ir_and_the_ir_digest_but_not_the_package_digest(built, name: str) -> None:
    assert set(differing(built[name]["observed"], built[name]["canonical"])) >= {"semantic", "ir", "irDigest"}
    assert "packageDigest" not in differing(built[name]["observed"], built[name]["canonical"])


@pytest.mark.parametrize("name", NAMES)
def test_the_canonical_zip_differs_only_in_the_sections_whose_object_order_was_changed(built, name: str) -> None:
    left, right = built[name]["observed"]["document"], built[name]["canonical"]["document"]
    sections = sections_differing(left, right)
    assert sections - {"spec.sourceMap"} == AFFECTED_SECTIONS[name]
    # Same members: with the order of those lists forgotten, the canonical IR is the directory's IR.
    for section in sections & ORDERED_SECTIONS:
        key = section.removeprefix("spec.")
        assert unordered(left["spec"][key]) == unordered(right["spec"][key])


@pytest.mark.parametrize("name", ["unordered-catalogs", "unordered-candidates"])
def test_the_canonical_eligibility_lists_are_the_sorted_ones(built, name: str) -> None:
    before, after = built[name]["observed"]["eligibility"], built[name]["canonical"]["eligibility"]
    assert sorted(before) == sorted(after)
    for task, references in before.items():
        assert references != after[task]
        assert sorted(map(str, references)) == sorted(map(str, after[task]))
        assert after[task] == sorted(references, key=lambda ref: (ref["resource"], ref["id"]))
