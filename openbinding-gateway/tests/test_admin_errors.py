"""Tests for plan-allowance/concurrency error discrimination, telemetry recording, and admin error diagnostics."""

from __future__ import annotations

import uuid
from _problem_helpers import revision_of, runs_url_for
from _problem_helpers import placeholder_refs
from datetime import timedelta

import pytest_asyncio
from sqlalchemy import select

from _pricing import caps_for, fake_pricing_gate, fixture_catalog
from _repo import REPO_ROOT
from test_api_keys import key_payload
from openbinding_gateway import space_client
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import ApiErrorEvent, Job, JobState, User, UserRole, utcnow
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
CATALOG = fixture_catalog()


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


async def _create_revision(client, headers):
    """Jobs are launched by JSON naming a problem revision."""
    revision_id = await revision_of(client, headers, archive=load_package(EXAMPLE).to_zip())
    return revision_id


def _job_request(revision_id):
    return {
        "revision": revision_id,
        "engine": "random-search",
        "mode": "seeded",
        "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
    }


async def _exceed_the_api_key_allowance(client, headers):
    """A 402 ``quota_exceeded``: the plan's allowance of API keys (``maxApiKeys``) is spent."""
    allowance = int(caps_for(fixture_catalog().default_plan).limit("maxApiKeys"))
    for n in range(allowance):
        minted = await client.post("/v1/users/me/api-keys", headers=headers, json=key_payload(f"key {n}"))
        assert minted.status_code == 201, minted.text
    return await client.post("/v1/users/me/api-keys", headers=headers, json=key_payload("one too many"))


async def test_the_api_key_allowance_returns_402_quota_exceeded(api_client, db_session, registration, gate):
    details = registration()
    headers, _ = await _register(api_client, details, db_session)

    response = await _exceed_the_api_key_allowance(api_client, headers)

    assert response.status_code == 402, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "quota_exceeded"
    assert detail["quota"]["limit_id"] == "maxApiKeys"
    assert "Retry-After" not in response.headers


async def test_solve_returns_429_on_concurrency_exceeded(api_client, db_session, registration, gate, monkeypatch):
    details = registration()
    headers, user_id = await _register(api_client, details, db_session)
    revision_id = await _create_revision(api_client, headers)

    # The account's only slot is taken by a job that is still queued.
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    db_session.add(Job(
        created_by_id=user_id, engine_id="random-search", engine_job_id="busy",
        service_url="http://engine", state=JobState.QUEUED, **placeholder_refs(),
    ))
    await db_session.commit()

    response = await api_client.post(runs_url_for(revision_id), headers=headers, json=_job_request(revision_id))

    assert response.status_code == 429, response.text
    body = response.json()
    assert body["title"] == "concurrency_limit_exceeded"
    assert body["detail"]["concurrency"]["limit"] == body["detail"]["concurrency"]["active"] == 1
    assert response.headers.get("Retry-After") == "15"


async def test_telemetry_captures_errors_and_sanitizes(api_client, db_session, registration):
    # Send a bad login attempt
    bad_login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": "nonexistent", "password": "super-secret-password-123"},
    )
    assert bad_login.status_code == 401

    # Send a validation failure
    bad_req = await api_client.post(
        "/v1/organizations/acme/runs",
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
    refused = await _exceed_the_api_key_allowance(api_client, user_headers)
    assert refused.status_code == 402, refused.text

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
