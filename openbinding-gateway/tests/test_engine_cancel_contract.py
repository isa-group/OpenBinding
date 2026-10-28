"""The gateway's remote cancellation against an engine that really answers over HTTP.

``test_remote_cancel.py`` pins the rules (R1-R5) with ``httpx.MockTransport``. Here the engine is a local HTTP
server in a thread that behaves like ``engines/minizinc-csp`` (per-tenant bearer tokens, an identical 404 for an
unknown id and for another tenant's job, ``DELETE`` that answers 200 when the job is over and 202 while it is
still being stopped), and the whole gateway path runs against it: the attempt's row, ``decide``, the credential,
``cancel_remote`` and the outcome written back. The rules are not changed here; what is checked is what the
engine actually receives and what the gateway concludes from what it answers:

* the ``DELETE`` goes only to the endpoint and the id of the attempt, and only if the capability is declared;
* the credential of another tenant cannot stop the job (404) and a 404 is not retried;
* ``202`` is "accepted, not confirmed": it is retried a bounded number of times and never counted as ``sent``;
* repeating a ``DELETE`` is harmless for the engine, and the gateway does not repeat a confirmed one;
* the races: the engine finished first (200 completed), forgot the job (404), or an older attempt is
  cancelled while a newer one keeps running with its own id.
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from _repo import REPO_ROOT
from analysis_b3_b4_b6._helpers import PER_ATTEMPT_CANCELLATION, a_job, a_registration, only_job
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import JobState
from openbinding_gateway.services import engines, execution
from openbinding_gateway.v1 import remote
from test_remote_cancel import cancel_rows, claim_and_record, cycle, lose_and_sweep  # noqa: F401
from test_remote_cancel import frozen as _frozen
from test_remote_cancel import owner as _owner

# Fixtures re-exported by assignment so the tests' own parameters do not redefine an imported name.
frozen = _frozen
owner = _owner

REPO = REPO_ROOT
TOKEN_A = "tenant-a-token-0123456789"
TOKEN_B = "tenant-b-token-0123456789"
JOB_PATH = "/internal/v1/jobs/"


@dataclass(frozen=True)
class Seen:
    method: str
    path: str
    authorization: str | None


class SimulatedEngine:
    """The HTTP surface of the job resource of ``engines/minizinc-csp``, in a thread."""

    TERMINAL = ("cancelled", "completed", "failed")

    def __init__(self, tokens: dict[str, str] | None = None) -> None:
        self.tokens = tokens or {}
        self.jobs: dict[str, dict[str, str]] = {}
        self.seen: list[Seen] = []
        #: How many DELETEs answer 202 (still stopping) before the job is finally stopped.
        self.stopping_polls = 0
        self._lock = threading.Lock()
        engine = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # silence the test output
                return

            def reply(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def tenant(self) -> str | None:
                if not engine.tokens:
                    return "*"
                scheme, _, token = self.headers.get("authorization", "").partition(" ")
                return engine.tokens.get(token) if scheme.lower() == "bearer" else None

            def handle_job(self, method: str) -> None:
                with engine._lock:
                    engine.seen.append(Seen(method, self.path, self.headers.get("authorization")))
                    tenant = self.tenant()
                    if tenant is None:
                        return self.reply(401, {"detail": "A valid bearer token is required"})
                    job_id = self.path[len(JOB_PATH):] if self.path.startswith(JOB_PATH) else ""
                    job = engine.jobs.get(job_id)
                    if job is None or job["tenant"] != tenant:
                        return self.reply(404, {"detail": "Engine job not found"})
                    if method == "DELETE" and job["state"] not in engine.TERMINAL:
                        if engine.stopping_polls > 0:
                            engine.stopping_polls -= 1
                            job["state"] = "cancelling"
                            return self.reply(202, {"id": job_id, "status": "cancelling"})
                        job["state"] = "cancelled"
                    return self.reply(200, {"id": job_id, "status": job["state"]})

            def do_DELETE(self) -> None:
                self.handle_job("DELETE")

            def do_GET(self) -> None:
                self.handle_job("GET")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def start_job(self, tenant: str = "tenant-a") -> str:
        job_id = str(uuid.uuid4())
        with self._lock:
            self.jobs[job_id] = {"tenant": tenant, "state": "running"}
        return job_id

    def state(self, job_id: str) -> str:
        with self._lock:
            return self.jobs[job_id]["state"]

    @property
    def deletes(self) -> list[str]:
        return [item.path[len(JOB_PATH):] for item in self.seen if item.method == "DELETE"]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@pytest.fixture
def engine_factory():
    created: list[SimulatedEngine] = []

    def make(tokens: dict[str, str] | None = None) -> SimulatedEngine:
        created.append(SimulatedEngine({TOKEN_A: "tenant-a", TOKEN_B: "tenant-b"} if tokens is None else tokens))
        return created[-1]

    yield make
    for engine in created:
        engine.close()


@pytest.fixture
def credential(monkeypatch) -> dict[str, str]:
    """The bearer credential the gateway holds for the deployment (changeable per test); loopback is allowed."""
    held = {"token": TOKEN_A}

    async def transport(_session, revision):
        return remote.RemoteRegistration(
            endpoint=revision.endpoint,
            mappings=revision.mappings,
            auth_scheme="bearer",
            credential=held["token"],
            allow_internal_http=True,
        )

    monkeypatch.setattr(execution, "revision_transport", transport)
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: ())
    return held


async def lost_attempt(session, owner, engine: SimulatedEngine, remote_id: str, **registration):
    """A job whose first attempt used ``remote_id`` on ``engine`` and then lost its lease."""
    deployment = await a_registration(session, owner, endpoint=engine.url, **registration)
    job = await a_job(session, owner, registration=deployment)
    await claim_and_record(session, job, remote_id)
    await lose_and_sweep(session, job)
    return deployment, job


# -- What the engine receives ----------------------------------------------------------------------------------


async def test_the_delete_reaches_the_engine_of_the_attempt_with_its_id_and_the_credential(
    db_session, owner, engine_factory, credential
):
    engine = engine_factory()
    remote_id = engine.start_job()
    other = engine.start_job()
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)

    sent = await cycle(db_session)

    assert sent == 1
    assert [(item.method, item.path) for item in engine.seen] == [("DELETE", f"{JOB_PATH}{remote_id}")]
    assert engine.seen[0].authorization == f"Bearer {TOKEN_A}"
    assert engine.state(remote_id) == "cancelled"
    assert engine.state(other) == "running"  # only the id of the attempt
    assert await cancel_rows(db_session, job) == {1: ("sent", 1)}


async def test_nothing_is_sent_when_the_registration_does_not_declare_the_capability(
    db_session, owner, engine_factory, credential
):
    engine = engine_factory()
    remote_id = engine.start_job()
    _, job = await lost_attempt(db_session, owner, engine, remote_id)  # the engine could cancel; nobody said so

    await cycle(db_session)

    assert engine.seen == []
    assert engine.state(remote_id) == "running"
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


async def test_nothing_is_sent_to_the_new_endpoint_of_a_registration_nor_to_the_old_one(
    db_session, owner, engine_factory, credential
):
    first, second = engine_factory(), engine_factory()
    remote_id = first.start_job()
    deployment, job = await lost_attempt(
        db_session, owner, first, remote_id, cancellation=PER_ATTEMPT_CANCELLATION
    )
    deployment.endpoint = second.url  # the registration now points somewhere else
    await db_session.commit()

    await cycle(db_session)

    assert first.seen == [] and second.seen == []
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


async def test_the_credential_of_another_tenant_cannot_stop_the_job_and_the_404_is_not_retried(
    db_session, owner, engine_factory, credential, frozen
):
    engine = engine_factory()
    remote_id = engine.start_job("tenant-a")
    credential["token"] = TOKEN_B  # the gateway holds the credential of tenant b for this deployment
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)

    for _ in range(3):
        await cycle(db_session, frozen)

    assert engine.deletes == [remote_id]  # asked once, answered 404 (not found == not yours), never retried
    assert engine.state(remote_id) == "running"  # the job of tenant a was not touched
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


async def test_a_slow_setup_behind_the_frozen_clock_still_gets_its_lost_attempt_cancelled(
    db_session, owner, engine_factory, credential, frozen
):
    """Regression for an intermittent failure: the frozen clock is taken when the fixture starts, and the lease
    that ``lose_the_worker`` stamped came from the real clock. A setup slower than the one-second margin of that
    helper left the lease in the frozen clock's future, so the sweep saw a live worker and nothing was cancelled.
    The lease now follows the frozen clock, so the distance between the two clocks does not matter."""
    engine = engine_factory()
    remote_id = engine.start_job()
    frozen.advance(-5)  # what a slow setup does to the distance between the two clocks
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)

    await cycle(db_session, frozen)

    assert engine.deletes == [remote_id]
    assert await cancel_rows(db_session, job) == {1: ("sent", 1)}


async def test_an_unauthenticated_delete_is_refused_retried_a_bounded_number_of_times_and_stops_nothing(
    db_session, owner, engine_factory, credential, frozen, monkeypatch
):
    monkeypatch.setattr(get_settings(), "remote_cancel_max_attempts", 3)
    engine = engine_factory()
    remote_id = engine.start_job()
    credential["token"] = "not-a-token-of-this-engine-01"
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)

    for _ in range(6):
        await cycle(db_session, frozen)

    assert len(engine.deletes) == 3
    assert engine.state(remote_id) == "running"
    assert await cancel_rows(db_session, job) == {1: ("failed", 3)}


# -- 202: accepted, not confirmed -------------------------------------------------------------------------------


async def test_a_202_is_not_a_confirmation_it_is_retried_until_the_engine_confirms(
    db_session, owner, engine_factory, credential, frozen
):
    engine = engine_factory()
    engine.stopping_polls = 2  # two answers of "cancelling" (202), then the job is stopped (200)
    remote_id = engine.start_job()
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)

    first = await cycle(db_session, frozen)
    assert first == 0
    assert await cancel_rows(db_session, job) == {1: ("failed", 1)}  # not 'sent': recoverable failure
    assert engine.state(remote_id) == "cancelling"

    second = await cycle(db_session, frozen)
    assert second == 0
    assert await cancel_rows(db_session, job) == {1: ("failed", 2)}

    third = await cycle(db_session, frozen)
    assert third == 1
    assert await cancel_rows(db_session, job) == {1: ("sent", 3)}
    assert engine.state(remote_id) == "cancelled"
    assert engine.deletes == [remote_id] * 3

    await cycle(db_session, frozen)
    assert engine.deletes == [remote_id] * 3  # a confirmed cancellation is never repeated


async def test_a_202_that_never_turns_into_a_confirmation_stops_after_the_bounded_number_of_claims(
    db_session, owner, engine_factory, credential, frozen, monkeypatch
):
    monkeypatch.setattr(get_settings(), "remote_cancel_max_attempts", 3)
    engine = engine_factory()
    engine.stopping_polls = 1000
    remote_id = engine.start_job()
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)

    sent = 0
    for _ in range(8):
        sent += await cycle(db_session, frozen)

    assert sent == 0
    assert len(engine.deletes) == 3  # and no more
    assert await cancel_rows(db_session, job) == {1: ("failed", 3)}  # honest: never confirmed
    assert engine.state(remote_id) == "cancelling"


# -- Idempotence -----------------------------------------------------------------------------------------------------


async def test_repeating_the_delete_is_harmless_for_the_engine(engine_factory, credential):
    engine = engine_factory()
    remote_id = engine.start_job()
    transport = remote.RemoteRegistration(
        endpoint=engine.url,
        mappings={"job": "/internal/v1/jobs/{id}"},
        auth_scheme="bearer",
        credential=TOKEN_A,
        allow_internal_http=True,
    )
    statuses: list[int] = []

    answers = [await remote.cancel_remote(transport, remote_id, on_status=statuses.append) for _ in range(3)]

    assert answers == [True, True, True]
    assert statuses == [200, 200, 200]
    assert engine.state(remote_id) == "cancelled"


# -- Races -----------------------------------------------------------------------------------------------------------


async def test_cancel_vs_finish_the_engine_finished_first_and_says_so(
    db_session, owner, engine_factory, credential
):
    engine = engine_factory()
    remote_id = engine.start_job()
    with engine._lock:
        engine.jobs[remote_id]["state"] = "completed"
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)

    sent = await cycle(db_session)

    assert sent == 1  # 200: the job is over, which is what the gateway wanted
    assert engine.state(remote_id) == "completed"  # a finished job is not turned into a cancelled one
    assert await cancel_rows(db_session, job) == {1: ("sent", 1)}


async def test_an_engine_that_forgot_the_job_answers_404_and_is_not_asked_again(
    db_session, owner, engine_factory, credential, frozen
):
    engine = engine_factory()
    remote_id = engine.start_job()
    _, job = await lost_attempt(db_session, owner, engine, remote_id, cancellation=PER_ATTEMPT_CANCELLATION)
    with engine._lock:
        engine.jobs.clear()  # expiry (TTL) or a restart: the jobs are in memory

    for _ in range(3):
        await cycle(db_session, frozen)

    assert engine.deletes == [remote_id]
    assert await cancel_rows(db_session, job) == {1: ("skipped", 1)}


async def test_a_lost_attempt_is_cancelled_by_its_own_id_while_the_running_one_keeps_its_job(
    db_session, owner, engine_factory, credential
):
    """The engine does not deduplicate by X-Openbinding-Job-Id: every attempt got its own id (idScope attempt)."""
    engine = engine_factory()
    first_id, second_id = engine.start_job(), engine.start_job()
    _, job = await lost_attempt(db_session, owner, engine, first_id, cancellation=PER_ATTEMPT_CANCELLATION)
    await claim_and_record(db_session, job, second_id)  # attempt 2 runs now, with its own id

    await cycle(db_session)

    assert (await only_job(db_session)).state is JobState.RUNNING
    assert engine.deletes == [first_id]
    assert engine.state(first_id) == "cancelled"
    assert engine.state(second_id) == "running"
    assert await cancel_rows(db_session, job) == {1: ("sent", 1), 2: ("none", 0)}


# -- The contract the engine publishes ------------------------------------------------------------------------------


def test_the_engine_pins_the_digest_of_the_installed_protocol():
    source = (REPO / "engines" / "minizinc-csp" / "src" / "index.ts").read_text(encoding="utf-8")
    match = re.search(r"PROTOCOL_DIGEST = '(sha256-[0-9a-f]{64})'", source)
    assert match is not None
    assert match.group(1) == engines.protocol_digest()
