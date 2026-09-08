"""Tests for quota/concurrency error discrimination, telemetry recording, and admin error diagnostics."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest_asyncio
from sqlalchemy import select

from _pricing import fake_pricing_gate, pricing_catalog
from _repo import REPO_ROOT
from openbinding_gateway import space_client
from openbinding_gateway.db.models import ApiErrorEvent, User, UserRole, utcnow
from openbinding_gateway.v1.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
CATALOG = pricing_catalog()


@pytest_asyncio.fixture
async def gate():
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def _register(client, details, db_session=None, *, admin=False) -> tuple[dict, uuid.UUID]:
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201

    user_id = None
    if db_session is not None:
        user = (
            await db_session.execute(select(User).where(User.username == details["username"]))
        ).scalars().one()
        user_id = user.id
        if admin:
            user.role = UserRole.ADMIN
            await db_session.flush()

    tokens = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert tokens.status_code == 200
    headers = {"Authorization": f"Bearer {tokens.json()['access_token']}"}
    return headers, user_id


async def test_solve_returns_402_on_task_quota_exceeded(api_client, db_session, registration, gate):
    details = registration()
    headers, user_id = await _register(api_client, details, db_session)

    # Exhaust monthly task quota
    gate.exhaust(user_id, "taskStarts")

    package = load_package(EXAMPLE)
    response = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )

    assert response.status_code == 402, response.text
    body = response.json()
    assert body["title"] == "quota_exceeded"
    assert "quota" in body
    assert body["quota"]["limit_id"] == "taskStarts"
    assert body["quota"]["used"] >= body["quota"]["limit"]
    assert "Retry-After" not in response.headers


async def test_solve_returns_429_on_concurrency_exceeded(api_client, db_session, registration, gate):
    details = registration()
    headers, user_id = await _register(api_client, details, db_session)

    # Exhaust concurrent slots
    gate.exhaust(user_id, "concurrentJobs")

    package = load_package(EXAMPLE)
    response = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )

    assert response.status_code == 429, response.text
    body = response.json()
    assert body["title"] == "concurrency_limit_exceeded"
    assert "concurrency" in body
    assert body["concurrency"]["limit_id"] == "concurrentJobs"
    assert response.headers.get("Retry-After") == "15"


async def test_precedence_commercial_quota_over_concurrency(api_client, db_session, registration, gate):
    details = registration()
    headers, user_id = await _register(api_client, details, db_session)

    # Exhaust BOTH commercial quota and concurrency slots
    gate.exhaust(user_id, "taskStarts")
    gate.exhaust(user_id, "concurrentJobs")

    package = load_package(EXAMPLE)
    response = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )

    # Precedence rule: 402 must take priority so user does not wait in vain
    assert response.status_code == 402, response.text
    body = response.json()
    assert body["title"] == "quota_exceeded"
    assert body["quota"]["limit_id"] == "taskStarts"
    assert "Retry-After" not in response.headers


async def test_telemetry_captures_errors_and_sanitizes(api_client, db_session, registration):
    # Send a bad login attempt
    bad_login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": "nonexistent", "password": "super-secret-password-123"},
    )
    assert bad_login.status_code == 401

    # Send a validation failure
    bad_req = await api_client.post(
        "/v1/jobs",
        headers={"Content-Type": "application/json"},
        json={"invalid": "payload"},
    )
    assert bad_req.status_code in {401, 422}

    # Query ApiErrorEvent directly
    events = (await db_session.execute(select(ApiErrorEvent))).scalars().all()
    assert len(events) >= 2

    login_event = next((e for e in events if "/v1/auth/login" in e.endpoint), None)
    assert login_event is not None
    assert login_event.category == "auth"
    # Ensure sensitive credentials were redacted or omitted
    detail_str = str(login_event.detail)
    assert "super-secret-password-123" not in detail_str
    assert "password" not in login_event.detail or login_event.detail.get("password") == "[REDACTED]"


async def test_admin_error_endpoints_and_overview(api_client, db_session, registration, gate):
    admin_details = registration()
    admin_headers, admin_id = await _register(api_client, admin_details, db_session, admin=True)

    user_details = registration()
    user_headers, user_id = await _register(api_client, user_details, db_session)

    # Trigger a 402 quota error for user
    gate.exhaust(user_id, "taskStarts")
    package = load_package(EXAMPLE)
    await api_client.post(
        "/v1/jobs",
        headers={**user_headers, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )

    # Overview endpoint
    overview_resp = await api_client.get("/v1/admin/errors/overview", headers=admin_headers)
    assert overview_resp.status_code == 200, overview_resp.text
    overview = overview_resp.json()
    assert "total_errors_24h" in overview
    assert overview["total_errors_24h"] >= 1
    assert "by_category_24h" in overview
    assert "timeline" in overview
    assert len(overview["timeline"]) == 24
    assert any(u["userId"] == str(user_id) for u in overview["top_users_quota"])

    # List endpoint
    list_resp = await api_client.get("/v1/admin/errors?category=pricing_quota", headers=admin_headers)
    assert list_resp.status_code == 200, list_resp.text
    data = list_resp.json()
    assert data["total"] >= 1
    assert any(item["errorCode"] == "quota_exceeded" for item in data["items"])
    item = data["items"][0]
    assert "statusCode" in item
    assert "detail" in item

    # Non-admin forbidden
    forbidden_resp = await api_client.get("/v1/admin/errors/overview", headers=user_headers)
    assert forbidden_resp.status_code == 403


async def test_admin_purge_expired_errors(api_client, db_session, registration):
    admin_details = registration()
    admin_headers, _ = await _register(api_client, admin_details, db_session, admin=True)

    now = utcnow()
    old_event = ApiErrorEvent(
        id=uuid.uuid4(),
        status_code=500,
        category="system_bug",
        error_code="http_500",
        endpoint="/v1/test",
        http_method="GET",
        detail={"error": "old"},
        created_at=now - timedelta(days=120),
    )
    db_session.add(old_event)
    await db_session.flush()

    purge_resp = await api_client.post(
        "/v1/admin/maintenance/purge",
        headers=admin_headers,
        json={"confirmation": "PURGE EXPIRED", "error_retention_days": 90},
    )
    assert purge_resp.status_code == 200, purge_resp.text
    result = purge_resp.json()
    assert result.get("errorEvents", 0) >= 1

    # Verify event was deleted
    remaining = await db_session.get(ApiErrorEvent, old_event.id)
    assert remaining is None
