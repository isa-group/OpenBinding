"""POST /v1/jobs is idempotent per account and per canonical request."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import func, select

from _repo import REPO_ROOT

from openbinding_gateway import space_client, study_jobs
from openbinding_gateway.access import metering
from openbinding_gateway.db.models import Job, User
from openbinding_gateway.domain import idempotency
from openbinding_gateway.engine_routing import get_adaptation_manager
from openbinding_gateway.engine_routing.adaptation_manager import RoutingPlanResult
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1.canonical import digest
from openbinding_gateway.v1.package import load_package

EXAMPLE = REPO_ROOT / "examples/demo/01_simple_seq"
OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
KEY = "idem-key-1"


async def _login(client, details):
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    logged = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert logged.status_code == 200, logged.text
    return {"Authorization": f"Bearer {logged.json()['access_token']}"}


async def _snapshot(client, headers):
    created = await client.post(
        "/v1/instances",
        headers={**headers, "Content-Type": "application/vnd.bim+zip"},
        content=load_package(EXAMPLE).to_zip(),
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


def _body(snapshot, **extra):
    return {
        "snapshot": snapshot,
        "engine": "random-search",
        "mode": "seeded",
        "optimization": OPTIMIZATION,
        **extra,
    }


async def _post(client, headers, body, key=KEY):
    return await client.post("/v1/jobs", headers={**headers, "Idempotency-Key": key}, json=body)


async def _job_count(db_session):
    return (await db_session.execute(select(func.count()).select_from(Job))).scalar_one()


@pytest.fixture
def no_dispatch(monkeypatch):
    async def queued(*args, **kwargs):
        return None

    monkeypatch.setattr(routes, "dispatch_persisted_job", queued)


@pytest.fixture
async def account(api_client, registration, no_dispatch):
    headers = await _login(api_client, registration())
    return headers, await _snapshot(api_client, headers)


async def test_same_key_and_body_replays_the_same_job(api_client, db_session, account):
    headers, snapshot = account
    first = await _post(api_client, headers, _body(snapshot))
    second = await _post(api_client, headers, _body(snapshot))

    assert first.status_code == 202, first.text
    assert second.status_code == 202, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["idempotent"] is True
    assert "idempotent" not in first.json()
    assert await _job_count(db_session) == 1
    stored = (await db_session.execute(select(Job))).scalars().one()
    assert idempotency.is_request_fingerprint(stored.idempotency_fingerprint)
    assert len(stored.idempotency_fingerprint) == 74


async def test_same_key_with_a_different_body_conflicts(api_client, db_session, account):
    headers, snapshot = account
    body = _body(snapshot, engine="evolutionary-heuristics", mode="elitist-genetic")
    first = await _post(api_client, headers, {**body, "options": {"max_evaluations": 100}})
    changed = await _post(api_client, headers, {**body, "options": {"max_evaluations": 200}})

    assert first.status_code == 202, first.text
    assert changed.status_code == 409, changed.text
    assert changed.json()["title"] == "idempotency_conflict"
    assert await _job_count(db_session) == 1


async def test_auto_routing_is_not_part_of_the_fingerprint(api_client, db_session, account, monkeypatch):
    headers, snapshot = account
    plans = [
        ("random-search", "seeded"),
        ("evolutionary-heuristics", "elitist-genetic"),
    ]
    calls = []

    async def plan_routing(*args, **kwargs):
        engine, mode = plans[len(calls)]
        calls.append(engine)
        return RoutingPlanResult(
            selected_engine=engine,
            selected_mode=mode,
            credits_cost=1,
            adaptation_loop_id="adp-test",
            provenance_user={"selectedEngine": engine},
            provenance_admin={},
            fallback_engine=None,
        )

    monkeypatch.setattr(get_adaptation_manager(), "plan_routing", plan_routing)
    body = {"snapshot": snapshot, "engine": "auto", "optimization": OPTIMIZATION}
    first = await _post(api_client, headers, body)
    second = await _post(api_client, headers, body)

    assert first.status_code == 202, first.text
    assert second.status_code == 202, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["idempotent"] is True
    assert calls == ["random-search"]
    assert await _job_count(db_session) == 1


async def test_plan_clamping_is_not_part_of_the_fingerprint(api_client, db_session, account, monkeypatch):
    headers, snapshot = account
    real = routes.clamp_options
    calls = []

    def clamp(options, caps):
        calls.append(1)
        clamped = real(options, caps)
        if len(calls) > 1:
            clamped.options["iterations"] = 1
        return clamped

    monkeypatch.setattr(routes, "clamp_options", clamp)
    first = await _post(api_client, headers, _body(snapshot))
    second = await _post(api_client, headers, _body(snapshot))

    assert second.status_code == 202, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["idempotent"] is True
    assert len(calls) == 1
    assert await _job_count(db_session) == 1


async def test_a_key_shared_by_two_accounts_is_independent(api_client, db_session, registration, no_dispatch):
    alice = await _login(api_client, registration())
    bob = await _login(api_client, registration())
    alice_snapshot = await _snapshot(api_client, alice)
    bob_snapshot = await _snapshot(api_client, bob)

    first = await _post(api_client, alice, _body(alice_snapshot))
    second = await _post(api_client, bob, _body(bob_snapshot))

    assert first.status_code == 202, first.text
    assert second.status_code == 202, second.text
    assert second.json()["id"] != first.json()["id"]
    assert "idempotent" not in second.json()
    assert await _job_count(db_session) == 2
    assert (await api_client.get(f"/v1/jobs/{first.json()['id']}", headers=bob)).status_code == 404
    assert (await api_client.get(f"/v1/jobs/{second.json()['id']}", headers=alice)).status_code == 404


def _legacy_fingerprint(provenance):
    limits = dict(provenance["limits"])
    limits.pop("effectiveTimeoutSeconds")
    return digest({
        "configuration": provenance.get("configuration"),
        "requestedOptions": provenance["requestedOptions"],
        "packageDigest": provenance["packageDigest"],
        "fileDigests": provenance["fileDigests"],
        "resourceDigests": provenance["resourceDigests"],
        "irDigest": provenance["irDigest"],
        "dialects": provenance["dialects"],
        "adapters": provenance["adapters"],
        "engineDigest": provenance["engineDigest"],
        "registration": provenance["registration"],
        "protocolDigest": provenance["protocolDigest"],
        "mode": provenance["mode"],
        "optimization": provenance["optimization"],
        "algorithm": provenance["algorithm"],
        "options": provenance["options"],
        "limits": limits,
    })


async def test_a_legacy_row_is_compared_with_the_legacy_algorithm(api_client, db_session, account):
    headers, snapshot = account
    first = await _post(api_client, headers, _body(snapshot))
    assert first.status_code == 202, first.text
    stored = (await db_session.execute(select(Job))).scalars().one()
    stored.idempotency_fingerprint = _legacy_fingerprint(stored.provenance)
    assert not idempotency.is_request_fingerprint(stored.idempotency_fingerprint)
    await db_session.commit()

    replay = await _post(api_client, headers, _body(snapshot))
    assert replay.status_code == 202, replay.text
    assert replay.json()["id"] == first.json()["id"]
    assert replay.json()["idempotent"] is True

    changed = await _post(
        api_client,
        headers,
        _body(snapshot, engine="evolutionary-heuristics", mode="elitist-genetic"),
    )
    assert changed.status_code == 409, changed.text
    assert changed.json()["title"] == "idempotency_conflict"
    assert await _job_count(db_session) == 1


async def test_internal_engines_cannot_be_selected_directly(api_client, account):
    headers, snapshot = account
    response = await _post(api_client, headers, _body(snapshot, engine="meta-router-csp"))

    assert response.status_code == 422, response.text
    assert response.json()["title"] == "internal_engine"


def _hide_from_first_lookups(monkeypatch, hidden):
    """Make the first `hidden` idempotency lookups miss, as if the winner had not committed yet."""
    real = routes._find_idempotent_job
    seen = []

    async def find(session, owner_id, key):
        seen.append(key)
        if len(seen) <= hidden:
            return None
        return await real(session, owner_id, key)

    monkeypatch.setattr(routes, "_find_idempotent_job", find)


async def test_losing_the_job_insert_race_returns_a_replay_and_releases(
    api_client, db_session, account, monkeypatch
):
    headers, snapshot = account
    first = await _post(api_client, headers, _body(snapshot))
    assert first.status_code == 202, first.text

    released = []

    async def reserve(gate, user_id, **kwargs):
        # The winner never ran, so its concurrency slot is still taken; the loser is let through.
        return space_client.Verdict.yes(), metering.Reservation(user_id=user_id, increments={})

    async def release(gate, reservation):
        released.append(reservation)

    monkeypatch.setattr(metering, "reserve", reserve)
    monkeypatch.setattr(metering, "release", release)
    # Misses the pre-check and the post-reserve check; only the INSERT notices the winner.
    _hide_from_first_lookups(monkeypatch, 2)
    loser = await _post(api_client, headers, _body(snapshot))

    assert loser.status_code == 202, loser.text
    assert loser.json()["id"] == first.json()["id"]
    assert loser.json()["idempotent"] is True
    assert len(released) == 1
    assert await _job_count(db_session) == 1


async def test_a_request_waiting_on_the_account_lock_gets_a_replay_not_a_429(
    api_client, db_session, account, monkeypatch
):
    headers, snapshot = account
    first = await _post(api_client, headers, _body(snapshot))
    assert first.status_code == 202, first.text

    released = []

    async def busy(*args, **kwargs):
        limit = space_client.LimitUsage(limit_id="concurrentJobs", limit=1, used=1)
        return space_client.Verdict.no("busy", limit), metering.Reservation(user_id=args[1], increments={})

    async def release(gate, reservation):
        released.append(reservation)

    monkeypatch.setattr(metering, "reserve", busy)
    monkeypatch.setattr(metering, "release", release)
    _hide_from_first_lookups(monkeypatch, 1)
    waited = await _post(api_client, headers, _body(snapshot))

    assert waited.status_code == 202, waited.text
    assert waited.json()["id"] == first.json()["id"]
    assert waited.json()["idempotent"] is True
    assert len(released) == 1


async def test_study_launches_replay_with_an_idempotency_key(api_client, db_session, account):
    headers, snapshot = account
    user = (await db_session.execute(select(User))).scalars().one()
    payload = _body(snapshot)

    def request():
        built = study_jobs._job_request(payload)
        built.scope["headers"].append((b"idempotency-key", b"study-launch-1"))
        return built

    first = study_jobs._response_payload(await routes.create_job(request(), caller=user, session=db_session))
    second = study_jobs._response_payload(await routes.create_job(request(), caller=user, session=db_session))

    assert second["id"] == first["id"]
    assert second["idempotent"] is True
    assert await _job_count(db_session) == 1
    json.dumps(second)
