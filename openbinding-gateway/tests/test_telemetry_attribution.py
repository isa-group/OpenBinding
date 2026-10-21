"""Error events are attributed only to authenticated users, and anonymous noise is bounded."""

from __future__ import annotations

import uuid
from datetime import timedelta

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from _b1_helpers import gate, make_account  # noqa: F401
from openbinding_gateway import telemetry
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import ApiErrorEvent, utcnow


@pytest.fixture(autouse=True)
def fresh_limits():
    telemetry.reset_anonymous_error_limits()
    yield
    telemetry.reset_anonymous_error_limits()


async def _events(db, endpoint: str) -> list[ApiErrorEvent]:
    rows = await db.execute(select(ApiErrorEvent).where(ApiErrorEvent.endpoint == endpoint))
    return list(rows.scalars().all())


async def test_request_state_is_the_scope_state_the_middleware_reads():
    async def endpoint(request: Request):
        request.state.user_id = uuid.UUID(int=7)
        return JSONResponse({"detail": "nope"}, status_code=401)

    app = Starlette(routes=[Route("/x", endpoint)])
    seen: dict = {}

    class Spy:
        def __init__(self, inner):
            self.inner = inner

        async def __call__(self, scope, receive, send):
            await self.inner(scope, receive, send)
            seen.update(scope["state"])

    app.add_middleware(Spy)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        assert (await client.get("/x")).status_code == 401
    assert seen["user_id"] == uuid.UUID(int=7)


async def test_a_forged_bearer_with_a_foreign_sub_is_not_attributed(
    api_client, registration, db_session, gate  # noqa: F811
):
    victim, _ = await make_account(api_client, registration, db_session, gate)
    forged = jwt.encode({"sub": victim["id"]}, "not-the-signing-secret-0123456789", algorithm="HS256")

    response = await api_client.get("/v1/jobs", headers={"Authorization": f"Bearer {forged}"})

    assert response.status_code == 401
    events = await _events(db_session, "/v1/jobs")
    assert len(events) == 1
    assert events[0].user_id is None


async def test_a_valid_credential_is_attributed_to_its_user(
    api_client, registration, db_session, gate  # noqa: F811
):
    user, headers = await make_account(api_client, registration, db_session, gate)
    missing = uuid.uuid4()

    response = await api_client.get(f"/v1/jobs/{missing}", headers=headers)

    assert response.status_code == 404
    events = await _events(db_session, f"/v1/jobs/{missing}")
    assert len(events) == 1
    assert events[0].user_id == uuid.UUID(user["id"])


async def test_anonymous_401_events_are_limited_per_client(api_client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 3)

    for _ in range(5):
        assert (await api_client.get("/v1/jobs")).status_code == 401

    assert len(await _events(db_session, "/v1/jobs")) == 3


async def test_anonymous_events_are_unlimited_when_the_limit_is_zero(api_client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 0)

    for _ in range(5):
        assert (await api_client.get("/v1/jobs")).status_code == 401

    assert len(await _events(db_session, "/v1/jobs")) == 5


async def test_the_limit_does_not_apply_to_authenticated_users(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 1)
    _, headers = await make_account(api_client, registration, db_session, gate)
    missing = uuid.uuid4()

    for _ in range(3):
        assert (await api_client.get(f"/v1/jobs/{missing}", headers=headers)).status_code == 404

    assert len(await _events(db_session, f"/v1/jobs/{missing}")) == 3


def test_the_client_table_stays_bounded(monkeypatch):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 5)

    for index in range(10_050):
        telemetry._admit_anonymous_error(f"10.{index}")

    assert len(telemetry._anonymous_hits) <= 10_000


async def test_purge_removes_only_events_older_than_the_retention(db_session):
    def event(age_days: int) -> ApiErrorEvent:
        return ApiErrorEvent(
            id=uuid.uuid4(), status_code=404, category="system_bug", error_code="not_found",
            endpoint="/purge", http_method="GET", detail={}, created_at=utcnow() - timedelta(days=age_days),
        )

    old, recent = event(120), event(10)
    db_session.add_all([old, recent])
    await db_session.flush()

    removed = await telemetry.purge_old_error_events(db_session, days=90)

    assert removed == 1
    remaining = await db_session.scalar(
        select(func.count()).select_from(ApiErrorEvent).where(ApiErrorEvent.endpoint == "/purge")
    )
    assert remaining == 1
    assert await db_session.get(ApiErrorEvent, recent.id) is not None
