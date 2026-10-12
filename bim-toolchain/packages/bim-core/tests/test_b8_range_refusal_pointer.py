"""Migrated (language side) from openbinding-gateway/tests/test_b8_range_refusal_pointer.py.

On the platform, refusing a job because of ranges points at the candidate feature value that carries the
range.  That location is built from two things the language owns: the ``sourceMap`` of the BindingProblem
(IR path of a candidate -> catalog file and JSON Pointer) and the IR layout of candidate features.  This
module checks both with ``bim_core`` alone, using the same lookup the platform applies
(``services/engines.py::_feature_value_location``), reproduced here as ``range_location``.

Not migrated (they need Engine manifests and the HTTP API; see docs/EXTRACTION_LOG.md): the refusals
produced by ``mode_compatibility`` against a scalar-only Engine mode and the ``422 engine_mode_incompatible``
test through the job endpoint.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from bim_core import compile_instance, load_package
from conftest import require_corpus_path

SOURCE_POINTER = "/spec/candidates/c1a/features/latency"
IR_POINTER = "/spec/candidates/catalog/candidates/c1a/features/latency"
RANGES = [
    {"min": 100, "max": None},
    {"min": None, "max": 200},
    {"min": None, "max": None},
    {"min": 1, "max": 2},
]


@pytest.fixture(scope="module")
def demo():
    return require_corpus_path("examples/demo/01_simple_seq")


def package_with(demo, latency):
    package = load_package(demo)
    catalog = json.loads(package.files["candidates.json"])
    catalog["spec"]["candidates"]["c1a"]["features"]["latency"] = latency
    package.files["candidates.json"] = json.dumps(catalog).encode()
    return package


def _segment(value) -> str:
    return str(value).replace("~", "~0").replace("/", "~1")


def range_location(problem):
    """Where the first interval feature value is: ``{irPath, resource?, pointer?}``, empty when there is none."""
    catalogs = problem.document["spec"]["candidates"]
    for catalog_id, catalog in catalogs.items():
        bindings = catalog.get("featureBindings", {})
        for candidate_id, candidate in catalog["candidates"].items():
            for alias, value in candidate.get("features", {}).items():
                if alias not in bindings or not isinstance(value, dict):
                    continue
                location = {
                    "irPath": f"/spec/candidates/{_segment(catalog_id)}/candidates/{_segment(candidate_id)}"
                    f"/features/{_segment(alias)}"
                }
                source = problem.source_map.get(f"/spec/candidates/{catalog_id}/{candidate_id}")
                if isinstance(source, dict) and isinstance(source.get("path"), str):
                    location["resource"] = source["path"]
                    location["pointer"] = f"{source['pointer']}/features/{alias}"
                return location
    return {}


@pytest.mark.parametrize("latency", RANGES)
def test_the_source_map_points_at_the_feature_value_of_the_candidate_with_the_range(demo, latency):
    location = range_location(compile_instance(package_with(demo, latency)))

    assert location == {"irPath": IR_POINTER, "resource": "candidates.json", "pointer": SOURCE_POINTER}


def test_the_source_pointer_resolves_to_the_range_in_the_catalog_file(demo):
    package = package_with(demo, {"min": 1, "max": None})
    location = range_location(compile_instance(package))

    node = json.loads(package.files[location["resource"]])
    for part in location["pointer"].lstrip("/").split("/"):
        node = node[part]
    assert node == {"min": 1, "max": None}


def test_the_pointer_names_the_first_candidate_that_carries_a_range(demo):
    package = package_with(demo, {"min": 1, "max": 2})
    catalog = json.loads(package.files["candidates.json"])
    catalog["spec"]["candidates"]["c1b"]["features"]["latency"] = {"min": None, "max": 5}
    package.files["candidates.json"] = json.dumps(catalog).encode()

    assert range_location(compile_instance(package))["pointer"] == SOURCE_POINTER


def test_a_package_with_only_single_values_has_no_range_location(demo):
    assert range_location(compile_instance(load_package(demo))) == {}


def test_without_a_source_map_the_location_keeps_only_the_ir_path(demo):
    problem = compile_instance(package_with(demo, {"min": 1, "max": None}))

    assert range_location(replace(problem, source_map={})) == {"irPath": IR_POINTER}
