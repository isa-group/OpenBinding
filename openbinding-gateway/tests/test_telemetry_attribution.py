"""Error events are attributed only to authenticated users, and anonymous noise is bounded."""

from __future__ import annotations

import json
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
from openbinding_gateway.routes import compositions


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


# ------------------------------------------------------------- every failure of an anonymous caller


async def test_anonymous_422_events_are_limited_per_client(api_client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 3)

    for _ in range(5):
        assert (await api_client.post("/v1/compositions/validate", json={})).status_code == 422

    assert len(await _events(db_session, "/v1/compositions/validate")) == 3


async def test_anonymous_429_events_are_limited_per_client(api_client, db_session, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "anonymous_error_events_per_minute", 2)
    monkeypatch.setattr(settings, "work_rate_limit_read_requests", 1)

    statuses = [(await api_client.post("/v1/compositions/parse", json={})).status_code for _ in range(6)]

    assert statuses == [422] + [429] * 5
    rows = await _events(db_session, "/v1/compositions/parse")
    assert len(rows) == 2
    assert {row.status_code for row in rows} == {422, 429}


async def test_anonymous_503_events_are_limited_per_client(api_client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 2)

    async def busy(*_: object, **__: object):
        raise compositions._readers_busy()

    monkeypatch.setattr(compositions, "_on", busy)

    answers = []
    for _ in range(4):
        response = await api_client.post("/v1/compositions/validate", json={"source": "a: 1\n"})
        assert response.status_code == 503
        answers.append(response.json()["correlationId"])

    rows = await _events(db_session, "/v1/compositions/validate")
    assert len(rows) == 2
    assert {row.error_code for row in rows} == {"composition_busy"}
    # A 5xx keeps the one thing that leads from the row to its cause in the log.
    assert {row.detail["correlationId"] for row in rows} == set(answers[:2])


async def test_an_anonymous_event_holds_counts_and_no_message(api_client, db_session):
    secret = "A VALUE THE CALLER CHOSE"

    response = await api_client.post(
        "/v1/compositions/package", json={"source": f"composition: {secret}\n"}
    )

    assert response.status_code == 422
    assert secret in response.text  # the caller is told; the table is not
    [event] = await _events(db_session, "/v1/compositions/package")
    assert event.user_id is None
    assert event.detail == {
        "code": "invalid_composition",
        "status": 422,
        "endpoint": "/v1/compositions/package",
        "counts": {"diagnostics": len(response.json()["diagnostics"]), "suppressed": 0},
    }
    assert secret not in json.dumps(event.detail)


async def test_an_anonymous_event_on_an_authentication_route_keeps_its_counts(api_client, db_session):
    response = await api_client.post(
        "/v1/auth/login", json={"username_or_email": "nobody", "password": "wrong-password-here"}
    )

    assert response.status_code == 401
    [event] = await _events(db_session, "/v1/auth/login")
    assert event.detail["counts"] == {"diagnostics": 0, "suppressed": 0}
    assert event.detail["endpoint"] == "/v1/auth/login"
    assert "error" not in event.detail and "detail" not in event.detail


async def test_the_next_event_says_how_many_went_unrecorded(api_client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 1)

    for _ in range(4):
        await api_client.post("/v1/compositions/validate", json={})
    assert len(await _events(db_session, "/v1/compositions/validate")) == 1

    telemetry._anonymous_hits["127.0.0.1"].clear()  # the minute has passed
    await api_client.post("/v1/compositions/validate", json={})

    rows = await _events(db_session, "/v1/compositions/validate")
    assert sorted(row.detail["counts"]["suppressed"] for row in rows) == [0, 3]
    assert telemetry._anonymous_suppressed == {}


async def test_the_addresses_of_one_ipv6_network_share_their_events(api_client, db_session, monkeypatch):
    from openbinding_gateway.main import app

    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 1)

    for host in ("2001:db8:1:2::1", "2001:db8:1:2::2"):
        transport = ASGITransport(app=app, client=(host, 51000))
        async with AsyncClient(transport=transport, base_url="http://gateway") as client:
            await client.post("/v1/compositions/validate", json={})

    assert len(await _events(db_session, "/v1/compositions/validate")) == 1


async def test_a_signed_in_failure_is_kept_whole_and_not_limited(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 1)
    user, headers = await make_account(api_client, registration, db_session, gate)

    for _ in range(3):
        response = await api_client.post(
            "/v1/compositions/package", json={"source": "composition: [\n"}, headers=headers
        )
        assert response.status_code == 422

    rows = await _events(db_session, "/v1/compositions/package")
    assert len(rows) == 3
    assert all(row.user_id == uuid.UUID(user["id"]) for row in rows)
    assert all(row.detail["diagnostics"] and "counts" not in row.detail for row in rows)


async def test_a_signed_in_failure_of_a_package_validation_is_attributed(
    api_client, registration, db_session, gate  # noqa: F811
):
    user, headers = await make_account(api_client, registration, db_session, gate)

    response = await api_client.post(
        "/v1/instances/validate", content=b"not a zip", headers={**headers, "content-type": "application/zip"}
    )

    assert response.status_code >= 400
    [event] = await _events(db_session, "/v1/instances/validate")
    assert event.user_id == uuid.UUID(user["id"])


def test_the_suppressed_table_stays_bounded(monkeypatch):
    monkeypatch.setattr(get_settings(), "anonymous_error_events_per_minute", 1)

    for index in range(10_050):
        telemetry._admit_anonymous_error(f"10.{index}")
        telemetry._admit_anonymous_error(f"10.{index}")

    assert len(telemetry._anonymous_suppressed) <= 10_000
