"""Deleting an account pseudonymises it: the row stays, nothing in it names a person, and what was theirs alone goes.

``DELETE /v1/users/me`` keeps the confirmation, the password check and the last-owner 409,
removes the SPACE contract first (a 503 there changes nothing), and then, in one
transaction, replaces the username, email and password, empties the preferences, sets
``deleted_at``, deletes every credential, identity, notification, membership and
invitation of the account, deactivates its federated engines (their revisions stay, past
runs name them) and audits ``account.deleted`` without personal data. Its personal
organization does not count as an organization it owns: it is deleted with everything it
holds, its runs included, as SPHERE deletes it, once its runs have stopped. A username that
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
from _pricing import fixture_catalog, largest_plan
from test_compositions_public_list import published
from openbinding_gateway import space_client
from openbinding_gateway.db.models import (
    IdentitySession,
    ApiKey,
    AuditEvent,
    AuthIdentity,
    EngineRegistrationRevision,
    EngineRevision,
    Job,
    JobEngineAttempt,
    JobState,
    Composition,
    CompositionVersion,
    Notification,
    Organization,
    OrganizationInvitationCode,
    OrganizationMembership,
    PasswordResetToken,
    Study,
    StudyCell,
    StudyRun,
    User,
    utcnow,
)
from openbinding_gateway.db.platform_models import RunState
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
        AuthIdentity(user_id=user_id, provider="scoretech", issuer="https://identity.test/identity/auth/realms/score", subject="sub-of-the-person", attributes={}),
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
    # Its personal organization went with it.
    assert await count(db_session, Organization, Organization.personal_owner_id == user_id) == 0

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


async def test_the_personal_organization_is_deleted_with_the_account(api_client, registration, db_session):
    """As SPHERE (``UserService.ts:281-285``): the personal organization goes, everything in it, its runs included."""
    profile, headers, details = await signed_in(api_client, registration)
    friend, friend_headers, _ = await signed_in(api_client, registration)
    space_client.get_gate().plans[uuid.UUID(profile["id"])] = largest_plan()
    user_id = uuid.UUID(profile["id"])
    listed = (await api_client.get("/v1/organizations", headers=headers)).json()
    personal = next(row for row in listed if row["is_personal"])
    personal_id = uuid.UUID(personal["id"])
    # A friend in it, invitation codes of the account's and of the friend's, a public composition, and history.
    assert (await api_client.put(
        f"/v1/organizations/{personal['slug']}/members/{friend['id']}", headers=headers,
        json={"user_id": friend["id"], "role": "ADMIN"},
    )).status_code == 200
    assert (await api_client.post(f"/v1/organizations/{personal['slug']}/invitations", headers=headers, json={})).status_code == 201
    assert (await api_client.post(f"/v1/organizations/{personal['slug']}/invitations", headers=friend_headers, json={})).status_code == 201
    await published(api_client, headers, personal["slug"], "menu")
    finished = Job(
        created_by_id=user_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="inline",
        state=JobState.COMPLETED, original_request={}, options={}, provenance={},
        **{**placeholder_refs(), "organization_id": personal_id},
    )
    db_session.add(finished)
    study = Study(organization_id=personal_id, slug="s", name="S", definition={}, definition_digest="sha256-x",
                  created_by_id=user_id)
    db_session.add(study)
    await db_session.flush()
    study_run = StudyRun(study_id=study.id, run_number=1, state=RunState.COMPLETED, matrix_digest="m",
                         definition={}, definition_digest="d", created_by_id=user_id)
    db_session.add(study_run)
    await db_session.flush()
    db_session.add(StudyCell(study_run_id=study_run.id, ordinal=1, binding_case_revision_id=uuid.uuid4(),
                             compilation_id=uuid.uuid4(), engine_ref={}, seed=1, fingerprint="f",
                             state=RunState.COMPLETED, job_id=finished.id))
    await db_session.commit()
    finished_id, study_run_id = finished.id, study_run.id

    preview = await api_client.get("/v1/users/me/deletion", headers=headers)
    assert preview.status_code == 200, preview.text
    assert preview.json() == {"personal_organization": {
        "slug": personal["slug"], "name": personal["name"], "compositions": 1, "public_compositions": 1,
        "problems": 0, "runs": 1, "feed_environments": 0,
    }}

    deleted = await delete(api_client, profile, headers)

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await db_session.get(Organization, personal_id) is None
    for model, column in (
        (OrganizationMembership, OrganizationMembership.organization_id),
        (OrganizationInvitationCode, OrganizationInvitationCode.organization_id),
        (Composition, Composition.organization_id),
        (Job, Job.organization_id),
        (AuditEvent, AuditEvent.organization_id),
    ):
        assert await count(db_session, model, column == personal_id) == 0, model.__name__
    assert await db_session.get(Job, finished_id) is None
    # Study runs are history everywhere else; the triggers let a deleted account's personal ones go.
    assert await db_session.get(StudyRun, study_run_id) is None
    assert await count(db_session, StudyCell, StudyCell.study_run_id == study_run_id) == 0
    audit = (await db_session.execute(select(AuditEvent).where(AuditEvent.action == "account.deleted"))).scalars().one()
    assert audit.detail == {"engine_registrations_deactivated": 0}
    # The friend lost it with its other members; the old slug answers nothing, and the username's namespace is free.
    assert (await api_client.get(f"/v1/organizations/{personal['slug']}", headers=friend_headers)).status_code == 404
    assert (await api_client.get("/v1/compositions", params={"q": "menu"})).json()["compositions"] == []
    again = await api_client.post("/v1/auth/register", json={**registration(), "username": details["username"]})
    assert again.status_code == 201, again.text


async def test_a_fork_in_another_organization_survives_the_deletion(api_client, registration, db_session):
    profile, headers, _ = await signed_in(api_client, registration)
    space_client.get_gate().plans[uuid.UUID(profile["id"])] = largest_plan()
    _, friend_headers, _ = await signed_in(api_client, registration)
    personal = next(row for row in (await api_client.get("/v1/organizations", headers=headers)).json() if row["is_personal"])
    base = await published(api_client, headers, personal["slug"], "card")
    team = await api_client.post(
        "/v1/organizations", headers=friend_headers, json={"slug": f"t-{uuid.uuid4().hex[:8]}", "name": "Team"},
    )
    assert team.status_code == 201, team.text
    forked = await api_client.post(
        f"{base}/fork", headers=friend_headers, json={"version": "1.0.0", "targetOrganization": team.json()["slug"]},
    )
    assert forked.status_code == 201, forked.text

    assert (await delete(api_client, profile, headers)).status_code == 204

    copy = await api_client.get(f"/v1/organizations/{team.json()['slug']}/compositions/card/versions/1.0.0", headers=friend_headers)
    assert copy.status_code == 200, copy.text
    # What it was forked from stays in its own snapshot, though the source is gone (and so is named to nobody).
    assert copy.json()["forked_from"] is not None
    stored = (await db_session.execute(
        select(CompositionVersion.forked_from).join(Composition).where(Composition.organization_id == uuid.UUID(team.json()["id"]))
    )).scalar_one()
    assert stored["organization"]["name"] == personal["slug"]


async def test_a_running_run_of_the_personal_organization_is_stopped_before_the_deletion(api_client, registration, db_session):
    profile, headers, _ = await signed_in(api_client, registration)
    user_id = uuid.UUID(profile["id"])
    personal = next(row for row in (await api_client.get("/v1/organizations", headers=headers)).json() if row["is_personal"])
    personal_id = uuid.UUID(personal["id"])
    refs = {**placeholder_refs(), "organization_id": personal_id}
    queued = Job(created_by_id=user_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="inline",
                 state=JobState.QUEUED, original_request={}, options={}, provenance={}, **refs)
    running = Job(created_by_id=user_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="inline",
                  state=JobState.RUNNING, original_request={}, options={}, provenance={}, lease_token="worker-1",
                  lease_until=utcnow() + timedelta(minutes=5), **refs)
    db_session.add_all([queued, running])
    await db_session.commit()
    queued_id, running_id = queued.id, running.id

    refused = await delete(api_client, profile, headers)

    # The queued run is cancelled on the spot; the running one is left to its worker, flagged; nothing else changed.
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "personal_runs_stopping"
    db_session.expire_all()
    assert (await db_session.get(Job, queued_id)).state is JobState.CANCELLED
    still = await db_session.get(Job, running_id)
    assert still.state is JobState.RUNNING and still.cancellation_requested is True
    assert (await db_session.get(User, user_id)).deleted_at is None
    assert await db_session.get(Organization, personal_id) is not None

    # Once its worker has stopped it, the account goes, and the organization with it.
    still.state, still.lease_token, still.lease_until, still.finished_at = JobState.CANCELLED, None, None, utcnow()
    await db_session.commit()
    assert (await delete(api_client, profile, headers)).status_code == 204
    db_session.expire_all()
    assert await db_session.get(Organization, personal_id) is None


@pytest.mark.parametrize(("state", "claims", "waits"), [
    ("pending", 0, True), ("failed", 3, True), ("pending", 8, False), ("failed", 8, False), ("sent", 1, False),
])
async def test_an_engine_attempt_still_being_stopped_makes_the_deletion_wait_while_its_claims_last(
    api_client, registration, db_session, state, claims, waits,
):
    profile, headers, _ = await signed_in(api_client, registration)
    user_id = uuid.UUID(profile["id"])
    personal = next(row for row in (await api_client.get("/v1/organizations", headers=headers)).json() if row["is_personal"])
    personal_id = uuid.UUID(personal["id"])
    job = Job(created_by_id=user_id, engine_id="random-search", engine_job_id=str(uuid.uuid4()), service_url="inline",
              state=JobState.FAILED, original_request={}, options={}, provenance={},
              **{**placeholder_refs(), "organization_id": personal_id})
    db_session.add(job)
    await db_session.flush()
    # REMOTE_CANCEL_MAX_ATTEMPTS is 8: an attempt whose claims ran out is given up, whatever state it was left in.
    db_session.add(JobEngineAttempt(job_id=job.id, attempt=1, engine_job_id="e-1", endpoint="http://engine",
                                    cancel_state=state, cancel_attempts=claims))
    await db_session.commit()

    answered = await delete(api_client, profile, headers)

    if waits:
        assert answered.status_code == 409 and answered.json()["detail"]["code"] == "personal_runs_stopping"
    else:
        assert answered.status_code == 204, answered.text


async def test_a_team_organization_with_runs_is_still_refused(api_client, registration, db_session):
    profile, headers, _ = await signed_in(api_client, registration)
    team = await api_client.post("/v1/organizations", headers=headers, json={"slug": f"t-{uuid.uuid4().hex[:8]}", "name": "T"})
    db_session.add(Job(
        created_by_id=uuid.UUID(profile["id"]), engine_id="random-search", engine_job_id=str(uuid.uuid4()),
        service_url="inline", state=JobState.COMPLETED, original_request={}, options={}, provenance={},
        **{**placeholder_refs(), "organization_id": uuid.UUID(team.json()["id"])},
    ))
    await db_session.commit()
    refused = await api_client.delete(f"/v1/organizations/{team.json()['slug']}", headers=headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "historical_references"


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
