"""Registering somebody else's solver, over HTTP.

Two things are being checked. The first is that the flow works end to end: a
draft is proposed from a spec, corrected, submitted, verified against the live
engine, and the engine then appears in the catalogue and can be solved on.

The second is the part that is easy to get wrong and expensive to get wrong -
that a registration is *checked* rather than trusted, that a failure keeps its
report instead of vanishing, and that somebody else's private engine is
invisible rather than forbidden.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict
from unittest.mock import patch

import httpx
import pytest

pytestmark = pytest.mark.asyncio

THEIR_SPEC: Dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "ACME Tabu"},
    "servers": [{"url": "https://acme.example"}],
    "paths": {
        "/optimize": {
            "post": {
                "operationId": "postOptimize",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {"problem": {"type": "object"}},
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
                                                "properties": {"assignment": {"type": "object"}},
                                            },
                                        }
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


def a_manifest(engine_id="tabu", **overrides) -> Dict[str, Any]:
    manifest = {
        "manifest_version": "1",
        "engine_id": engine_id,
        "display_name": "ACME Tabu",
        "type": "HEURISTIC",
        "capabilities": {
            "composition_nodes_supported": ["TASK", "SEQ"],
            "objective_types_supported": ["MONO"],
        },
        "instance_schema": {"type": "object"},
        "transport": {
            "openapi": {"document": THEIR_SPEC},
            "operations": {"solve": {"operationId": "postOptimize"}},
            "request_mapping": {"instance": "/problem"},
            "response_mapping": {"solutions": "/results", "binding": "/assignment"},
        },
    }
    manifest.update(overrides)
    return manifest


async def account(client, registration) -> tuple[dict, str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    return created.json(), tokens.json()["access_token"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


#: The gateway itself is reached over httpx too, by the test client. Stubbing
#: every outbound request would stub the request under test, so the stub has to
#: know which host is which.
GATEWAY_HOSTS = {"gateway", "testserver", "localhost"}

_real_send = httpx.AsyncClient.send


def engine_is(body=None, status=200):
    """Pretend the engine is reachable at a public address and answers this."""
    answer = body if body is not None else {"results": [{"assignment": {"t1": "c1a", "t2": "c2a"}}]}

    async def send(self, request, **kwargs):
        if request.url.host in GATEWAY_HOSTS:
            return await _real_send(self, request, **kwargs)
        return httpx.Response(
            status_code=status,
            content=json.dumps(answer).encode(),
            headers={"content-type": "application/json"},
            request=request,
        )

    return (
        patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]),
        patch.object(httpx.AsyncClient, "send", new=send),
    )


async def register(client, token, manifest=None, body=None, status=200, **extra):
    dns, send = engine_is(body, status)
    with dns, send:
        return await client.post(
            "/v1/engines",
            headers=auth(token),
            json={"manifest": manifest or a_manifest(), **extra},
        )


# -- Drafting: the part that makes this usable ------------------------------


async def test_a_manifest_is_proposed_from_a_spec(api_client, registration):
    # Registering should be correcting a draft, not authoring a document.
    _, token = await account(api_client, registration)

    response = await api_client.post(
        "/v1/engines/draft",
        headers=auth(token),
        json={"openapi_document": THEIR_SPEC, "engine_id": "tabu"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is True
    assert body["manifest"]["transport"]["response_mapping"]["binding"] == "/assignment"
    assert body["manifest"]["transport"]["request_mapping"]["instance"] == "/problem"


async def test_the_draft_says_what_each_guess_was_based_on(api_client, registration):
    _, token = await account(api_client, registration)

    body = (
        await api_client.post(
            "/v1/engines/draft",
            headers=auth(token),
            json={"openapi_document": THEIR_SPEC},
        )
    ).json()

    assert body["notes"], "a guess nobody can check is worse than no guess"
    assert any("assignment" in note for note in body["notes"])


async def test_the_draft_lists_what_the_document_cannot_answer(api_client, registration):
    _, token = await account(api_client, registration)

    body = (
        await api_client.post(
            "/v1/engines/draft",
            headers=auth(token),
            json={"openapi_document": THEIR_SPEC},
        )
    ).json()

    assert any("Widen them" in item for item in body["unresolved"])


async def test_a_draft_needs_exactly_one_source(api_client, registration):
    _, token = await account(api_client, registration)

    response = await api_client.post(
        "/v1/engines/draft",
        headers=auth(token),
        json={"openapi_document": THEIR_SPEC, "openapi_url": "https://acme.example/o.json"},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "one_source"


async def test_drafting_needs_an_account(api_client):
    response = await api_client.post("/v1/engines/draft", json={"openapi_document": THEIR_SPEC})

    assert response.status_code == 401


# -- Registration -----------------------------------------------------------


async def test_an_engine_that_answers_correctly_is_registered_and_active(
    api_client, registration
):
    _, token = await account(api_client, registration)

    response = await register(api_client, token)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "active"
    assert body["visibility"] == "private"
    assert body["verified_at"] is not None
    assert body["conformance_report"]["passed"] is True


async def test_the_engine_id_is_qualified_with_its_owner(api_client, registration):
    profile, token = await account(api_client, registration)

    body = (await register(api_client, token)).json()

    assert body["engine_id"] == f"{profile['username']}~tabu"


async def test_two_people_may_both_call_their_engine_tabu(api_client, registration):
    _, alice = await account(api_client, registration)
    _, bob = await account(api_client, registration)

    assert (await register(api_client, alice)).status_code == 201
    assert (await register(api_client, bob)).status_code == 201


async def test_the_same_person_may_not_register_the_same_name_twice(api_client, registration):
    _, token = await account(api_client, registration)
    await register(api_client, token)

    response = await register(api_client, token)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "engine_exists"


async def test_a_registered_engine_becomes_solvable(api_client, registration):
    # The whole point: it joins the catalogue and the registry, so /v1/solve
    # can route to it like any other engine.
    profile, token = await account(api_client, registration)
    await register(api_client, token)

    from openbinding_gateway.registry.engine import EngineRegistry

    engine_id = f"{profile['username']}~tabu"
    assert EngineRegistry.get_plugin(engine_id).engine_id == "tabu"
    assert EngineRegistry.get_transport(engine_id).is_federated is True


async def test_a_registration_needs_an_account(api_client):
    response = await api_client.post("/v1/engines", json={"manifest": a_manifest()})

    assert response.status_code == 401


async def test_a_manifest_with_no_transport_is_not_a_federated_engine(api_client, registration):
    _, token = await account(api_client, registration)
    manifest = a_manifest()
    del manifest["transport"]

    response = await register(api_client, token, manifest)

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "no_transport"


async def test_an_invalid_manifest_is_refused_field_by_field(api_client, registration):
    # A submission form needs to know which box was wrong, not that something was.
    _, token = await account(api_client, registration)

    response = await register(api_client, token, a_manifest(type="MAGIC"))

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_manifest"
    assert any("type" in violation["path"] for violation in detail["violations"])


# -- The allowance ----------------------------------------------------------


@pytest.fixture
def pricing():
    """A pricing service with balances that really run out."""
    from openbinding_gateway import space_client
    from openbinding_gateway.space_client import FakePricingGate

    installed = FakePricingGate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def test_registering_an_engine_spends_the_allowance(api_client, registration, pricing):
    """Asking and taking are two calls, and only the second one counts.

    ``evaluate`` answers whether this is allowed and spends nothing. Checking
    without taking means the allowance is measured against a number that never
    grows, so the limit is never reached however many engines are registered -
    and deleting one hands back an allowance nobody took.
    """
    profile, token = await account(api_client, registration)

    await register(api_client, token)

    used = pricing.consumed[uuid.UUID(profile["id"])]
    assert used["federatedEnginesLimit"] == 1


async def test_the_free_plan_runs_out_after_its_one_engine(api_client, registration, pricing):
    _, token = await account(api_client, registration)
    manifest = a_manifest()
    await register(api_client, token, manifest)

    second = a_manifest("annealing")
    response = await register(api_client, token, second)

    assert response.status_code == 402
    assert response.json()["detail"]["code"] == "quota_exceeded"


async def test_deleting_gives_the_allowance_back(api_client, registration, pricing):
    profile, token = await account(api_client, registration)
    await register(api_client, token)

    await api_client.delete(
        f"/v1/engines/registered/{profile['username']}~tabu", headers=auth(token)
    )

    assert pricing.consumed[uuid.UUID(profile["id"])]["federatedEnginesLimit"] == 0
    # And the freed allowance is usable rather than merely recorded.
    assert (await register(api_client, token)).status_code == 201


async def test_a_registration_that_never_happened_costs_nothing(
    api_client, registration, pricing
):
    # Otherwise the allowance is spent on an engine with no row, which its
    # owner can never delete to get back.
    profile, token = await account(api_client, registration)
    manifest = a_manifest()
    manifest["transport"]["openapi"] = {"url": "not-a-url"}

    response = await register(api_client, token, manifest)

    assert response.status_code == 422
    assert pricing.consumed.get(uuid.UUID(profile["id"]), {}).get(
        "federatedEnginesLimit", 0
    ) == 0


# -- Verification, and failing usefully -------------------------------------


async def test_an_engine_that_cannot_be_reached_is_kept_with_its_report(
    api_client, registration
):
    # A rejection would tell the owner less than a stored report does.
    _, token = await account(api_client, registration)

    with patch("socket.getaddrinfo", side_effect=OSError("no route")):
        response = await api_client.post(
            "/v1/engines", headers=auth(token), json={"manifest": a_manifest()}
        )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "failed"
    assert body["conformance_report"]["passed"] is False
    assert body["conformance_report"]["findings"][0]["code"] == "unreachable"


async def test_a_wrong_mapping_names_the_field_to_change(api_client, registration):
    _, token = await account(api_client, registration)
    manifest = a_manifest()
    manifest["transport"]["response_mapping"]["binding"] = "/nowhere"

    body = (await register(api_client, token, manifest)).json()

    assert body["status"] == "failed"
    finding = body["conformance_report"]["findings"][0]
    assert finding["field"] == "transport.response_mapping.binding"


async def test_an_engine_returning_an_illegal_binding_fails_verification(
    api_client, registration
):
    _, token = await account(api_client, registration)

    body = (
        await register(
            api_client, token, body={"results": [{"assignment": {"t1": "c2a", "t2": "c2b"}}]}
        )
    ).json()

    assert body["status"] == "failed"
    assert "illegal_candidate" in [
        f["code"] for f in body["conformance_report"]["findings"]
    ]


async def test_a_failed_engine_is_not_usable_but_is_still_listed_to_its_owner(
    api_client, registration
):
    _, token = await account(api_client, registration)
    with patch("socket.getaddrinfo", side_effect=OSError("no route")):
        await api_client.post("/v1/engines", headers=auth(token), json={"manifest": a_manifest()})

    listing = await api_client.get("/v1/engines/registered", headers=auth(token))

    assert listing.status_code == 200
    assert listing.json()[0]["status"] == "failed"


async def test_verification_can_be_asked_for_again(api_client, registration):
    # The ordinary case: the engine simply was not running yet.
    profile, token = await account(api_client, registration)
    with patch("socket.getaddrinfo", side_effect=OSError("no route")):
        await api_client.post("/v1/engines", headers=auth(token), json={"manifest": a_manifest()})

    dns, send = engine_is()
    with dns, send:
        response = await api_client.post(
            f"/v1/engines/registered/{profile['username']}~tabu/verify", headers=auth(token)
        )

    assert response.json()["status"] == "active"


# -- Credentials ------------------------------------------------------------


@pytest.fixture
def federation_key(monkeypatch):
    """A deployment that can store credentials at all.

    Without a key the gateway refuses to keep one rather than keeping it in the
    clear, so these tests have to configure what a real deployment configures.
    """
    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.security.secrets import generate_key

    monkeypatch.setenv("FEDERATION_SECRET_KEY", generate_key())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def test_a_credential_cannot_be_stored_without_a_key(
    api_client, registration, monkeypatch
):
    # Refusing is the right answer: the alternative is a third party's secret
    # sitting in the database in the clear.
    #
    # The key is deleted explicitly because importing `main` runs load_dotenv(),
    # which puts the developer's own .env into the process - so once a deployment
    # here was configured, this test started asserting against that machine
    # rather than against an unconfigured gateway.
    from openbinding_gateway.core.settings import get_settings

    monkeypatch.delenv("FEDERATION_SECRET_KEY", raising=False)
    get_settings.cache_clear()

    _, token = await account(api_client, registration)
    manifest = a_manifest()
    manifest["transport"]["auth"] = {"type": "bearer"}

    response = await register(api_client, token, manifest, credential="sk-live-1234")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "secrets_unavailable"
    get_settings.cache_clear()


async def test_a_credential_is_never_returned(api_client, registration, federation_key):
    _, token = await account(api_client, registration)
    manifest = a_manifest()
    manifest["transport"]["auth"] = {"type": "bearer"}

    body = (await register(api_client, token, manifest, credential="sk-live-1234")).json()

    assert body["has_credential"] is True
    assert "sk-live-1234" not in json.dumps(body)
    assert "credential" not in body["manifest"].get("transport", {})


async def test_a_credential_can_be_replaced(api_client, registration, federation_key):
    profile, token = await account(api_client, registration)
    manifest = a_manifest()
    manifest["transport"]["auth"] = {"type": "bearer"}
    await register(api_client, token, manifest, credential="old")

    response = await api_client.post(
        f"/v1/engines/registered/{profile['username']}~tabu/credential",
        headers=auth(token),
        json={"credential": "new"},
    )

    assert response.status_code == 200
    assert response.json()["has_credential"] is True


# -- Ownership --------------------------------------------------------------


async def test_somebody_elses_engine_is_absent_rather_than_forbidden(
    api_client, registration
):
    # Telling a stranger that alice~tabu exists but is not theirs tells them
    # about Alice. Same rule as a foreign job.
    alice, alice_token = await account(api_client, registration)
    await register(api_client, alice_token)
    _, bob_token = await account(api_client, registration)

    response = await api_client.get(
        f"/v1/engines/registered/{alice['username']}~tabu", headers=auth(bob_token)
    )

    assert response.status_code == 404


async def test_the_catalogue_hides_a_private_engine_from_everybody_else(
    api_client, registration
):
    alice, alice_token = await account(api_client, registration)
    await register(api_client, alice_token)
    _, bob_token = await account(api_client, registration)

    listed = {
        entry["id"] for entry in (await api_client.get("/v1/engines", headers=auth(bob_token))).json()
    }

    assert f"{alice['username']}~tabu" not in listed


async def test_the_catalogue_shows_an_owner_their_own_engine(api_client, registration):
    alice, alice_token = await account(api_client, registration)
    await register(api_client, alice_token)

    listed = {
        entry["id"]
        for entry in (await api_client.get("/v1/engines", headers=auth(alice_token))).json()
    }

    assert f"{alice['username']}~tabu" in listed


async def test_only_the_owner_may_delete(api_client, registration):
    alice, alice_token = await account(api_client, registration)
    await register(api_client, alice_token)
    _, bob_token = await account(api_client, registration)

    response = await api_client.delete(
        f"/v1/engines/registered/{alice['username']}~tabu", headers=auth(bob_token)
    )

    assert response.status_code == 404


async def test_deleting_removes_it_from_the_registry(api_client, registration):
    profile, token = await account(api_client, registration)
    await register(api_client, token)
    engine_id = f"{profile['username']}~tabu"

    response = await api_client.delete(
        f"/v1/engines/registered/{engine_id}", headers=auth(token)
    )

    from openbinding_gateway.registry.engine import EngineRegistry

    assert response.status_code == 204
    assert EngineRegistry.federated_entry(engine_id) is None


# -- Hiding an engine is not the same as refusing to use it -----------------


async def test_a_stranger_cannot_solve_on_a_private_engine(
    api_client, registration, micro_placement_instance
):
    """Absent from the catalogue was not enough: naming it still worked.

    Before the check, a stranger who guessed the id had their instance
    validated against Alice's manifest - so they learned the engine exists and
    what it accepts, and a compatible instance would have been solved on it.
    """
    alice, alice_token = await account(api_client, registration)
    await register(api_client, alice_token)
    _, bob_token = await account(api_client, registration)

    response = await api_client.post(
        "/v1/solve",
        headers=auth(bob_token),
        json={
            "engine_id": f"{alice['username']}~tabu",
            "instance": micro_placement_instance,
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "engine_not_found"


async def test_analysing_against_a_private_engine_leaks_nothing_either(
    api_client, registration, micro_placement_instance
):
    # /v1/analyze names an engine and validates against its manifest, so
    # guarding only /v1/solve would leave the same question answerable.
    alice, alice_token = await account(api_client, registration)
    await register(api_client, alice_token)

    response = await api_client.post(
        "/v1/analyze",
        json={
            "engine_id": f"{alice['username']}~tabu",
            "instance": micro_placement_instance,
        },
    )

    assert response.status_code == 404


async def test_an_engine_that_failed_verification_cannot_be_solved_on(
    api_client, registration, micro_placement_instance
):
    # "Registered but unusable" was a status nothing consulted.
    profile, token = await account(api_client, registration)
    with patch("socket.getaddrinfo", side_effect=OSError("no route")):
        await api_client.post("/v1/engines", headers=auth(token), json={"manifest": a_manifest()})

    response = await api_client.post(
        "/v1/solve",
        headers=auth(token),
        json={
            "engine_id": f"{profile['username']}~tabu",
            "instance": micro_placement_instance,
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "engine_not_usable"


async def test_a_disabled_engine_cannot_be_solved_on(
    api_client, registration, db_session, micro_placement_instance
):
    # Otherwise an administrator's off switch only changes a label.
    from sqlalchemy import select

    from openbinding_gateway.db.models import User, UserRole

    profile, token = await account(api_client, registration)
    await register(api_client, token)

    admin_details, admin_token = await account(api_client, registration)
    admin = (
        await db_session.execute(select(User).where(User.username == admin_details["username"]))
    ).scalar_one()
    admin.role = UserRole.ADMIN
    await db_session.flush()
    await api_client.post(
        f"/v1/admin/engines/{profile['username']}~tabu/disable", headers=auth(admin_token)
    )

    response = await api_client.post(
        "/v1/solve",
        headers=auth(token),
        json={
            "engine_id": f"{profile['username']}~tabu",
            "instance": micro_placement_instance,
        },
    )

    assert response.status_code == 409


async def test_a_built_in_engine_is_never_refused_by_this_check(
    api_client, registration, micro_placement_instance
):
    # Its liveness is a health check, not a registration state.
    from openbinding_gateway.registry.engine import EngineRegistry

    assert EngineRegistry.refusal_for("random-search", None) is None


# -- Publication and review -------------------------------------------------


async def test_asking_to_publish_is_not_being_published(api_client, registration):
    profile, token = await account(api_client, registration)
    await register(api_client, token)

    response = await api_client.post(
        f"/v1/engines/registered/{profile['username']}~tabu/publish", headers=auth(token)
    )

    assert response.json()["visibility"] == "pending_review"

    anonymous = {entry["id"] for entry in (await api_client.get("/v1/engines")).json()}
    assert f"{profile['username']}~tabu" not in anonymous


async def test_an_unverified_engine_may_not_ask_to_be_published(api_client, registration):
    # It would put a broken engine in everybody's catalogue.
    profile, token = await account(api_client, registration)
    with patch("socket.getaddrinfo", side_effect=OSError("no route")):
        await api_client.post("/v1/engines", headers=auth(token), json={"manifest": a_manifest()})

    response = await api_client.post(
        f"/v1/engines/registered/{profile['username']}~tabu/publish", headers=auth(token)
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "not_verified"


async def test_the_review_queue_is_for_administrators_only(api_client, registration):
    _, token = await account(api_client, registration)

    response = await api_client.get("/v1/admin/engines", headers=auth(token))

    assert response.status_code in (401, 403)


async def test_an_approved_engine_becomes_visible_to_everybody(
    api_client, registration, db_session
):
    from sqlalchemy import select

    from openbinding_gateway.db.models import User, UserRole

    profile, token = await account(api_client, registration)
    await register(api_client, token)
    await api_client.post(
        f"/v1/engines/registered/{profile['username']}~tabu/publish", headers=auth(token)
    )

    admin_details, admin_token = await account(api_client, registration)
    admin = (
        await db_session.execute(select(User).where(User.username == admin_details["username"]))
    ).scalar_one()
    admin.role = UserRole.ADMIN
    await db_session.flush()

    approved = await api_client.post(
        f"/v1/admin/engines/{profile['username']}~tabu/approve", headers=auth(admin_token)
    )

    assert approved.status_code == 200, approved.text
    assert approved.json()["visibility"] == "public"

    anonymous = {entry["id"] for entry in (await api_client.get("/v1/engines")).json()}
    assert f"{profile['username']}~tabu" in anonymous


async def test_the_review_queue_shows_what_is_waiting(api_client, registration, db_session):
    from sqlalchemy import select

    from openbinding_gateway.db.models import User, UserRole

    profile, token = await account(api_client, registration)
    await register(api_client, token)
    await api_client.post(
        f"/v1/engines/registered/{profile['username']}~tabu/publish", headers=auth(token)
    )

    admin_details, admin_token = await account(api_client, registration)
    admin = (
        await db_session.execute(select(User).where(User.username == admin_details["username"]))
    ).scalar_one()
    admin.role = UserRole.ADMIN
    await db_session.flush()

    waiting = await api_client.get("/v1/admin/engines?pending=true", headers=auth(admin_token))

    assert [entry["engine_id"] for entry in waiting.json()] == [f"{profile['username']}~tabu"]


async def test_an_administrator_can_turn_an_engine_off_without_deleting_it(
    api_client, registration, db_session
):
    from sqlalchemy import select

    from openbinding_gateway.db.models import User, UserRole

    profile, token = await account(api_client, registration)
    await register(api_client, token)

    admin_details, admin_token = await account(api_client, registration)
    admin = (
        await db_session.execute(select(User).where(User.username == admin_details["username"]))
    ).scalar_one()
    admin.role = UserRole.ADMIN
    await db_session.flush()

    response = await api_client.post(
        f"/v1/admin/engines/{profile['username']}~tabu/disable", headers=auth(admin_token)
    )

    assert response.json()["status"] == "disabled"
    # Still there, so its owner can see what happened.
    assert (
        await api_client.get(
            f"/v1/engines/registered/{profile['username']}~tabu", headers=auth(token)
        )
    ).status_code == 200
