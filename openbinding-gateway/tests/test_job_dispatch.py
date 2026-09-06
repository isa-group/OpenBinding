from types import SimpleNamespace
import uuid

import pytest
import pytest_asyncio
from dramatiq.brokers.redis import RedisBroker
from dramatiq.middleware import AsyncIO
from sqlalchemy import func, select

from openbinding_gateway import space_client
from openbinding_gateway import job_dispatch
from openbinding_gateway.db import base as db_base
from openbinding_gateway.db.models import Job, JobState, User
from openbinding_gateway.routes import v1
from _pricing import fake_pricing_gate, pricing_catalog


@pytest_asyncio.fixture
async def durable_gate():
    previous = space_client.get_gate()
    gate = fake_pricing_gate()
    space_client.set_gate(gate)
    yield gate
    space_client.set_gate(previous)


async def _account(client, registration):
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    login = await client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert created.status_code == 201 and login.status_code == 200
    return uuid.UUID(created.json()["id"]), {
        "Authorization": f"Bearer {login.json()['access_token']}"
    }


def test_redis_actor_is_bound_to_the_configured_broker_and_async_runtime():
    broker = job_dispatch.configure_broker()

    assert isinstance(broker, RedisBroker)
    assert job_dispatch.run_persisted_job_message.broker is broker
    assert any(isinstance(middleware, AsyncIO) for middleware in broker.middleware)
    assert any(isinstance(middleware, job_dispatch.WorkerRuntime) for middleware in broker.middleware)
    assert job_dispatch.run_persisted_job_message.options["max_retries"] == 5


@pytest.mark.asyncio
async def test_worker_startup_refuses_an_in_memory_job_store(monkeypatch):
    monkeypatch.setattr(job_dispatch, "get_settings", lambda: SimpleNamespace(database_url=None))
    monkeypatch.setattr(job_dispatch, "_runtime_started", False)

    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        await job_dispatch.start_worker_runtime()


@pytest.mark.asyncio
async def test_actor_refuses_to_ack_before_runtime_initialization(monkeypatch):
    monkeypatch.setattr(job_dispatch, "_runtime_started", False)
    actor = job_dispatch.run_persisted_job_message.fn.__wrapped__

    with pytest.raises(RuntimeError, match="not initialized"):
        await actor("00000000-0000-0000-0000-000000000000")


@pytest.mark.asyncio
async def test_persisted_runner_never_silently_ignores_a_missing_database(monkeypatch):
    monkeypatch.setattr(db_base, "is_configured", lambda: False)

    with pytest.raises(RuntimeError, match="initialized database"):
        await v1._run_persisted_job("00000000-0000-0000-0000-000000000000")


@pytest.mark.asyncio
async def test_broker_failure_leaves_the_persisted_job_for_redelivery(monkeypatch):
    monkeypatch.setattr(
        job_dispatch,
        "get_settings",
        lambda: SimpleNamespace(job_dispatch_mode="dramatiq", redis_url="redis://unused"),
    )
    monkeypatch.setattr(job_dispatch, "configure_broker", lambda: None)

    def unavailable(_job_id):
        raise OSError("redis unavailable")

    monkeypatch.setattr(job_dispatch.run_persisted_job_message, "send", unavailable)

    assert await job_dispatch.dispatch_persisted_job(str(uuid.uuid4())) is False


@pytest.mark.asyncio
async def test_reconciler_redelivers_only_persisted_queued_jobs(db_session, monkeypatch):
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(user)
    await db_session.flush()
    queued = Job(
        owner_id=user.id,
        engine_id="random-search",
        engine_job_id="queued",
        service_url="http://engine",
        state=JobState.QUEUED,
    )
    completed = Job(
        owner_id=user.id,
        engine_id="random-search",
        engine_job_id="completed",
        service_url="http://engine",
        state=JobState.COMPLETED,
    )
    db_session.add_all([queued, completed])
    await db_session.flush()
    sent: list[str] = []
    monkeypatch.setattr(
        job_dispatch,
        "get_settings",
        lambda: SimpleNamespace(job_dispatch_mode="dramatiq", redis_url="redis://unused"),
    )

    async def dispatch(job_id, _request_session=None):
        sent.append(job_id)
        return True

    monkeypatch.setattr(job_dispatch, "dispatch_persisted_job", dispatch)

    assert await job_dispatch.redeliver_queued_jobs(db_session, older_than_s=0) == 1
    assert sent == [str(queued.id)]


@pytest.mark.asyncio
async def test_job_retry_is_idempotent_and_reserves_only_once(
    api_client, db_session, registration, durable_gate
):
    user_id, headers = await _account(api_client, registration)
    original = Job(
        owner_id=user_id,
        engine_id="random-search",
        engine_job_id="failed-original",
        service_url="http://engine",
        state=JobState.FAILED,
        original_request={},
        options={},
        provenance={},
        metered=True,
        concurrency_released=True,
    )
    db_session.add(original)
    await db_session.flush()

    first = await api_client.post(f"/v1/jobs/{original.id}/retry", headers=headers)
    second = await api_client.post(f"/v1/jobs/{original.id}/retry", headers=headers)
    retries = int(
        await db_session.scalar(
            select(func.count(Job.id)).where(Job.retry_of_id == original.id)
        )
        or 0
    )

    assert first.status_code == second.status_code == 202
    assert first.json()["id"] == second.json()["id"]
    assert retries == 1
    assert [entry[:2] for entry in durable_gate.evaluations].count((user_id, "solve")) == 1


@pytest.mark.asyncio
async def test_job_cancel_is_terminal_and_its_sse_stream_closes(
    api_client, db_session, registration, durable_gate
):
    user_id, headers = await _account(api_client, registration)
    job = Job(
        owner_id=user_id,
        engine_id="random-search",
        engine_job_id="queued-to-cancel",
        service_url="http://engine",
        state=JobState.QUEUED,
    )
    db_session.add(job)
    await db_session.flush()

    cancelled = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=headers)
    repeated = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=headers)
    events = await api_client.get(f"/v1/jobs/{job.id}/events", headers=headers)

    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert repeated.status_code == 409
    assert events.status_code == 200
    assert events.headers["cache-control"] == "no-store"
    assert '"status":"cancelled"' in events.text
