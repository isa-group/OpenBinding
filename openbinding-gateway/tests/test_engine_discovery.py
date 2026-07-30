"""Adding an in-tree engine should cost a manifest, and nothing else.

It used to cost five edits: a manifest, a plugin class, a settings field, an
entry in a URL dictionary, and a line in the registry. Four of those repeated
what the manifest already said, and each was a place to forget - which is how
a capability gets declared and never enforced.

So the claim under test is narrow and checkable: a file dropped into
``schemas/manifests/`` becomes a usable engine, with capabilities, an instance
schema, options, defaults and a URL, and no Python written anywhere.
"""

from __future__ import annotations

import json
import os

import pytest

from openbinding_gateway.registry.discovery import (
    ManifestEnginePlugin,
    discover,
    load_manifests,
    manifest_ids,
    url_env_var,
)

BUILT_INS = {"minizinc-csp", "random-search", "many-heuristic", "evolutionary-heuristics"}


def a_manifest(engine_id: str = "drop-in", **overrides) -> dict:
    manifest = {
        "manifest_version": "1",
        "engine_id": engine_id,
        "display_name": "Dropped In",
        "type": "HEURISTIC",
        "capabilities": {
            "composition_nodes_supported": ["TASK", "SEQ"],
            "objective_types_supported": ["MONO"],
        },
        "instance_schema": {"type": "object"},
        "options_schema": {
            "type": "object",
            "additionalProperties": True,
            "properties": {"rounds": {"type": "integer", "default": 7}},
        },
    }
    manifest.update(overrides)
    return manifest


@pytest.fixture
def manifests_dir(tmp_path):
    def write(name: str, body: dict | str):
        path = tmp_path / f"{name}.manifest.json"
        path.write_text(
            body if isinstance(body, str) else json.dumps(body), encoding="utf-8"
        )
        return path

    write.dir = str(tmp_path)  # type: ignore[attr-defined]
    return write


class FakeRegistry:
    def __init__(self):
        self._plugins = {}

    def register(self, engine_id, plugin):
        self._plugins[engine_id] = plugin


# -- The claim --------------------------------------------------------------


def test_a_manifest_on_disk_is_the_whole_registration(manifests_dir):
    manifests_dir("drop-in", a_manifest())
    registry = FakeRegistry()

    added = discover(registry, manifests_dir.dir)

    assert added == ["drop-in"]
    plugin = registry._plugins["drop-in"]
    assert plugin.get_capabilities()["type"] == "HEURISTIC"
    assert plugin.get_instance_schema() == {"type": "object"}
    assert plugin.get_default_options() == {"rounds": 7}
    assert plugin.validate_semantics({"composition": {"root": {"kind": "TASK"}}}) == []


def test_a_discovered_engine_still_enforces_what_it_declares(manifests_dir):
    manifests_dir("drop-in", a_manifest())
    registry = FakeRegistry()
    discover(registry, manifests_dir.dir)

    violations = registry._plugins["drop-in"].validate_semantics(
        {"composition": {"root": {"kind": "LOOP"}}, "objective": {"type": "MANY"}}
    )

    assert {v.code for v in violations} == {
        "engine_unsupported_feature",
        "unsupported_objective_type",
    }


def test_the_url_comes_from_a_convention_not_a_dictionary():
    assert url_env_var("random-search") == "ENGINE_RANDOM_SEARCH_URL"
    assert url_env_var("drop-in") == "ENGINE_DROP_IN_URL"


def test_an_engine_found_on_disk_reads_its_url_from_the_environment(monkeypatch, tmp_path):
    # The other half of "a manifest and an environment variable": the settings
    # object has to find a URL for an engine nobody wrote a field for.
    from openbinding_gateway.core.settings import Settings

    (tmp_path / "manifests").mkdir()
    (tmp_path / "manifests" / "drop-in.manifest.json").write_text(
        json.dumps(a_manifest()), encoding="utf-8"
    )
    monkeypatch.setenv("SCHEMAS_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_DROP_IN_URL", "http://engine-drop-in:9000")

    urls = Settings(schemas_dir=str(tmp_path)).engine_urls

    assert urls["drop-in"] == "http://engine-drop-in:9000"


def test_an_engine_with_no_url_configured_is_simply_absent(monkeypatch, tmp_path):
    # Rather than defaulting to a guess that would fail at solve time with a
    # connection error instead of a configuration message.
    from openbinding_gateway.core.settings import Settings

    (tmp_path / "manifests").mkdir()
    (tmp_path / "manifests" / "drop-in.manifest.json").write_text(
        json.dumps(a_manifest()), encoding="utf-8"
    )
    monkeypatch.delenv("ENGINE_DROP_IN_URL", raising=False)

    assert "drop-in" not in Settings(schemas_dir=str(tmp_path)).engine_urls


# -- A plugin still wins ----------------------------------------------------


def test_a_handwritten_plugin_is_never_displaced_by_its_manifest(manifests_dir):
    # Each of the four exists because its engine needs something a manifest
    # cannot express. Discovery must not quietly replace one with a generic.
    manifests_dir("drop-in", a_manifest())
    registry = FakeRegistry()
    sentinel = object()
    registry._plugins["drop-in"] = sentinel

    added = discover(registry, manifests_dir.dir)

    assert added == []
    assert registry._plugins["drop-in"] is sentinel


def test_the_real_registry_kept_its_handwritten_plugins():
    from openbinding_gateway.registry.engine import EngineRegistry
    from openbinding_gateway.validation.engine_plugins.minizinc_csp import (
        MiniZincCSPEnginePlugin,
    )

    assert isinstance(EngineRegistry.get_plugin("minizinc-csp"), MiniZincCSPEnginePlugin)
    assert BUILT_INS <= set(EngineRegistry._plugins)


def test_the_shipped_manifests_are_all_discoverable():
    # If this ever finds fewer than four, a manifest has stopped parsing.
    assert BUILT_INS <= set(manifest_ids())


# -- Bad files ---------------------------------------------------------------


def test_one_unreadable_manifest_does_not_take_the_others_with_it(manifests_dir):
    manifests_dir("good", a_manifest("good"))
    manifests_dir("broken", "{ not json")

    manifests, problems = load_manifests(manifests_dir.dir)

    assert set(manifests) == {"good"}
    assert any("broken" in problem for problem in problems)


def test_a_manifest_whose_name_disagrees_with_its_id_is_refused(manifests_dir):
    # The filename is how the URL variable and the endpoints find it, so a
    # disagreement would produce an engine reachable under two names and
    # configurable under neither.
    manifests_dir("filename", a_manifest("something-else"))

    manifests, problems = load_manifests(manifests_dir.dir)

    assert manifests == {}
    assert "agree" in problems[0]


def test_a_federated_manifest_does_not_belong_in_the_in_tree_directory(manifests_dir):
    manifests_dir(
        "not-ours",
        a_manifest(
            "not-ours",
            transport={
                "openapi": {"url": "https://acme.example/o.json"},
                "operations": {"solve": {"operationId": "postOptimize"}},
                "response_mapping": {"binding": "/binding"},
            },
        ),
    )

    manifests, problems = load_manifests(manifests_dir.dir)

    assert manifests == {}
    assert "federated" in problems[0]


def test_a_manifest_with_an_invented_capability_is_refused(manifests_dir):
    manifests_dir(
        "typo",
        a_manifest(
            "typo",
            capabilities={
                "composition_nodes_supported": ["TASK", "PARALEL"],
                "objective_types_supported": ["MONO"],
            },
        ),
    )

    manifests, problems = load_manifests(manifests_dir.dir)

    assert manifests == {}
    assert "PARALEL" in problems[0]


def test_a_directory_that_does_not_exist_is_not_an_error():
    assert manifest_ids("/nonexistent/manifests") == []


def test_files_that_are_not_manifests_are_ignored(manifests_dir):
    (open(os.path.join(manifests_dir.dir, "README.md"), "w")).write("not a manifest")
    manifests_dir("good", a_manifest("good"))

    assert manifest_ids(manifests_dir.dir) == ["good"]


# -- The generic plugin -----------------------------------------------------


def test_the_generic_plugin_passes_requests_and_responses_through(manifests_dir):
    # Correct for any engine implementing schemas/engine-contract.openapi.yaml,
    # which is what makes "no Python" true rather than aspirational.
    plugin = ManifestEnginePlugin("drop-in", None)
    plugin._preloaded = None

    from openbinding_gateway.models.manifest import EngineManifest

    plugin = ManifestEnginePlugin("drop-in", EngineManifest.model_validate(a_manifest()))

    payload, warnings = plugin.transform_request({"tasks": []}, {"rounds": 3})
    assert payload == {"instance": {"tasks": []}, "options": {"rounds": 3}}
    assert warnings == []

    body = {"solutions": [{"binding": {"t1": "c1"}}]}
    assert plugin.transform_response(body, {}) == body


def test_the_generic_plugin_warns_about_options_it_does_not_declare():
    from openbinding_gateway.models.manifest import EngineManifest

    plugin = ManifestEnginePlugin("drop-in", EngineManifest.model_validate(a_manifest()))

    _, warnings = plugin.transform_request({}, {"nonsense": 1})

    assert warnings == ["Option 'nonsense' is not supported by drop-in"]


# -- The catalogue stays public --------------------------------------------


def test_the_catalogue_answers_without_an_accounts_database():
    """A gateway with no DATABASE_URL still lists its engines.

    ``GET /v1/engines`` learned to vary its answer by caller, which meant it
    acquired a dependency on knowing who the caller is. On a deployment where
    nobody can sign in, "nobody is signed in" has to be an answer rather than a
    503 - that is the promise the whole accounts module was added under.
    """
    from fastapi.testclient import TestClient

    from openbinding_gateway.main import app

    response = TestClient(app).get("/v1/engines")

    assert response.status_code == 200
    assert BUILT_INS <= {entry["id"] for entry in response.json()}
