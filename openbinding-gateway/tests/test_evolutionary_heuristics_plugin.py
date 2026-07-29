from openbinding_gateway.validation.engine_plugins.evolutionary_heuristics import (
    EvolutionaryHeuristicsEnginePlugin,
)


def test_evolutionary_plugin_passes_general_instance_and_filters_options():
    plugin = EvolutionaryHeuristicsEnginePlugin()
    instance = {
        "composition": {"root": {"kind": "TASK", "task_id": "t1"}},
        "features": [{"id": "cost"}],
        "candidates": [{"id": "c1", "task_ids": ["t1"]}],
        "objective": {"type": "MONO", "targets": ["cost"]},
    }

    payload, warnings = plugin.transform_request(
        instance,
        {"population_size": 50, "seed": 7, "unsupported": True},
    )

    assert payload["instance"] is instance
    assert payload["options"] == {"population_size": 50, "seed": 7}
    assert warnings == [
        "Option 'unsupported' is not supported by evolutionary-heuristics"
    ]


def test_evolutionary_plugin_reports_missing_candidates():
    plugin = EvolutionaryHeuristicsEnginePlugin()
    instance = {
        "composition": {"root": {"kind": "TASK", "task_id": "t1"}},
        "features": [{"id": "cost"}],
        "candidates": [],
        "objective": {"type": "MONO", "targets": ["cost"]},
    }

    violations = plugin.validate_semantics(instance)

    assert [violation.code for violation in violations] == ["missing_candidates"]


def test_evolutionary_plugin_capabilities_cover_all_objective_types():
    capabilities = EvolutionaryHeuristicsEnginePlugin().get_capabilities()

    assert capabilities["objective_types_supported"] == ["MONO", "MULTI", "MANY"]
    assert capabilities["algorithms_supported"] == ["NSGAII", "NSGAIII"]
