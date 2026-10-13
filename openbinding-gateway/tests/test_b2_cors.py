"""B2 #8 and #13: a closed CORS list by default, and the headers the browser may read.

Sessions live in ``localStorage``, so the origin list is the line between the
frontend and every other website. ``Retry-After`` is only readable by the
frontend's 429 countdown when CORS exposes it.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from pydantic import ValidationError

from openbinding_gateway import main, space_client
from openbinding_gateway.core.settings import (
    CORS_EXPOSED_HEADERS,
    DEV_CORS_ORIGINS,
    Settings,
    get_settings,
)
from openbinding_gateway.db.models import Job, JobState, User
from sqlalchemy import select
from _pricing import fake_pricing_gate
from _repo import REPO_ROOT
from bim_core.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
FRONTEND_DEV = "http://localhost:5173"


@pytest.fixture(autouse=True)
def clean_cors_environment(monkeypatch):
    for name in ("CORS_ALLOW_ORIGINS", "CORS_ALLOW_CREDENTIALS", "APP_ENV"):
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


# -- #8: closed by default ---------------------------------------------------


def test_the_default_origins_are_a_closed_list_of_local_development_origins():
    configured = settings()

    assert configured.cors_origin_list == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4177",
        "http://127.0.0.1:4177",
    ]
    assert "*" not in configured.cors_origin_list
    assert DEV_CORS_ORIGINS == ",".join(configured.cors_origin_list)


def test_the_closed_default_allows_credentials_again():
    # The wildcard used to switch credentials off; a named list does not.
    assert settings().cors_credentials_allowed is True


def test_the_origin_list_still_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "https://a.example, https://b.example")

    assert Settings(_env_file=None).cors_origin_list == ["https://a.example", "https://b.example"]


@pytest.mark.parametrize("origins", ["*", "https://a.example,*", " * ", "*,https://a.example"])
def test_production_refuses_a_wildcard(origins):
    with pytest.raises(ValidationError, match=r"CORS_ALLOW_ORIGINS.*'\*'.*APP_ENV=prod"):
        settings(app_env="prod", cors_allow_origins=origins)


@pytest.mark.parametrize("origins", ["", " ", ",", " , ,"])
def test_production_refuses_an_empty_list(origins):
    with pytest.raises(ValidationError, match=r"CORS_ALLOW_ORIGINS is empty.*APP_ENV=prod"):
        settings(app_env="prod", cors_allow_origins=origins)


def test_production_accepts_an_explicit_closed_list():
    configured = settings(
        app_env="prod", space_enabled=True, cors_allow_origins="https://openbinding.example.org"
    )

    assert configured.cors_origin_list == ["https://openbinding.example.org"]
    assert configured.cors_credentials_allowed is True


def test_the_startup_failure_is_raised_when_the_process_reads_its_settings(monkeypatch):
    monkeypatch.setenv("APP_ENV", "prod")
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "*")
    get_settings.cache_clear()

    with pytest.raises(ValidationError) as failure:
        get_settings()

    assert "CORS_ALLOW_ORIGINS" in str(failure.value)


@pytest.mark.parametrize("app_env", ["dev", "test"])
def test_a_wildcard_is_tolerated_outside_production_and_still_drops_credentials(app_env):
    configured = settings(app_env=app_env, cors_allow_origins="*", cors_allow_credentials=True)

    assert configured.cors_origin_list == ["*"]
    assert configured.cors_credentials_allowed is False


def test_an_empty_list_outside_production_allows_no_origin_at_all():
    assert settings(app_env="dev", cors_allow_origins="").cors_origin_list == []


def test_the_running_app_was_built_from_a_closed_list():
    # The middleware is configured once at import from the process settings.
    assert "*" not in main.settings.cors_origin_list
    assert main.settings.cors_origin_list


# -- #13: exposed headers ----------------------------------------------------


def test_retry_after_is_always_among_the_exposed_headers():
    assert "Retry-After" in CORS_EXPOSED_HEADERS
    assert {"ETag", "Location", "Content-Disposition", "Digest", "Idempotency-Key"} <= set(CORS_EXPOSED_HEADERS)
    assert settings().cors_expose_headers == list(CORS_EXPOSED_HEADERS)


def allowed_origin() -> str:
    return main.settings.cors_origin_list[0]


async def test_a_normal_response_exposes_the_headers_to_an_allowed_origin(api_client):
    origin = allowed_origin()

    response = await api_client.get("/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    exposed = {name.strip().lower() for name in response.headers["access-control-expose-headers"].split(",")}
    assert {name.lower() for name in CORS_EXPOSED_HEADERS} == exposed


async def test_a_foreign_origin_is_never_allowed_to_read_the_response(api_client):
    response = await api_client.get("/health", headers={"Origin": "https://evil.example"})

    assert response.status_code == 200
    # Without Access-Control-Allow-Origin the browser withholds the response from
    # the page, whatever else is attached (Starlette adds the expose list to every
    # CORS response; it is inert without the allow-origin header).
    assert "access-control-allow-origin" not in response.headers


async def test_a_request_without_origin_gets_no_cors_headers(api_client):
    response = await api_client.get("/health")

    assert "access-control-allow-origin" not in response.headers
    assert "access-control-expose-headers" not in response.headers


async def test_the_preflight_of_a_foreign_origin_is_refused(api_client):
    foreign = await api_client.options(
        "/v1/jobs",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    local = await api_client.options(
        "/v1/jobs",
        headers={"Origin": allowed_origin(), "Access-Control-Request-Method": "POST"},
    )

    assert foreign.status_code == 400
    assert "access-control-allow-origin" not in foreign.headers
    assert local.status_code == 200
    assert local.headers["access-control-allow-origin"] == allowed_origin()


@pytest_asyncio.fixture
async def gate():
    installed = fake_pricing_gate()
    space_client.set_gate(installed)
    yield installed
    space_client.set_gate(None)


async def test_a_429_exposes_retry_after_to_the_browser(
    api_client, db_session, registration, gate, monkeypatch
):
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201
    user = (await db_session.execute(select(User).where(User.username == details["username"]))).scalars().one()
    tokens = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    headers = {"Authorization": f"Bearer {tokens.json()['access_token']}"}
    snapshot = await api_client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=load_package(EXAMPLE).to_zip(),
    )
    assert snapshot.status_code == 201, snapshot.text
    # The account's only slot is taken by a job that is still queued.
    monkeypatch.setattr(get_settings(), "max_concurrent_jobs_per_user", 1)
    db_session.add(Job(
        owner_id=user.id, engine_id="random-search", engine_job_id="busy",
        service_url="http://engine", state=JobState.QUEUED,
    ))
    await db_session.commit()
    origin = allowed_origin()

    response = await api_client.post(
        "/v1/jobs",
        headers={**headers, "Origin": origin},
        json={
            "snapshot": snapshot.json()["id"],
            "engine": "random-search",
            "mode": "seeded",
            "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
        },
    )

    assert response.status_code == 429, response.text
    assert response.headers["retry-after"] == "15"
    assert response.headers["access-control-allow-origin"] == origin
    exposed = {name.strip().lower() for name in response.headers["access-control-expose-headers"].split(",")}
    assert "retry-after" in exposed
