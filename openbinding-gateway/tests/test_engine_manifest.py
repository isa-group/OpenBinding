"""What a manifest must say before anybody's solver is let in.

Everything checked here is checked without a network: shapes, vocabularies,
pointer syntax, and the interlocks between fields. The point of drawing the line
there is that these are the mistakes which would otherwise surface at solve
time, on somebody's real instance, as a message about a missing key.

The vocabulary tests matter more than they look. The four built-in engines each
return a capabilities dict that nothing has ever compared against the general
schema, so a typo has always been able to advertise a capability that does not
exist. That was tolerable when every engine arrived as reviewed code. A manifest
comes from a stranger.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from openbinding_gateway.models.manifest import (
    EngineManifest,
    EngineType,
    ManifestTransport,
    is_json_pointer,
    qualify,
    resolve_pointer,
    split_qualified,
)


def a_manifest(**overrides) -> dict:
    """The smallest manifest that says everything required.

    Deliberately minimal on the response side: one pointer, ``binding``. That is
    the whole claim of this design - the reference evaluator computes the rest -
    so the fixture had better exercise it rather than a comfortable maximal case.
    """
    manifest = {
        "manifest_version": "1",
        "engine_id": "acme-tabu",
        "display_name": "ACME Tabu Search",
        "type": "HEURISTIC",
        "capabilities": {
            "composition_nodes_supported": ["TASK", "SEQ"],
            "objective_types_supported": ["MONO"],
        },
        "instance_schema": {"type": "object"},
        "transport": {
            "openapi": {"url": "https://acme.example/openapi.json"},
            "operations": {"solve": {"operationId": "postOptimize"}},
            "response_mapping": {"binding": "/assignment"},
        },
    }
    manifest.update(overrides)
    return manifest


def a_transport(**overrides) -> dict:
    transport = {
        "openapi": {"url": "https://acme.example/openapi.json"},
        "operations": {"solve": {"operationId": "postOptimize"}},
        "response_mapping": {"binding": "/assignment"},
    }
    transport.update(overrides)
    return transport


# -- The minimum contract ---------------------------------------------------


def test_a_binding_pointer_is_the_whole_requirement():
    # The claim being tested: an engine that reports only which candidate serves
    # which task is a complete engine, because canonicalization derives the rest.
    manifest = EngineManifest.model_validate(a_manifest())

    assert manifest.transport.response_mapping.binding == "/assignment"
    assert manifest.transport.response_mapping.objective is None


def test_a_manifest_without_a_binding_pointer_is_refused():
    with pytest.raises(ValidationError) as error:
        EngineManifest.model_validate(
            a_manifest(transport=a_transport(response_mapping={"solutions": "/results"}))
        )

    assert "binding" in str(error.value)


def test_capabilities_reach_the_shape_the_router_reads():
    # The router asks get_capabilities()["type"] to decide between INFEASIBLE
    # and UNKNOWN, so type has to be folded into that dict, not left beside it.
    manifest = EngineManifest.model_validate(a_manifest(type="EXACT"))

    assert manifest.as_capabilities_dict()["type"] == "EXACT"
    assert manifest.type is EngineType.EXACT


# -- Vocabularies -----------------------------------------------------------


def test_an_invented_composition_node_is_refused():
    with pytest.raises(ValidationError) as error:
        EngineManifest.model_validate(
            a_manifest(
                capabilities={
                    "composition_nodes_supported": ["TASK", "PARALLEL"],
                    "objective_types_supported": ["MONO"],
                }
            )
        )

    message = str(error.value)
    assert "PARALLEL" in message
    # The message should name what is allowed, not just what is not.
    assert "XOR" in message


def test_an_invented_objective_type_is_refused():
    with pytest.raises(ValidationError) as error:
        EngineManifest.model_validate(
            a_manifest(
                capabilities={
                    "composition_nodes_supported": ["TASK"],
                    "objective_types_supported": ["PARETO"],
                }
            )
        )

    assert "PARETO" in str(error.value)


def test_a_wildcard_is_expanded_rather_than_stored():
    # Storing "*" would mean every later reader has to know to expand it.
    manifest = EngineManifest.model_validate(
        a_manifest(
            capabilities={
                "composition_nodes_supported": ["*"],
                "objective_types_supported": ["*"],
            }
        )
    )

    assert "LOOP" in manifest.capabilities.composition_nodes_supported
    assert set(manifest.capabilities.objective_types_supported) == {"MONO", "MULTI", "MANY"}


def test_constraint_families_are_accepted_in_either_case():
    # The general schema writes ATTRIBUTE_BOUND; the four plugins publish
    # attribute_bound through GET /v1/engines. A manifest author may have read
    # either one, so both work and both normalise to what the endpoint publishes.
    from_schema = EngineManifest.model_validate(
        a_manifest(
            capabilities={
                "composition_nodes_supported": ["TASK"],
                "objective_types_supported": ["MONO"],
                "constraints_supported": ["ATTRIBUTE_BOUND", "DEPENDENCY"],
            }
        )
    )
    from_endpoint = EngineManifest.model_validate(
        a_manifest(
            capabilities={
                "composition_nodes_supported": ["TASK"],
                "objective_types_supported": ["MONO"],
                "constraints_supported": ["attribute_bound", "dependency"],
            }
        )
    )

    assert from_schema.capabilities.constraints_supported == ["attribute_bound", "dependency"]
    assert (
        from_schema.capabilities.constraints_supported
        == from_endpoint.capabilities.constraints_supported
    )


def test_an_engine_may_declare_its_own_extra_capabilities():
    # The evolutionary engine already publishes algorithms_supported, and the
    # engines endpoint passes capabilities through untouched.
    manifest = EngineManifest.model_validate(
        a_manifest(
            capabilities={
                "composition_nodes_supported": ["TASK"],
                "objective_types_supported": ["MONO"],
                "algorithms_supported": ["TABU"],
            }
        )
    )

    assert manifest.as_capabilities_dict()["algorithms_supported"] == ["TABU"]


# -- Asynchrony is all or nothing -------------------------------------------


def test_polling_without_a_job_id_is_refused():
    # Half an async engine: the gateway could poll but would never learn what
    # to poll for. It fails on a real instance otherwise.
    with pytest.raises(ValidationError) as error:
        ManifestTransport.model_validate(
            a_transport(
                operations={
                    "solve": {"operationId": "postOptimize"},
                    "job": {"operationId": "getJob"},
                }
            )
        )

    assert "job_id" in str(error.value)


def test_a_job_id_with_nothing_to_poll_is_refused():
    with pytest.raises(ValidationError) as error:
        ManifestTransport.model_validate(
            a_transport(response_mapping={"binding": "/assignment", "job_id": "/id"})
        )

    assert "operations.job" in str(error.value)


def test_a_status_mapping_needs_something_to_poll():
    with pytest.raises(ValidationError) as error:
        ManifestTransport.model_validate(
            a_transport(
                response_mapping={
                    "binding": "/assignment",
                    "job_status": {"pointer": "/state"},
                }
            )
        )

    assert "job_status" in str(error.value)


def test_a_complete_async_engine_is_accepted_and_says_so():
    transport = ManifestTransport.model_validate(
        a_transport(
            operations={
                "solve": {"operationId": "postOptimize"},
                "job": {"operationId": "getJob"},
            },
            response_mapping={
                "binding": "/assignment",
                "job_id": "/id",
                "job_status": {"pointer": "/state", "map": {"done": "completed"}},
            },
        )
    )

    assert transport.is_asynchronous is True


def test_a_synchronous_engine_is_not_asynchronous():
    assert ManifestTransport.model_validate(a_transport()).is_asynchronous is False


def test_their_status_words_map_onto_ours():
    transport = ManifestTransport.model_validate(
        a_transport(
            operations={
                "solve": {"operationId": "postOptimize"},
                "job": {"operationId": "getJob"},
            },
            response_mapping={
                "binding": "/assignment",
                "job_id": "/id",
                "job_status": {"pointer": "/state", "map": {"DONE": "COMPLETED"}},
            },
        )
    )

    # Lower-cased on the way in, because JobStatus is lower case.
    assert transport.response_mapping.job_status.map == {"DONE": "completed"}


def test_a_status_that_maps_onto_nothing_we_have_is_refused():
    with pytest.raises(ValidationError) as error:
        ManifestTransport.model_validate(
            a_transport(
                operations={
                    "solve": {"operationId": "postOptimize"},
                    "job": {"operationId": "getJob"},
                },
                response_mapping={
                    "binding": "/assignment",
                    "job_id": "/id",
                    "job_status": {"pointer": "/state", "map": {"done": "finished"}},
                },
            )
        )

    assert "finished" in str(error.value)


# -- Authentication ---------------------------------------------------------


def test_an_api_key_needs_a_header_to_travel_in():
    with pytest.raises(ValidationError) as error:
        ManifestTransport.model_validate(a_transport(auth={"type": "api_key"}))

    assert "header" in str(error.value)


def test_a_bearer_token_may_not_name_a_header():
    # Silently ignoring it would leave an author believing their header is used.
    with pytest.raises(ValidationError) as error:
        ManifestTransport.model_validate(
            a_transport(auth={"type": "bearer", "header": "X-Token"})
        )

    assert "header" in str(error.value)


def test_no_authentication_is_the_default_and_needs_no_secret():
    transport = ManifestTransport.model_validate(a_transport())

    assert transport.auth.needs_secret is False


def test_an_authenticated_engine_says_it_needs_a_secret():
    transport = ManifestTransport.model_validate(
        a_transport(auth={"type": "api_key", "header": "X-API-Key"})
    )

    assert transport.auth.needs_secret is True


def test_a_manifest_carries_no_secret_of_its_own():
    # The credential arrives separately and is stored encrypted, so that a
    # manifest can be shown to its owner or reviewed by an admin as-is.
    with pytest.raises(ValidationError):
        ManifestTransport.model_validate(
            a_transport(auth={"type": "bearer", "token": "sk-live-1234"})
        )


# -- The OpenAPI source -----------------------------------------------------


def test_the_document_may_be_inline():
    # An engine behind an authenticating gateway may not serve its spec
    # anonymously, and inline keeps a manifest reviewable on its own.
    transport = ManifestTransport.model_validate(
        a_transport(openapi={"document": {"openapi": "3.1.0", "paths": {}}})
    )

    assert transport.openapi.document is not None


def test_a_url_and_a_document_together_are_refused():
    with pytest.raises(ValidationError):
        ManifestTransport.model_validate(
            a_transport(
                openapi={"url": "https://acme.example/o.json", "document": {"openapi": "3.1.0"}}
            )
        )


def test_neither_a_url_nor_a_document_is_refused():
    with pytest.raises(ValidationError):
        ManifestTransport.model_validate(a_transport(openapi={}))


# -- Schemas ----------------------------------------------------------------


def test_a_instance_schema_that_is_not_a_schema_is_refused():
    # Checked with the same validator class the pipeline uses, so a manifest
    # cannot pass here and then fail on every instance later.
    with pytest.raises(ValidationError) as error:
        EngineManifest.model_validate(a_manifest(instance_schema={"type": "nonsense"}))

    assert "instance_schema" in str(error.value)


def test_an_options_schema_that_is_not_a_schema_is_refused():
    with pytest.raises(ValidationError) as error:
        EngineManifest.model_validate(a_manifest(options_schema={"required": "not-a-list"}))

    assert "options_schema" in str(error.value)


def test_options_default_to_accepting_anything():
    manifest = EngineManifest.model_validate(a_manifest())

    assert manifest.options_schema["additionalProperties"] is True


# -- Identifiers ------------------------------------------------------------


def test_two_users_may_both_call_their_engine_tabu():
    assert qualify("alice", "tabu") != qualify("bob", "tabu")


def test_a_qualified_id_survives_a_url_path_unescaped():
    from urllib.parse import quote

    engine_id = qualify("alice", "acme-tabu")

    assert quote(engine_id, safe="") == engine_id


def test_a_qualified_id_splits_back_into_its_parts():
    assert split_qualified(qualify("alice", "tabu")) == ("alice", "tabu")


def test_a_built_in_id_is_not_mistaken_for_a_qualified_one():
    # This is what keeps a registered engine from ever shadowing minizinc-csp:
    # usernames cannot contain the separator, so a built-in id cannot look
    # qualified.
    assert split_qualified("minizinc-csp") is None
    assert split_qualified("evolutionary-heuristics") is None


@pytest.mark.parametrize("name", ["Acme", "acme_tabu", "-acme", "acme-", "a", "acme tabu", ""])
def test_an_unusable_engine_name_is_refused(name):
    with pytest.raises(ValidationError):
        EngineManifest.model_validate(a_manifest(engine_id=name))


def test_an_unknown_manifest_version_is_refused_by_name():
    with pytest.raises(ValidationError) as error:
        EngineManifest.model_validate(a_manifest(manifest_version="2"))

    assert "manifest_version" in str(error.value)


def test_an_unexpected_top_level_key_is_refused():
    # A typo in a field name would otherwise be accepted and ignored, which is
    # the worst of the three possible outcomes.
    with pytest.raises(ValidationError):
        EngineManifest.model_validate(a_manifest(capabilties={"typo": True}))


# -- JSON Pointers ----------------------------------------------------------


@pytest.mark.parametrize("pointer", ["", "/", "/a", "/a/b", "/a~0b", "/a~1b", "/0"])
def test_valid_pointers_are_accepted(pointer):
    assert is_json_pointer(pointer)


@pytest.mark.parametrize("pointer", ["a", "a/b", "/a~2b", "~0"])
def test_invalid_pointers_are_rejected(pointer):
    assert not is_json_pointer(pointer)


def test_a_mapping_with_a_malformed_pointer_is_refused_by_name():
    with pytest.raises(ValidationError) as error:
        ManifestTransport.model_validate(a_transport(response_mapping={"binding": "assignment"}))

    message = str(error.value)
    assert "binding" in message
    assert "6901" in message


def test_an_empty_solutions_pointer_means_the_body_is_the_list():
    transport = ManifestTransport.model_validate(
        a_transport(response_mapping={"solutions": "", "binding": "/assignment"})
    )

    assert transport.response_mapping.solutions == ""


# -- Resolving pointers -----------------------------------------------------


def test_a_pointer_reaches_into_a_nested_body():
    assert resolve_pointer({"results": [{"assignment": {"t1": "c1"}}]}, "/results/0/assignment") == {
        "t1": "c1"
    }


def test_the_empty_pointer_is_the_whole_document():
    body = [{"assignment": {}}]

    assert resolve_pointer(body, "") is body


def test_an_escaped_token_is_unescaped_before_lookup():
    assert resolve_pointer({"a/b": 1}, "/a~1b") == 1
    assert resolve_pointer({"a~b": 2}, "/a~0b") == 2


def test_a_pointer_that_misses_yields_nothing_rather_than_raising():
    # An engine may legitimately omit an optional field on some answers, so a
    # miss is a fact about one response, not a programming error.
    assert resolve_pointer({"results": []}, "/results/0/assignment") is None
    assert resolve_pointer({"a": 1}, "/b") is None
    assert resolve_pointer({"a": 1}, "/a/b") is None
    assert resolve_pointer({"a": [1]}, "/a/notanindex") is None
