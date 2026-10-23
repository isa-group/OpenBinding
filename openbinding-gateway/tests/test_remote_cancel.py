"""GW-C5: the remote job of an attempt that lost its lease is asked to stop, best effort, behind one guarded door.

Everything is local: SQLite, ``httpx.MockTransport`` for the engines' HTTP side, nothing reaches a network.

What is pinned, in the order of the contract:

* a registration declares the capability in ``spec.extensions.cancellation``; without it (and without the
  deployment's OpenAPI describing ``DELETE``) no ``DELETE`` is ever sent, whichever path asks;
* the id and the endpoint of every attempt are kept (``job_engine_attempts``);
* the fencing rules: the attempt that runs the job is never cancelled, the id of a newer attempt is never
  cancelled, a cancellation that has to wait is deferred and finally skipped, never sent blind, and the
  credential is never sent to an endpoint the attempt did not use;
* the sweep only marks; the network is touched afterwards, in bounded batches, with bounded retries.

``tests/concurrency/test_remote_cancel_pg.py`` is the PostgreSQL side (two replicas at once).
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from itertools import product
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from _paths import GATEWAY_ROOT
from _pricing import pricing_catalog
from analysis_b3_b4_b6._helpers import (
    PER_ATTEMPT_CANCELLATION,
    a_job,
    a_registration,
    account_with_snapshot,
    answer,
    lose_the_worker,
    only_job,
    submit,
)
from bim_core.canonical import digest
from openbinding_gateway.core.settings import Settings, get_settings
from openbinding_gateway.db.models import (
    EngineRegistrationRevision,
    Job,
    JobEngineAttempt,
    JobState,
    User,
    UserRole,
    utcnow,
)
from openbinding_gateway.jobs import clock, leases, reconciler, remote_attempts
from openbinding_gateway.jobs.remote_attempts import Action, AttemptView, JobView, decide
from openbinding_gateway.security.secrets import generate_key
from openbinding_gateway.services import engines, execution
from openbinding_gateway.services.engine_registry import (
    ATTEMPT_ID_SCOPE,
    CancellationCapability,
    cancellation_capability,
    register_engine,
    verify_registration,
)
from openbinding_gateway.v1 import remote

ROOT = GATEWAY_ROOT
SOURCE = ROOT / "src" / "openbinding_gateway"
SECRET = "engine-credential-that-must-not-leave-for-another-host"
JOB_PATH = "/internal/v1/jobs/{id}"


# -- Doubles ----------------------------------------------------------------------------------------------


@pytest_asyncio.fixture
async def owner(db_session) -> User:
    user = User(
        username=f"user{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:8]}@example.org",
        password_hash="not-a-real-hash",
        role=UserRole.USER,
        plan_cache=pricing_catalog().default_plan,
    )
    db_session.add(user)
    await db_session.commit()
    return user


class EngineDouble:
    """The HTTP side of the engines, recording every request; ``status`` and ``error`` say how it answers."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status = 204
        self.error: Exception | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return httpx.Response(self.status)

    @property
    def deleted(self) -> list[str]:
        """The engine job ids that were sent a DELETE, in order."""
        return [request.url.path.rsplit("/", 1)[-1] for request in self.requests if request.method == "DELETE"]


@pytest.fixture
def engine_http(monkeypatch) -> EngineDouble:
    double = EngineDouble()
    real = remote.cancel_remote

    async def through_the_double(registration, engine_job_id, **kwargs):
        return await real(registration, engine_job_id, transport=httpx.MockTransport(double.handler), **kwargs)

    monkeypatch.setattr(execution, "cancel_remote", through_the_double)
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: ())
    return double


@pytest.fixture
def credentials(monkeypatch) -> list[str]:
    """Stands in for the decryption of a deployment's credential, and notes every endpoint it was loaded for."""
    loaded: list[str] = []

    async def transport(_session, revision):
        loaded.append(revision.endpoint)
        return remote.RemoteRegistration(
            endpoint=revision.endpoint,
            mappings=revision.mappings,
            auth_scheme="bearer",
            credential=SECRET,
            allow_internal_http=True,
        )

    monkeypatch.setattr(execution, "revision_transport", transport)
    return loaded


class Clock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def frozen(monkeypatch) -> Clock:
    moving = Clock(utcnow())
    monkeypatch.setattr(clock, "utcnow", lambda: moving.now)
    return moving


@pytest.fixture
def declared_cancellation(monkeypatch) -> CancellationCapability:
    capability = CancellationCapability(declared=True, supported=True, id_scope=ATTEMPT_ID_SCOPE)
    monkeypatch.setattr(execution, "registration_cancellation", lambda _registration: capability)
    return capability


async def claim_and_record(session, job, remote_id: str | None) -> None:
    assert await leases.claim_job(session, job.id) is not None
    await session.commit()
    if remote_id is not None:
        await execution.record_engine_job_id(session, job.id, remote_id)


async def lose_and_sweep(session, job) -> None:
    await lose_the_worker(session, job)
    await reconciler.sweep_abandoned(session)
    await session.commit()


async def cancel_rows(session, job) -> dict[int, tuple[str, int]]:
    rows = (
        await session.execute(
            select(JobEngineAttempt.attempt, JobEngineAttempt.cancel_state, JobEngineAttempt.cancel_attempts).where(
                JobEngineAttempt.job_id == job.id
            )
        )
    ).all()
    return {row.attempt: (row.cancel_state, row.cancel_attempts) for row in rows}


async def cycle(session, frozen: Clock | None = None, *, wait_s: float = 3600.0) -> int:
    """One cancellation step of the reconciler, then time moves on past any backoff."""
    sent = await reconciler.cancel_lost_attempts(session)
    if frozen is not None:
        frozen.advance(wait_s)
    return sent


# -- The capability a registration declares -----------------------------------------------------------------


def spec_with(cancellation=None, *, delete=True, responses=None, auth="none", security=None):
    operations = {"get": {"responses": {"200": {"description": "job"}}}}
    if delete:
        operation = {"responses": responses if responses is not None else {"204": {"description": "stopped"}}}
        if security is not None:
            operation["security"] = security
        operations["delete"] = operation
    openapi = {"openapi": "3.1.0", "paths": {JOB_PATH: operations}}
    spec = {"mappings": {"job": JOB_PATH}, "auth": {"scheme": auth}}
    if cancellation is not None:
        spec["extensions"] = {"cancellation": cancellation}
    return spec, openapi


@pytest.mark.parametrize(
    ("spec_args", "declared", "supported", "per_attempt"),
    [
        ({}, False, False, False),
        ({"cancellation": {"supported": False}}, False, False, False),
        ({"cancellation": {"supported": "yes"}}, False, False, False),
        ({"cancellation": PER_ATTEMPT_CANCELLATION}, True, True, True),
        ({"cancellation": {"supported": True, "idScope": "job"}}, True, True, False),
        ({"cancellation": {"supported": True}}, True, True, False),
        ({"cancellation": PER_ATTEMPT_CANCELLATION, "delete": False}, True, False, False),
        ({"cancellation": PER_ATTEMPT_CANCELLATION, "responses": {"404": {}}}, True, False, False),
        ({"cancellation": PER_ATTEMPT_CANCELLATION, "auth": "bearer"}, True, False, False),
    ],
)
def test_the_capability_needs_the_declaration_and_an_openapi_that_describes_the_delete(
    spec_args, declared, supported, per_attempt
):
    spec, openapi = spec_with(**spec_args)

    capability = cancellation_capability(spec, openapi)

    assert (capability.declared, capability.supported, capability.per_attempt) == (declared, supported, per_attempt)
    assert (capability.reason is not None) == (declared and not supported)


def test_a_registration_without_a_document_or_openapi_has_no_capability():
    assert cancellation_capability(None, None) == CancellationCapability()
    assert cancellation_capability({"extensions": {"cancellation": PER_ATTEMPT_CANCELLATION}}, None).supported is False
    assert execution.registration_cancellation({}) == CancellationCapability()
    assert execution.registration_cancellation({"document": {"spec": {}}}) == CancellationCapability()


def deployment_document(owner: User, *, cancellation=None, delete=False) -> dict:
    openapi = copy.deepcopy(engines.protocol_document())
    openapi["x-bim-protocol"] = "bim-engine/v1"
    openapi["x-bim-protocol-digest"] = engines.protocol_digest()
    openapi["paths"]["/health"] = {"get": {"responses": {"200": {"description": "Healthy"}}}}
    if delete:
        openapi["paths"][JOB_PATH]["delete"] = {"responses": {"204": {"description": "stopped"}}}
    spec = {
        "engine": engines.engine_ref(engines.manifest("random-search"), "bim.builtin"),
        "endpoint": "https://93.184.216.34",
        "protocol": {"id": "bim-engine/v1", "mediaType": "application/json", "digest": engines.protocol_digest()},
        "mappings": {"request": "/internal/v1/binding-problems", "job": JOB_PATH, "health": "/health", "openapi": "/openapi.json"},
        "auth": {"scheme": "none"},
        "openapi": openapi,
    }
    if cancellation is not None:
        spec["extensions"] = {"cancellation": cancellation}
    return {
        "apiVersion": "bim/v1",
        "kind": "EngineRegistration",
        "metadata": {"namespace": owner.username, "name": f"deployment-{uuid.uuid4().hex[:8]}", "version": "1.0.0"},
        "spec": spec,
    }


async def verified(document: dict) -> dict:
    async def fetch(_registration, _path, **_kwargs):
        return document["spec"]["openapi"]

    async def solve(*_args, **_kwargs):
        binding = {"probe-task": {"resource": "probe-catalog", "id": "probe-candidate"}}
        return {"termination": "OPTIMAL", "solutions": [{"decision": {"binding": binding}}]}

    report, _, _ = await verify_registration(
        document,
        None,
        engines.manifest("random-search"),
        settings=Settings(federation_secret_key=generate_key()),
        fetch=fetch,
        solve=solve,
    )
    return report


async def test_a_declared_capability_the_openapi_does_not_back_is_reported_and_leaves_the_registration_verified(
    owner, caplog
):
    with caplog.at_level(logging.WARNING):
        report = await verified(deployment_document(owner, cancellation=PER_ATTEMPT_CANCELLATION, delete=False))

    assert report["status"] == "verified"  # the registration itself is untouched
    check = next(check for check in report["checks"] if check["id"] == "cancellation")
    assert check["status"] == "disabled" and "DELETE" in check["message"]
    assert "declares cancellation but it is off" in caplog.text


async def test_a_capability_the_openapi_backs_is_reported_as_passed(owner):
    report = await verified(deployment_document(owner, cancellation=PER_ATTEMPT_CANCELLATION, delete=True))

    assert report["status"] == "verified"
    assert {"id": "cancellation", "status": "passed", "idScope": "attempt"} in report["checks"]


async def test_a_registration_that_declares_nothing_has_no_cancellation_check(owner):
    report = await verified(deployment_document(owner))

    assert report["status"] == "verified"
    assert "cancellation" not in [check["id"] for check in report["checks"]]


async def test_the_registration_schema_accepts_the_declaration_in_extensions(db_session, owner):
    document = deployment_document(owner, cancellation=PER_ATTEMPT_CANCELLATION, delete=True)

    summary = await register_engine(
        document,
        owner,
        db_session,
        settings=Settings(federation_secret_key=generate_key()),
        validate=lambda endpoint, **kwargs: (),
    )

    row = (
        await db_session.execute(
            select(EngineRegistrationRevision).where(EngineRegistrationRevision.manifest_digest == summary["digest"])
        )
    ).scalars().one()
    assert row.document["spec"]["extensions"]["cancellation"] == PER_ATTEMPT_CANCELLATION
    assert execution.registration_cancellation(row).per_attempt is True
    assert digest(row.document) == summary["digest"]


# -- The rules of the door, over the rows alone ----------------------------------------------------------------


def view(state, attempt, **ids) -> JobView:
    """A job in ``state`` that was claimed ``attempt`` times, with the engine ids given as ``{"1": "A"}``."""
    return JobView(
        state=state,
        attempt=attempt,
        attempts=tuple(AttemptView(int(number), remote_id, "e1") for number, remote_id in sorted(ids.items())),
    )


def action(job: JobView, target: int = 1, *, per_attempt=True, endpoint="e1") -> Action:
    row = next(item for item in job.attempts if item.attempt == target)
    return decide(job, row, supported=True, per_attempt=per_attempt, current_endpoint=endpoint).action


def test_the_attempt_that_runs_the_job_is_never_cancelled():
    assert action(view(JobState.RUNNING, 1, **{"1": "A"})) is Action.DEFER


def test_a_lost_attempt_waits_for_the_running_one_to_register_an_id_and_is_cancelled_when_it_differs():
    assert action(view(JobState.RUNNING, 2, **{"1": "A"})) is Action.DEFER
    assert action(view(JobState.RUNNING, 2, **{"1": "A", "2": "B"})) is Action.CANCEL
    assert action(view(JobState.RUNNING, 2, **{"1": "A", "2": "A"})) is Action.SKIP  # the same id: not ours to stop


def test_a_queued_job_has_nothing_running_and_a_terminal_one_is_over():
    assert action(view(JobState.QUEUED, 1, **{"1": "A"})) is Action.CANCEL
    for state in (JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED):
        assert action(view(state, 2, **{"1": "A"})) is Action.CANCEL
        assert action(view(state, 2, **{"1": "A", "2": "A"})) is Action.SKIP


def test_without_a_per_attempt_scope_only_a_terminal_job_allows_it():
    assert action(view(JobState.QUEUED, 1, **{"1": "A"}), per_attempt=False) is Action.DEFER
    assert action(view(JobState.RUNNING, 2, **{"1": "A", "2": "B"}), per_attempt=False) is Action.DEFER
    assert action(view(JobState.FAILED, 2, **{"1": "A", "2": "B"}), per_attempt=False) is Action.CANCEL


def test_nothing_is_sent_to_another_endpoint_or_without_the_capability():
    job = view(JobState.FAILED, 2, **{"1": "A"})
    row = job.attempts[0]

    assert decide(job, row, supported=True, per_attempt=True, current_endpoint="e2").action is Action.SKIP
    assert decide(job, row, supported=True, per_attempt=True, current_endpoint=None).action is Action.SKIP
    assert decide(job, row, supported=False, per_attempt=False, current_endpoint="e1").action is Action.SKIP


def test_whatever_the_states_the_delete_never_meets_the_running_attempt_or_a_newer_one():
    """Every combination of job state, claims, ids (shared or not) and endpoints: the rules hold in all of them."""
    seen = {action: 0 for action in Action}
    options = (None, "A", "B")
    for state, claims, target, ids, endpoints, current, supported, per_attempt in product(
        JobState,
        range(4),
        (1, 2, 3),
        product(options, repeat=3),
        product(("e1", "e2"), repeat=3),
        ("e1", "e2"),
        (True, False),
        (True, False),
    ):
        rows = tuple(
            AttemptView(number, remote_id, endpoints[number - 1])
            for number, remote_id in enumerate(ids, start=1)
            if remote_id is not None
        )
        row = next((item for item in rows if item.attempt == target), None)
        if row is None:
            continue
        job = JobView(state=state, attempt=claims, attempts=rows)
        decision = decide(job, row, supported=supported, per_attempt=per_attempt, current_endpoint=current)
        seen[decision.action] += 1
        if decision.action is not Action.CANCEL:
            continue
        running = next((item for item in rows if item.attempt == claims), None) if state is JobState.RUNNING else None
        newer = [item for item in rows if item.attempt > target]
        assert supported, decision
        assert row.endpoint == current, decision
        assert all(item.engine_job_id != row.engine_job_id for item in newer), decision
        assert claims >= target, decision
        assert not (state is JobState.RUNNING and claims == target), decision
        if running is not None:
            assert (running.engine_job_id, running.endpoint) != (row.engine_job_id, row.endpoint), decision
        if state not in remote_attempts.TERMINAL_STATES and state is JobState.RUNNING:
            assert per_attempt and running is not None, decision
        if not per_attempt:
            assert state in remote_attempts.TERMINAL_STATES, decision
    assert all(count > 0 for count in seen.values()), seen  # the space really contains every outcome


# -- The attempts' own rows ------------------------------------------------------------------------------


async def test_every_attempt_keeps_its_own_id_and_endpoint_and_the_job_keeps_the_latest(db_session, owner):
    deployment = await a_registration(db_session, owner, endpoint="http://engine-one")
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    await claim_and_record(db_session, job, "engine-job-B")

    rows = (
        await db_session.execute(
            select(JobEngineAttempt.attempt, JobEngineAttempt.engine_job_id, JobEngineAttempt.endpoint)
            .where(JobEngineAttempt.job_id == job.id)
            .order_by(JobEngineAttempt.attempt)
        )
    ).all()
    assert [tuple(row) for row in rows] == [
        (1, "engine-job-A", "http://engine-one"),
        (2, "engine-job-B", "http://engine-one"),
    ]
    assert (await only_job(db_session)).engine_job_id == "engine-job-B"


async def test_an_id_that_arrives_after_the_lease_was_lost_is_kept_for_cancellation_and_does_not_touch_the_job(
    db_session, owner
):
    job = await a_job(db_session, owner)
    job_id = job.id  # the write below rolls the session back, which expires the loaded job
    await claim_and_record(db_session, job, None)
    stale_token = leases.held_token(db_session, job_id)
    await lose_and_sweep(db_session, job)
    db_session.info[leases.lease_key(job_id)] = stale_token  # the slow worker still believes it holds it

    await execution.record_engine_job_id(
        db_session, job_id, "engine-job-late", attempt=1, endpoint="http://engine"
    )

    assert await cancel_rows(db_session, SimpleNamespace(id=job_id)) == {1: ("pending", 0)}
    assert (await only_job(db_session)).engine_job_id == "engine-1"  # the job row is the new owner's


async def test_a_worker_cancelled_while_the_id_is_being_written_lets_the_write_finish(
    db_session, owner, monkeypatch
):
    job = await a_job(db_session, owner)
    await claim_and_record(db_session, job, None)
    started = asyncio.Event()
    real = remote_attempts.record

    async def slow(*args, **kwargs):
        started.set()
        await asyncio.sleep(0.05)
        return await real(*args, **kwargs)

    monkeypatch.setattr(remote_attempts, "record", slow)
    writing = asyncio.create_task(execution.record_engine_job_id(db_session, job.id, "engine-job-A"))
    await started.wait()

    writing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await writing

    assert await cancel_rows(db_session, job) == {1: ("none", 0)}
    assert (await only_job(db_session)).engine_job_id == "engine-job-A"
    assert (await db_session.execute(select(1))).scalar_one() == 1  # the session is still usable


# -- Without the capability nothing is sent ----------------------------------------------------------------------


async def test_the_sweep_sends_nothing_to_a_registration_that_does_not_declare_cancellation(
    db_session, owner, engine_http, credentials
):
    deployment = await a_registration(db_session, owner)  # no extensions
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)

    sent = await cycle(db_session)

    assert sent == 0 and engine_http.requests == []
    assert credentials == []  # the credential was not even decrypted
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


async def test_a_declaration_the_openapi_does_not_back_sends_nothing_and_is_logged(
    db_session, owner, engine_http, credentials, caplog
):
    deployment = await a_registration(
        db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION, delete_described=False
    )
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)

    with caplog.at_level(logging.WARNING):
        await cycle(db_session)

    assert engine_http.requests == [] and credentials == []
    assert "declares cancellation but it is off" in caplog.text
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}
    await db_session.refresh(deployment)
    assert deployment.is_active is True  # the registration itself is not changed


async def test_a_registration_that_is_gone_or_deactivated_is_not_sent_anything(
    db_session, owner, engine_http, credentials
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    deployment.is_active = False
    await db_session.commit()

    await cycle(db_session)

    assert engine_http.requests == [] and credentials == []
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


def an_engine_that_fails(session, scenario: str):
    """The solve double of a worker path: it accepts the job, then the scenario unfolds."""

    async def solve(*_args, on_remote_id=None, **_kwargs):
        await on_remote_id("engine-job-X")
        job = (await session.execute(select(Job))).scalars().one()
        if scenario == "engine_error":
            raise execution.RemoteEngineError("remote engine timed out")
        if scenario == "lease_lost":
            job.lease_until = utcnow() - timedelta(seconds=1)
            await session.commit()
            assert await reconciler.sweep_abandoned(session) == 0
            await session.commit()
        else:
            job.cancellation_requested = True
            await session.commit()
        return answer()

    return solve


@pytest.mark.parametrize("scenario", ["engine_error", "lease_lost", "cancel_requested"])
@pytest.mark.parametrize("declared", [False, True])
async def test_the_three_paths_of_the_worker_cancel_only_when_the_capability_is_declared(
    api_client, db_session, registration, monkeypatch, engine_http, scenario, declared
):
    if declared:
        capability = CancellationCapability(declared=True, supported=True, id_scope=ATTEMPT_ID_SCOPE)
        monkeypatch.setattr(execution, "registration_cancellation", lambda _registration: capability)
    monkeypatch.setattr(execution, "solve_remote", an_engine_that_fails(db_session, scenario))
    headers, snapshot_id = await account_with_snapshot(api_client, registration)

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert engine_http.deleted == (["engine-job-X"] if declared else [])
    expected = {"engine_error": JobState.FAILED, "lease_lost": JobState.QUEUED, "cancel_requested": JobState.CANCELLED}
    assert job.state is expected[scenario]
    assert job.result is None or scenario == "engine_error"  # a late result of a lost attempt is discarded


# -- With the capability -----------------------------------------------------------------------------------------


async def test_the_sweep_marks_and_never_touches_the_network(db_session, owner, monkeypatch):
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("the sweep reached for the network")

    monkeypatch.setattr(execution, "cancel_remote", forbidden)
    monkeypatch.setattr(remote, "cancel_remote", forbidden)
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")

    await lose_and_sweep(db_session, job)

    assert (await only_job(db_session)).state is JobState.QUEUED
    assert await cancel_rows(db_session, job) == {1: ("pending", 0)}


async def test_a_lost_attempt_of_a_queued_job_is_cancelled_with_the_credential(
    db_session, owner, engine_http, credentials
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)

    sent = await cycle(db_session)

    assert sent == 1 and engine_http.deleted == ["engine-job-A"]
    assert engine_http.requests[0].headers["authorization"] == f"Bearer {SECRET}"
    assert await cancel_rows(db_session, job) == {1: ("sent", 1)}
    assert await cycle(db_session) == 0 and engine_http.deleted == ["engine-job-A"]  # once only


async def test_every_attempt_of_a_job_that_ended_is_cancelled_by_its_own_id(
    db_session, owner, engine_http, credentials
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    for remote_id in ("engine-job-A", "engine-job-B"):
        await claim_and_record(db_session, job, remote_id)
        await lose_and_sweep(db_session, job)
    assert (await only_job(db_session)).state is JobState.FAILED

    await cycle(db_session)

    assert sorted(engine_http.deleted) == ["engine-job-A", "engine-job-B"]


async def test_the_id_of_the_attempt_that_runs_now_is_never_cancelled(db_session, owner, engine_http, credentials):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    await claim_and_record(db_session, job, "engine-job-B")  # attempt 2 runs and has its own id

    await cycle(db_session)

    assert (await only_job(db_session)).state is JobState.RUNNING
    assert engine_http.deleted == ["engine-job-A"]
    assert await cancel_rows(db_session, job) == {1: ("sent", 1), 2: ("none", 0)}


async def test_an_engine_that_hands_the_same_id_to_two_attempts_has_it_left_alone(
    db_session, owner, engine_http, credentials
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    await claim_and_record(db_session, job, "engine-job-A")  # deduplicated by X-Openbinding-Job-Id

    await cycle(db_session)

    assert engine_http.requests == []
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1), 2: ("none", 0)}


async def test_a_lost_attempt_waits_while_the_running_one_has_no_id_and_is_skipped_after_the_limit(
    db_session, owner, engine_http, credentials, frozen
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    await claim_and_record(db_session, job, None)  # attempt 2 runs and has not registered an id
    limit = get_settings().remote_cancel_defer_limit
    assert limit == 5

    await cycle(db_session)
    assert await cancel_rows(db_session, job) == {1: ("pending", 1)}
    await cycle(db_session)  # not due again before its backoff
    assert await cancel_rows(db_session, job) == {1: ("pending", 1)}
    frozen.advance(3600)
    for _ in range(limit + 3):
        await cycle(db_session, frozen)

    assert engine_http.requests == []  # never blind
    assert await cancel_rows(db_session, job) == {1: ("skipped", limit)}


async def test_a_deferred_cancellation_goes_out_once_the_running_attempt_has_an_id(
    db_session, owner, engine_http, credentials, frozen
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    await claim_and_record(db_session, job, None)
    await cycle(db_session, frozen)
    await cycle(db_session, frozen)
    assert engine_http.requests == []

    await execution.record_engine_job_id(db_session, job.id, "engine-job-B")
    await cycle(db_session, frozen)

    assert engine_http.deleted == ["engine-job-A"]


async def test_without_an_attempt_scoped_id_only_a_job_that_ended_is_touched(
    db_session, owner, engine_http, credentials, frozen
):
    deployment = await a_registration(
        db_session, owner, cancellation={"supported": True, "idScope": "job"}
    )
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)

    await cycle(db_session, frozen)
    assert engine_http.requests == []

    await db_session.execute(update(Job).where(Job.id == job.id).values(state=JobState.FAILED))
    await db_session.commit()
    await cycle(db_session, frozen)

    assert engine_http.deleted == ["engine-job-A"]


async def test_the_credential_is_not_sent_to_an_endpoint_the_attempt_did_not_use(
    db_session, owner, engine_http, credentials
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    deployment.endpoint = "http://another-host"  # the registration now points somewhere else
    await db_session.commit()

    await cycle(db_session)

    assert engine_http.requests == []
    assert credentials == []
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


async def test_a_network_error_is_retried_with_backoff_a_bounded_number_of_times(
    db_session, owner, engine_http, credentials, frozen, monkeypatch
):
    monkeypatch.setattr(get_settings(), "remote_cancel_max_attempts", 3)
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    engine_http.error = httpx.ConnectError("refused")

    await cycle(db_session)
    assert len(engine_http.requests) == 1
    assert await cancel_rows(db_session, job) == {1: ("failed", 1)}
    await cycle(db_session)
    assert len(engine_http.requests) == 1  # backing off
    frozen.advance(3600)
    await cycle(db_session, frozen)
    await cycle(db_session, frozen)
    for _ in range(3):
        await cycle(db_session, frozen)

    assert len(engine_http.requests) == 3  # and no more
    assert await cancel_rows(db_session, job) == {1: ("failed", 3)}


async def test_an_engine_that_answers_404_or_405_is_not_asked_again(
    db_session, owner, engine_http, credentials, frozen
):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    engine_http.status = 405

    for _ in range(3):
        await cycle(db_session, frozen)

    assert len(engine_http.requests) == 1
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


async def test_a_202_is_accepted_but_not_confirmed_so_it_is_retried_and_never_counted_as_sent(
    db_session, owner, engine_http, credentials, frozen, monkeypatch
):
    monkeypatch.setattr(get_settings(), "remote_cancel_max_attempts", 3)
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    engine_http.status = 202

    sent = 0
    for _ in range(5):
        sent += await cycle(db_session, frozen)

    assert sent == 0
    assert len(engine_http.requests) == 3  # bounded, like a network error
    assert await cancel_rows(db_session, job) == {1: ("failed", 3)}


async def test_a_batch_is_bounded(db_session, owner, engine_http, credentials, monkeypatch):
    monkeypatch.setattr(get_settings(), "remote_cancel_batch", 2)
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    for number in range(3):
        job = await a_job(db_session, owner, registration=deployment)
        await claim_and_record(db_session, job, f"engine-job-{number}")
        await lose_and_sweep(db_session, job)

    assert await cycle(db_session) == 2
    assert await cycle(db_session) == 1
    assert len(engine_http.deleted) == 3


# -- Two replicas ------------------------------------------------------------------------------------------------


async def test_a_claim_is_won_once_and_a_stale_read_loses(db_session, owner):
    deployment = await a_registration(db_session, owner, cancellation=PER_ATTEMPT_CANCELLATION)
    job = await a_job(db_session, owner, registration=deployment)
    await claim_and_record(db_session, job, "engine-job-A")
    await lose_and_sweep(db_session, job)
    maximum = get_settings().remote_cancel_max_attempts
    stale = (
        await db_session.execute(
            select(
                JobEngineAttempt.id,
                JobEngineAttempt.job_id,
                JobEngineAttempt.attempt,
                JobEngineAttempt.engine_job_id,
                JobEngineAttempt.endpoint,
                JobEngineAttempt.cancel_attempts,
            )
        )
    ).one()

    first = await remote_attempts.claim_due(db_session, limit=10, max_attempts=maximum)
    second_replica = await remote_attempts.claim_due(db_session, limit=10, max_attempts=maximum)
    late = await remote_attempts._claim_row(db_session, SimpleNamespace(**stale._asdict()), maximum)

    assert [item.engine_job_id for item in first] == ["engine-job-A"]
    assert second_replica == [] and late is None


# -- The cycle -----------------------------------------------------------------------------------------------------


async def test_the_reconciler_cycle_runs_the_cancellation_step_and_survives_its_failure(
    db_session, owner, monkeypatch
):
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    steps: list[str] = []

    async def failing(_session):
        steps.append("cancel")
        raise RuntimeError("the cancellation step failed")

    monkeypatch.setattr(reconciler, "cancel_lost_attempts", failing)

    await reconciler._reconcile_cycle(factory)

    assert steps == ["cancel"]


# -- One door ------------------------------------------------------------------------------------------------------


def test_the_engines_are_asked_to_stop_a_job_from_one_place_only():
    import ast

    callers = []
    for path in sorted(SOURCE.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call):
                name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
                if name == "cancel_remote":
                    callers.append(f"{path.relative_to(SOURCE).as_posix()}:{node.lineno}")

    assert [caller.split(":")[0] for caller in callers] == ["services/execution.py"], callers


# -- The migration ------------------------------------------------------------------------------------------------


PREVIOUS_REVISION = "a5b6c7d8e9f0"
THIS_REVISION = "b6c7d8e9f0a1"


def alembic(database: Path, *arguments: str) -> subprocess.CompletedProcess:
    environment = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", "alembic.ini", *arguments],
        cwd=ROOT, env=environment, capture_output=True, text=True, check=False,
    )


def run(database: Path, *arguments: str) -> str:
    done = alembic(database, *arguments)
    assert done.returncode == 0, done.stdout + done.stderr
    return done.stdout


def table_info(database: Path) -> tuple[set[str], dict[str, int]]:
    with sqlite3.connect(database) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(job_engine_attempts)")}
        indexes = {row[1]: row[2] for row in connection.execute("PRAGMA index_list(job_engine_attempts)")}
    return columns, indexes


def test_the_migration_hangs_from_the_previous_head_and_its_downgrade_drops_the_table(tmp_path):
    database = tmp_path / "attempts.db"

    heads = run(database, "heads")
    assert heads.count("(head)") == 1 and THIS_REVISION in heads

    run(database, "upgrade", PREVIOUS_REVISION)
    assert table_info(database) == (set(), {})

    run(database, "upgrade", "head")
    columns, indexes = table_info(database)
    assert columns == {
        "id", "job_id", "attempt", "engine_job_id", "endpoint", "registered_at",
        "cancel_state", "cancel_attempts", "next_cancel_at",
    }
    assert indexes["uq_job_engine_attempts_job_attempt"] == 1  # unique
    assert "ix_job_engine_attempts_cancel_due" in indexes

    run(database, "downgrade", PREVIOUS_REVISION)  # drops the table and the ids and pending cancellations in it
    assert table_info(database) == (set(), {})

    run(database, "upgrade", "head")
    assert table_info(database)[0]


def test_the_defaults_of_the_cancellation_settings():
    settings = Settings()

    assert (settings.remote_cancel_defer_limit, settings.remote_cancel_max_attempts) == (5, 8)
    assert settings.remote_cancel_batch >= 1 and settings.remote_cancel_concurrency >= 1
