"""Tests for engine capability resolution and compatibility validation."""

from __future__ import annotations

import pytest

from openbinding_gateway.generator.compatibility import (
    IncompatibleTargetEnginesError,
    TargetCapabilities,
    resolve_engine_capabilities,
)


def test_empty_target_engines_returns_defaults():
    caps = resolve_engine_capabilities(None)
    assert isinstance(caps, TargetCapabilities)
    assert caps.target_engines == []
    assert "weighted" in caps.allowed_optimizations
    assert "pareto" in caps.allowed_optimizations

    caps_empty = resolve_engine_capabilities([])
    assert caps_empty.target_engines == []


def test_single_engine_minizinc():
    caps = resolve_engine_capabilities(["minizinc-csp"])
    assert "weighted" in caps.allowed_optimizations
    assert "pareto" not in caps.allowed_optimizations
    assert caps.default_optimization == "weighted"
    assert caps.default_objective_type == "MONO"


def test_single_engine_many_heuristic():
    caps = resolve_engine_capabilities(["many-heuristic"])
    assert "pareto" in caps.allowed_optimizations
    assert "weighted" not in caps.allowed_optimizations
    assert caps.default_optimization == "pareto"
    assert caps.default_objective_type == "MANY"
    assert caps.min_objectives >= 2


def test_compatible_multi_engines():
    caps = resolve_engine_capabilities(["evolutionary-heuristics", "random-search"])
    assert isinstance(caps, TargetCapabilities)
    assert len(caps.target_engines) == 2
    # Both support weighted optimization
    assert "weighted" in caps.allowed_optimizations


def test_incompatible_engines_disjoint_optimization():
    # minizinc-csp (only weighted/satisfy) vs many-heuristic (only pareto)
    with pytest.raises(IncompatibleTargetEnginesError) as exc_info:
        resolve_engine_capabilities(["minizinc-csp", "many-heuristic"])

    err = exc_info.value
    assert "disjoint" in err.message.lower() or "incompatible" in err.message.lower()
    assert len(err.conflicts) > 0


def test_unknown_engine_raises_error():
    with pytest.raises(IncompatibleTargetEnginesError) as exc_info:
        resolve_engine_capabilities(["nonexistent-engine-xyz"])

    err = exc_info.value
    assert "unknown" in err.message.lower()
