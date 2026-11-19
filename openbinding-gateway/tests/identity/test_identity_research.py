"""RESEARCH by a verified institutional email, else by an administrator (plan §5, T16, D-l)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from openbinding_gateway import space_client
from openbinding_gateway.db.models import AuditEvent, User
from openbinding_gateway.modules.identity.domain.rules import research_eligible

from ._flow import choose, first_sign_in, known_user, sign_in

pytestmark = pytest.mark.usefixtures("fake_issuer")

DOMAINS = ("us.es", "alum.us.es")


@pytest.mark.parametrize("email", ["ana@us.es", "ana@alum.us.es", "Ana@US.ES"])
def test_institutional_domains_qualify(email) -> None:
    assert research_eligible(email.lower(), True, DOMAINS)


@pytest.mark.parametrize(
    ("email", "verified"),
    [
        ("ana@x.us.es", True),
        ("ana@us.es.evil.com", True),
        ("ana@us.es", "true"),
        ("ana@us.es", False),
        ("1f@identity.openbinding.invalid", True),
        (None, True),
    ],
)
def test_everything_else_does_not(email, verified) -> None:
    assert not research_eligible(email, verified, DOMAINS)


async def _granted(db) -> list[AuditEvent]:
    return (await db.execute(select(AuditEvent).where(AuditEvent.action == "account.research.granted"))).scalars().all()


async def test_a_first_sign_in_with_an_institutional_email_starts_on_research(browser, fake_issuer, db_session) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user(email="maria@us.es"))
    assert (await choose(browser, "maria")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "maria"))).scalars().one()
    assert user.plan_cache == "RESEARCH"
    assert space_client.get_gate().plans[user.id] == "RESEARCH"
    assert [event.detail for event in await _granted(db_session)] == [{"basis": "email"}]


async def test_an_unverified_institutional_email_stays_on_the_default_plan(browser, fake_issuer, db_session) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user(email="pepe@us.es", email_verified=False))
    assert (await choose(browser, "pepe")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "pepe"))).scalars().one()
    assert user.plan_cache == "FREE" and await _granted(db_session) == []


async def _contracted(db, fake, **values):
    user, identity, person = await known_user(db, fake, **values)
    await space_client.get_gate().create_contract(user.id, "FREE", user.email, "0.2.0")
    return user, person


async def test_a_known_account_is_upgraded_once_whatever_the_number_of_sign_ins(browser, fake_issuer, db_session) -> None:
    user, person = await _contracted(db_session, fake_issuer, email="luis@alum.us.es")
    await sign_in(browser, fake_issuer, person)
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    assert user.plan_cache == "RESEARCH" and space_client.get_gate().plans[user.id] == "RESEARCH"
    assert len(await _granted(db_session)) == 1


async def test_an_account_above_the_default_plan_is_left_alone(browser, fake_issuer, db_session) -> None:
    user, person = await _contracted(db_session, fake_issuer, email="lab@us.es")
    gate = space_client.get_gate()
    await gate.change_plan(user.id, "LAB", "0.2.0", (await gate.subscription(user.id)).contract_version)
    user.plan_cache = "LAB"
    await db_session.flush()
    await sign_in(browser, fake_issuer, person)
    assert gate.plans[user.id] == "LAB" and await _granted(db_session) == []


async def test_space_down_defers_the_grant_and_does_not_block_the_sign_in(browser, fake_issuer, db_session) -> None:
    user, person = await _contracted(db_session, fake_issuer, email="later@us.es")
    space_client.get_gate().unavailable = True
    response = await sign_in(browser, fake_issuer, person)
    assert "/sso/identity/callback" in response.headers["location"]
    await db_session.refresh(user)
    assert user.plan_cache == "FREE"
    space_client.get_gate().unavailable = False
    await sign_in(browser, fake_issuer, person)
    await db_session.refresh(user)
    assert user.plan_cache == "RESEARCH"


async def test_space_down_at_provisioning_leaves_a_pending_research_contract(browser, fake_issuer, db_session) -> None:
    from openbinding_gateway.access.contracts import settle_pending_contract

    space_client.get_gate().unavailable = True
    await first_sign_in(browser, fake_issuer, fake_issuer.user(email="queued@us.es"))
    assert (await choose(browser, "queued")).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == "queued"))).scalars().one()
    assert user.contract_pending and user.plan_cache == "RESEARCH"
    space_client.get_gate().unavailable = False
    await settle_pending_contract(user, db_session)
    assert not user.contract_pending and space_client.get_gate().plans[user.id] == "RESEARCH"


async def test_the_profile_shows_the_institutional_email(browser, fake_issuer, db_session) -> None:
    await first_sign_in(browser, fake_issuer, fake_issuer.user(email="prof@us.es"))
    await choose(browser, "prof")
    token = (await browser.post("/v1/auth/identity/session")).json()["access_token"]
    me = (await browser.get("/v1/users/me", headers={"authorization": f"Bearer {token}"})).json()
    assert me["email_verified"] is True and me["institutional_email"] is True and me["plan"] == "RESEARCH"
    assert uuid.UUID(me["id"])
