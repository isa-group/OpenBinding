"""An organization's SPHERE connection: a write-only, encrypted key (``/v1/organizations/{org}/connections``)."""

from __future__ import annotations

import json
import logging
import uuid

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from _problem_helpers import make_org
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import (
    AuditEvent,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    OrgConnection,
    User,
)
from openbinding_gateway.modules.plans.application import (
    DEFAULT_ENDPOINT,
    PricingNotFound,
    credential_for,
    read_version,
)
from openbinding_gateway.security.secrets import CredentialStore
from sphere_recorded import RecordedSphere, sfx_bytes

KEY = "sk-" + "0123456789abcdef" * 4
OTHER_KEY = "sk-" + "fedcba9876543210" * 4
MAILGUN = "6ade364540e55445692b0eda"
PRIVATE = "6b0000000000000000000004"


@pytest.fixture
def fernet(monkeypatch) -> list[str]:
    keys = [Fernet.generate_key().decode(), Fernet.generate_key().decode()]
    monkeypatch.setattr(get_settings(), "secrets_fernet_keys", keys[0])
    return keys


@pytest.fixture
def users_me(sphere: RecordedSphere) -> RecordedSphere:
    sphere.serve("/api/v1/users/me", sfx_bytes("users-me.json"), {"content-type": "application/json"})
    return sphere


async def _admin(api_client, registration, db_session, gate):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    slug = await make_org(api_client, headers)
    return account, headers, slug


async def _member_of(api_client, registration, db_session, gate, slug: str, role: OrganizationRole):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    organization = await db_session.scalar(select(Organization).where(Organization.slug == slug))
    db_session.add(OrganizationMembership(organization_id=organization.id, user_id=uuid.UUID(account["id"]), role=role))
    await db_session.commit()
    return headers


async def test_an_admin_connects_a_key_nobody_can_read_back(
    api_client, registration, db_session, gate, fernet, users_me, caplog  # noqa: F811
) -> None:
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    with caplog.at_level(logging.DEBUG):
        put = await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
        assert put.status_code == 200, put.text
        listed = await api_client.get(f"/v1/organizations/{slug}/connections", headers=headers)
    body = put.json()
    assert body["kind"] == "sphere" and body["status"] == "active" and body["username"] == "fixture-user"
    assert body["keyHint"] == KEY[-4:] and body["scopes"] == [{"organizationId": "6ade2ce94b2b5b01c587d7c6", "scope": "MANAGEMENT"}]
    assert put.headers["ETag"]
    assert listed.status_code == 200 and listed.json()["connections"] == [body]
    for text in (put.text, listed.text):
        assert KEY not in text and "apiKey" not in text and "secret" not in text
    row = await db_session.scalar(select(OrgConnection))
    assert row.secret != KEY and KEY not in row.secret
    assert CredentialStore(fernet[0]).decrypt(row.secret) == KEY
    # The email and every other personal field of /users/me are neither stored nor logged.
    assert "example.invalid" not in json.dumps({c.name: str(getattr(row, c.name)) for c in OrgConnection.__table__.c})
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert KEY not in logged and "example.invalid" not in logged and "Fixture" not in logged
    assert users_me.requests[-1].headers["x-api-key"] == KEY
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "organization.connection_set"))
    assert audit is not None and KEY not in json.dumps(audit.detail)


@pytest.mark.parametrize("role", [OrganizationRole.MEMBER, OrganizationRole.VIEWER])
async def test_members_and_viewers_cannot_touch_connections(
    api_client, registration, db_session, gate, fernet, users_me, role  # noqa: F811
) -> None:
    _, _, slug = await _admin(api_client, registration, db_session, gate)
    headers = await _member_of(api_client, registration, db_session, gate, slug, role)
    for method, path, body in (
        ("GET", "connections", None), ("PUT", "connections/sphere", {"apiKey": KEY}), ("DELETE", "connections/sphere", None),
    ):
        answer = await api_client.request(method, f"/v1/organizations/{slug}/{path}", json=body, headers=headers)
        assert answer.status_code == 403, answer.text
    assert users_me.sent("/api/v1/users/me") == []


async def test_a_non_member_gets_the_problems_convention(
    api_client, registration, db_session, gate, fernet, users_me  # noqa: F811
) -> None:
    _, _, slug = await _admin(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    problems = await api_client.get(f"/v1/organizations/{slug}/problems", headers=stranger)
    connections = await api_client.get(f"/v1/organizations/{slug}/connections", headers=stranger)
    assert connections.status_code == problems.status_code
    missing = await api_client.get("/v1/organizations/no-such-org/connections", headers=stranger)
    assert missing.status_code == 404


async def test_a_rejected_or_malformed_key_stores_nothing(
    api_client, registration, db_session, gate, fernet, users_me  # noqa: F811
) -> None:
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    malformed = await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": "sk-123"}, headers=headers)
    assert malformed.status_code == 422 and malformed.json()["code"] == "sphere_key_malformed"
    assert users_me.sent("/api/v1/users/me") == []
    users_me.unauthorized(KEY)
    rejected = await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    assert rejected.status_code == 422 and rejected.json()["code"] == "sphere_key_rejected"
    assert await db_session.scalar(select(OrgConnection.id)) is None


async def test_without_fernet_keys_the_key_cannot_be_kept(
    api_client, registration, db_session, gate, users_me, monkeypatch  # noqa: F811
) -> None:
    monkeypatch.setattr(get_settings(), "secrets_fernet_keys", None)
    monkeypatch.setattr(get_settings(), "federation_secret_key", None)
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    answer = await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    assert answer.status_code == 503 and answer.json()["detail"]["code"] == "secrets_unavailable"
    assert users_me.sent("/api/v1/users/me") == []


async def test_replace_with_a_stale_if_match_and_delete(
    api_client, registration, db_session, gate, fernet, users_me  # noqa: F811
) -> None:
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    url = f"/v1/organizations/{slug}/connections/sphere"
    first = await api_client.put(url, json={"apiKey": KEY}, headers=headers)
    second = await api_client.put(url, json={"apiKey": OTHER_KEY}, headers={**headers, "If-Match": first.headers["ETag"]})
    assert second.status_code == 200 and second.json()["keyHint"] == OTHER_KEY[-4:]
    stale = await api_client.put(url, json={"apiKey": KEY}, headers={**headers, "If-Match": first.headers["ETag"]})
    assert stale.status_code == 412
    deleted = await api_client.delete(url, headers=headers)
    assert deleted.status_code == 204
    assert (await api_client.get(f"/v1/organizations/{slug}/connections", headers=headers)).json() == {"connections": []}
    assert (await api_client.delete(url, headers=headers)).status_code == 404
    removed = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "organization.connection_removed"))
    assert removed is not None and removed.detail == {"kind": "sphere"}


async def test_rotation_still_decrypts(
    api_client, registration, db_session, gate, fernet, users_me, monkeypatch  # noqa: F811
) -> None:
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    monkeypatch.setattr(get_settings(), "secrets_fernet_keys", f"{fernet[1]},{fernet[0]}")
    organization = await db_session.scalar(select(Organization).where(Organization.slug == slug))
    credential = await credential_for(db_session, organization.id)
    assert credential is not None and credential.api_key == KEY


async def test_the_connection_reads_private_pricings_for_this_organization_only(
    api_client, registration, db_session, gate, fernet, users_me  # noqa: F811
) -> None:
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    _, other_headers, other_slug = await _admin(api_client, registration, db_session, gate)
    await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    users_me.private(MAILGUN, PRIVATE, b"saasName: Private\n", credential=KEY)
    organization = await db_session.scalar(select(Organization).where(Organization.slug == slug))
    other = await db_session.scalar(select(Organization).where(Organization.slug == other_slug))
    source = users_me.source
    credential = await credential_for(db_session, organization.id)
    read = await read_version(source, DEFAULT_ENDPOINT, MAILGUN, PRIVATE, credential)
    assert read.entry.private
    assert await credential_for(db_session, other.id) is None
    with pytest.raises(PricingNotFound):
        await read_version(source, DEFAULT_ENDPOINT, MAILGUN, PRIVATE, None)


async def test_a_later_401_marks_the_connection_invalid_and_public_reads_go_on(
    api_client, registration, db_session, gate, fernet, users_me  # noqa: F811
) -> None:
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    organization = await db_session.scalar(select(Organization).where(Organization.slug == slug))
    credential = await credential_for(db_session, organization.id)
    users_me.unauthorized(KEY)
    manifest = await users_me.source.manifest(DEFAULT_ENDPOINT, MAILGUN, credential)
    assert manifest.name == "Mailgun"
    row = await db_session.scalar(select(OrgConnection))
    await db_session.refresh(row)
    assert row.status == "invalid"
    assert await credential_for(db_session, organization.id) is None
    listed = await api_client.get(f"/v1/organizations/{slug}/connections", headers=headers)
    assert listed.json()["connections"][0]["status"] == "invalid"


async def test_users_me_without_an_api_key_stores_null_scopes(
    api_client, registration, db_session, gate, fernet, sphere: RecordedSphere  # noqa: F811
) -> None:
    me = json.loads(sfx_bytes("users-me.json"))
    del me["apiKey"]
    sphere.serve("/api/v1/users/me", json.dumps(me).encode(), {"content-type": "application/json"})
    _, headers, slug = await _admin(api_client, registration, db_session, gate)
    answer = await api_client.put(f"/v1/organizations/{slug}/connections/sphere", json={"apiKey": KEY}, headers=headers)
    assert answer.status_code == 200 and answer.json()["scopes"] is None


async def test_the_key_is_masked_in_any_log_line() -> None:
    from openbinding_gateway.core.logging import redact

    assert KEY not in redact(f"calling SPHERE with {KEY} for x")
    assert redact(f"key={KEY}") == "key=[REDACTED]"
    assert User.__tablename__ == "users"
