"""Reading somebody's spec so they do not have to.

Writing a transport block by hand means finding the right operationId and
working out JSON Pointers into bodies you did not design. Doable, and almost
nobody would - which would leave federation with a wall in front of it.

What matters in these tests is not that every guess is right. It is that the
guesses are *checkable*: each one carries a note saying what it was based on,
and anything the document does not answer is listed as unresolved rather than
filled in with something plausible. A wrong guess costs one correction in a
form; a confident wrong guess costs a debugging session.
"""

from __future__ import annotations

from openbinding_gateway.federation.inference import draft_manifest, infer
from openbinding_gateway.models.manifest import EngineManifest

TIDY_SYNC_SPEC = {
    "openapi": "3.1.0",
    "info": {"title": "ACME Tabu", "description": "Tabu search over binding problems."},
    "servers": [{"url": "https://acme.example/api"}],
    "paths": {
        "/optimize": {
            "post": {
                "operationId": "postOptimize",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "problem": {"type": "object"},
                                    "params": {"type": "object"},
                                },
                            }
                        }
                    }
                },
                "responses": {
                    "200": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "results": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "assignment": {"type": "object"},
                                                    "score": {"type": "number"},
                                                },
                                            },
                                        }
                                    },
                                }
                            }
                        }
                    }
                },
            }
        },
        "/health": {"get": {"operationId": "getHealth"}},
    },
}


# -- The tidy case: everything is inferable ---------------------------------


def test_the_solve_operation_is_found():
    draft = infer(TIDY_SYNC_SPEC)

    assert draft.transport["operations"]["solve"] == {"operationId": "postOptimize"}


def test_the_request_mapping_finds_their_field_names():
    draft = infer(TIDY_SYNC_SPEC)

    assert draft.transport["request_mapping"] == {"instance": "/problem", "options": "/params"}


def test_the_response_mapping_finds_the_binding():
    draft = infer(TIDY_SYNC_SPEC)

    mapping = draft.transport["response_mapping"]
    assert mapping["solutions"] == "/results"
    assert mapping["binding"] == "/assignment"
    assert mapping["objective"] == "/score"


def test_a_health_operation_is_picked_up():
    assert infer(TIDY_SYNC_SPEC).transport["operations"]["health"] == {
        "operationId": "getHealth"
    }


def test_a_synchronous_engine_is_not_given_a_job_operation():
    draft = infer(TIDY_SYNC_SPEC)

    assert "job" not in draft.transport["operations"]
    assert "job_id" not in draft.transport["response_mapping"]


def test_every_guess_carries_a_reason():
    # A proposal a user cannot check is worse than no proposal.
    draft = infer(TIDY_SYNC_SPEC)

    assert any("postOptimize" in note or "/optimize" in note for note in draft.notes)
    assert any("assignment" in note for note in draft.notes)


def test_a_complete_draft_says_it_is_complete():
    assert infer(TIDY_SYNC_SPEC).is_complete is True


def test_the_drafted_manifest_is_valid_as_it_stands():
    # The point of the whole exercise: what comes out can be submitted after
    # correcting the guesses, not after learning the format.
    manifest, _ = draft_manifest(
        TIDY_SYNC_SPEC, engine_id="tabu", openapi_url="https://acme.example/openapi.json"
    )

    parsed = EngineManifest.model_validate(manifest)

    assert parsed.transport.response_mapping.binding == "/assignment"
    assert parsed.transport.openapi.url == "https://acme.example/openapi.json"


def test_a_draft_from_a_pasted_document_carries_that_document():
    """The obvious path has to work: paste a spec, register what comes back.

    A draft built from a pasted document used to keep a placeholder URL, so
    registering it failed while trying to fetch a URL the author never typed -
    on the one route somebody takes precisely because their spec is not
    published.
    """
    manifest, _ = draft_manifest(TIDY_SYNC_SPEC, engine_id="tabu")

    parsed = EngineManifest.model_validate(manifest)

    assert parsed.transport.openapi.url is None
    assert parsed.transport.openapi.document == TIDY_SYNC_SPEC


def test_a_url_is_recorded_when_that_is_how_it_arrived():
    manifest, _ = draft_manifest(
        TIDY_SYNC_SPEC, engine_id="tabu", openapi_url="https://acme.example/openapi.json"
    )

    parsed = EngineManifest.model_validate(manifest)

    assert parsed.transport.openapi.url == "https://acme.example/openapi.json"
    assert parsed.transport.openapi.document is None


def test_the_manifest_borrows_the_title_and_description():
    manifest, _ = draft_manifest(TIDY_SYNC_SPEC, engine_id="tabu")

    assert manifest["display_name"] == "ACME Tabu"
    assert "Tabu search" in manifest["description"]


def test_capabilities_are_guessed_narrowly_on_purpose():
    # The dangerous direction is over-generous: advertising what the engine may
    # not enforce means the gateway routes instances to it accordingly.
    manifest, draft = draft_manifest(TIDY_SYNC_SPEC, engine_id="tabu")

    assert manifest["capabilities"]["composition_nodes_supported"] == ["TASK", "SEQ"]
    assert manifest["capabilities"]["constraints_supported"] == []
    assert any("Widen them" in item for item in draft.unresolved)


# -- Asynchronous engines ---------------------------------------------------


ASYNC_SPEC = {
    "openapi": "3.1.0",
    "servers": [{"url": "https://acme.example"}],
    "paths": {
        "/v1/runs": {
            "post": {
                "operationId": "createRun",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {"type": "object", "properties": {"instance": {"type": "object"}}}
                        }
                    }
                },
                "responses": {
                    "202": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {"run_id": {"type": "string"}},
                                }
                            }
                        }
                    }
                },
            }
        },
        "/v1/runs/{runId}": {
            "get": {
                "operationId": "getRun",
                "responses": {
                    "200": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "state": {"type": "string"},
                                        "solutions": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {"binding": {"type": "object"}},
                                            },
                                        },
                                    },
                                }
                            }
                        }
                    }
                },
            }
        },
    },
}


def test_an_asynchronous_engine_gets_both_operations():
    draft = infer(ASYNC_SPEC)

    assert draft.transport["operations"]["solve"] == {"operationId": "createRun"}
    assert draft.transport["operations"]["job"] == {"operationId": "getRun"}


def test_the_job_identifier_is_found_in_the_receipt():
    assert infer(ASYNC_SPEC).transport["response_mapping"]["job_id"] == "/run_id"


def test_the_solutions_are_read_from_the_polling_response():
    # They are not in the receipt; looking for them there would find nothing.
    mapping = infer(ASYNC_SPEC).transport["response_mapping"]

    assert mapping["solutions"] == "/solutions"
    assert mapping["binding"] == "/binding"


def test_the_status_vocabulary_is_left_for_a_person():
    # We can find the field. What "PENDING" means to this engine is not in the
    # document, and guessing it would be inventing behaviour.
    draft = infer(ASYNC_SPEC)

    assert draft.transport["response_mapping"]["job_status"]["pointer"] == "/state"
    assert draft.transport["response_mapping"]["job_status"]["map"] == {}
    assert any("queued, running, completed or failed" in item for item in draft.unresolved)


def test_an_inferred_async_manifest_needs_its_status_map_before_it_parses():
    # The interlock from B1 doing its job on a draft: an async engine with no
    # status map is still valid, but it is the thing the wizard must ask about.
    manifest, _ = draft_manifest(ASYNC_SPEC, engine_id="runner")

    parsed = EngineManifest.model_validate(manifest)

    assert parsed.transport.is_asynchronous is True


# -- Awkward documents ------------------------------------------------------


def test_a_body_that_is_the_instance_is_recognised():
    spec = {
        "openapi": "3.1.0",
        "paths": {
            "/solve": {
                "post": {
                    "operationId": "solve",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {"type": "object", "properties": {"tasks": {"type": "array"}}}
                            }
                        }
                    },
                    "responses": {},
                }
            }
        },
    }

    assert infer(spec).transport["request_mapping"]["instance"] == ""


def test_a_response_that_is_itself_the_list_is_recognised():
    spec = {
        "openapi": "3.1.0",
        "paths": {
            "/solve": {
                "post": {
                    "operationId": "solve",
                    "responses": {
                        "200": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {"binding": {"type": "object"}},
                                        },
                                    }
                                }
                            }
                        }
                    },
                }
            }
        },
    }

    mapping = infer(spec).transport["response_mapping"]

    assert mapping["solutions"] == ""
    assert mapping["binding"] == "/binding"


def test_references_are_followed():
    spec = {
        "openapi": "3.1.0",
        "components": {
            "schemas": {
                "Solution": {"type": "object", "properties": {"assignment": {"type": "object"}}},
                "Answer": {
                    "type": "object",
                    "properties": {
                        "results": {
                            "type": "array",
                            "items": {"$ref": "#/components/schemas/Solution"},
                        }
                    },
                },
            }
        },
        "paths": {
            "/solve": {
                "post": {
                    "operationId": "solve",
                    "responses": {
                        "200": {
                            "content": {
                                "application/json": {"schema": {"$ref": "#/components/schemas/Answer"}}
                            }
                        }
                    },
                }
            }
        },
    }

    assert infer(spec).transport["response_mapping"]["binding"] == "/assignment"


def test_a_remote_reference_is_not_fetched():
    # Following one would make this helper an SSRF primitive, in a function
    # nobody expects to make requests.
    spec = {
        "openapi": "3.1.0",
        "paths": {
            "/solve": {
                "post": {
                    "operationId": "solve",
                    "responses": {
                        "200": {
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "https://evil.example/schema.json"}
                                }
                            }
                        }
                    },
                }
            }
        },
    }

    draft = infer(spec)

    assert draft.is_complete is False


def test_several_posts_with_no_hint_are_left_to_a_person():
    spec = {
        "openapi": "3.1.0",
        "paths": {
            "/alpha": {"post": {"operationId": "alpha", "responses": {}}},
            "/beta": {"post": {"operationId": "beta", "responses": {}}},
        },
    }

    draft = infer(spec)

    assert draft.is_complete is False
    # The decision is handed back rather than made by picking whichever came
    # first in the document.
    assert any("Which operation submits an instance" in item for item in draft.unresolved)
    assert any("none of them mentions solving" in note for note in draft.notes)


def test_the_named_post_wins_when_there_are_several():
    spec = {
        "openapi": "3.1.0",
        "paths": {
            "/login": {"post": {"operationId": "login", "responses": {}}},
            "/optimize": {
                "post": {
                    "operationId": "postOptimize",
                    "responses": {
                        "200": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "solutions": {
                                                "type": "array",
                                                "items": {
                                                    "type": "object",
                                                    "properties": {"binding": {"type": "object"}},
                                                },
                                            }
                                        },
                                    }
                                }
                            }
                        }
                    },
                }
            },
        },
    }

    assert infer(spec).transport["operations"]["solve"] == {"operationId": "postOptimize"}


def test_an_operation_with_no_id_cannot_be_mapped_and_says_so():
    # Mappings refer to operations by id precisely so a reorganised path does
    # not break a registration, which means an id is not optional here.
    spec = {"openapi": "3.1.0", "paths": {"/solve": {"post": {"responses": {}}}}}

    draft = infer(spec)

    assert draft.is_complete is False
    assert any("operationId" in item for item in draft.unresolved)


def test_a_missing_binding_field_is_the_one_thing_that_must_be_asked():
    spec = {
        "openapi": "3.1.0",
        "paths": {
            "/solve": {
                "post": {
                    "operationId": "solve",
                    "responses": {
                        "200": {
                            "content": {
                                "application/json": {
                                    "schema": {"type": "object", "properties": {"cost": {"type": "number"}}}
                                }
                            }
                        }
                    },
                }
            }
        },
    }

    draft = infer(spec)

    assert draft.is_complete is False
    assert any("task-to-candidate map" in item for item in draft.unresolved)


def test_a_document_with_no_servers_says_the_base_url_is_needed():
    spec = {"openapi": "3.1.0", "paths": {"/solve": {"post": {"operationId": "s", "responses": {}}}}}

    assert any("base_url" in item for item in infer(spec).unresolved)


def test_something_that_is_not_a_spec_is_refused_gently():
    draft = infer({"hello": "world"})

    assert draft.transport == {}
    assert "OpenAPI" in draft.unresolved[0]


def test_a_document_with_no_post_says_there_is_nothing_to_solve_with():
    spec = {"openapi": "3.1.0", "paths": {"/health": {"get": {"operationId": "h"}}}}

    draft = infer(spec)

    assert draft.is_complete is False
    assert any("no POST" in note for note in draft.notes)
