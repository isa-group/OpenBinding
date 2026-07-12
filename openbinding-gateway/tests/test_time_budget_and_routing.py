"""Regression tests for the shared time-budget option and sync-response routing."""

import sys
from pathlib import Path

from openbinding_gateway.routing.router import Router
from openbinding_gateway.validation.engine_plugins.evolutionary_heuristics import (
    EvolutionaryHeuristicsEnginePlugin,
)
from openbinding_gateway.validation.engine_plugins.random_search import (
    RandomSearchEnginePlugin,
)

sys.path.insert(0, str(Path(__file__).parent))
from test_bimstar_reference import micro_instance  # noqa: E402


def test_random_search_bimstar_payload_carries_budget_and_seed():
    plugin = RandomSearchEnginePlugin()
    payload, warnings = plugin.transform_request(
        micro_instance(),
        {"iterations_count": 1000, "seed": 7, "time_budget_ms": 300_000},
    )
    assert warnings == []
    # BIM* instances take the placement-native path.
    assert "placement" in payload and "instance" in payload
    assert payload["config"] == {
        "max_iterations": 1000,
        "seed": 7,
        "time_budget_ms": 300_000,
    }


def test_random_search_legacy_payload_unaffected_by_budget_shape():
    plugin = RandomSearchEnginePlugin()
    instance = micro_instance()
    del instance["resource_model"]
    del instance["latency_model"]
    payload, _ = plugin.transform_request(instance, {"iterations_count": 500})
    assert "market" in payload  # legacy DTO path
    assert payload["config"]["max_iterations"] == 500


def test_evolutionary_payload_keeps_time_budget_option():
    plugin = EvolutionaryHeuristicsEnginePlugin()
    payload, warnings = plugin.transform_request(
        micro_instance(),
        {
            "algorithm": "NSGAII",
            "population_size": 20,
            "max_evaluations": 1000,
            "seed": 3,
            "time_budget_ms": 300_000,
        },
    )
    assert warnings == []
    assert payload["options"]["time_budget_ms"] == 300_000
    assert payload["options"]["max_evaluations"] == 1000
    assert payload["placement"] is not None


def test_random_search_response_uses_engine_internal_objective():
    """The engine's internal objective must survive transform_response so the
    canonicalization step can stash it as engine_objective_value (audit)."""
    plugin = RandomSearchEnginePlugin()
    instance = micro_instance()
    cand = instance["candidates"][0]
    engine_response = {
        "status": "optimized",
        "selection": {cand["task_id"]: cand["id"]},
        "aggregated_features": {},
        "objective_value": 0.4242,
        "feasible": True,
        "execution_time": 12,
        "iterations_count": 1000,
    }
    result = plugin.transform_response(engine_response, instance)
    assert result["solutions"][0]["objective_value"] == 0.4242


def test_router_sync_response_detection():
    assert Router._is_sync_response({"selection": {"t1": "c1"}}) is True
    # An empty selection object still marks a finished (empty) sync result.
    assert Router._is_sync_response({"result": {"solution": {"selection": {}}}}) is True
    assert Router._is_sync_response(
        {"result": {"solution": {"selection": {"t1": "c1"}}}}
    ) is True
    # The evolutionary engine answers with a general "solutions" list.
    assert Router._is_sync_response({"solutions": [], "provenance": {}}) is True
    assert Router._is_sync_response({"job_id": "abc", "status": "queued"}) is False
    assert Router._is_sync_response({}) is False


def test_infeasible_solutions_do_not_make_response_feasible():
    router = Router()
    result_data = {
        "solutions": [
            {"binding": {"t1": "c1"}, "feasible": False},
        ]
    }
    assert router._has_non_empty_binding_solution(result_data) is False
    result_data["solutions"].append({"binding": {"t1": "c2"}, "feasible": True})
    assert router._has_non_empty_binding_solution(result_data) is True
