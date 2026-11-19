"""First sign-ins racing on PostgreSQL: one username, ``Alice`` against ``alice``, one identity twice (T15)."""

from __future__ import annotations

import asyncio
import contextlib

import pytest

from ._flow import choose, first_sign_in
from ._settings import FRONTEND



@contextlib.asynccontextmanager
async def browsers(pg, count: int):
    from httpx import ASGITransport, AsyncClient

    from openbinding_gateway.access.dependencies import optional_session, session_dependency
    from openbinding_gateway.main import app

    async def one_session_per_request():
        async with pg.session() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[session_dependency] = one_session_per_request
    app.dependency_overrides[optional_session] = one_session_per_request
    clients = [
        AsyncClient(transport=ASGITransport(app=app), base_url=FRONTEND, headers={"origin": FRONTEND})
        for _ in range(count)
    ]
    try:
        yield clients
    finally:
        for client in clients:
            await client.aclose()
        app.dependency_overrides.clear()


def _outcome(response) -> tuple[int, str | None]:
    body = response.json()
    return response.status_code, (body.get("detail") or {}).get("code") if isinstance(body.get("detail"), dict) else None


@pytest.mark.usefixtures("fake_issuer")
@pytest.mark.parametrize("names", [("racer", "racer"), ("Alice", "alice")])
async def test_two_pending_sign_ups_racing_for_one_username(pg, fake_issuer, names) -> None:
    async with browsers(pg, 2) as (one, two):
        await first_sign_in(one, fake_issuer, fake_issuer.user(email="one@example.invalid"))
        await first_sign_in(two, fake_issuer, fake_issuer.user(email="two@example.invalid"))
        results = await asyncio.gather(choose(one, names[0]), choose(two, names[1]))
    outcomes = sorted(_outcome(response) for response in results)
    assert outcomes == [(201, None), (409, "username_taken")], outcomes


@pytest.mark.usefixtures("fake_issuer")
async def test_one_identity_completed_from_two_browsers(pg, fake_issuer) -> None:
    person = fake_issuer.user()
    async with browsers(pg, 2) as (one, two):
        await first_sign_in(one, fake_issuer, person)
        await first_sign_in(two, fake_issuer, person)
        results = await asyncio.gather(choose(one, "first-name"), choose(two, "second-name"))
    outcomes = sorted(_outcome(response) for response in results)
    assert outcomes == [(201, None), (409, "identity_already_provisioned")], outcomes


async def test_a_local_registration_of_alice_beside_alice_is_refused(pg, registration) -> None:
    from _pg_support import http_client

    async with http_client(pg) as client:
        first = await client.post("/v1/auth/register", json=registration(username="alice"))
        second = await client.post("/v1/auth/register", json=registration(username="Alice"))
    assert first.status_code == 201
    assert second.status_code == 409 and second.json()["detail"]["code"] == "already_registered"
