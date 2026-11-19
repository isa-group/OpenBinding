"""What a sign-in keeps of the Identity profile, and the email rule that never links by email (O15, D-g)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from openbinding_gateway.db.models import AuditEvent, AuthIdentity, User
from openbinding_gateway.modules.identity.application import sessions

from ._flow import known_user, sign_in
from ._settings import ISSUER

pytestmark = pytest.mark.usefixtures("fake_issuer")


async def _holder(db, email: str, *, verified: bool, issuer: str | None = None) -> User:
    holder = User(username=f"h{uuid.uuid4().hex[:8]}", email=email, email_verified=verified, password_hash="x", plan_cache="")
    db.add(holder)
    await db.flush()
    if issuer:
        db.add(AuthIdentity(user_id=holder.id, provider="scoretech", issuer=issuer, subject=f"s-{uuid.uuid4().hex}", attributes={}))
        await db.flush()
    return holder


async def _actions(db, target) -> list[AuditEvent]:
    return (await db.execute(select(AuditEvent).where(AuditEvent.target_id == target))).scalars().all()


async def test_a_sign_in_updates_the_profile(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(
        db_session, fake_issuer, email="ana@example.invalid", display_name="Ana", 
        avatar={"kind": "icon", "assetId": "leaf", "backgroundColor": "graphite", "foregroundColor": "paper"},
    )
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    assert user.email == "ana@example.invalid" and user.email_verified is True
    assert user.display_name == "Ana"
    assert user.avatar == {"kind": "icon", "assetId": "leaf", "backgroundColor": "#212529", "foregroundColor": "#ffffff"}
    assert user.last_identity_refresh_at is not None


async def test_an_unverified_email_is_not_stored(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(db_session, fake_issuer, email="unverified@example.invalid", email_verified=False)
    before = user.email
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    assert user.email == before and user.email_verified is False


async def test_a_stale_identity_copy_of_the_same_issuer_is_released(browser, fake_issuer, db_session) -> None:
    holder = await _holder(db_session, "moved@example.invalid", verified=True, issuer=ISSUER)
    user, _, person = await known_user(db_session, fake_issuer, email="moved@example.invalid")
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    await db_session.refresh(holder)
    assert user.email == "moved@example.invalid"
    assert holder.email == f"{holder.id}@identity.openbinding.invalid" and holder.email_verified is False
    released = [event for event in await _actions(db_session, holder.id) if event.action == "account.email.released"]
    assert released[0].detail == {"reason": "stale_identity"}


async def test_an_unverified_local_holder_is_released(browser, fake_issuer, db_session) -> None:
    holder = await _holder(db_session, "squat@example.invalid", verified=False)
    username = holder.username
    user, _, person = await known_user(db_session, fake_issuer, email="squat@example.invalid")
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(holder)
    await db_session.refresh(user)
    assert user.email == "squat@example.invalid" and holder.username == username
    assert [event.detail for event in await _actions(db_session, holder.id) if event.action == "account.email.released"] == [
        {"reason": "unverified_holder"}
    ]


@pytest.mark.parametrize("other_issuer", [None, "https://another.test/realms/score"])
async def test_a_verified_holder_without_an_identity_of_this_issuer_keeps_it(browser, fake_issuer, db_session, other_issuer) -> None:
    holder = await _holder(db_session, "kept@example.invalid", verified=True, issuer=other_issuer)
    user, _, person = await known_user(db_session, fake_issuer, email="kept@example.invalid")
    before = user.email
    response = await sign_in(browser, fake_issuer, person)
    assert "/sso/identity/callback" in response.headers["location"]
    await db_session.refresh(user)
    await db_session.refresh(holder)
    assert user.email == before and user.email_verified is False and holder.email == "kept@example.invalid"
    assert "account.identity.email_conflict" in [event.action for event in await _actions(db_session, user.id)]


async def test_bio_socials_and_phone_are_never_persisted(browser, fake_issuer, db_session) -> None:
    user, _, person = await known_user(db_session, fake_issuer)
    await sign_in(browser, fake_issuer, person)
    rows = (await db_session.execute(select(User))).scalars().all()
    stored = " ".join(str(vars(row)) for row in rows)
    assert "a bio that must never be stored" not in stored and "+34600000000" not in stored


async def test_a_renewal_without_an_id_token_moves_only_liveness(db_session, fake_issuer) -> None:
    from openbinding_gateway.modules.identity.domain.claims import IdentityClaims

    user, _, _ = await known_user(db_session, fake_issuer)
    user.display_name, user.email_verified = "Kept", True
    await sessions.sync_claims(db_session, user, IdentityClaims(issuer=ISSUER, subject="s"))
    assert user.display_name == "Kept" and user.email_verified is True and user.last_identity_refresh_at
