"""First SCORETech sign-ins: a chosen username, and no account ever found or created from an email (T14, T15)."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select

from openbinding_gateway import space_client
from openbinding_gateway.db.models import (
    AuditEvent,
    AuthIdentity,
    EngineRevision,
    IdentitySession,
    Organization,
    OrganizationMembership,
    OrganizationRole,
    User,
    UserRole,
)

from ._flow import choose, first_sign_in, known_user, session_cookie, sign_in
from ._settings import FRONTEND, ISSUER

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def _holder(db, email: str, *, verified: bool, username: str | None = None) -> User:
    holder = User(
        username=username or f"h{uuid.uuid4().hex[:8]}", email=email, email_verified=verified, password_hash="x", plan_cache="FREE"
    )
    db.add(holder)
    await db.flush()
    return holder


async def _audit(db, action: str) -> list[AuditEvent]:
    return (await db.execute(select(AuditEvent).where(AuditEvent.action == action))).scalars().all()


async def test_a_first_sign_in_waits_for_a_username_then_creates_the_account(browser, fake_issuer, db_session) -> None:
    person = fake_issuer.user(email="Ana.Lopez@Example.Invalid")
    response = await first_sign_in(browser, fake_issuer, person, return_to="/compositions")
    assert response.headers["location"] == f"{FRONTEND}/sso/identity/username?returnTo=%2Fcompositions"
    assert browser.cookies.get("__Host-ob_pending") and session_cookie(browser) is None
    pending = await browser.get("/v1/auth/identity/pending")
    assert pending.status_code == 200
    body = pending.json()
    assert body["suggested_username"] == "ana.lopez" and body["email"] == "ana.lopez@example.invalid"
    assert body["email_verified"] is True and body["display_name"] == "Walk Member"
    done = await choose(browser, "ana")
    assert done.status_code == 201 and done.json() == {"return_to": "/compositions"}
    assert session_cookie(browser) and browser.cookies.get("__Host-ob_pending") is None
    user = (await db_session.execute(select(User).where(User.username == "ana"))).scalars().one()
    assert user.email == "ana.lopez@example.invalid" and user.email_verified is True
    assert user.password_enabled is False and user.role is UserRole.USER
    identity = (await db_session.execute(select(AuthIdentity).where(AuthIdentity.user_id == user.id))).scalars().one()
    assert (identity.provider, identity.issuer, identity.subject, identity.attributes) == ("scoretech", ISSUER, person.sub, {})
    assert space_client.get_gate().contracts[user.id] == "ana.lopez@example.invalid"
    assert [event.target_id for event in await _audit(db_session, "account.identity.provisioned")] == [user.id]
    again = await sign_in(browser, fake_issuer, person)
    assert "/sso/identity/callback" in again.headers["location"]


async def test_identity_roles_never_make_an_administrator(browser, fake_issuer, db_session) -> None:
    person = fake_issuer.user(roles=["openbinding:access", "administrador", "admin"])
    await first_sign_in(browser, fake_issuer, person)
    assert (await choose(browser, "notadmin")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "notadmin"))).scalars().one()
    assert user.role is UserRole.USER


async def test_an_unverified_local_holder_is_released_and_never_merged(browser, fake_issuer, db_session) -> None:
    holder = await _holder(db_session, "shared@example.invalid", verified=False)
    name, password = holder.username, holder.password_hash
    person = fake_issuer.user(email="shared@example.invalid")
    await first_sign_in(browser, fake_issuer, person)
    assert (await choose(browser, "newcomer")).status_code == 201
    await db_session.refresh(holder)
    user = (await db_session.execute(select(User).where(User.username == "newcomer"))).scalars().one()
    assert user.id != holder.id and user.email == "shared@example.invalid"
    assert holder.email == f"{holder.id}@identity.openbinding.invalid"
    assert (holder.username, holder.password_hash) == (name, password)
    assert [event.detail for event in await _audit(db_session, "account.email.released")] == [{"reason": "unverified_holder"}]


async def test_a_verified_holder_without_this_issuer_refuses_provisioning(browser, fake_issuer, db_session) -> None:
    holder = await _holder(db_session, "taken@example.invalid", verified=True)
    person = fake_issuer.user(email="taken@example.invalid")
    response = await first_sign_in(browser, fake_issuer, person)
    assert response.headers["location"] == f"{FRONTEND}/authentication?identity_error=account_not_linked"
    assert browser.cookies.get("__Host-ob_pending") is None
    assert len(fake_issuer.logouts) == 1
    assert (await db_session.execute(select(AuthIdentity))).scalars().all() == []
    await db_session.refresh(holder)
    assert holder.email == "taken@example.invalid"
    refused = await _audit(db_session, "account.identity.refused")
    assert refused[0].actor_id is None and refused[0].detail["reason"] == "account_not_linked"
    assert person.sub not in str(refused[0].detail)


async def test_the_same_sub_under_another_issuer_is_another_identity(browser, fake_issuer, db_session) -> None:
    person = fake_issuer.user()
    other = User(username="elsewhere", email="e@example.invalid", password_hash="x", plan_cache="")
    db_session.add(other)
    await db_session.flush()
    db_session.add(AuthIdentity(user_id=other.id, provider="scoretech", issuer="https://other.test/realms/score", subject=person.sub, attributes={}))
    await db_session.flush()
    response = await first_sign_in(browser, fake_issuer, person)
    assert "/sso/identity/username" in response.headers["location"]


@pytest.mark.parametrize("taken", ["Taken", "taken", "TAKEN"])
async def test_a_taken_username_is_refused_case_insensitively_and_can_be_retried(browser, fake_issuer, db_session, taken) -> None:
    await _holder(db_session, "x@example.invalid", verified=False, username="taken")
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    refused = await choose(browser, taken)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "username_taken"
    assert (await choose(browser, "free-name")).status_code == 201


@pytest.mark.parametrize("name", ["admin", "Identity", "deleted-abc", "support"])
async def test_reserved_names_are_unavailable(browser, fake_issuer, name) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    refused = await choose(browser, name)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "username_unavailable"


async def test_an_engine_namespace_is_unavailable(browser, fake_issuer, db_session, monkeypatch) -> None:
    from openbinding_gateway.modules.identity.application import provisioning

    real = provisioning.username_reserved

    async def reserved(session, username):
        return username.casefold() == "acme" or await real(session, username)

    monkeypatch.setattr(provisioning, "username_reserved", reserved)
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    refused = await choose(browser, "Acme")
    assert refused.json()["detail"]["code"] == "username_unavailable"
    assert EngineRevision.namespace is not None


async def test_a_first_sign_in_owns_its_personal_organization(browser, fake_issuer, db_session) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    assert (await choose(browser, "Rosa.M")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "Rosa.M"))).scalars().one()
    personal = (await db_session.execute(
        select(Organization).where(Organization.personal_owner_id == user.id)
    )).scalars().one()
    assert (personal.slug, personal.name, personal.parent_id) == ("rosa-m", "Rosa.M PERSONAL", None)
    seat = (await db_session.execute(
        select(OrganizationMembership).where(OrganizationMembership.organization_id == personal.id)
    )).scalars().one()
    assert (seat.user_id, seat.role) == (user.id, OrganizationRole.OWNER)


async def test_a_username_that_names_an_organization_is_unavailable_and_can_be_retried(
    browser, fake_issuer, db_session
) -> None:
    holder = await _holder(db_session, "o@example.invalid", verified=False)
    db_session.add(Organization(slug="acme-labs", name="Acme Labs", created_by_id=holder.id))
    await db_session.flush()
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    for name in ("acme-labs", "Acme.Labs", "acme_labs", "public"):
        refused = await choose(browser, name)
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "username_unavailable", name
    assert (await choose(browser, "acme-person")).status_code == 201


async def test_the_name_of_an_account_with_its_personal_organization_is_taken_not_unavailable(
    browser, fake_issuer, db_session
) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    assert (await choose(browser, "first-one")).status_code == 201
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    refused = await choose(browser, "First-One")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "username_taken"


async def test_the_account_is_rolled_back_when_its_personal_organization_fails(pooled, fake_issuer, monkeypatch) -> None:
    from openbinding_gateway.modules.identity.application import get_account_hook

    factory, browser = pooled
    hook = get_account_hook()

    async def free(db, username):
        return True

    async def lost(db, user):
        return False  # the slug was taken between the check and the insert

    monkeypatch.setattr(hook, "name_free", free)
    monkeypatch.setattr(hook, "created", lost)
    person = fake_issuer.user()
    await first_sign_in(browser, fake_issuer, person)
    refused = await choose(browser, "late-name")
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "username_unavailable"
    async with factory() as db:
        assert (await db.execute(select(User.id).where(User.username == "late-name"))).first() is None
        assert (await db.execute(select(AuthIdentity.id).where(AuthIdentity.subject == person.sub))).first() is None
    monkeypatch.setattr(hook, "name_free", type(hook).name_free.__get__(hook))
    monkeypatch.setattr(hook, "created", type(hook).created.__get__(hook))
    assert (await choose(browser, "late-name")).status_code == 201
    async with factory() as db:
        user = (await db.execute(select(User).where(User.username == "late-name"))).scalars().one()
        assert (await db.execute(select(Organization.slug).where(Organization.personal_owner_id == user.id))).scalar() == "late-name"


async def test_the_suggestion_steps_around_an_organization_slug(browser, fake_issuer, db_session) -> None:
    holder = await _holder(db_session, "h@example.invalid", verified=False)
    db_session.add(Organization(slug="lucia", name="Lucia's team", created_by_id=holder.id))
    await db_session.flush()
    await first_sign_in(browser, fake_issuer, fake_issuer.user(email="lucia@example.invalid"))
    assert (await browser.get("/v1/auth/identity/pending")).json()["suggested_username"] == "lucia-2"


@pytest.mark.parametrize("name", ["ab", "-leading", "has space", "x" * 65])
async def test_the_username_pattern_is_a_422(browser, fake_issuer, name) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    assert (await choose(browser, name)).status_code == 422


async def test_complete_needs_the_frontend_origin(browser, fake_issuer) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    for origin in ("https://evil.test", "null"):
        refused = await choose(browser, "someone", origin=origin)
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "origin_refused"
    browser.headers.pop("origin")
    assert (await choose(browser, "someone")).status_code == 403


async def test_an_expired_or_missing_pending_sign_up_is_a_404(browser, fake_issuer, identity_stores) -> None:
    store, _ = identity_stores
    assert (await browser.get("/v1/auth/identity/pending")).status_code == 404
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    store.clock = lambda: 10**12
    gone = await choose(browser, "late")
    assert gone.status_code == 404 and gone.json()["detail"]["code"] == "no_pending_signup"


async def test_two_completes_of_one_pending_sign_up_serialise(browser, fake_issuer, identity_stores) -> None:
    _, lock = identity_stores
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    key = __import__("hashlib").sha256(browser.cookies.get("__Host-ob_pending").encode()).hexdigest()
    held = await lock.acquire(f"identity-complete:{key}", 30_000)
    busy = await choose(browser, "racer")
    assert busy.status_code == 409 and busy.json()["detail"]["code"] == "pending_in_progress"
    await lock.release(f"identity-complete:{key}", held)
    first, second = await asyncio.gather(choose(browser, "racer"), choose(browser, "racer2"))
    assert sorted([first.status_code, second.status_code]) in ([201, 404], [201, 409])


@pytest.mark.parametrize(
    ("switch", "values"),
    [("email_unverified", {}), ("no_email", {}), (None, {"email": None})],
)
async def test_without_a_verified_email_the_account_gets_the_placeholder(browser, fake_issuer, db_session, switch, values) -> None:
    if switch:
        fake_issuer.switches.add(switch)
    await first_sign_in(browser, fake_issuer, fake_issuer.user(display_name="Somebody Here", **values))
    pending = (await browser.get("/v1/auth/identity/pending")).json()
    assert pending["email"] is None and pending["email_verified"] is False
    assert pending["suggested_username"] == "somebodyhere"
    assert (await choose(browser, "noemail")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "noemail"))).scalars().one()
    assert user.email == f"{user.id}@identity.openbinding.invalid" and user.email_verified is False


async def test_the_suggestion_is_made_free_and_never_from_preferred_username(browser, fake_issuer, db_session) -> None:
    await _holder(db_session, "o@example.invalid", verified=False, username="maria")
    person = fake_issuer.user(email="maria@example.invalid")
    await first_sign_in(browser, fake_issuer, person)
    assert (await browser.get("/v1/auth/identity/pending")).json()["suggested_username"] == "maria-2"


async def test_a_known_identity_whose_new_email_collides_with_a_verified_holder_signs_in(browser, fake_issuer, db_session) -> None:
    await _holder(db_session, "dup@example.invalid", verified=True)
    user, _, person = await known_user(db_session, fake_issuer, email="dup@example.invalid")
    response = await sign_in(browser, fake_issuer, person)
    assert "/sso/identity/callback" in response.headers["location"]
    assert await _audit(db_session, "account.identity.email_conflict")


async def test_space_down_leaves_the_contract_pending(browser, fake_issuer, db_session) -> None:
    space_client.get_gate().unavailable = True
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    assert (await choose(browser, "pendingcontract")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "pendingcontract"))).scalars().one()
    assert user.contract_pending is True


async def test_the_new_session_is_an_identity_session(browser, fake_issuer, db_session) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user())
    await choose(browser, "withsession")
    user = (await db_session.execute(select(User).where(User.username == "withsession"))).scalars().one()
    row = (await db_session.execute(select(IdentitySession).where(IdentitySession.user_id == user.id))).scalars().one()
    assert row.provider == "scoretech" and row.identity_id is not None
