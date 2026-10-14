"""A BIM package compiled from its directory and from its ZIP, on synthetic packages (no corpus needed).

The 82-package corpus is compared in ``test_zip_dir_equivalence_corpus.py``.  This module exercises the same equivalence
with small packages written by ``synthetic_packages.py``, so that the CI of this repository checks it without the corpus.
It never skips.

For each variant the package is packed as a directory, as a raw ZIP (the bytes as written, entries in any order), as the
canonical ZIP of ``InstancePackage.to_zip()`` and with the members of its JSON objects shuffled, and five things are
compared: (a) the semantic digest, (b) the canonical IR, (c) ``irDigest``, (d) ``packageDigest`` and (e) the order of the
eligibility lists.  All of them are equal.

History (``docs/qa/IR_NORMALIZATION.md``): the canonical form sorts the members of every JSON object and the compiler used
to build the eligibility, constraint and placement lists by iterating objects in document order, so a package that
declared them out of alphabetical order had another IR in canonical form.  The compiler now lists those sets in one
canonical order, whatever the order of the JSON members, and the four ``unordered-*`` variants, which used to be strict
``xfail``, are ordinary tests.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Any

import pytest
from synthetic_packages import VARIANTS, files, write

from bim_core import canonical_json, compile_instance, digest, load_package

NON_SEMANTIC = frozenset({"profile", "dialects", "instance", "sourceMap"})
METRICS = ("semantic", "ir", "irDigest", "packageDigest", "eligibility")
NAMES = sorted(VARIANTS)


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


@pytest.fixture(scope="module")
def built(tmp_path_factory, baseline_tool) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name in NAMES:
        package = load_package(write(tmp_path_factory.mktemp(name), name))
        result[name] = {
            "package": package,
            "observed": observe(package),
            "canonical": observe(load_package(package.to_zip())),
            "permuted": [
                observe(load_package(raw_zip(baseline_tool.permute_members(package.files, seed))))
                for seed in baseline_tool.PERMUTATION_SEEDS
            ],
        }
    return result


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


@pytest.mark.parametrize("name", NAMES)
def test_the_canonical_zip_is_the_directory(built, name: str) -> None:
    """(a) semantic digest, (b) IR, (c) ``irDigest``, (d) ``packageDigest`` and (e) eligibility order.

    Was a strict ``xfail`` for the four ``unordered-*`` variants."""
    assert differing(built[name]["observed"], built[name]["canonical"]) == []


@pytest.mark.parametrize("name", NAMES)
def test_shuffling_the_members_of_the_json_objects_changes_nothing(built, name: str) -> None:
    for other in built[name]["permuted"]:
        assert differing(built[name]["observed"], other) == []


def test_the_order_in_which_a_package_declares_its_objects_has_no_effect_on_the_ir(built) -> None:
    """The five variants are one problem written five ways: one IR, byte for byte."""
    assert len({built[name]["observed"]["ir"] for name in NAMES}) == 1
    assert len({built[name]["observed"]["irDigest"] for name in NAMES}) == 1


@pytest.mark.parametrize("name", NAMES)
def test_the_sets_of_the_ir_are_in_the_canonical_order(built, name: str) -> None:
    """Eligibility by (catalog id, candidate id), constraints by ref; the source map follows the constraints."""
    document = built[name]["observed"]["document"]
    spec = document["spec"]
    for task, references in spec["eligibility"].items():
        assert references == sorted(references, key=lambda ref: (ref["resource"], ref["id"])), task
        assert len(references) == 4
    refs = [(item["ref"]["resource"], item["ref"]["id"]) for item in spec["constraints"]]
    assert refs == sorted(refs) and len(refs) == 3
    for index, (resource, constraint_id) in enumerate(refs):
        location = spec["sourceMap"][f"/spec/constraints/{index}"]
        assert (location["resource"], location["pointer"]) == (resource, f"/spec/constraints/{constraint_id}")
        assert spec["sourceMap"][f"/spec/constraints/{index}/assert"]["pointer"].endswith(f"{constraint_id}/assert")


@pytest.mark.parametrize("name", NAMES)
def test_every_binding_evaluates_identically_in_every_form(built, name: str, baseline_tool) -> None:
    """Same bindings, same evaluation including the order and the text of the violations."""
    reference = compile_instance(built[name]["package"])
    forms = [compile_instance(load_package(built[name]["package"].to_zip()))] + [
        compile_instance(load_package(raw_zip(baseline_tool.permute_members(built[name]["package"].files, seed))))
        for seed in baseline_tool.PERMUTATION_SEEDS
    ]
    bindings = baseline_tool.identifier_bindings(reference.document["spec"], name)
    assert len(bindings) == 16
    for form in forms:
        for binding in bindings:
            assert baseline_tool.evaluate_binding(form, binding) == baseline_tool.evaluate_binding(reference, binding)
