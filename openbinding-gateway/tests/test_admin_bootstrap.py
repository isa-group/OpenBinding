"""Breaking the circle a fresh installation starts in.

Registration is open and produces ordinary users, so a new deployment has no
administrator and no way to acquire one - promoting an account is itself an
administrator's privilege. Two ways out: a configured account, and a
throwaway one for a database with nothing in it at all.
"""

from __future__ import annotations

from sqlalchemy import select

from openbinding_gateway.core.settings import Settings
from openbinding_gateway.db.bootstrap import (
    DEFAULT_ADMIN_PASSWORD,
    DEFAULT_ADMIN_USERNAME,
    ensure_administrator,
    seed_default_administrator,
)
from openbinding_gateway.db.models import User, UserRole
from openbinding_gateway.security.passwords import verify_password


async def users(session) -> list[User]:
    return list((await session.execute(select(User))).scalars().all())


# -- The throwaway account --------------------------------------------------


async def test_an_empty_database_gets_an_administrator(db_session):
    assert await seed_default_administrator(db_session) is True

    seeded = (await users(db_session))[0]
    assert seeded.username == DEFAULT_ADMIN_USERNAME
    assert seeded.role is UserRole.ADMIN


async def test_an_administrator_is_seeded_on_the_plan_it_needs(db_session):
    # The account that demonstrates the system and reproduces what users report
    # should not be the first to run out of tasks. There is no payment gateway,
    # so PRO costs nothing.
    from openbinding_gateway.db.models import Plan

    await seed_default_administrator(db_session)
    admin = (
        await db_session.execute(
            select(User).where(User.username == DEFAULT_ADMIN_USERNAME)
        )
    ).scalar_one()

    assert admin.plan_cache is Plan.PRO


async def test_the_seeded_password_is_the_documented_one(db_session):
    await seed_default_administrator(db_session)

    seeded = (await users(db_session))[0]
    assert verify_password(DEFAULT_ADMIN_PASSWORD, seeded.password_hash)


async def test_the_seeded_password_is_not_stored_in_the_clear(db_session):
    await seed_default_administrator(db_session)

    seeded = (await users(db_session))[0]
    assert DEFAULT_ADMIN_PASSWORD not in seeded.password_hash


async def test_seeding_is_refused_once_anybody_exists(db_session):
    # Not just "once an administrator exists": a surprise account with a
    # guessable password must never appear in an installation that is in use,
    # including one whose administrators were all deactivated.
    db_session.add(
        User(username="someone", email="someone@example.org", password_hash="x")
    )
    await db_session.flush()

    assert await seed_default_administrator(db_session) is False
    assert len(await users(db_session)) == 1


async def test_seeding_twice_creates_one_account(db_session):
    await seed_default_administrator(db_session)

    assert await seed_default_administrator(db_session) is False
    assert len(await users(db_session)) == 1


async def test_the_seeded_email_survives_being_read_back_by_the_api(db_session):
    # It failed here once: `admin@localhost` has no dot in the domain, which
    # the response models reject - so listing users answered 500 the moment
    # this account appeared in the results.
    from openbinding_gateway.models.accounts import AdminUserView

    await seed_default_administrator(db_session)
    seeded = (await users(db_session))[0]

    AdminUserView(
        id=seeded.id,
        username=seeded.username,
        email=seeded.email,
        role=seeded.role.value,
        is_active=seeded.is_active,
        plan=seeded.plan_cache.value,
        created_at=seeded.created_at,
        contract_pending=seeded.contract_pending,
        api_key_count=0,
    )


# -- The configured account -------------------------------------------------


def configured(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


async def test_nothing_happens_without_a_configured_username(db_session):
    assert await ensure_administrator(db_session, configured()) is False


async def test_a_configured_administrator_is_created(db_session):
    changed = await ensure_administrator(
        db_session,
        configured(
            bootstrap_admin_username="alice", bootstrap_admin_password="a-long-enough-one"
        ),
    )

    assert changed is True
    assert (await users(db_session))[0].role is UserRole.ADMIN


async def test_an_existing_account_is_promoted_rather_than_duplicated(db_session):
    # So somebody who registered normally can be given the role by restarting
    # with their username configured.
    db_session.add(User(username="alice", email="alice@example.org", password_hash="x"))
    await db_session.flush()

    await ensure_administrator(db_session, configured(bootstrap_admin_username="alice"))

    everybody = await users(db_session)
    assert len(everybody) == 1
    assert everybody[0].role is UserRole.ADMIN


async def test_nothing_happens_once_an_administrator_exists(db_session):
    # Leaving the variables in place is harmless, which matters because they
    # live in a compose file that nobody edits again.
    db_session.add(
        User(
            username="existing",
            email="existing@example.org",
            password_hash="x",
            role=UserRole.ADMIN,
        )
    )
    await db_session.flush()

    changed = await ensure_administrator(
        db_session,
        configured(bootstrap_admin_username="alice", bootstrap_admin_password="a-long-one"),
    )

    assert changed is False


async def test_a_weak_configured_password_is_refused(db_session):
    changed = await ensure_administrator(
        db_session,
        configured(bootstrap_admin_username="alice", bootstrap_admin_password="short"),
    )

    assert changed is False
    assert await users(db_session) == []


async def test_a_configured_administrator_without_a_password_is_not_invented(db_session):
    changed = await ensure_administrator(db_session, configured(bootstrap_admin_username="alice"))

    assert changed is False
    assert await users(db_session) == []


# -- Starting the gateway ---------------------------------------------------


def test_starting_on_an_empty_database_produces_an_administrator(tmp_path, monkeypatch):
    """The bug this file's other tests could not see.

    Every seeding rule below was correct and covered, and none of it ran:
    the lifespan called only ``ensure_administrator``, which does nothing
    without BOOTSTRAP_ADMIN_USERNAME - and the compose files pass that empty.
    So ``docker compose up`` produced a gateway with no accounts and no way to
    make one, because promoting somebody is an administrator's privilege and
    there was no administrator.

    This asserts the outcome a person cares about: start it, sign in.
    """
    import asyncio

    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine

    from openbinding_gateway.core.settings import get_settings
    from openbinding_gateway.db.base import Base

    database = tmp_path / "bootstrap.db"
    sync_engine = create_engine(f"sqlite:///{database}")
    with sync_engine.begin() as connection:
        Base.metadata.create_all(connection)
    sync_engine.dispose()

    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setenv("GATEWAY_JWT_SECRET", "a-secret-long-enough-for-hs256-signing")
    monkeypatch.delenv("BOOTSTRAP_ADMIN_USERNAME", raising=False)
    get_settings.cache_clear()

    from openbinding_gateway.main import app

    try:
        # Entering the client runs the lifespan, which is the thing under test.
        with TestClient(app) as client:
            signed_in = client.post(
                "/v1/auth/login",
                json={
                    "username_or_email": DEFAULT_ADMIN_USERNAME,
                    "password": DEFAULT_ADMIN_PASSWORD,
                },
            )
            assert signed_in.status_code == 200, signed_in.text

            profile = client.get(
                "/v1/users/me",
                headers={"Authorization": f"Bearer {signed_in.json()['access_token']}"},
            ).json()
            assert profile["role"] == "admin"
    finally:
        get_settings.cache_clear()
        asyncio.run(_dispose())


async def _dispose():
    from openbinding_gateway.db.base import dispose_engine

    await dispose_engine()


async def test_a_pending_contract_is_settled_on_the_next_request(db_session):
    """The debt the flag records has to actually be paid by something.

    Registration survives SPACE being unreachable on purpose - the account is
    created and ``contract_pending`` says it still owes a contract. Nothing ever
    read that flag back and acted on it, so such an account stayed unmetered for
    good, with quotas that read as an empty list rather than as a failure. The
    first one it happened to was the seeded administrator, created before
    anybody had connected SPACE at all.
    """
    from openbinding_gateway import space_client
    from openbinding_gateway.access.contracts import settle_pending_contract
    from openbinding_gateway.space_client import FakePricingGate

    await seed_default_administrator(db_session)
    await db_session.flush()
    admin = (
        await db_session.execute(
            select(User).where(User.username == DEFAULT_ADMIN_USERNAME)
        )
    ).scalar_one()
    assert admin.contract_pending is True, "the seeded administrator owes a contract"

    gate = FakePricingGate()
    space_client.set_gate(gate)
    try:
        await settle_pending_contract(admin, db_session)
    finally:
        space_client.set_gate(None)

    assert admin.contract_pending is False
    assert admin.id in gate.contracts


async def test_settling_is_skipped_for_an_account_that_owes_nothing(db_session):
    # It runs on every authenticated request, so the common case has to cost a
    # boolean rather than a call to a pricing service.
    from openbinding_gateway import space_client
    from openbinding_gateway.access.contracts import settle_pending_contract
    from openbinding_gateway.space_client import FakePricingGate

    await seed_default_administrator(db_session)
    admin = (
        await db_session.execute(
            select(User).where(User.username == DEFAULT_ADMIN_USERNAME)
        )
    ).scalar_one()
    admin.contract_pending = False

    gate = FakePricingGate()
    space_client.set_gate(gate)
    try:
        await settle_pending_contract(admin, db_session)
    finally:
        space_client.set_gate(None)

    assert gate.contracts == {}


async def test_an_account_stays_pending_while_space_is_still_down(db_session):
    # And the request it happened during must not fail because of it.
    from openbinding_gateway import space_client
    from openbinding_gateway.access.contracts import settle_pending_contract
    from openbinding_gateway.space_client import FakePricingGate

    await seed_default_administrator(db_session)
    admin = (
        await db_session.execute(
            select(User).where(User.username == DEFAULT_ADMIN_USERNAME)
        )
    ).scalar_one()

    gate = FakePricingGate()
    gate.unavailable = True
    space_client.set_gate(gate)
    try:
        await settle_pending_contract(admin, db_session)
    finally:
        space_client.set_gate(None)

    assert admin.contract_pending is True
