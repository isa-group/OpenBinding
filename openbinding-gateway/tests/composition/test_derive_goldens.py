"""The document a binding of a compiled problem derives to, byte for byte.

Each problem is compiled by the gateway's in-process port, its first eligible binding is
evaluated by the same port, and :func:`derive.derived` builds the document from the result.
``golden/derived/<name>.yaml`` holds the canonical bytes, with ``{compilation}`` and
``{toolchain}`` standing for what the installed toolchain gives, so the goldens outlive a
toolchain release that compiles the same problems alike.

A derived document is one its own language accepts: it reads back with no diagnostic at all,
judges clean against the problem it came from, and building it twice gives the same bytes.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path as FilePath
from typing import Any

import pytest

from _paths import TESTS_DIR
from _repo import REPO_ROOT
from openbinding_gateway.composition import derive, text
from openbinding_gateway.composition.document import Document, Evidence, ProblemRef
from openbinding_gateway.composition.problem import ProblemFacts, against, computed_values, value_findings
from openbinding_gateway.composition.workflow import Exclusive, walk
from openbinding_gateway.integrations import bim, packages

GOLDEN = TESTS_DIR / "composition" / "golden" / "derived"
EXAMPLES = REPO_ROOT / "examples"

#: Golden name -> (package directory, the composition's slug).
CASES = {
    "01_simple_seq": (EXAMPLES / "demo" / "01_simple_seq", "simple-seq"),
    "16_json_complete": (EXAMPLES / "demo" / "16_json_complete", "json-complete"),
    "13_fms": (EXAMPLES / "demo" / "13_fms", "fms"),
    "01_small_placement": (EXAMPLES / "placement" / "01_small_placement", "small-placement"),
}


@cache
def _port():
    return bim.build_bim()


def _files(directory: FilePath) -> dict[str, bytes]:
    return {
        path.relative_to(directory).as_posix(): path.read_bytes()
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


@cache
def _compiled_package(package: bytes) -> dict[str, Any]:
    return _port().compile(package)


def _derive(package: bytes, slug: str) -> tuple[Document, dict[str, Any], ProblemFacts]:
    """The derived document of the first eligible binding, the compilation and its facts."""
    compiled = _compiled_package(package)
    ir = compiled["ir"]
    facts = ProblemFacts.from_ir(ir, compiled.get("sourceMap"))
    spec = ir["spec"]
    binding = {task: dict(spec["eligibility"][task][0]) for task in sorted(facts.service_tasks)}
    features = _port().evaluate(ir, binding)["features"]
    toolchain = compiled["toolchain"]
    document = derive.derived(
        slug=slug,
        label="1.0.0",
        kind="application",
        problem_ref=ProblemRef("isa", slug, "1"),
        compilation_digest=compiled["compilationDigest"],
        facts=facts,
        bim_binding=binding,
        features=features,
        evidence=Evidence(manual=True, evaluated_by="gateway", toolchain=f"{toolchain['name']} {toolchain['version']}"),
    )
    return document, compiled, facts


def _derive_example(name: str) -> tuple[Document, dict[str, Any], ProblemFacts]:
    directory, slug = CASES[name]
    return _derive(packages.zip_directory(directory), slug)


def _expected(name: str, compiled: dict[str, Any]) -> str:
    toolchain = compiled["toolchain"]
    return (
        (GOLDEN / f"{name}.yaml").read_text(encoding="utf-8")
        .replace("{compilation}", compiled["compilationDigest"])
        .replace("{toolchain}", f"{toolchain['name']} {toolchain['version']}")
    )


def test_every_golden_has_its_case() -> None:
    # ``<name>.run.yaml`` is the same binding derived from a run through the API (test_composition_derive_api).
    derived = [path for path in GOLDEN.glob("*.yaml") if not path.name.endswith(".run.yaml")]
    assert sorted(path.stem for path in derived) == sorted(CASES)


@pytest.mark.parametrize("name", sorted(CASES))
def test_a_derived_document_writes_its_golden_bytes(name: str) -> None:
    document, compiled, _ = _derive_example(name)
    assert text.serialise(document) == _expected(name, compiled)


@pytest.mark.parametrize("name", sorted(CASES))
def test_a_derived_document_reads_back_clean_and_builds_the_same_bytes_twice(name: str) -> None:
    document, compiled, facts = _derive_example(name)
    content = text.serialise(document)
    reading = text.read(content)
    assert reading.diagnostics == ()
    assert reading.document == document
    again, _, _ = _derive_example(name)
    assert text.serialise(again) == content
    # What derive writes, its own checks against the problem accept.
    resolution = against(reading.document, facts)
    assert resolution.blocking == () and resolution.pending == ()
    computed = computed_values(_port().evaluate(compiled["ir"], resolution.bim_binding)["features"], facts)
    assert value_findings(reading.document, computed) == ()


def test_what_each_golden_shows() -> None:
    assert "    uniform: true\n" in _expected("01_small_placement", _derive_example("01_small_placement")[1])
    assert "  node_classic_routing:\n    local: true\n" in _expected("13_fms", _derive_example("13_fms")[1])
    json_complete = _expected("16_json_complete", _derive_example("16_json_complete")[1])
    assert "probability: 0.65\n" in json_complete and "probability: 0.35\n" in json_complete


def _application_variant(change) -> bytes:
    """``16_json_complete`` with its application and routing edited by ``change``."""
    files = _files(CASES["16_json_complete"][0])
    application = json.loads(files["application.json"])
    routing = json.loads(files["routing.json"])
    change(application, routing)
    files["application.json"] = json.dumps(application).encode("utf-8")
    files["routing.json"] = json.dumps(routing).encode("utf-8")
    return packages.zip_files(files)


def _exclusive(application: dict[str, Any]) -> list[dict[str, Any]]:
    workflow = application["spec"]["workflow"]
    return workflow["sequence"][1]["sequence"][0]["parallel"][0]["sequence"][1]["sequence"][0]["exclusive"]


def _exclusives(document: Document) -> list[Exclusive]:
    return [node for _, node in walk(document.workflow) if isinstance(node, Exclusive)]


def test_a_three_way_uniform_choice_derives_to_uniform_without_probabilities() -> None:
    def three_way(application: dict[str, Any], routing: dict[str, Any]) -> None:
        _exclusive(application).append({"id": "Flow_Skip", "flow": {"empty": True}})
        routing["spec"] = {"uniform": True}

    document, _, _ = _derive(_application_variant(three_way), "three-way")
    (choice,) = _exclusives(document)
    assert choice.uniform and [branch.probability for branch in choice.branches] == [None, None, None]
    content = text.serialise(document)
    assert "uniform: true" in content and "probability" not in content
    assert text.read(content).diagnostics == ()


def test_a_zero_branch_and_a_long_unit_with_spaces_derive_unchanged() -> None:
    unit = ("euro cents per run " * 11)[:199] + "x"

    def edges(application: dict[str, Any], routing: dict[str, Any]) -> None:
        routing["spec"]["entries"][0]["probability"] = 0
        routing["spec"]["entries"][1]["probability"] = 1
        application["spec"]["features"]["cost"]["unit"] = unit

    document, _, _ = _derive(_application_variant(edges), "edges")
    (choice,) = _exclusives(document)
    assert not choice.uniform and [branch.probability for branch in choice.branches] == [0, 1]
    assert len(unit) == 200 and document.value("cost").unit == unit
    content = text.serialise(document)
    assert "probability: 0.0\n" in content and f"unit: {unit}\n" in content
    reading = text.read(content)
    assert reading.diagnostics == () and reading.document.value("cost").unit == unit
