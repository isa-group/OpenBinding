"""Deleting an account pseudonymises it: the row stays, nothing in it names a person, and what was theirs alone goes.

``DELETE /v1/users/me`` keeps the confirmation, the password check and the last-owner 409,
removes the SPACE contract first (a 503 there changes nothing), and then, in one
transaction, replaces the username, email and password, empties the preferences, sets
``deleted_at``, deletes every credential, identity, notification, membership and
invitation of the account, deactivates its federated engines (their revisions stay, past
runs name them) and audits ``account.deleted`` without personal data. A username that
names engines stays reserved for good.
"""

from __future__ import annotations

import json
import uuid
from _problem_helpers import placeholder_refs
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from _fake_space import FakePricingGate
from _pricing import fixture_catalog
from openbinding_gateway import space_client
from openbinding_gateway.db.models import (
    IdentitySession,
    ApiKey,
    AuditEvent,
    AuthIdentity,
    EngineRegistrationRevision,
    EngineRevision,
    Job,
    JobState,
    Notification,
    OrganizationInvitationCode,
    OrganizationMembership,
    PasswordResetToken,
    User,
    utcnow,
)
from openbinding_gateway.space_client import PricingUnavailable

PASSWORD = "correct-horse-battery"


async def signed_in(client, registration, **overrides) -> tuple[dict, dict[str, str], dict]:
    details = registration(**overrides)
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]})
    assert login.status_code == 200, login.text
    return created.json(), {"Authorization": f"Bearer {login.json()['access_token']}"}, details


async def delete(client, profile, headers):
    return await client.request(
        "DELETE", "/v1/users/me", headers=headers, json={"confirmation": profile["username"], "current_password": PASSWORD}
    )


def engine_rows(owner: User) -> tuple[EngineRevision, EngineRegistrationRevision]:
    digest = "sha256-" + uuid.uuid4().hex * 2
    engine = EngineRevision(
        owner_id=owner.id, namespace=owner.username, name="solver", version="1.0.0", digest=digest, document={},
    )
    registration = EngineRegistrationRevision(
        owner_id=owner.id, namespace=owner.username, name="solver-eu", version="1.0.0",
        manifest_digest="sha256-" + uuid.uuid4().hex * 2, engine_digest=digest, document={},
        endpoint="https://solver.example.org", protocol_digest="sha256-" + "0" * 64, mappings={},
        publication_status="published", is_active=True,
    )
    return engine, registration


async def count(session, model, *conditions) -> int:
    return int(await session.scalar(select(func.count()).select_from(model).where(*conditions)))


async def test_deletion_pseudonymises_the_row_and_removes_what_was_the_accounts_alone(api_client, registration, db_session):
    profile, headers, details = await signed_in(api_client, registration)
    colleague, colleague_headers, _ = await signed_in(api_client, registration)
    user_id = uuid.UUID(profile["id"])

    # An organization of the colleague's, where the account is a member and has invited somebody.
    organization = await api_client.post(
        "/v1/organizations", headers=colleague_headers, json={"slug": f"o-{uuid.uuid4().hex[:8]}", "name": "Shared"}
    )
    assert organization.status_code == 201, organization.text
    slug = organization.json()["slug"]
    joined = await api_client.put(
        f"/v1/organizations/{slug}/members/{profile['id']}", headers=colleague_headers,
        json={"user_id": profile["id"], "role": "ADMIN"},
    )
    assert joined.status_code == 200, joined.text
    invited = await api_client.post(f"/v1/organizations/{slug}/invitations", headers=headers, json={})
    assert invited.status_code == 201, invited.text
    theirs = await api_client.post(f"/v1/organizations/{slug}/invitations", headers=colleague_headers, json={})
    assert theirs.status_code == 201, theirs.text
    key = await api_client.post(
        "/v1/users/me/api-keys", headers=headers,
        json={"name": "k", "permissions": ["account:read"], "engine_access": {"all": False, "engines": []}},
    )
    assert key.status_code == 201, key.text

    user = await db_session.get(User, user_id)
    user.preferences = {"email": {"jobs": False}}
    engine, engine_registration = engine_rows(user)
    job = Job(
        created_by_id=user_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="inline",
        state=JobState.COMPLETED, original_request={}, options={}, provenance={}, **placeholder_refs(),
    )
    db_session.add_all([
        engine, engine_registration, job,
        Notification(user_id=user_id, kind="test", subject="Hello", body="Hello"),
        AuthIdentity(user_id=user_id, provider="us-cas", issuer="https://sso.us.es/CAS", subject="uvus-of-the-person", attributes={"mail": details["email"]}),
        PasswordResetToken(user_id=user_id, token_prefix=uuid.uuid4().hex[:12], token_hash="0" * 64, expires_at=utcnow() + timedelta(hours=1)),
    ])
    await db_session.commit()
    job_id, engine_id, registration_id = job.id, engine.id, engine_registration.id

    deleted = await delete(api_client, profile, headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    row = await db_session.get(User, user_id)
    assert row is not None
    assert row.username == f"deleted-{user_id.hex[:12]}"
    assert row.email == f"deleted+{user_id.hex}@users.invalid"
    assert row.password_enabled is False and row.is_active is False
    assert row.preferences == {} and row.plan_cache == "" and row.contract_pending is False
    assert row.deleted_at is not None
    for model, column in (
        (ApiKey, ApiKey.user_id), (IdentitySession, IdentitySession.user_id), (PasswordResetToken, PasswordResetToken.user_id),
        (AuthIdentity, AuthIdentity.user_id), (Notification, Notification.user_id),
        (OrganizationMembership, OrganizationMembership.user_id),
    ):
        assert await count(db_session, model, column == user_id) == 0, model.__name__
    # The code they made goes; the colleague's stays.
    assert await count(db_session, OrganizationInvitationCode) == 1
    # Shared history stays and still names the account; the engines no longer serve new runs.
    assert (await db_session.get(Job, job_id)).created_by_id == user_id
    assert (await db_session.get(EngineRevision, engine_id)) is not None
    stored_registration = await db_session.get(EngineRegistrationRevision, registration_id)
    assert stored_registration is not None and stored_registration.is_active is False
    audit = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "account.deleted"))).scalars().one()
    assert audit.target_id == user_id
    text = json.dumps(audit.detail)
    assert details["username"] not in text and details["email"] not in text
    assert audit.detail == {"engine_registrations_deactivated": 1}

    # The old credentials are dead, and the colleague's organization goes on without the account.
    assert (await api_client.get("/v1/users/me", headers=headers)).status_code == 401
    relogin = await api_client.post("/v1/auth/login", json={"username_or_email": details["username"], "password": PASSWORD})
    assert relogin.status_code == 401
    members = await api_client.get(f"/v1/organizations/{slug}/members", headers=colleague_headers)
    assert profile["id"] not in {member["user_id"] for member in members.json()}


async def test_a_username_that_names_engines_stays_reserved(api_client, registration, db_session):
    profile, headers, details = await signed_in(api_client, registration)
    user = await db_session.get(User, uuid.UUID(profile["id"]))
    engine, _ = engine_rows(user)
    db_session.add(engine)
    await db_session.commit()
    assert (await delete(api_client, profile, headers)).status_code == 204

    again = await api_client.post("/v1/auth/register", json={**registration(), "username": details["username"]})

    assert again.status_code == 409, again.text
    assert again.json()["detail"]["code"] == "username_unavailable"


async def test_a_freed_username_without_engines_can_be_registered_again(api_client, registration):
    profile, headers, details = await signed_in(api_client, registration)
    assert (await delete(api_client, profile, headers)).status_code == 204

    again = await api_client.post("/v1/auth/register", json={**registration(), "username": details["username"]})

    assert again.status_code == 201, again.text


async def test_the_last_owner_cannot_delete_the_account(api_client, registration, db_session):
    profile, headers, _ = await signed_in(api_client, registration)
    created = await api_client.post("/v1/organizations", headers=headers, json={"slug": f"o-{uuid.uuid4().hex[:8]}", "name": "Mine"})
    assert created.status_code == 201, created.text

    refused = await delete(api_client, profile, headers)

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "last_owner"
    db_session.expire_all()
    assert (await db_session.get(User, uuid.UUID(profile["id"]))).deleted_at is None


@pytest.fixture
def request_transactions(db_session):
    """Each request commits or rolls back, as ``db.base.get_session`` does, instead of sharing the test's open transaction."""
    from openbinding_gateway.access.dependencies import session_dependency
    from openbinding_gateway.main import app

    async def transactional():
        try:
            yield db_session
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            raise

    app.dependency_overrides[session_dependency] = transactional
    yield


async def test_a_contract_that_cannot_be_removed_changes_nothing(api_client, registration, db_session, request_transactions):
    profile, headers, details = await signed_in(api_client, registration)
    gate = FakePricingGate(fixture_catalog())
    space_client.set_gate(gate)

    async def remove_contract(user_id):
        raise PricingUnavailable("SPACE is not reachable")

    gate.remove_contract = remove_contract

    refused = await delete(api_client, profile, headers)

    assert refused.status_code == 503, refused.text
    db_session.expire_all()
    row = await db_session.get(User, uuid.UUID(profile["id"]))
    assert (row.username, row.email, row.is_active, row.deleted_at) == (details["username"], details["email"], True, None)
    # The sessions registration and login opened survive a deletion that did not happen.
    assert await count(db_session, IdentitySession, IdentitySession.user_id == row.id) >= 1
    assert await count(
        db_session, IdentitySession, IdentitySession.user_id == row.id, IdentitySession.revoked_at.is_not(None)
    ) == 0


@pytest.mark.parametrize("wrong", ["confirmation", "password"])
async def test_the_confirmation_and_the_password_are_still_required(api_client, registration, wrong):
    profile, headers, _ = await signed_in(api_client, registration)
    body = {"confirmation": profile["username"], "current_password": PASSWORD}
    body["confirmation" if wrong == "confirmation" else "current_password"] = "not-it"

    refused = await api_client.request("DELETE", "/v1/users/me", headers=headers, json=body)

    assert refused.status_code == (422 if wrong == "confirmation" else 401), refused.text


async def test_administration_no_longer_lists_or_acts_on_a_deleted_account(api_client, registration, db_session):
    profile, headers, _ = await signed_in(api_client, registration)
    admin_profile, _, admin_details = await signed_in(api_client, registration)
    from openbinding_gateway.db.models import UserRole

    (await db_session.get(User, uuid.UUID(admin_profile["id"]))).role = UserRole.ADMIN
    await db_session.commit()
    login = await api_client.post(
        "/v1/auth/login", json={"username_or_email": admin_details["username"], "password": admin_details["password"]}
    )
    admin_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (await delete(api_client, profile, headers)).status_code == 204

    listing = await api_client.get("/v1/admin/users", headers=admin_headers)
    detail = await api_client.patch(f"/v1/admin/users/{profile['id']}", headers=admin_headers, json={"is_active": True})

    assert listing.status_code == 200, listing.text
    assert profile["id"] not in {user["id"] for user in listing.json()["users"]}
    assert detail.status_code == 404, detail.text


async def test_a_database_refusal_leaves_the_contract_in_place(api_client, registration, db_session, request_transactions):
    profile, headers, details = await signed_in(api_client, registration)
    user_id = uuid.UUID(profile["id"])
    gate = space_client.get_gate()
    assert user_id in gate.contracts
    # A row that already holds the pseudonym (registration refuses such names; this one is planted).
    db_session.add(User(
        username=f"deleted-{user_id.hex[:12]}", email="squatter@example.org", password_hash="x", plan_cache="",
    ))
    await db_session.commit()

    try:
        response = await delete(api_client, profile, headers)
    except Exception:  # noqa: BLE001 - the transport may hand the unhandled IntegrityError back as it is
        pass
    else:
        assert response.status_code >= 500, response.text

    assert user_id in gate.contracts
    db_session.expire_all()
    row = await db_session.get(User, user_id)
    assert (row.username, row.is_active, row.deleted_at) == (details["username"], True, None)


async def test_a_deleted_administrator_no_longer_counts_and_the_bootstrap_seeds_again(api_client, registration, db_session):
    from openbinding_gateway.core.settings import Settings
    from openbinding_gateway.db.bootstrap import ensure_administrator
    from openbinding_gateway.db.models import UserRole

    profile, headers, _ = await signed_in(api_client, registration)
    (await db_session.get(User, uuid.UUID(profile["id"]))).role = UserRole.ADMIN
    await db_session.commit()

    assert (await delete(api_client, profile, headers)).status_code == 204

    db_session.expire_all()
    assert (await db_session.get(User, uuid.UUID(profile["id"]))).role is UserRole.USER
    settings = Settings(_env_file=None, bootstrap_admin_username="operator", bootstrap_admin_password="an-operator-chosen-passphrase")
    assert await ensure_administrator(db_session, settings) is True
    seeded = (await db_session.execute(select(User).where(User.username == "operator"))).scalar_one()
    assert seeded.role is UserRole.ADMIN


@pytest.mark.parametrize("name", ["deleted-0123456789ab", "Deleted-anything"])
async def test_the_pseudonym_space_cannot_be_registered(api_client, registration, name):
    refused = await api_client.post("/v1/auth/register", json={**registration(), "username": name})

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "username_unavailable"


async def test_a_username_that_names_only_an_engine_registration_stays_reserved(api_client, registration, db_session):
    profile, headers, details = await signed_in(api_client, registration)
    user = await db_session.get(User, uuid.UUID(profile["id"]))
    _, engine_registration = engine_rows(user)
    db_session.add(engine_registration)  # pins somebody else's engine: the account has no engine revision of its own
    await db_session.commit()
    assert await count(db_session, EngineRevision, EngineRevision.namespace == details["username"]) == 0
    assert (await delete(api_client, profile, headers)).status_code == 204

    again = await api_client.post("/v1/auth/register", json={**registration(), "username": details["username"]})

    assert again.status_code == 409, again.text
    assert again.json()["detail"]["code"] == "username_unavailable"


async def test_the_pseudonym_email_cannot_be_registered(api_client, registration):
    refused = await api_client.post(
        "/v1/auth/register", json={**registration(), "email": f"deleted+{uuid.uuid4().hex}@users.invalid"}
    )

    # `.invalid` is a special-use domain, so the email itself is refused before any account exists.
    assert refused.status_code == 422, refused.text
