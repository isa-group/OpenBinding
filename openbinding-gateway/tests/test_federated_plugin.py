"""A third party's answer, turned into a comparable result.

The claim this file exists to check is the one the whole federation design
rests on: an engine that reports **only which candidate serves which task**
comes back with a complete result, because the reference evaluator computes
everything else. If that is true, a stranger's solver needs no trust and no
code here; if it is not, federation is a way of importing somebody else's
arithmetic errors.

So the last section solves a real instance through a stub whose response
carries a binding and nothing else, and checks that features, violations and
feasibility come out anyway.
"""

from __future__ import annotations

import pytest

from openbinding_gateway.models.manifest import EngineManifest
from openbinding_gateway.validation.engine_plugins.base import capability_violations
from openbinding_gateway.validation.engine_plugins.federated import FederatedEnginePlugin


def a_manifest(**overrides) -> EngineManifest:
    manifest = {
        "manifest_version": "1",
        "engine_id": "tabu",
        "display_name": "ACME Tabu",
        "type": "HEURISTIC",
        "capabilities": {
            "composition_nodes_supported": ["TASK", "SEQ"],
            "objective_types_supported": ["MONO"],
            "constraints_supported": ["attribute_bound"],
        },
        "instance_schema": {"type": "object"},
        "options_schema": {
            "type": "object",
            "additionalProperties": True,
            "properties": {"iterations": {"type": "integer", "default": 500}},
        },
        "transport": {
            "openapi": {"url": "https://acme.example/openapi.json"},
            "operations": {"solve": {"operationId": "postOptimize"}},
            "response_mapping": {
                "solutions": "/results",
                "binding": "/assignment",
                "objective": "/score",
            },
        },
    }
    manifest.update(overrides)
    return EngineManifest.model_validate(manifest)


def a_plugin(**overrides) -> FederatedEnginePlugin:
    return FederatedEnginePlugin(a_manifest(**overrides), owner="alice")


# -- Everything comes from the manifest -------------------------------------


def test_the_plugin_needs_no_files_and_no_engine_id_lookup():
    plugin = a_plugin()

    assert plugin.engine_id == "tabu"
    assert plugin.get_capabilities()["type"] == "HEURISTIC"
    assert plugin.get_default_options() == {"iterations": 500}
    assert plugin.get_instance_schema() == {"type": "object"}


def test_an_option_the_engine_never_declared_draws_a_warning_and_is_dropped():
    payload, warnings = a_plugin().transform_request({"tasks": []}, {"iterations": 10, "nope": 1})

    assert payload["options"] == {"iterations": 10}
    assert warnings == ["Option 'nope' is not supported by tabu"]


# -- Capability-driven semantics -------------------------------------------


def test_an_unsupported_node_kind_is_caught_from_the_declaration_alone():
    instance = {
        "composition": {"root": {"kind": "SEQ", "children": [{"kind": "LOOP", "body": {"kind": "TASK"}}]}},
        "objective": {"type": "MONO"},
    }

    violations = a_plugin().validate_semantics(instance)

    assert [v.code for v in violations] == ["engine_unsupported_feature"]
    assert "LOOP" in violations[0].message


def test_an_unsupported_objective_type_is_caught():
    instance = {"composition": {"root": {"kind": "TASK"}}, "objective": {"type": "MANY"}}

    violations = a_plugin().validate_semantics(instance)

    assert [v.code for v in violations] == ["unsupported_objective_type"]


def test_an_unsupported_constraint_family_is_caught():
    instance = {
        "composition": {"root": {"kind": "TASK"}},
        "objective": {"type": "MONO"},
        "constraints": [{"kind": "RESOURCE_CAPACITY"}],
    }

    violations = a_plugin().validate_semantics(instance)

    assert [v.code for v in violations] == ["unsupported_constraint"]
    assert violations[0].path == "constraints[0].kind"


def test_an_instance_within_the_declaration_passes():
    instance = {
        "composition": {"root": {"kind": "SEQ", "children": [{"kind": "TASK"}]}},
        "objective": {"type": "MONO"},
        "constraints": [{"kind": "ATTRIBUTE_BOUND"}],
    }

    assert a_plugin().validate_semantics(instance) == []


def test_declaring_no_constraint_families_means_no_restriction():
    # Silence is not consent to reject: an omitted optional field must not
    # become a blanket refusal of every constrained instance.
    capabilities = {"composition_nodes_supported": ["TASK"], "objective_types_supported": ["MONO"]}
    instance = {
        "composition": {"root": {"kind": "TASK"}},
        "objective": {"type": "MONO"},
        "constraints": [{"kind": "RESOURCE_CAPACITY"}],
    }

    assert capability_violations(instance, capabilities) == []


def test_nodes_are_found_down_every_branch():
    instance = {
        "composition": {
            "root": {
                "kind": "XOR",
                "branches": [{"child": {"kind": "TASK"}}, {"child": {"kind": "LOOP"}}],
            }
        }
    }
    capabilities = {"composition_nodes_supported": ["TASK", "XOR"], "objective_types_supported": ["MONO"]}

    violations = capability_violations(instance, capabilities)

    assert len(violations) == 1
    assert "LOOP" in violations[0].message


def test_a_dag_composition_is_checked_too():
    instance = {"composition": {"type": "DAG", "nodes": [{"kind": "ELEMENT", "id": "n1"}]}}
    capabilities = {"composition_nodes_supported": ["TASK"], "objective_types_supported": ["MONO"]}

    assert [v.code for v in capability_violations(instance, capabilities)] == [
        "engine_unsupported_feature"
    ]


# -- Reading their answer ---------------------------------------------------


def test_a_binding_under_their_own_field_names_is_found():
    response = {"results": [{"assignment": {"t1": "c1"}, "score": 12.5}]}

    result = a_plugin().transform_response(response, {})

    assert result["solutions"] == [{"binding": {"t1": "c1"}, "objective_value": 12.5}]


def test_nothing_but_the_binding_is_believed():
    # The engine claims a feasibility and some features. None of it survives:
    # the reference evaluator decides those, for every engine.
    response = {
        "results": [
            {
                "assignment": {"t1": "c1"},
                "feasible": True,
                "aggregated_features": {"cost": 0.0},
                "violations": [],
            }
        ]
    }

    solution = a_plugin().transform_response(response, {})["solutions"][0]

    assert set(solution) == {"binding"}


def test_an_engine_returning_one_object_rather_than_a_list_is_understood():
    response = {"results": {"assignment": {"t1": "c1"}}}

    assert a_plugin().transform_response(response, {})["solutions"] == [
        {"binding": {"t1": "c1"}}
    ]


def test_an_engine_whose_body_is_the_list_is_understood():
    plugin = FederatedEnginePlugin(
        a_manifest(
            transport={
                "openapi": {"url": "https://acme.example/o.json"},
                "operations": {"solve": {"operationId": "postOptimize"}},
                "response_mapping": {"solutions": "", "binding": "/assignment"},
            }
        )
    )

    assert plugin.transform_response([{"assignment": {"t1": "c1"}}], {})["solutions"] == [
        {"binding": {"t1": "c1"}}
    ]


def test_an_entry_with_no_binding_is_not_a_solution():
    # An empty binding reported as a solution would read as feasible-but-empty
    # rather than as no answer at all.
    response = {"results": [{"score": 1.0}, {"assignment": {}}, {"assignment": {"t1": "c1"}}]}

    assert len(a_plugin().transform_response(response, {})["solutions"]) == 1


def test_an_unparseable_answer_yields_no_solutions_rather_than_raising():
    assert a_plugin().transform_response({"unexpected": True}, {})["solutions"] == []


def test_a_non_numeric_objective_is_ignored_rather_than_carried():
    response = {"results": [{"assignment": {"t1": "c1"}, "score": "very good"}]}

    assert a_plugin().transform_response(response, {})["solutions"] == [
        {"binding": {"t1": "c1"}}
    ]


# -- Provenance -------------------------------------------------------------


def test_every_federated_result_says_it_is_federated():
    # So that one can never be mistaken for an in-tree result in a benchmark.
    provenance = a_plugin().transform_response({"results": []}, {})["provenance"]

    assert provenance["engine_id"] == "tabu"
    assert provenance["metadata"]["federated"] is True
    assert provenance["metadata"]["owner"] == "alice"


# -- Asynchronous engines ---------------------------------------------------


def an_async_plugin() -> FederatedEnginePlugin:
    return FederatedEnginePlugin(
        a_manifest(
            transport={
                "openapi": {"url": "https://acme.example/o.json"},
                "operations": {
                    "solve": {"operationId": "postOptimize"},
                    "job": {"operationId": "getOptimizeRun"},
                },
                "response_mapping": {
                    "solutions": "/results",
                    "binding": "/assignment",
                    "job_id": "/id",
                    "job_status": {
                        "pointer": "/state",
                        "map": {"done": "completed", "error": "failed", "queued": "queued"},
                    },
                },
            }
        )
    )


def test_their_job_identifier_is_found():
    assert an_async_plugin().job_id({"id": "run-42"}) == "run-42"


@pytest.mark.parametrize(
    "reported,expected",
    [("done", "completed"), ("error", "failed"), ("queued", "queued")],
)
def test_their_vocabulary_is_translated(reported, expected):
    assert an_async_plugin().job_status({"state": reported}) == expected


def test_a_state_we_have_no_mapping_for_is_treated_as_still_running():
    # Treating silence as failure would abandon jobs that are merely still
    # going, which is the more expensive mistake of the two.
    assert an_async_plugin().job_status({"state": "warming-up"}) == "running"
    assert an_async_plugin().job_status({}) == "running"


def test_a_synchronous_engine_has_no_job_identifier():
    assert a_plugin().job_id({"id": "x"}) is None


# -- The claim the design rests on ------------------------------------------


def test_a_binding_only_answer_still_yields_a_complete_result(micro_placement_instance):
    """The whole argument for federation, checked end to end on a real instance.

    A stranger's engine returns which candidate serves which task, and nothing
    else. What comes back has aggregated features, violations and a feasibility
    verdict, all computed here by the same evaluator that scores the built-in
    engines - so the result is comparable with theirs by construction.
    """
    from openbinding_gateway.semantics import canonicalize_result_data

    binding = {task["id"]: f"c_{task['id']}_p1" for task in micro_placement_instance["tasks"]}
    their_answer = {"results": [{"assignment": binding}]}

    reduced = a_plugin().transform_response(their_answer, micro_placement_instance)
    assert reduced["solutions"][0] == {"binding": binding}, "only the binding should survive"

    canonical = canonicalize_result_data(reduced, micro_placement_instance)
    solution = canonical["solutions"][0]

    assert solution["aggregated_features"], "features are derived from the binding"
    assert "feasible" in solution
    assert solution["violations"] is not None
