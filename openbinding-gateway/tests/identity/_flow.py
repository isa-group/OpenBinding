"""Helpers of the identity flow tests: an account with a SCORETech identity and a sign-in through the fake."""

from __future__ import annotations

import uuid
from urllib.parse import parse_qs, urlsplit

from openbinding_gateway.db.models import AuthIdentity, User

from ._settings import ISSUER


async def known_user(db, fake, **values) -> tuple[User, AuthIdentity, object]:
    person = fake.user(**values)
    suffix = uuid.uuid4().hex[:8]
    user = User(
        username=f"known{suffix}", email=f"{uuid.uuid4()}@identity.openbinding.invalid", password_hash="x",
        password_enabled=False, plan_cache="FREE",
    )
    db.add(user)
    await db.flush()
    identity = AuthIdentity(user_id=user.id, provider="scoretech", issuer=ISSUER, subject=person.sub, attributes={})
    db.add(identity)
    await db.flush()
    return user, identity, person


async def start(browser, *, return_to: str | None = "/compositions", screen: str | None = None):
    params = {}
    if return_to is not None:
        params["returnTo"] = return_to
    if screen:
        params["screen"] = screen
    return await browser.get("/v1/auth/identity/login", params=params)


async def sign_in(browser, fake, person, **start_values):
    begun = await start(browser, **start_values)
    assert begun.status_code == 302, begun.text
    query = fake.authorize(begun.headers["location"], person)
    return await browser.get("/v1/auth/identity/callback", params=query)


def query_of(location: str) -> dict:
    return {key: values[0] for key, values in parse_qs(urlsplit(location).query).items()}


def session_cookie(browser) -> str | None:
    return browser.cookies.get("__Host-ob_session")


async def first_sign_in(browser, fake, person, **start_values):
    """A sign-in of an unknown identity: the callback answer (to the username screen, with the pending cookie)."""
    return await sign_in(browser, fake, person, **start_values)


async def choose(browser, username: str, **headers):
    return await browser.post("/v1/auth/identity/complete", json={"username": username}, headers=headers or None)
