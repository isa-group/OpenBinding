"""Phase 2-3 hardening: body limits, authentication throttling, token and secret rules,
and what a project VIEWER may read of a job."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

import jwt
import pytest
from cryptography.fernet import Fernet
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy import select

from _b1_helpers import gate, make_account, make_key, make_org, put_member  # noqa: F401
from openbinding_gateway.core.ratelimit import (
    AuthRateLimiter,
    MemoryBackend,
    RedisBackend,
    set_auth_limiter,
)
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import Job, JobState, StudyCell
from openbinding_gateway.models.platform import job_view
from openbinding_gateway.security.bodylimit import BodyLimitMiddleware, is_upload
from openbinding_gateway.security.redaction import allowed_option_names
from openbinding_gateway.security.secrets import CredentialStore, SecretsUnavailable
from openbinding_gateway.security.tokens import (
    TokenError,
    issue_access_token,
    issue_refresh_token,
    read_access_token,
    read_refresh_token,
)

LONG_SECRET = "a-signing-secret-of-more-than-32-characters"


# --------------------------------------------------------------------------- 1. body limits


async def run_asgi(app, *, method="POST", path="/v1/anything", headers=(), chunks=()):
    """Drive an ASGI app with a body delivered chunk by chunk, with no Content-Length
    unless a header says so. Returns the messages sent and how many chunks were pulled."""
    sent: list[dict] = []
    pending = list(chunks)
    pulled = 0

    async def receive():
        nonlocal pulled
        if pulled < len(pending):
            body = pending[pulled]
            pulled += 1
            return {"type": "http.request", "body": body, "more_body": pulled < len(pending)}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "root_path": "",
        "headers": [(name.encode(), value.encode()) for name, value in headers],
    }
    await app(scope, receive, send)
    return sent, pulled


def refusal(sent):
    start = next(message for message in sent if message["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start, json.loads(body)


async def reading_app(scope, receive, send):
    total = 0
    while True:
        message = await receive()
        total += len(message.get("body", b""))
        if not message.get("more_body"):
            break
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": str(total).encode()})


async def framework_like_app(scope, receive, send):
    """Behaves like FastAPI: any failure while reading the body becomes a 400."""
    try:
        while (await receive()).get("more_body"):
            pass
    except Exception:  # noqa: BLE001
        await send({"type": "http.response.start", "status": 400, "headers": []})
        await send({"type": "http.response.body", "body": b"There was an error parsing the body"})
        return
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


async def test_a_chunked_json_body_is_cut_off_at_the_limit_without_content_length():
    app = BodyLimitMiddleware(reading_app, max_request_bytes=1000, max_json_bytes=25)

    sent, pulled = await run_asgi(app, chunks=[b"x" * 10] * 100)

    start, body = refusal(sent)
    assert start["status"] == 413
    assert (b"content-type", b"application/problem+json") in start["headers"]
    assert body["code"] == "payload_too_large" and body["status"] == 413
    # It stopped reading at the chunk that crossed the limit: 10, 20, 30 > 25.
    assert pulled == 3


async def test_a_declared_length_over_the_limit_never_reaches_the_application():
    called = []

    async def app(scope, receive, send):
        called.append(True)

    sent, pulled = await run_asgi(
        BodyLimitMiddleware(app, max_request_bytes=1000, max_json_bytes=25),
        headers=[("content-length", "26")],
        chunks=[b"x" * 26],
    )

    assert refusal(sent)[0]["status"] == 413
    assert called == [] and pulled == 0


async def test_a_body_at_the_limit_passes():
    app = BodyLimitMiddleware(reading_app, max_request_bytes=1000, max_json_bytes=25)

    sent, _ = await run_asgi(app, chunks=[b"x" * 10, b"x" * 15])

    start, _ = refusal_or_ok(sent)
    assert start["status"] == 200


def refusal_or_ok(sent):
    start = next(message for message in sent if message["type"] == "http.response.start")
    return start, b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")


async def test_the_frameworks_400_for_an_unreadable_body_becomes_the_413():
    app = BodyLimitMiddleware(framework_like_app, max_request_bytes=1000, max_json_bytes=25)

    sent, _ = await run_asgi(app, chunks=[b"x" * 20, b"x" * 20])

    start, body = refusal(sent)
    assert start["status"] == 413 and body["code"] == "payload_too_large"
    assert [m["status"] for m in sent if m["type"] == "http.response.start"] == [413]


async def test_upload_routes_keep_the_larger_ceiling_and_other_routes_the_json_one():
    app = BodyLimitMiddleware(reading_app, max_request_bytes=1000, max_json_bytes=25)

    upload, _ = await run_asgi(app, path="/v1/instances", chunks=[b"x" * 500])
    blob, _ = await run_asgi(
        app, path="/v1/organizations/o/projects/p/blobs", chunks=[b"x" * 500, b"x" * 400]
    )
    document, _ = await run_asgi(app, path="/v1/organizations", chunks=[b"x" * 500])
    too_big_upload, _ = await run_asgi(app, path="/v1/instances", chunks=[b"x" * 600, b"x" * 600])

    assert refusal_or_ok(upload)[0]["status"] == 200
    assert refusal_or_ok(blob)[0]["status"] == 200
    assert refusal_or_ok(document)[0]["status"] == 413
    assert refusal_or_ok(too_big_upload)[0]["status"] == 413


def test_the_upload_routes_are_the_package_and_artifact_ones():
    assert is_upload("POST", "/v1/jobs")
    assert is_upload("POST", "/v1/organizations/acme/projects/p/blobs")
    assert is_upload("POST", "/v1/organizations/acme/projects/p/package")
    assert not is_upload("GET", "/v1/jobs")
    assert not is_upload("POST", "/v1/auth/login")
    assert not is_upload("POST", "/v1/engine-registrations")


def test_the_default_ceilings_keep_the_upload_limit_and_tighten_the_rest():
    settings = Settings(_env_file=None)
    assert settings.max_request_body_bytes == 512 * 1024 * 1024
    assert settings.max_json_body_bytes < settings.max_request_body_bytes
    with pytest.raises(ValidationError, match="MAX_JSON_BODY_BYTES"):
        Settings(_env_file=None, max_json_body_bytes=2048, max_request_body_bytes=1024)


async def chunks_of(size: int, count: int):
    for _ in range(count):
        yield b"x" * size


async def test_the_application_refuses_a_chunked_json_body_with_a_problem_document(
    api_client, monkeypatch
):
    monkeypatch.setattr(get_settings(), "max_json_body_bytes", 64)

    response = await api_client.post(
        "/v1/auth/login", content=chunks_of(16, 40), headers={"content-type": "application/json"}
    )

    assert response.status_code == 413, response.text
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "payload_too_large"


async def test_the_application_refuses_a_declared_length_over_the_limit(api_client, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_json_body_bytes", 64)

    response = await api_client.post(
        "/v1/auth/login", content=b"x" * 200, headers={"content-type": "application/json"}
    )

    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


async def test_an_upload_route_is_not_held_to_the_json_limit(api_client, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_json_body_bytes", 64)

    response = await api_client.post(
        "/v1/instances", content=b"x" * 200, headers={"content-type": "application/zip"}
    )

    assert response.status_code != 413  # whatever the route says (401/422), not the limiter

    # The upload ceiling still applies: a declared length above it never reaches the route.
    monkeypatch.setattr(get_settings(), "max_request_body_bytes", 128)
    refused = await api_client.post(
        "/v1/instances", content=b"x" * 300, headers={"content-type": "application/zip"}
    )
    assert refused.status_code == 413


# ------------------------------------------------------------ 2. authentication throttling


class FakePipeline:
    def __init__(self, redis):
        self.redis, self.operations = redis, []

    def incr(self, key):
        self.operations.append(("incr", key))

    def ttl(self, key):
        self.operations.append(("ttl", key))

    async def execute(self):
        results = []
        for operation, key in self.operations:
            if operation == "incr":
                self.redis.counts[key] = self.redis.counts.get(key, 0) + 1
                results.append(self.redis.counts[key])
            else:
                results.append(self.redis.ttls.get(key, -1))
        return results


class FakeRedis:
    """Just enough of redis.asyncio for INCR + TTL + EXPIRE."""

    def __init__(self):
        self.counts: dict[str, int] = {}
        self.ttls: dict[str, int] = {}
        self.expirations: list[tuple[str, int]] = []

    def pipeline(self, transaction=True):
        return FakePipeline(self)

    async def expire(self, key, seconds):
        self.ttls[key] = seconds
        self.expirations.append((key, seconds))


class DownBackend:
    async def hit(self, key, window_s):
        raise ConnectionError("redis is down")


def tight_limits(monkeypatch, attempts=3, multiplier=100):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_rate_limit_login_attempts", attempts)
    monkeypatch.setattr(settings, "auth_rate_limit_register_attempts", attempts)
    monkeypatch.setattr(settings, "auth_rate_limit_refresh_attempts", attempts)
    monkeypatch.setattr(settings, "auth_rate_limit_ip_multiplier", multiplier)
    monkeypatch.setattr(settings, "auth_rate_limit_window_s", 300)


def client_at(address: str) -> AsyncClient:
    from openbinding_gateway.main import app

    return AsyncClient(
        transport=ASGITransport(app=app, client=(address, 51000)), base_url="http://gateway"
    )


def login_body(name="nobody", password="wrong-password-here"):
    return {"username_or_email": name, "password": password}


async def test_login_is_limited_per_address_and_identifier_with_a_shared_backend(
    api_client, monkeypatch
):
    tight_limits(monkeypatch, attempts=3)
    redis = FakeRedis()
    set_auth_limiter(AuthRateLimiter(primary=RedisBackend(redis)))

    for _ in range(3):
        assert (await api_client.post("/v1/auth/login", json=login_body())).status_code == 401
    blocked = await api_client.post("/v1/auth/login", json=login_body())

    assert blocked.status_code == 429, blocked.text
    assert int(blocked.headers["Retry-After"]) >= 1
    assert blocked.json()["detail"]["code"] == "rate_limit_exceeded"
    # The counters live in the injected shared backend, expired once per window.
    assert any(key.startswith("authrl:login:id:127.0.0.1:") for key in redis.counts)
    assert redis.expirations and all(seconds == 300 for _, seconds in redis.expirations)
    # Another identifier from the same address is a different budget.
    assert (await api_client.post("/v1/auth/login", json=login_body("someone"))).status_code == 401


async def test_a_second_address_has_its_own_budget(api_client, monkeypatch):
    tight_limits(monkeypatch, attempts=3)
    set_auth_limiter(AuthRateLimiter(primary=RedisBackend(FakeRedis())))

    for _ in range(4):
        await api_client.post("/v1/auth/login", json=login_body())
    first_address = await api_client.post("/v1/auth/login", json=login_body())
    async with client_at("203.0.113.9") as other:
        second_address = await other.post("/v1/auth/login", json=login_body())

    assert first_address.status_code == 429
    assert second_address.status_code == 401  # same account name, different source


async def test_the_forwarded_header_does_not_choose_the_bucket(api_client, monkeypatch):
    tight_limits(monkeypatch, attempts=3)
    set_auth_limiter(AuthRateLimiter(primary=RedisBackend(FakeRedis())))

    statuses = []
    for number in range(5):
        response = await api_client.post(
            "/v1/auth/login", json=login_body(), headers={"X-Forwarded-For": f"198.51.100.{number}"}
        )
        statuses.append(response.status_code)

    assert statuses == [401, 401, 401, 429, 429]


async def test_one_address_cannot_spray_many_identifiers(api_client, monkeypatch):
    tight_limits(monkeypatch, attempts=3, multiplier=1)
    set_auth_limiter(AuthRateLimiter(primary=RedisBackend(FakeRedis())))

    statuses = [
        (await api_client.post("/v1/auth/login", json=login_body(f"user{n}"))).status_code
        for n in range(5)
    ]

    assert statuses == [401, 401, 401, 429, 429]


async def test_registration_and_refresh_are_limited_too(api_client, monkeypatch, registration):
    tight_limits(monkeypatch, attempts=2, multiplier=2)
    set_auth_limiter(AuthRateLimiter(primary=RedisBackend(FakeRedis())))

    details = registration()
    statuses = [
        (await api_client.post("/v1/auth/register", json={**details, "password": "short"})).status_code
        for _ in range(3)
    ]
    assert statuses == [422, 422, 429]

    # A refresh token is not trusted to name a bucket, so only the address counts.
    refreshes = [
        (await api_client.post("/v1/auth/refresh", json={"refresh_token": "not-a-token"})).status_code
        for _ in range(5)
    ]
    assert refreshes == [401, 401, 401, 401, 429]


async def test_redis_failure_degrades_to_process_counters_and_never_switches_the_limit_off(
    api_client, monkeypatch, caplog
):
    tight_limits(monkeypatch, attempts=3)
    now = [1000.0]
    limiter = AuthRateLimiter(
        primary=DownBackend(), retry_after_failure_s=15.0, clock=lambda: now[0]
    )
    set_auth_limiter(limiter)

    with caplog.at_level(logging.WARNING, logger="openbinding_gateway.core.ratelimit"):
        statuses = [
            (await api_client.post("/v1/auth/login", json=login_body())).status_code for _ in range(5)
        ]

    assert statuses == [401, 401, 401, 429, 429]  # still enforced, per process
    assert limiter.degradation.events == 1  # one failure, then Redis is left alone for 15 s
    assert limiter.degradation.last_error == "ConnectionError"
    assert any("rate limiter" in record.getMessage() for record in caplog.records)

    now[0] += 16.0  # the retry window passed: Redis is tried (and degraded) again
    await api_client.post("/v1/auth/login", json=login_body("another"))
    assert limiter.degradation.events == 2


async def test_the_fixed_window_resets():
    now = [0.0]
    backend = MemoryBackend(clock=lambda: now[0])

    assert [(await backend.hit("k", 10))[0] for _ in range(3)] == [1, 2, 3]
    now[0] = 11.0
    assert (await backend.hit("k", 10))[0] == 1


async def test_the_redis_backend_expires_a_key_on_its_first_hit_only():
    redis = FakeRedis()
    backend = RedisBackend(redis)

    first = await backend.hit("k", 60)
    second = await backend.hit("k", 60)

    assert first == (1, 60) and second == (2, 60)
    assert redis.expirations == [("k", 60)]


async def test_a_successful_login_still_works_within_the_budget(
    api_client, registration, monkeypatch
):
    tight_limits(monkeypatch, attempts=3)
    details = registration()
    assert (await api_client.post("/v1/auth/register", json=details)).status_code == 201

    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )

    assert login.status_code == 200


# --------------------------------------------------------------- 3. JWT claims and secrets


def settings_for(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_a_short_signing_secret_is_refused_outside_the_test_environment():
    for environment in ("dev", "prod"):
        with pytest.raises(ValidationError, match="shorter than 32"):
            settings_for(app_env=environment, gateway_jwt_secret="too-short", space_enabled=True)


def test_the_test_environment_may_use_a_short_secret_and_a_long_one_is_accepted():
    assert settings_for(app_env="test", gateway_jwt_secret="short").gateway_jwt_secret == "short"
    assert settings_for(app_env="dev", gateway_jwt_secret=LONG_SECRET).gateway_jwt_secret == LONG_SECRET


def test_production_refuses_to_start_without_a_signing_secret(monkeypatch):
    monkeypatch.delenv("GATEWAY_JWT_SECRET", raising=False)
    with pytest.raises(ValidationError, match="GATEWAY_JWT_SECRET is not set"):
        settings_for(
            app_env="prod", space_enabled=True, cors_allow_origins="https://openbinding.example.org"
        )


def test_the_token_claims_default_to_the_gateway_name():
    settings = settings_for()
    assert (settings.gateway_jwt_issuer, settings.gateway_jwt_audience) == (
        "openbinding-gateway",
        "openbinding-gateway",
    )


def test_an_access_token_carries_issuer_and_audience_and_both_are_verified():
    user_id = uuid.uuid4()
    token = issue_access_token(LONG_SECRET, user_id=user_id, role="user", ttl_seconds=60)

    claims = jwt.decode(token, LONG_SECRET, algorithms=["HS256"], audience="openbinding-gateway")
    assert claims["iss"] == "openbinding-gateway" and claims["aud"] == "openbinding-gateway"
    assert read_access_token(LONG_SECRET, token).user_id == user_id

    foreign_audience = issue_access_token(
        LONG_SECRET, user_id=user_id, role="user", ttl_seconds=60, audience="another-service"
    )
    foreign_issuer = issue_access_token(
        LONG_SECRET, user_id=user_id, role="user", ttl_seconds=60, issuer="another-issuer"
    )
    for rejected in (foreign_audience, foreign_issuer):
        with pytest.raises(TokenError):
            read_access_token(LONG_SECRET, rejected)


def test_a_token_without_issuer_or_audience_is_refused():
    now = 4_000_000_000
    bare = jwt.encode(
        {"sub": str(uuid.uuid4()), "kind": "access", "role": "user", "iat": 1, "exp": now},
        LONG_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(TokenError):
        read_access_token(LONG_SECRET, bare)


def test_refresh_tokens_carry_and_verify_the_same_claims():
    user_id, jti = uuid.uuid4(), uuid.uuid4()
    token = issue_refresh_token(LONG_SECRET, user_id=user_id, jti=jti, ttl_seconds=60)
    assert read_refresh_token(LONG_SECRET, token).jti == jti
    with pytest.raises(TokenError):
        read_refresh_token(LONG_SECRET, token, audience="another-service")


def test_the_configured_issuer_and_audience_are_what_gets_issued_and_read(monkeypatch):
    monkeypatch.setattr(get_settings(), "gateway_jwt_issuer", "acme-gateway")
    monkeypatch.setattr(get_settings(), "gateway_jwt_audience", "acme-clients")
    user_id = uuid.uuid4()

    token = issue_access_token(LONG_SECRET, user_id=user_id, role="user", ttl_seconds=60)

    claims = jwt.decode(token, LONG_SECRET, algorithms=["HS256"], audience="acme-clients")
    assert claims["iss"] == "acme-gateway"
    assert read_access_token(LONG_SECRET, token).user_id == user_id


async def test_the_api_refuses_a_correctly_signed_token_for_another_audience(
    api_client, registration
):
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    secret = get_settings().gateway_jwt_secret
    good = issue_access_token(
        secret, user_id=uuid.UUID(created.json()["id"]), role="user", ttl_seconds=60
    )
    forged = issue_access_token(
        secret,
        user_id=uuid.UUID(created.json()["id"]),
        role="user",
        ttl_seconds=60,
        audience="another-service",
    )

    assert (await api_client.get("/v1/users/me", headers={"Authorization": f"Bearer {good}"})).status_code == 200
    assert (await api_client.get("/v1/users/me", headers={"Authorization": f"Bearer {forged}"})).status_code == 401


def test_encrypted_secrets_are_rotated_with_multifernet():
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    written_with_old = CredentialStore(old).encrypt("sk-live-1")

    rotated = CredentialStore(f"{new}, {old}")

    assert rotated.decrypt(written_with_old) == "sk-live-1"  # every key decrypts
    fresh = rotated.encrypt("sk-live-2")
    assert CredentialStore(new).decrypt(fresh) == "sk-live-2"  # the first key encrypts
    with pytest.raises(SecretsUnavailable):
        CredentialStore(old).decrypt(fresh)


def test_the_store_reads_the_list_and_the_legacy_single_key_from_settings(monkeypatch):
    monkeypatch.delenv("SECRETS_FERNET_KEYS", raising=False)
    monkeypatch.delenv("FEDERATION_SECRET_KEY", raising=False)
    legacy, current = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    token = CredentialStore(legacy).encrypt("sk-live-3")

    store = CredentialStore.from_settings(
        settings_for(secrets_fernet_keys=current, federation_secret_key=legacy)
    )

    assert store.decrypt(token) == "sk-live-3"  # the old single key still decrypts
    assert CredentialStore(current).decrypt(store.encrypt("x")) == "x"  # the list encrypts
    only_legacy = CredentialStore.from_settings(settings_for(federation_secret_key=legacy))
    assert only_legacy.available and only_legacy.decrypt(token) == "sk-live-3"
    assert CredentialStore.from_settings(settings_for()).available is False


def test_a_bad_key_in_the_list_fails_at_construction():
    with pytest.raises(SecretsUnavailable, match="[Gg]enerate"):
        CredentialStore(f"{Fernet.generate_key().decode()},not-a-key")


# ------------------------------------------------------- 4. what a VIEWER reads of a job

HARMLESS = {"seed": 7, "time_budget_ms": 1000}
SENSITIVE_OPTIONS = {
    **HARMLESS,
    "auth": {"scheme": "bearer", "token": "tok-SECRET-1"},
    "authorization": "Bearer tok-SECRET-2",
    "headers": {"X-Key": "tok-SECRET-3"},
    "engine_url": "http://10.0.0.5:8080/private-engine",
    "api_key": "tok-SECRET-4",
    "note": "free text a member typed",
}
REGISTRATION_REF = {
    "namespace": "acme",
    "name": "solver",
    "version": "1.0.0",
    "digest": "sha256-" + "a" * 64,
}
PROVENANCE = {
    "irDigest": "sha256-" + "b" * 64,
    "packageDigest": "sha256-" + "c" * 64,
    "options": SENSITIVE_OPTIONS,
    "requestedOptions": SENSITIVE_OPTIONS,
    "registration": {
        **REGISTRATION_REF,
        "document": {"spec": {"endpoint": "https://private.example", "auth": {"token": "tok-SECRET-5"}}},
    },
    "engineReported": {"iterations": 10, "authToken": "tok-SECRET-6"},
}
PROBLEM = {"apiVersion": "bim/v1", "kind": "BindingProblem", "spec": {"tasks": ["t1"]}}


async def project_with_a_job(api_client, registration, db_session, gate):  # noqa: F811
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    organization = await make_org(api_client, owner_h)
    slug = organization["slug"]
    created = await api_client.post(
        f"/v1/organizations/{slug}/projects", headers=owner_h,
        json={"slug": "p", "name": "P", "description": "d", "visibility": "private"},
    )
    assert created.status_code == 201, created.text
    job = Job(
        owner_id=uuid.UUID(owner["id"]), engine_id="random-search", engine_job_id=str(uuid.uuid4()),
        service_url="http://engine", state=JobState.COMPLETED, termination="OPTIMAL",
        organization_id=uuid.UUID(organization["id"]), project_id=uuid.UUID(created.json()["id"]),
        options=dict(SENSITIVE_OPTIONS),
        original_request={
            "bindingProblem": PROBLEM,
            "timeout": 30.0,
            "mode": {"id": "random", "auth": {"token": "tok-SECRET-7"}},
            "optimization": {"type": "SINGLE", "scalarization": "feasibility"},
            "registration": PROVENANCE["registration"],
            "headers": {"Authorization": "Bearer tok-SECRET-8"},
            "auth": {"token": "tok-SECRET-9"},
        },
        provenance=json.loads(json.dumps(PROVENANCE)),
        result={"termination": "OPTIMAL", "solutions": [], "provenance": json.loads(json.dumps(PROVENANCE))},
    )
    db_session.add(job)
    await db_session.flush()
    return slug, owner_h, job


async def member(api_client, registration, db_session, gate, owner_h, slug, role):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    assert (await put_member(api_client, owner_h, slug, account["id"], role)).status_code == 200
    return headers


async def test_a_viewer_sees_state_engine_result_and_digests_but_not_sensitive_options(
    api_client, registration, db_session, gate  # noqa: F811
):
    slug, owner_h, job = await project_with_a_job(api_client, registration, db_session, gate)
    viewer_h = await member(api_client, registration, db_session, gate, owner_h, slug, "VIEWER")

    response = await api_client.get(f"/v1/organizations/{slug}/projects/p/jobs", headers=viewer_h)

    assert response.status_code == 200, response.text
    [row] = response.json()
    assert row["status"] == "completed" and row["engine_id"] == "random-search"
    assert row["termination"] == "OPTIMAL"
    assert row["result"]["termination"] == "OPTIMAL"
    assert row["provenance"]["irDigest"] == PROVENANCE["irDigest"]
    assert row["provenance"]["packageDigest"] == PROVENANCE["packageDigest"]
    assert row["options"] == HARMLESS
    assert row["provenance"]["options"] == HARMLESS
    assert row["provenance"]["requestedOptions"] == HARMLESS
    assert row["result"]["provenance"]["options"] == HARMLESS
    assert row["provenance"]["registration"] == REGISTRATION_REF
    assert row["original_request"]["bindingProblem"] == PROBLEM
    assert set(row["original_request"]) <= {
        "bindingProblem", "timeout", "mode", "optimization", "registration"
    }
    assert row["original_request"]["registration"] == REGISTRATION_REF
    assert "auth" not in row["original_request"]["mode"]
    for leaked in ("tok-SECRET", "10.0.0.5", "private.example", "free text", "private-engine"):
        assert leaked not in response.text, leaked

    # Reading never edits the stored row.
    assert job.options == SENSITIVE_OPTIONS


async def test_a_member_and_an_owner_see_the_complete_options(
    api_client, registration, db_session, gate  # noqa: F811
):
    slug, owner_h, _ = await project_with_a_job(api_client, registration, db_session, gate)
    member_h = await member(api_client, registration, db_session, gate, owner_h, slug, "MEMBER")
    admin_h = await member(api_client, registration, db_session, gate, owner_h, slug, "ADMIN")

    for headers in (owner_h, member_h, admin_h):
        response = await api_client.get(f"/v1/organizations/{slug}/projects/p/jobs", headers=headers)
        assert response.status_code == 200, response.text
        [row] = response.json()
        assert row["options"] == SENSITIVE_OPTIONS
        assert row["original_request"]["auth"] == {"token": "tok-SECRET-9"}
        assert row["provenance"]["options"] == SENSITIVE_OPTIONS


async def test_a_user_of_another_organization_does_not_read_the_jobs(
    api_client, registration, db_session, gate  # noqa: F811
):
    slug, owner_h, _ = await project_with_a_job(api_client, registration, db_session, gate)
    _, outsider_h = await make_account(api_client, registration, db_session, gate)

    response = await api_client.get(f"/v1/organizations/{slug}/projects/p/jobs", headers=outsider_h)

    # Refused exactly as before (the access matrix pins /jobs as closed to non-members).
    assert response.status_code == 403
    assert "random-search" not in response.text and "tok-SECRET" not in response.text


async def test_an_api_key_without_the_project_scope_is_refused(
    api_client, registration, db_session, gate  # noqa: F811
):
    slug, owner_h, _ = await project_with_a_job(api_client, registration, db_session, gate)
    viewer_account, viewer_h = await make_account(api_client, registration, db_session, gate)
    assert (await put_member(api_client, owner_h, slug, viewer_account["id"], "VIEWER")).status_code == 200
    unscoped = await make_key(api_client, viewer_h, ["account:read"])
    scoped = await make_key(api_client, viewer_h, ["projects:read"])
    url = f"/v1/organizations/{slug}/projects/p/jobs"

    refused = await api_client.get(url, headers=unscoped)
    allowed = await api_client.get(url, headers=scoped)

    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "insufficient_api_key_permission"
    assert allowed.status_code == 200
    assert allowed.json()[0]["options"] == HARMLESS  # a key does not widen what a VIEWER sees


async def project_package_with_a_study_job(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    """A project whose study run holds one job carrying sensitive options; returns
    ``(slug, owner headers, package url)``."""
    from _repo import REPO_ROOT
    from openbinding_gateway.routes import v1 as v1_routes
    from openbinding_gateway.services import execution
    from openbinding_gateway.v1.package import load_package

    async def solve(*args, **kwargs):
        return {"termination": "FEASIBLE", "solutions": []}

    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", solve)
    owner, owner_h = await make_account(api_client, registration, db_session, gate)
    slug = (await make_org(api_client, owner_h))["slug"]
    package = load_package(REPO_ROOT / "examples/demo/01_simple_seq")
    snapshot = await api_client.post(
        "/v1/instances", headers={**owner_h, "Content-Type": "application/vnd.bim+zip"},
        content=package.to_zip(),
    )
    assert snapshot.status_code == 201, snapshot.text
    base = f"/v1/organizations/{slug}/projects"
    assert (await api_client.post(
        base, headers=owner_h, json={"slug": "p", "name": "P", "visibility": "private"}
    )).status_code == 201
    assert (await api_client.post(
        f"{base}/p/cases", headers=owner_h, json={"slug": "c", "name": "C"}
    )).status_code == 201
    revision = await api_client.post(
        f"{base}/p/cases/c/revisions", headers=owner_h,
        json={"document": package.instance(), "source_snapshot_id": snapshot.json()["id"]},
    )
    assert revision.status_code == 201, revision.text
    reference = v1_routes._engine_ref(v1_routes._manifest("random-search"), "bim.builtin")
    study = await api_client.post(
        f"{base}/p/studies", headers=owner_h,
        json={"slug": "s", "name": "S", "definition": {
            "case_revision_ids": [revision.json()["id"]],
            "engines": [{**reference, "mode": "seeded",
                         "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}}],
            "parameter_sets": [{"iterations": 100}], "seeds": [1],
        }},
    )
    assert study.status_code == 201, study.text
    run = await api_client.post(f"{base}/p/studies/s/runs", headers=owner_h)
    assert run.status_code == 202, run.text
    job = (await db_session.scalars(
        select(Job).join(StudyCell, StudyCell.job_id == Job.id)
        .where(StudyCell.study_run_id == uuid.UUID(run.json()["id"]))
    )).one()
    job.options = dict(SENSITIVE_OPTIONS)
    job.provenance = json.loads(json.dumps(PROVENANCE))
    job.original_request = {**(job.original_request or {}), "auth": {"token": "tok-SECRET-9"},
                            "headers": {"Authorization": "Bearer tok-SECRET-8"}}
    await db_session.flush()
    return slug, owner_h, f"{base}/p/package?format=json"


def exported_jobs(package: dict) -> list[dict]:
    return [cell["job"] for study in package["studies"] for run in study["runs"]
            for cell in run["cells"] if cell["job"]]


async def test_the_package_export_gives_a_viewer_the_same_redacted_jobs_as_the_job_list(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    slug, owner_h, url = await project_package_with_a_study_job(
        api_client, registration, db_session, gate, monkeypatch
    )
    viewer_h = await member(api_client, registration, db_session, gate, owner_h, slug, "VIEWER")

    full = await api_client.get(url, headers=owner_h)
    redacted = await api_client.get(url, headers=viewer_h)

    assert full.status_code == 200 and redacted.status_code == 200, (full.text, redacted.text)
    [owner_job] = exported_jobs(full.json())
    assert owner_job["options"] == SENSITIVE_OPTIONS
    assert owner_job["request"]["auth"] == {"token": "tok-SECRET-9"}
    assert owner_job["provenance"]["options"] == SENSITIVE_OPTIONS
    [viewer_job] = exported_jobs(redacted.json())
    assert viewer_job["options"] == HARMLESS
    assert viewer_job["provenance"]["options"] == HARMLESS
    assert viewer_job["provenance"]["irDigest"] == PROVENANCE["irDigest"]
    assert viewer_job["provenance"]["registration"] == REGISTRATION_REF
    assert "auth" not in viewer_job["request"] and "headers" not in viewer_job["request"]
    assert viewer_job["state"] == owner_job["state"] and viewer_job["id"] == owner_job["id"]
    for leaked in ("tok-SECRET", "10.0.0.5", "private.example", "free text", "private-engine"):
        assert leaked not in redacted.text, leaked


async def test_a_member_key_without_the_project_write_permission_gets_the_redacted_package(
    api_client, registration, db_session, gate, monkeypatch  # noqa: F811
):
    slug, owner_h, url = await project_package_with_a_study_job(
        api_client, registration, db_session, gate, monkeypatch
    )
    member_account, member_h = await make_account(api_client, registration, db_session, gate)
    assert (await put_member(api_client, owner_h, slug, member_account["id"], "MEMBER")).status_code == 200
    read_only = await make_key(api_client, member_h, ["projects:read", "studies:read", "artifacts:read"])
    writer = await make_key(
        api_client, member_h, ["projects:read", "projects:write", "studies:read", "artifacts:read"]
    )
    jobs_url = f"/v1/organizations/{slug}/projects/p/jobs"

    from_key = await api_client.get(url, headers=read_only)
    from_writer = await api_client.get(url, headers=writer)
    listed = await api_client.get(jobs_url, headers=read_only)

    assert from_key.status_code == 200, from_key.text
    assert exported_jobs(from_key.json())[0]["options"] == HARMLESS
    assert "tok-SECRET" not in from_key.text
    assert listed.status_code == 200 and listed.json()[0]["options"] == HARMLESS
    assert from_writer.status_code == 200, from_writer.text
    assert exported_jobs(from_writer.json())[0]["options"] == SENSITIVE_OPTIONS


def test_the_allow_list_comes_from_the_engine_manifests():
    names = allowed_option_names()

    assert {"time_budget_ms", "seed", "iterations", "max_evaluations", "population_size"} <= names
    assert not {"auth", "headers", "api_key", "engine_url", "authorization"} & names


def test_redacting_a_job_view_never_mutates_the_job():
    job = Job(
        owner_id=uuid.uuid4(), engine_id="e", engine_job_id="1", service_url="http://engine",
        state=JobState.COMPLETED, options=dict(SENSITIVE_OPTIONS),
        original_request={"bindingProblem": PROBLEM, "auth": {"token": "tok-SECRET-9"}},
        provenance=json.loads(json.dumps(PROVENANCE)),
        # Column defaults only apply on flush; this job is never persisted.
        id=uuid.uuid4(), cancellation_requested=False, created_at=datetime.now(timezone.utc),
    )

    redacted = job_view(job, None, redact=True)
    full = job_view(job, None)

    assert redacted.options == HARMLESS and full.options == SENSITIVE_OPTIONS
    assert job.options == SENSITIVE_OPTIONS and job.original_request["auth"]
    assert job.provenance["options"] == SENSITIVE_OPTIONS
