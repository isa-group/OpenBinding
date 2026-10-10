"""B5: finite ranges keep the exact IR, canonical JSON and digests of before open ends existed.

The pinned values were computed with the code *before* open (null) range ends
were introduced, for the package built by `finite_range_package`.  They are
independent of compiler.py/schema bytes: `problem.digest` also covers `spec.profile`,
which pins the compiler bundle digest and therefore moves with any compiler edit,
so the golden digest is taken over the remaining semantic document.
"""

from __future__ import annotations

import json

from _repo import REPO_ROOT
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1.canonical import canonical_json, digest
from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package

DEMO = REPO_ROOT / "examples/demo/01_simple_seq"

GOLDEN_CATALOG_BYTES_DIGEST = "sha256-9997045d41e96d413f7703a5385624cf4f42374409113ee348072f8bdd91653a"
GOLDEN_CANDIDATES_DIGEST = "sha256-692b2c1ac3290aedde24c59fa6df4fc50a5d594d012cdac39c3c99dee83beec3"
GOLDEN_SEMANTIC_SPEC_DIGEST = "sha256-8e3e9d4fe20743f0f5b20dd9f17997e6625f3d4bdfb226c9142cf8e362ba9ecb"
GOLDEN_C1A_CANONICAL = (
    '{"features":{"latency":{"max":12.5,"min":8}},"properties":{},'
    '"provides":[{"properties":{},"type":"service/t1"}],"ref":{"id":"c1a","resource":"catalog"}}'
)


def finite_range_package():
    value = load_package(DEMO)
    catalog = json.loads(value.files["candidates.json"])
    candidates = catalog["spec"]["candidates"]
    candidates["c1a"]["features"]["latency"] = {"min": 8, "max": 12.5}
    candidates["c1b"]["features"]["latency"] = {"min": 5, "max": 5}
    value.files["candidates.json"] = json.dumps(catalog).encode()
    return value


def test_finite_ranges_keep_their_canonical_json_and_digests() -> None:
    package = finite_range_package()
    problem = compile_instance(package)
    spec = problem.document["spec"]
    semantic = {
        key: value for key, value in spec.items() if key not in {"profile", "dialects", "instance", "sourceMap"}
    }

    assert package.digest("candidates.json") == GOLDEN_CATALOG_BYTES_DIGEST
    assert canonical_json(spec["candidates"]["catalog"]["candidates"]["c1a"]).decode() == GOLDEN_C1A_CANONICAL
    assert digest(spec["candidates"]) == GOLDEN_CANDIDATES_DIGEST
    assert digest(semantic) == GOLDEN_SEMANTIC_SPEC_DIGEST


def test_finite_range_ir_is_unchanged_literal_data() -> None:
    spec = compile_instance(finite_range_package()).document["spec"]["candidates"]["catalog"]["candidates"]
    assert spec["c1a"]["features"] == {"latency": {"min": 8, "max": 12.5}}
    assert spec["c1b"]["features"] == {"latency": {"min": 5, "max": 5}}


def test_protocol_digest_is_pinned_by_the_shipped_registration_and_engine_openapi() -> None:
    # The BindingProblem schema bytes changed for open ends, so the digest pinned
    # by the federated example must have been regenerated with them.
    expected = routes._protocol_digest()
    registration = json.loads(
        (REPO_ROOT / "examples/federation/multi-heuristic/registration.json").read_text(encoding="utf-8")
    )
    engine_openapi = json.loads(
        (REPO_ROOT / "engines/multi-heuristic/src/main/resources/openapi.json").read_text(encoding="utf-8")
    )
    assert registration["spec"]["protocol"]["digest"] == expected
    assert registration["spec"]["openapi"]["x-bim-protocol-digest"] == expected
    assert engine_openapi["x-bim-protocol-digest"] == expected
