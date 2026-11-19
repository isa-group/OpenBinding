"""Environment feed keys: minted once, limited, revocable, never logged, and refused everywhere but their feed (F4 A5).

A feed key (``obe_…``) belongs to its environment: it carries no permission list and names no user. Every route that
resolves a credential refuses it with 401 ``environment_key_elsewhere``; a ``counted_caller`` route answers it as it
answers nobody; the routes that read no credential ignore it. The walk below is generated from the router, so a new
route must be classified.
"""

from __future__ import annotations

import logging
import re
import uuid

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select

from _b1_helpers import gate, make_key  # noqa: F401
from _environment_api import code, env, team
from openbinding_gateway.access import dependencies
from openbinding_gateway.core.logging import JsonFormatter, redact
from openbinding_gateway.db.models import AuditEvent, CompositionEnvironment, CompositionEnvironmentKey, User
from openbinding_gateway.main import app
from openbinding_gateway.access.dependencies import environment_for_feed_key
from openbinding_gateway.security import feed_keys as keys

pytestmark = pytest.mark.asyncio

KEY_SHAPE = re.compile(r"^obe_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$")


async def mint(client, t, headers=None, slug="production", label="tomatometer"):
    return await client.post(f"{t.environments}/{slug}/keys", headers=headers or t.owner, json={"label": label})


async def test_a_key_is_shown_once_and_only_its_hash_is_kept(api_client, registration, db_session, gate, caplog):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t)
    caplog.set_level(logging.DEBUG)

    created = await mint(api_client, t)

    assert created.status_code == 201, created.text
    assert created.headers["Cache-Control"] == "no-store"
    secret = created.json()["secret"]
    assert KEY_SHAPE.fullmatch(secret)
    key = created.json()["key"]
    assert key["hint"] == secret[:12] + "…" and key["label"] == "tomatometer" and key["revokedAt"] is None
    assert key["createdBy"] == t.ids["owner_username"] and key["creatorIsMember"] is True
    row = await db_session.scalar(select(CompositionEnvironmentKey))
    assert row.prefix == secret[:12] and row.secret_hash == keys.hash_key(secret) and secret not in row.secret_hash

    view = await api_client.get(f"{t.environments}/production", headers=t.owner)
    assert secret not in view.text and view.json()["keyCount"] == 1
    assert [item["id"] for item in view.json()["keys"]] == [key["id"]]
    assert view.json()["keys"][0]["lastUsedAt"] is None
    # A VIEWER sees how many, never which.
    viewer = (await api_client.get(f"{t.environments}/production", headers=t.viewer)).json()
    assert viewer["keys"] is None and viewer["keyCount"] == 1
    audited = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.environment_key_created"))
    assert audited.detail["prefix"] == row.prefix and secret not in str(audited.detail)
    assert all(secret not in record.getMessage() for record in caplog.records)


async def test_two_live_keys_at_most_and_revocation(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t)
    first = (await mint(api_client, t)).json()
    second = await mint(api_client, t, label="rotation")
    assert second.status_code == 201

    third = await mint(api_client, t)
    assert third.status_code == 409 and code(third) == "feed_key_limit"

    url = f"{t.environments}/production/keys/{first['key']['id']}"
    assert (await api_client.delete(url, headers=t.admin)).status_code == 204
    again = await api_client.delete(url, headers=t.admin)
    assert again.status_code == 404
    assert (await api_client.delete(f"{t.environments}/production/keys/nope", headers=t.admin)).status_code == 404
    assert (await mint(api_client, t)).status_code == 201

    assert await environment_for_feed_key(db_session, first["secret"]) is None
    found = await environment_for_feed_key(db_session, second.json()["secret"])
    assert found is not None and found.slug == "production"
    view = (await api_client.get(f"{t.environments}/production", headers=t.owner)).json()
    assert view["keyCount"] == 2
    revoked = [item for item in view["keys"] if item["revokedAt"]]
    assert [item["id"] for item in revoked] == [first["key"]["id"]]
    actions = (await db_session.scalars(select(AuditEvent.action).where(AuditEvent.action.like("%key_%")))).all()
    assert sorted(actions) == ["composition.environment_key_created"] * 3 + ["composition.environment_key_revoked"]


async def test_only_an_admin_mints_and_revokes(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t)
    created = (await mint(api_client, t)).json()
    for headers in (t.member, t.viewer):
        refused = await mint(api_client, t, headers)
        assert refused.status_code == 403 and code(refused) == "organization_forbidden"
        revoke = await api_client.delete(f"{t.environments}/production/keys/{created['key']['id']}", headers=headers)
        assert revoke.status_code == 403
    outsider = await mint(api_client, t, t.outsider)
    assert outsider.status_code == 404

    without = await make_key(api_client, t.owner, ["compositions:read", "compositions:write"])
    refused = await mint(api_client, t, without)
    assert refused.status_code == 403 and code(refused) == "insufficient_api_key_permission"
    assert refused.json()["detail"]["missing_permissions"] == ["keys:write"]
    with_keys = await make_key(api_client, t.owner, ["compositions:write", "keys:write"])
    assert (await mint(api_client, t, with_keys)).status_code == 201


async def test_a_key_outlives_its_creator(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    await env(api_client, t)
    created = (await mint(api_client, t, t.admin)).json()
    removed = await api_client.delete(f"/v1/organizations/{t.org}/members/{t.ids['admin']}", headers=t.owner)
    assert removed.status_code == 204
    user = await db_session.get(User, uuid.UUID(t.ids["admin"]))
    user.is_active = False
    await db_session.commit()

    found = await environment_for_feed_key(db_session, created["secret"])

    assert isinstance(found, CompositionEnvironment)
    view = (await api_client.get(f"{t.environments}/production", headers=t.owner)).json()
    assert view["keys"][0]["creatorIsMember"] is False


async def test_a_personal_key_is_never_a_feed_key(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate, versions=False)
    personal = (await make_key(api_client, t.owner, ["compositions:read"]))["X-API-Key"]
    assert await environment_for_feed_key(db_session, personal) is None
    assert await environment_for_feed_key(db_session, "obe_00000000_nothing") is None
    assert await environment_for_feed_key(db_session, "obe_") is None


def test_logs_redact_both_kinds_of_key():
    line = "auth obk_1a2b3c4d_secretpart and obe_5e6f7a8b_othersecret, done"
    assert redact(line) == "auth [REDACTED] and [REDACTED], done"
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "key=%s", ("obe_1234abcd_zzz",), None)
    assert "obe_1234abcd_zzz" not in JsonFormatter().format(record)


def test_the_key_format():
    minted = keys.mint()
    assert KEY_SHAPE.fullmatch(minted.secret) and keys.prefix_of(minted.secret) == minted.prefix
    assert keys.looks_like_feed_key(minted.secret) and not keys.looks_like_feed_key("obk_1_2")
    assert keys.prefix_of("obk_1a2b3c4d_x") is None and keys.prefix_of("obe__x") is None
    assert len({keys.mint().secret for _ in range(50)}) == 50


# -- The key opens nothing else ----------------------------------------------------------------------------

#: The routes that read no credential at all: an environment key is ignored there. A new one must be added here.
NO_CREDENTIAL_ROUTES = {
    ("GET", "/health"),
    ("GET", "/health/live"),
    ("GET", "/health/ready"),
    ("GET", "/v1/auth/config"),
    ("GET", "/v1/auth/identity/callback"),
    ("GET", "/v1/auth/identity/login"),
    ("GET", "/v1/auth/identity/pending"),
    ("GET", "/v1/avatars"),
    ("GET", "/v1/avatars/{name}"),
    ("GET", "/v1/bim/templates"),
    ("GET", "/v1/bim/templates/{template:path}"),
    ("GET", "/v1/compositions/schema"),
    ("GET", "/v1/engines/protocol"),
    ("GET", "/v1/notifications/stream"),
    ("GET", "/v1/organizations/{org}/avatar/{digest}"),
    ("GET", "/v1/plans/pricing"),
    ("POST", "/v1/auth/identity/complete"),
    ("POST", "/v1/auth/identity/logout"),
    ("POST", "/v1/auth/identity/session"),
    ("POST", "/v1/auth/login"),
    ("POST", "/v1/auth/password-reset/complete"),
    ("POST", "/v1/auth/password-reset/request"),
    ("POST", "/v1/auth/register"),
}
#: The only route that accepts an environment key: its feed.
FEED_ROUTES = {("GET", "/v1/organizations/{org}/compositions/{composition}/environments/{environment}/composition")}
RESOLVING = (dependencies.get_current_user, dependencies.get_reader, dependencies.get_optional_user, dependencies.solve_caller)


def depends_on(dependant, call) -> bool:
    return any(item.call is call or depends_on(item, call) for item in dependant.dependencies)


def classified() -> dict[str, set[tuple[str, str]]]:
    found: dict[str, set[tuple[str, str]]] = {"resolving": set(), "counted": set(), "none": set(), "feed": set()}
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if not isinstance(route, APIRoute):
                continue
            if depends_on(route.dependant, dependencies.get_feed_reader):
                kind = "feed"
            elif any(depends_on(route.dependant, call) for call in RESOLVING):
                kind = "resolving"
            elif depends_on(route.dependant, dependencies.counted_caller):
                kind = "counted"
            else:
                kind = "none"
            found[kind].update((method, route.path) for method in route.methods - {"HEAD", "OPTIONS"})
    return found


ROUTES = classified()
FEED_KEY = {"X-API-Key": "obe_0a1b2c3d_" + "x" * 43}


def concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


def test_every_route_is_classified():
    assert ROUTES["feed"] == FEED_ROUTES
    assert ROUTES["none"] == NO_CREDENTIAL_ROUTES
    assert ROUTES["counted"] == {
        ("POST", "/v1/bim/validate"), ("POST", "/v1/compositions/diff"), ("POST", "/v1/compositions/parse"),
        ("POST", "/v1/compositions/serialise"), ("POST", "/v1/compositions/validate"),
    }


@pytest.mark.parametrize(("method", "path"), sorted(ROUTES["resolving"]))
async def test_a_route_that_resolves_a_credential_refuses_an_environment_key(api_client, method, path):
    for headers in (FEED_KEY, {"Authorization": f"Bearer {FEED_KEY['X-API-Key']}"}):
        response = await api_client.request(method, concrete(path), headers=headers)
        assert response.status_code == 401, (method, path, response.status_code, response.text[:200])
        assert code(response) == "environment_key_elsewhere"


@pytest.mark.parametrize(("method", "path"), sorted(ROUTES["counted"]))
async def test_a_counted_route_answers_an_environment_key_as_nobody(api_client, method, path):
    nobody = await api_client.request(method, concrete(path), content=b"{}", headers={"content-type": "application/json"})
    keyed = await api_client.request(
        method, concrete(path), content=b"{}", headers={"content-type": "application/json", **FEED_KEY},
    )
    assert keyed.status_code == nobody.status_code and keyed.json() == nobody.json()
