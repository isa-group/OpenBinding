"""The optimization the integration tests submit is valid for each engine mode.

It is checked against the engine manifest and the toolchain rule that resolves
the execution-time optimization, without needing a gateway or any engine.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from _repo import REPO_ROOT
from bim_core.compat import resolve_optimization
from bim_core.compiler import compile_instance
from bim_core.package import load_package

import test_engine_representation_regression as representation
import test_icsoc_regression as icsoc
import test_v1_gateway as conformance


pytestmark = pytest.mark.integration


def _mode(engine: str, mode: str) -> dict:
    candidates = (
        REPO_ROOT / "schemas/bim/v1/manifests" / f"{engine}.json",
        REPO_ROOT / "examples/federation" / engine / "engine.json",
    )
    manifest: Path | None = next((path for path in candidates if path.is_file()), None)
    if manifest is None:
        raise AssertionError(f"no engine manifest found for {engine}")
    document = json.loads(manifest.read_text(encoding="utf-8"))
    return next(item for item in document["spec"]["modes"] if item["id"] == mode)


def _resolved(problem: object, engine: str, mode: str, optimization: dict) -> dict:
    return resolve_optimization(problem, _mode(engine, mode), optimization)


@pytest.mark.parametrize("case", conformance.ENGINE_CASES, ids=lambda case: case.name)
def test_conformance_jobs_send_a_resolvable_optimization(
    case: conformance.EngineCase,
) -> None:
    problem = compile_instance(load_package(REPO_ROOT / "examples" / case.example))
    resolved = _resolved(problem, case.name, case.mode, case.optimization)
    assert {
        "type": resolved["type"],
        "scalarization": resolved["scalarization"],
    } == case.optimization


@pytest.mark.parametrize(
    "example", ["demo/15_bpmn_complete", "demo/16_json_complete"]
)
@pytest.mark.parametrize("case", representation.CASES, ids=lambda case: case.engine)
def test_representation_jobs_send_a_resolvable_optimization(
    case: representation.RepresentationCase,
    example: str,
) -> None:
    problem = compile_instance(load_package(representation._package(example, case)))
    resolved = _resolved(problem, case.engine, case.mode, case.optimization)
    assert {
        "type": resolved["type"],
        "scalarization": resolved["scalarization"],
    } == case.optimization
    assert len(resolved["weights"]) in (0, case.criteria_count)


@pytest.mark.parametrize("engine", list(icsoc.LANES))
def test_icsoc_jobs_send_a_resolvable_optimization(engine: str) -> None:
    mode, _ = icsoc.LANES[engine]
    criteria = ("latency", "cost", "security")
    problem = SimpleNamespace(
        document={"spec": {"optimization": {"criteria": [{"id": name} for name in criteria]}}}
    )
    resolved = _resolved(problem, engine, mode, icsoc.OPTIMIZATION)
    assert {
        "type": resolved["type"],
        "scalarization": resolved["scalarization"],
    } == icsoc.OPTIMIZATION
    assert [weight["criteria"] for weight in resolved["weights"]] == list(criteria)
