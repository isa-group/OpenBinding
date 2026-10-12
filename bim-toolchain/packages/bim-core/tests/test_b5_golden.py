"""Migrated from openbinding-gateway/tests/test_b5_golden.py: finite ranges keep their IR, canonical JSON and digests.

The pinned values were computed with the code *before* open (null) range ends existed, for the package
built by ``finite_range_package``.  They do not depend on compiler bytes: ``problem.digest`` also covers
``spec.profile``, which pins the toolchain digest, so the golden digest is taken over the remaining
semantic document.  The platform-only test that checks the Engine protocol digest against the shipped
federation example stays in OpenBinding (see docs/EXTRACTION_LOG.md).
"""

from __future__ import annotations

import json

import pytest

from bim_core import canonical_json, compile_instance, digest, load_package
from conftest import require_corpus_path

GOLDEN_CATALOG_BYTES_DIGEST = "sha256-9997045d41e96d413f7703a5385624cf4f42374409113ee348072f8bdd91653a"
GOLDEN_CANDIDATES_DIGEST = "sha256-692b2c1ac3290aedde24c59fa6df4fc50a5d594d012cdac39c3c99dee83beec3"
GOLDEN_SEMANTIC_SPEC_DIGEST = "sha256-8e3e9d4fe20743f0f5b20dd9f17997e6625f3d4bdfb226c9142cf8e362ba9ecb"
GOLDEN_C1A_CANONICAL = (
    '{"features":{"latency":{"max":12.5,"min":8}},"properties":{},'
    '"provides":[{"properties":{},"type":"service/t1"}],"ref":{"id":"c1a","resource":"catalog"}}'
)


@pytest.fixture(scope="module")
def demo():
    return require_corpus_path("examples/demo/01_simple_seq")


def finite_range_package(demo):
    value = load_package(demo)
    catalog = json.loads(value.files["candidates.json"])
    candidates = catalog["spec"]["candidates"]
    candidates["c1a"]["features"]["latency"] = {"min": 8, "max": 12.5}
    candidates["c1b"]["features"]["latency"] = {"min": 5, "max": 5}
    value.files["candidates.json"] = json.dumps(catalog).encode()
    return value


def test_finite_ranges_keep_their_canonical_json_and_digests(demo) -> None:
    package = finite_range_package(demo)
    problem = compile_instance(package)
    spec = problem.document["spec"]
    semantic = {
        key: value for key, value in spec.items() if key not in {"profile", "dialects", "instance", "sourceMap"}
    }

    assert package.digest("candidates.json") == GOLDEN_CATALOG_BYTES_DIGEST
    assert canonical_json(spec["candidates"]["catalog"]["candidates"]["c1a"]).decode() == GOLDEN_C1A_CANONICAL
    assert digest(spec["candidates"]) == GOLDEN_CANDIDATES_DIGEST
    assert digest(semantic) == GOLDEN_SEMANTIC_SPEC_DIGEST


def test_finite_range_ir_is_unchanged_literal_data(demo) -> None:
    spec = compile_instance(finite_range_package(demo)).document["spec"]["candidates"]["catalog"]["candidates"]
    assert spec["c1a"]["features"] == {"latency": {"min": 8, "max": 12.5}}
    assert spec["c1b"]["features"] == {"latency": {"min": 5, "max": 5}}
