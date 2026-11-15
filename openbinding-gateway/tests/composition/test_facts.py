"""The facts of a compiled problem: one projection for the graph, the matrix and the editors.

The problems are compiled by the gateway's in-process port, so the projection is tested on the
toolchain's real IRs while the library imports nothing of the toolchain. The central property:
the workflow of the facts is, byte for byte, the ``workflow:`` of the document derived from the
same compilation, for every package of the corpus with a derivable binding.
"""

from __future__ import annotations

import copy
import importlib.util
import json
from functools import cache
from pathlib import Path
from typing import Any

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition import derive, text
from openbinding_gateway.composition.document import Evidence, ProblemRef
from openbinding_gateway.composition.facts import facts_view
from openbinding_gateway.composition.problem import ProblemFacts, ProblemFactsError
from openbinding_gateway.integrations import bim, packages

DEMO = REPO_ROOT / "examples" / "demo"
SIMPLE = DEMO / "01_simple_seq"
FMS = DEMO / "13_fms"
JSON = DEMO / "16_json_complete"
SOFT = DEMO / "07_soft_constraints"


@cache
def _port():
    return bim.build_bim()


@cache
def _compiled(directory: Path) -> dict[str, Any]:
    return _port().compile(packages.zip_directory(directory))


def _facts(directory: Path, ir: dict[str, Any] | None = None) -> dict[str, Any]:
    compiled = _compiled(directory)
    ir = compiled["ir"] if ir is None else ir
    return facts_view(ir, compiled.get("sourceMap"), {"bindingSpace": "2"}, ir_digest=compiled["irDigest"])


def _corpus() -> list[Path]:
    spec = importlib.util.spec_from_file_location("check_bim_corpus_facts", REPO_ROOT / "tools" / "check_bim_corpus.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return [
        directory
        for directory in module.package_directories()
        if not any(part.startswith(".") for part in directory.relative_to(REPO_ROOT).parts)
    ]


def _derived_workflow(compiled: dict[str, Any]) -> Any:
    """The ``workflow:`` of the document derived from the first eligible binding, read back from its bytes."""
    ir = compiled["ir"]
    facts = ProblemFacts.from_ir(ir, compiled.get("sourceMap"))
    binding = {task: dict(ir["spec"]["eligibility"][task][0]) for task in sorted(facts.service_tasks)}
    features = _port().evaluate(ir, binding)["features"]
    document = derive.derived(
        slug="facts", label="1.0.0", kind="application", problem_ref=ProblemRef("isa", "facts", "1"),
        compilation_digest=compiled["compilationDigest"], facts=facts, bim_binding=binding, features=features,
        evidence=Evidence(manual=True, evaluated_by="gateway", toolchain="bim-toolchain"),
    )
    return text.document(text.read(text.serialise(document)).document)["workflow"]


def test_task_kinds_follow_the_workflow_and_local_tasks_take_no_candidate() -> None:
    facts = _facts(FMS)
    assert [(task["id"], task["kind"]) for task in facts["tasks"]] == [
        ("T1", "service"), ("T2", "service"), ("T3", "service"),
        ("node_classic_routing", "local"), ("T5", "service"), ("T6", "service"),
    ]
    local = next(task for task in facts["tasks"] if task["id"] == "node_classic_routing")
    assert local["eligible"] == []
    t1 = next(task for task in facts["tasks"] if task["id"] == "T1")
    assert t1["eligible"] == [
        {"candidate": "catalog/cand_t1_aws", "written": "cand_t1_aws"},
        {"candidate": "catalog/cand_t1_google_cloud", "written": "cand_t1_google_cloud"},
    ]


def test_an_id_two_catalogs_give_a_task_is_written_with_its_catalog() -> None:
    ir = copy.deepcopy(_compiled(SIMPLE)["ir"])
    spec = ir["spec"]
    spec["candidates"]["other"] = copy.deepcopy(spec["candidates"]["catalog"])
    spec["eligibility"]["t1"].append({"resource": "other", "id": "c1a"})
    facts = _facts(SIMPLE, ir)
    t1 = next(task for task in facts["tasks"] if task["id"] == "t1")
    assert t1["eligible"] == [
        {"candidate": "catalog/c1a", "written": "catalog/c1a"},
        {"candidate": "catalog/c1b", "written": "c1b"},
        {"candidate": "other/c1a", "written": "other/c1a"},
    ]
    t2 = next(task for task in facts["tasks"] if task["id"] == "t2")
    assert t2["eligible"] == [{"candidate": "catalog/c2a", "written": "c2a"}]
    # Every candidate of every catalog, by key, with nothing written for the copy's source map.
    assert [candidate["key"] for candidate in facts["candidates"]] == [
        "catalog/c1a", "catalog/c1b", "catalog/c2a", "catalog/c3a",
        "other/c1a", "other/c1b", "other/c2a", "other/c3a",
    ]
    other = next(candidate for candidate in facts["candidates"] if candidate["key"] == "other/c1a")
    assert (other["resource"], other["id"], other["values"], other["origins"]) == ("other", "c1a", {"latency": 10}, {})


def test_values_units_directions_providers_and_required_features() -> None:
    facts = _facts(FMS)
    features = {feature["id"]: feature for feature in facts["features"]}
    assert features["cost"] == {"id": "cost", "unit": "USD/month", "direction": "min", "required": True}
    assert features["availability"]["direction"] == "max"
    aws = next(candidate for candidate in facts["candidates"] if candidate["key"] == "catalog/cand_t1_aws")
    assert aws["provider"] == "amazon"
    assert aws["values"] == {"cost": 220, "execution_time": 210, "availability": 0.9995, "reliability": 0.9975, "security": 5}
    # A catalog without providers gives none.
    assert all(candidate["provider"] is None for candidate in _facts(SIMPLE)["candidates"])


def test_a_range_value_and_a_feature_without_direction_are_read_as_written() -> None:
    ir = copy.deepcopy(_compiled(SIMPLE)["ir"])
    catalog = ir["spec"]["candidates"]["catalog"]["candidates"]
    catalog["c1a"]["features"]["latency"] = {"min": 5, "max": None}
    feature = ir["spec"]["application"]["features"]["latency"]
    del feature["direction"]
    ir["spec"]["application"]["features"]["weight"] = {"type": "number", "unit": "kg"}
    facts = _facts(SIMPLE, ir)
    c1a = next(candidate for candidate in facts["candidates"] if candidate["key"] == "catalog/c1a")
    assert c1a["values"] == {"latency": {"min": 5, "max": None}}
    assert facts["features"] == [
        {"id": "latency", "unit": "ms", "direction": None, "required": True},
        {"id": "weight", "unit": "kg", "direction": None, "required": False},
    ]


def test_a_value_is_keyed_by_the_feature_its_catalog_binds_it_to() -> None:
    ir = copy.deepcopy(_compiled(SIMPLE)["ir"])
    catalog = ir["spec"]["candidates"]["catalog"]
    catalog["featureBindings"] = {"lat": {"resource": "application", "id": "latency"}}
    for candidate in catalog["candidates"].values():
        candidate["features"] = {"lat": candidate["features"]["latency"]}
    facts = _facts(SIMPLE, ir)
    c1a = next(candidate for candidate in facts["candidates"] if candidate["key"] == "catalog/c1a")
    assert c1a["values"] == {"latency": 10}
    assert c1a["origins"]["latency"]["pointer"] == "/spec/candidates/c1a/features/lat"


def test_origins_point_at_entries_of_the_source_map() -> None:
    for directory in (SIMPLE, FMS, JSON):
        compiled = _compiled(directory)
        source_map = compiled["sourceMap"]
        files = {entry["path"] for entry in source_map.values()}
        facts = _facts(directory)
        for candidate in facts["candidates"]:
            entry = source_map[f"/spec/candidates/{candidate['resource']}/{candidate['id']}"]
            assert set(candidate["origins"]) == set(candidate["values"])
            for feature, origin in candidate["origins"].items():
                assert origin["kind"] == "package" and origin["resource"] == entry["resource"]
                assert origin["path"] == entry["path"] and origin["path"] in files
                assert origin["pointer"].startswith(entry["pointer"] + "/features/")
                written = json.loads((directory / origin["path"]).read_text(encoding="utf-8"))
                assert _pointed(written, origin["pointer"]) == candidate["values"][feature]


def _pointed(document: Any, pointer: str) -> Any:
    for token in pointer.split("/")[1:]:
        document = document[token.replace("~1", "/").replace("~0", "~")]
    return document


def test_constraint_expressions_and_objectives_are_the_irs() -> None:
    compiled = _compiled(JSON)
    spec = compiled["ir"]["spec"]
    facts = _facts(JSON)
    assert [item["id"] for item in facts["constraints"]] == [
        f"{item['ref']['resource']}/{item['ref']['id']}" for item in spec["constraints"]
    ]
    for item, constraint in zip(facts["constraints"], spec["constraints"], strict=True):
        assert item["expression"] == constraint["assert"]
        assert item["when"] == constraint["when"]
        assert item["enforcement"] == constraint["enforcement"]
        origin = item["origin"]
        assert origin is not None and (JSON / origin["path"]).is_file()
    assert facts["objectives"] == {"criteria": spec["optimization"]["criteria"], "penalties": spec["optimization"]["penalties"]}
    soft = _facts(SOFT)
    (constraint,) = soft["constraints"]
    assert constraint["enforcement"] == "soft" and constraint["penalty"] == {"kind": "literal", "value": 1}
    assert soft["objectives"]["penalties"] == [{"constraint": {"resource": "constraints", "id": "c_soft_lat"}, "weight": 1.0}]


def test_the_binding_space_and_the_digest_are_passed_through() -> None:
    compiled = _compiled(SIMPLE)
    facts = facts_view(compiled["ir"], compiled["sourceMap"], {"bindingSpace": "12"}, ir_digest="sha256-" + "a" * 64)
    assert facts["binding_space"] == "12" and facts["ir_digest"] == "sha256-" + "a" * 64
    assert facts_view(compiled["ir"], None, None, ir_digest="x")["binding_space"] is None


def test_an_ir_without_a_member_every_compiled_problem_has_is_unreadable() -> None:
    ir = copy.deepcopy(_compiled(SIMPLE)["ir"])
    ir["spec"]["candidates"]["catalog"]["candidates"]["c1a"]["features"]["latency"] = "fast"
    with pytest.raises(ProblemFactsError):
        _facts(SIMPLE, ir)
    del ir["spec"]["application"]
    with pytest.raises(ProblemFactsError):
        _facts(SIMPLE, ir)


def test_the_facts_workflow_is_the_workflow_of_the_derived_document_for_every_corpus_package() -> None:
    compared = []
    for directory in _corpus():
        compiled = _port().compile(packages.zip_directory(directory))
        spec = compiled["ir"]["spec"]
        services = [task for task, body in spec["application"]["tasks"].items() if body["kind"] == "service"]
        if any(not spec["eligibility"].get(task) for task in services):
            continue  # no binding to derive
        facts = facts_view(compiled["ir"], compiled.get("sourceMap"), None, ir_digest=compiled["irDigest"])
        assert json.dumps(facts["workflow"], sort_keys=True) == json.dumps(_derived_workflow(compiled), sort_keys=True), directory
        compared.append(directory)
    # Most of the corpus is compared, and every workflow shape is among it.
    assert len(compared) >= 60
    shapes = json.dumps([_facts(directory)["workflow"] for directory in (FMS, JSON)])
    assert all(f'"{word}"' in shapes for word in ("seq", "and", "xor", "loop"))
