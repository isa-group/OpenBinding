"""Every engine declares itself in one manifest, and the plugin reads it.

Capabilities used to be a literal dictionary in each plugin, sitting beside a
schema file that described the same engine, with nothing keeping the two
consistent. Both now come from one document, so these tests are mostly about
that document being the single source: that the four built-in engines still
report exactly what they used to, that their defaults and their published
options schema cannot drift apart, and that a plugin holding its manifest in
memory - which is what a registered engine will do - needs no file at all.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import jsonschema
import pytest

from openbinding_gateway.models.api import ValidationViolation
from openbinding_gateway.models.manifest import EngineManifest
from openbinding_gateway.registry.engine import EngineRegistry
from openbinding_gateway.validation.engine_plugins.base import EngineValidationPlugin

BUILT_INS = ["minizinc-csp", "random-search", "many-heuristic", "evolutionary-heuristics"]

#: What each engine published before its capabilities were derived from a
#: manifest. Written out rather than computed, because the point is that the
#: refactor changed where the answer comes from and not what the answer is.
CAPABILITIES_AS_PUBLISHED = {
    "minizinc-csp": {
        "qos_features_supported": ["*"],
        "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP", "ELEMENT"],
        "objective_types_supported": ["MONO"],
        "constraints_supported": [
            "attribute_bound",
            "dependency",
            "resource_capacity",
            "latency_transition",
        ],
        "type": "EXACT",
        "schema_version": "v1",
    },
    "random-search": {
        "qos_features_supported": ["*"],
        "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP"],
        "objective_types_supported": ["MONO"],
        "constraints_supported": [
            "attribute_bound",
            "dependency",
            "resource_capacity",
            "latency_transition",
        ],
        "type": "HEURISTIC",
        "schema_version": "v1",
    },
    "many-heuristic": {
        "qos_features_supported": ["*"],
        "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP"],
        "objective_types_supported": ["MANY"],
        "constraints_supported": [
            "attribute_bound",
            "dependency",
            "resource_capacity",
            "latency_transition",
        ],
        "type": "HEURISTIC",
        "schema_version": "v1",
    },
    "evolutionary-heuristics": {
        "qos_features_supported": ["*"],
        "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP"],
        "objective_types_supported": ["MONO", "MULTI", "MANY"],
        "constraints_supported": [
            "attribute_bound",
            "dependency",
            "resource_capacity",
            "latency_transition",
        ],
        "algorithms_supported": ["NSGAII", "NSGAIII"],
        "type": "HEURISTIC",
        "schema_version": "v1",
    },
}

#: Likewise for the defaults, which used to be a second literal dictionary.
DEFAULTS_AS_PUBLISHED = {
    "minizinc-csp": {
        "solver": "gecode",
        "time_limit_ms": 900000,
        "intermediate_solutions": True,
    },
    "random-search": {"iterations_count": 1000, "seed": 1, "time_budget_ms": None},
    "many-heuristic": {"iterations_count": 1000, "archive_size": 20},
    "evolutionary-heuristics": {
        "algorithm": "AUTO",
        "population_size": 100,
        "max_evaluations": 10000,
        "crossover_probability": 0.9,
        "mutation_probability": None,
        "distribution_index": 20.0,
        "archive_size": 100,
        "soft_penalty": 10.0,
        "seed": 1,
        "reference_divisions": 12,
    },
}

IN_MEMORY_MANIFEST = {
    "manifest_version": "1",
    "engine_id": "in-memory",
    "display_name": "An engine with no files",
    "type": "HEURISTIC",
    "capabilities": {
        "composition_nodes_supported": ["TASK"],
        "objective_types_supported": ["MONO"],
    },
    "instance_schema": {"type": "object", "required": ["composition"]},
    "options_schema": {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "iterations_count": {"type": "integer", "default": 250},
            "seed": {"type": "integer"},
        },
    },
}


class InMemoryPlugin(EngineValidationPlugin):
    """A plugin handed its manifest instead of finding one.

    This is the shape the federated plugin takes: nothing on disk, no engine id
    resolved to a path, and every derived answer still available.
    """

    engine_id = "in-memory"

    def load_manifest(self) -> EngineManifest:
        return EngineManifest.model_validate(IN_MEMORY_MANIFEST)

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        return []


# -- The built-ins say what they always said --------------------------------


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_every_built_in_engine_has_a_manifest_that_parses(engine_id):
    manifest = EngineRegistry.get_plugin(engine_id).get_manifest()

    assert manifest.engine_id == engine_id
    # An engine shipping with the gateway is reached at a configured URL over
    # the contract every in-tree engine implements, so it describes no transport.
    assert manifest.is_federated is False


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_capabilities_are_unchanged_by_being_derived(engine_id):
    # The refactor moved where this answer comes from. It must not have moved
    # what the answer is: GET /v1/engines publishes this dictionary verbatim.
    assert EngineRegistry.get_plugin(engine_id).get_capabilities() == CAPABILITIES_AS_PUBLISHED[
        engine_id
    ]


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_default_options_are_unchanged_by_being_derived(engine_id):
    # Including the entries whose default is None, which the JVM plugins filter
    # on: dropping them would silently change what reaches the engine.
    assert EngineRegistry.get_plugin(engine_id).get_default_options() == DEFAULTS_AS_PUBLISHED[
        engine_id
    ]


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_every_built_in_engine_still_yields_its_instance_schema(engine_id):
    schema = EngineRegistry.get_plugin(engine_id).get_instance_schema()

    assert isinstance(schema, dict)
    assert schema, f"{engine_id} returned an empty schema"


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_the_instance_schema_is_the_one_in_the_manifest_file(engine_id):
    plugin = EngineRegistry.get_plugin(engine_id)

    with open(plugin.get_manifest_path(), encoding="utf-8") as handle:
        on_disk = json.load(handle)

    assert plugin.get_instance_schema() == on_disk["instance_schema"]


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_the_instance_schema_still_resolves_its_own_internal_references(engine_id):
    # Nesting the schema inside a manifest would break "#/$defs/..." if the
    # nested document were ever validated in place rather than as a root.
    schema = EngineRegistry.get_plugin(engine_id).get_instance_schema()

    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.Draft202012Validator(schema).iter_errors({"composition": {}})


# -- A plugin with nothing on disk -----------------------------------------


def test_a_plugin_may_be_handed_its_manifest():
    plugin = InMemoryPlugin()

    assert plugin.get_capabilities()["type"] == "HEURISTIC"
    assert plugin.get_instance_schema() == {"type": "object", "required": ["composition"]}
    assert plugin.get_default_options() == {"iterations_count": 250}


def test_the_manifest_is_parsed_once_and_reused():
    plugin = InMemoryPlugin()

    assert plugin.get_manifest() is plugin.get_manifest()


def test_the_validation_stage_reads_whatever_the_plugin_declares():
    from openbinding_gateway.validation.manifest_schema import ManifestSchemaValidator

    EngineRegistry.register("in-memory", InMemoryPlugin())
    try:
        accepted = ManifestSchemaValidator().validate("in-memory", {"composition": {}})
        refused = ManifestSchemaValidator().validate("in-memory", {})
    finally:
        EngineRegistry._plugins.pop("in-memory", None)

    assert accepted == []
    assert refused, "an instance missing a required property should violate"
    assert refused[0].code == "manifest_schema_invalid"


# -- Options schemas -------------------------------------------------------


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_every_built_in_engine_describes_its_options(engine_id):
    schema = EngineRegistry.get_plugin(engine_id).get_options_schema()

    assert schema["type"] == "object"
    # An unrecognised option draws a warning rather than a refusal, so the
    # schema says the same rather than promising a strictness nobody has.
    assert schema["additionalProperties"] is True


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_the_options_schema_is_a_valid_schema(engine_id):
    jsonschema.Draft202012Validator.check_schema(
        EngineRegistry.get_plugin(engine_id).get_options_schema()
    )


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_the_defaults_validate_against_the_schema_that_declares_them(engine_id):
    # The bounds in a manifest are a claim about what the engine accepts. An
    # engine whose own defaults fail its own schema has one of the two wrong.
    plugin = EngineRegistry.get_plugin(engine_id)

    jsonschema.Draft202012Validator(plugin.get_options_schema()).validate(
        plugin.get_default_options()
    )


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_every_default_belongs_to_a_declared_option(engine_id):
    plugin = EngineRegistry.get_plugin(engine_id)

    assert set(plugin.get_default_options()) <= plugin.accepted_option_names()


def test_an_option_with_no_default_is_accepted_without_being_sent():
    # "seed" is declared but has no default: the engine takes it, the gateway
    # does not invent one.
    plugin = InMemoryPlugin()

    assert "seed" in plugin.accepted_option_names()
    assert "seed" not in plugin.get_default_options()


def test_an_option_defaulting_to_null_is_sent_as_unset():
    # random-search filters on "is not None", so time_budget_ms has to arrive
    # as a present key holding None rather than not arrive at all.
    defaults = EngineRegistry.get_plugin("random-search").get_default_options()

    assert "time_budget_ms" in defaults
    assert defaults["time_budget_ms"] is None


def test_an_unknown_option_draws_a_warning_naming_the_engine():
    warnings = InMemoryPlugin().unsupported_option_warnings({"nonsense": 1, "seed": 2})

    assert warnings == ["Option 'nonsense' is not supported by in-memory"]


def test_no_options_draws_no_warnings():
    assert InMemoryPlugin().unsupported_option_warnings({}) == []


# -- Over HTTP -------------------------------------------------------------


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from openbinding_gateway.main import app

    return TestClient(app)


@pytest.mark.parametrize("engine_id", BUILT_INS)
def test_the_manifest_endpoint_serves_the_whole_document(client, engine_id):
    body = client.get(f"/v1/engines/{engine_id}/manifest").json()

    assert body["engine_id"] == engine_id
    assert body["capabilities"]
    assert body["instance_schema"]


def test_the_manifest_endpoint_omits_the_transport_of_an_in_tree_engine(client):
    # Absent rather than null: an engine that ships with the gateway has
    # nothing to describe, and a null would suggest it does and it is unknown.
    body = client.get("/v1/engines/random-search/manifest").json()

    assert "transport" not in body


def test_the_endpoints_and_the_plugin_agree(client):
    # Three endpoints reading one document should not be able to disagree, but
    # only a test makes that true rather than intended.
    plugin = EngineRegistry.get_plugin("evolutionary-heuristics")

    manifest = client.get("/v1/engines/evolutionary-heuristics/manifest").json()
    options = client.get("/v1/engines/evolutionary-heuristics/options/schema").json()
    defaults = client.get("/v1/engines/evolutionary-heuristics/options/defaults").json()
    instance_schema = client.get("/v1/schemas/evolutionary-heuristics").json()

    assert manifest["capabilities"]["objective_types_supported"] == plugin.get_capabilities()[
        "objective_types_supported"
    ]
    assert options == plugin.get_options_schema()
    assert defaults == plugin.get_default_options()
    assert instance_schema == plugin.get_instance_schema()


def test_the_options_schema_of_an_unknown_engine_is_a_typed_404(client):
    response = client.get("/v1/engines/nope/options/schema")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "engine_not_found"


def test_the_manifest_of_an_unknown_engine_is_a_typed_404(client):
    response = client.get("/v1/engines/nope/manifest")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "engine_not_found"
