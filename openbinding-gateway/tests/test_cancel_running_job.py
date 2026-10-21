"""G2: cancelling a job that is RUNNING reaches the solver while the worker waits for the engine.

``POST /v1/jobs/{id}/cancel`` on a running job only sets ``cancellation_requested``. The worker used to read it
after ``solve_remote`` returned, so the ``DELETE`` left when the solver was already over. Now the worker looks at the
flag between two polls (``execution.CancelWatch``) and, when the registration declares cancellation, claims the
attempt and sends the ``DELETE`` through the same guarded door as every other cancellation.

Everything is local: SQLite, the whole gateway path (the API, ``run_claimed_job``, ``solve_remote``,
``cancel_remote``) against an asynchronous engine simulated with ``httpx.MockTransport``. What is pinned:

* the ``DELETE`` goes out once, and the job is CANCELLED only after the engine confirmed (200, or ``failed`` with
  ``cancelled:`` on a poll after a 202), never on the request alone;
* an engine that never confirms leaves an honest state: the job is not called cancelled, the flag stays, the
  attempt's cancellation stays open and the reconciler's sweep finishes it (also for a bundled engine);
* without the capability nothing is sent and the worker waits for the engine as before;
* another account cannot cancel the job; cancel and finish racing, or a late result, never reopen a job.
"""

from __future__ import annotations

import time

import httpx
import pytest
from sqlalchemy import select

from analysis_b3_b4_b6._helpers import a_job, account_headers, account_with_snapshot, answer, only_job, submit
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, JobState
from openbinding_gateway.jobs import leases, reconciler, remote_attempts
from openbinding_gateway.jobs.remote_attempts import Action, AttemptView, JobView, decide
from openbinding_gateway.services import execution
from openbinding_gateway.services.engine_registry import ATTEMPT_ID_SCOPE, CancellationCapability
from openbinding_gateway.v1 import remote
from test_remote_cancel import cancel_rows, frozen, owner  # noqa: F401

ENGINE_ID = "engine-job-X"


class AsyncEngine:
    """An asynchronous engine (POST 202, GET polls, DELETE) that records every request.

    ``delete_answers`` is what the successive ``DELETE``s answer (the last one repeats): 200 stops the job, 202
    says it is stopping. ``stops_after`` makes a job that is stopping report ``cancelled:`` on its own after that
    many polls; otherwise it stays stopping until a ``DELETE`` answers 200. ``complete_at`` is the poll at which it
    finishes by itself. ``before_poll`` runs at the start of every poll with its number.
    """

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.state = "running"
        self.polls = 0
        self.delete_answers = [200]
        self.stops_after: int | None = None
        self.complete_at: int | None = None
        self.before_poll = None
        self.gateway_job_id: str | None = None
        self.on_delete = None
        self._stopping: int | None = None

    @property
    def deletes(self) -> list[str]:
        return [request.url.path.rsplit("/", 1)[-1] for request in self.requests if request.method == "DELETE"]

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "POST":
            self.gateway_job_id = request.headers["x-openbinding-job-id"]
            return httpx.Response(202, json={"id": ENGINE_ID, "status": "queued"})
        if request.method == "DELETE":
            if self.on_delete is not None:
                await self.on_delete()
            status = self.delete_answers[min(len(self.deletes), len(self.delete_answers)) - 1]
            if status == 200 and self.state in ("running", "cancelling"):
                self.state = "cancelled"
            if status == 202 and self.state == "running":
                self.state, self._stopping = "cancelling", self.stops_after
            return httpx.Response(status, json={"id": ENGINE_ID, "status": self.state})
        self.polls += 1
        if self.before_poll is not None:
            await self.before_poll(self.polls)
        if self.state == "cancelling" and self._stopping is not None:
            self._stopping -= 1
            if self._stopping <= 0:
                self.state = "cancelled"
        if self.state == "running" and self.complete_at is not None and self.polls >= self.complete_at:
            self.state = "completed"
        body = {"id": ENGINE_ID, "created_at": 1}
        if self.state == "cancelled":
            body.update(status="failed", error="cancelled: stopped by DELETE")
        elif self.state == "completed":
            body.update(status="completed", result=answer())
        else:
            body.update(status="running")
        return httpx.Response(200, json=body)


@pytest.fixture
def engine(monkeypatch) -> AsyncEngine:
    """The engine's HTTP side behind both the solve and the cancellation, polled without waiting."""
    double = AsyncEngine()
    transport = httpx.MockTransport(double.handler)
    real_solve, real_cancel = remote.solve_remote, remote.cancel_remote

    async def solve(*args, **kwargs):
        return await real_solve(*args, transport=transport, **kwargs)

    async def cancel(registration, engine_job_id, **kwargs):
        return await real_cancel(registration, engine_job_id, transport=transport, **kwargs)

    async def accepted(_answer) -> None:
        return None

    monkeypatch.setattr(execution, "solve_remote", solve)
    monkeypatch.setattr(execution, "cancel_remote", cancel)
    monkeypatch.setattr(execution, "validate_engine_result", accepted)
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: ())
    monkeypatch.setenv("REMOTE_CANCEL_WATCH_INTERVAL_S", "0")
    return double


@pytest.fixture
def declared(monkeypatch) -> CancellationCapability:
    capability = CancellationCapability(declared=True, supported=True, id_scope=ATTEMPT_ID_SCOPE)
    monkeypatch.setattr(execution, "registration_cancellation", lambda _registration: capability)
    return capability


def at_poll(engine: AsyncEngine, number: int, action) -> None:
    async def hook(polls: int) -> None:
        if polls == number:
            await action()

    engine.before_poll = hook


def cancelling(api_client, headers, engine: AsyncEngine, *, times: int = 1, expect: int = 200):
    async def cancel() -> None:
        for _ in range(times):
            response = await api_client.post(f"/v1/jobs/{engine.gateway_job_id}/cancel", headers=headers)
            assert response.status_code == expect, response.text

    return cancel


async def launched(api_client, registration):
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    return headers, snapshot_id


async def state_seen_by_the_engine(db_session) -> JobState:
    state = (await db_session.execute(select(Job.state))).scalar_one()
    await db_session.commit()  # a rollback would expire the worker's own objects
    return state


# -- The cancellation reaches the solver while the worker waits ------------------------------------------------------


async def test_a_cancel_during_the_wait_sends_one_delete_and_the_job_is_cancelled_after_the_confirmation(
    api_client, db_session, registration, engine, declared
):
    headers, snapshot_id = await launched(api_client, registration)
    seen: list[JobState] = []

    async def note_state() -> None:
        seen.append(await state_seen_by_the_engine(db_session))

    engine.on_delete = note_state
    at_poll(engine, 2, cancelling(api_client, headers, engine, times=2))  # cancelling twice is one cancellation

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert engine.deletes == [ENGINE_ID]
    assert seen == [JobState.RUNNING]  # not cancelled before the engine said so
    assert job.state is JobState.CANCELLED and job.cancellation_requested is True
    assert job.result is None and job.termination is None and job.lease_token is None
    assert engine.state == "cancelled" and engine.polls == 2  # the wait ended at the confirmation
    assert await cancel_rows(db_session, job) == {1: ("sent", 1)}
    again = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=headers)
    assert again.status_code == 409 and engine.deletes == [ENGINE_ID]


async def test_a_202_is_followed_by_the_engine_reporting_the_stop_and_the_job_is_cancelled(
    api_client, db_session, registration, engine, declared
):
    headers, snapshot_id = await launched(api_client, registration)
    engine.delete_answers, engine.stops_after = [202], 2
    at_poll(engine, 2, cancelling(api_client, headers, engine))

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert engine.deletes == [ENGINE_ID]  # the stop was seen on the poll; no second DELETE
    assert job.state is JobState.CANCELLED and job.result is None
    assert engine.state == "cancelled"
    assert await cancel_rows(db_session, job) == {1: ("sent", 1)}  # settled: nothing is left for the sweep


async def test_a_202_is_retried_and_the_second_delete_confirms(
    api_client, db_session, registration, engine, declared, frozen  # noqa: F811
):
    headers, snapshot_id = await launched(api_client, registration)
    engine.delete_answers = [202, 200]
    at_poll(engine, 2, cancelling(api_client, headers, engine))
    advance = engine.before_poll

    async def later(polls: int) -> None:
        await advance(polls)
        if polls == 4:
            frozen.advance(3600)  # the backoff of the first claim is over

    engine.before_poll = later

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert engine.deletes == [ENGINE_ID, ENGINE_ID]
    assert job.state is JobState.CANCELLED and engine.state == "cancelled"
    assert await cancel_rows(db_session, job) == {1: ("sent", 2)}


async def test_an_engine_that_never_confirms_leaves_an_honest_state_that_the_sweep_finishes(
    api_client, db_session, registration, engine, declared, frozen, monkeypatch  # noqa: F811
):
    monkeypatch.setenv("REMOTE_CANCEL_CONFIRM_TIMEOUT_S", "0.3")
    headers, snapshot_id = await launched(api_client, registration)
    engine.delete_answers = [202, 200]  # stopping, and the retry of the sweep finally finds it stopped
    at_poll(engine, 2, cancelling(api_client, headers, engine))

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert engine.deletes == [ENGINE_ID] and engine.state == "cancelling"  # the solver is not known to be gone
    assert job.state is JobState.FAILED  # not CANCELLED: the solver may be alive
    assert job.result["code"] == "engine_timeout"
    assert job.cancellation_requested is True
    assert await cancel_rows(db_session, job) == {1: ("failed", 1)}  # still open, due again after its backoff
    # a result the engine produces now finds a terminal job and is discarded
    await execution.settle_engine_answer(
        db_session, job, time.monotonic(), attempt=1, remote_result=answer(), document={}, optimization={},
        termination_guarantees=["FEASIBLE"], provenance={}, transport=None,
    )
    assert (await only_job(db_session)).state is JobState.FAILED

    frozen.advance(3600)
    sent = await reconciler.cancel_lost_attempts(db_session)  # the sweep resolves the bundled registration

    assert sent == 1 and engine.deletes == [ENGINE_ID, ENGINE_ID] and engine.state == "cancelled"
    assert await cancel_rows(db_session, job) == {1: ("sent", 2)}
    assert (await only_job(db_session)).state is JobState.FAILED


async def test_without_the_capability_nothing_is_sent_and_the_worker_waits_for_the_engine_as_before(
    api_client, db_session, registration, engine
):
    headers, snapshot_id = await launched(api_client, registration)
    engine.complete_at = 5
    at_poll(engine, 2, cancelling(api_client, headers, engine))

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert engine.deletes == [] and engine.polls == 5  # it waited for the engine to finish
    assert job.state is JobState.CANCELLED  # the flag is read after the solve, as always
    assert job.result is None
    assert await cancel_rows(db_session, job) == {1: ("none", 0)}


# -- Races, permissions, late results -----------------------------------------------------------------------------


async def test_a_cancel_that_arrives_with_the_result_wins_and_the_result_is_discarded(
    api_client, db_session, registration, engine, declared
):
    headers, snapshot_id = await launched(api_client, registration)
    engine.complete_at = 2  # the engine finishes on the very poll the cancel arrives
    at_poll(engine, 2, cancelling(api_client, headers, engine))

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert job.state is JobState.CANCELLED and job.result is None and job.termination is None
    assert len(engine.deletes) <= 1  # best effort on a job that is over; idempotent at the engine
    assert (await cancel_rows(db_session, job))[1][0] in ("sent", "none")


async def test_a_job_that_finished_first_cannot_be_cancelled_and_stays_as_it_ended(
    api_client, db_session, registration, engine, declared
):
    headers, snapshot_id = await launched(api_client, registration)
    engine.complete_at = 2

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    ended = job.state
    assert ended in (JobState.COMPLETED, JobState.FAILED)
    response = await api_client.post(f"/v1/jobs/{job.id}/cancel", headers=headers)
    assert response.status_code == 409
    after = await only_job(db_session)
    assert after.state is ended and after.cancellation_requested is False
    assert engine.deletes == []


async def test_another_account_cannot_cancel_the_job_and_nothing_reaches_the_engine(
    api_client, db_session, registration, engine, declared
):
    headers, snapshot_id = await launched(api_client, registration)
    stranger = await account_headers(api_client, registration)
    engine.complete_at = 4
    at_poll(engine, 2, cancelling(api_client, stranger, engine, expect=404))

    await submit(api_client, headers, snapshot_id)

    job = await only_job(db_session)
    assert engine.deletes == []
    assert job.cancellation_requested is False
    assert job.state is not JobState.CANCELLED


async def test_a_result_that_arrives_late_never_reopens_a_cancelled_job(
    api_client, db_session, registration, engine, declared
):
    headers, snapshot_id = await launched(api_client, registration)
    at_poll(engine, 2, cancelling(api_client, headers, engine))
    await submit(api_client, headers, snapshot_id)
    job = await only_job(db_session)
    assert job.state is JobState.CANCELLED

    await execution.settle_engine_answer(
        db_session, job, time.monotonic(), attempt=1, remote_result=answer(), document={}, optimization={},
        termination_guarantees=["FEASIBLE"], provenance={}, transport=None,
    )

    after = await only_job(db_session)
    assert after.state is JobState.CANCELLED and after.result is None and after.termination is None


# -- The sweep and the bundled registrations -----------------------------------------------------------------------


async def test_the_sweep_resolves_the_context_of_a_bundled_registration_from_the_gateways_own_endpoint(
    api_client, db_session, registration, engine, declared
):
    headers, snapshot_id = await launched(api_client, registration)
    at_poll(engine, 2, cancelling(api_client, headers, engine))
    await submit(api_client, headers, snapshot_id)
    job = await only_job(db_session)
    job.service_url = "http://attacker.example"  # nothing stored on the job decides where the DELETE goes
    await db_session.commit()

    context = await execution.resolve_cancel_context(db_session, job.id)

    assert context is not None and context.endpoint == get_settings().engine_urls["random-search"]
    assert context.capability.supported

    request = dict(job.original_request)
    for field in ("version", "digest"):
        job.original_request = {**request, "registration": {**request["registration"], field: "changed"}}
        await db_session.commit()
        assert await execution.resolve_cancel_context(db_session, job.id) is None  # not the installed one any more

    job.original_request = {**request, "registration": {**request["registration"], "namespace": "bim.builtin-x"}}
    await db_session.commit()
    assert await execution.resolve_cancel_context(db_session, job.id) is None  # no stored revision either


# -- The rule of the door ------------------------------------------------------------------------------------------


def judged(
    *, running: bool = True, flag: bool = True, job_attempt: int = 1, target: int = 1, others=(), per_attempt: bool = True
):
    mine = AttemptView(target, "A", "e1")
    job = JobView(
        state=JobState.RUNNING if running else JobState.QUEUED,
        attempt=job_attempt,
        attempts=(mine, *others),
        cancellation_requested=flag,
    )
    return decide(job, mine, supported=True, per_attempt=per_attempt, current_endpoint="e1").action


@pytest.mark.parametrize("per_attempt", [True, False])
def test_the_attempt_that_runs_a_cancelled_job_may_be_stopped_whatever_the_scope_of_the_engine_ids(per_attempt):
    assert judged(per_attempt=per_attempt) is Action.CANCEL


def test_without_the_flag_the_running_attempt_is_still_never_stopped():
    assert judged(flag=False) is Action.DEFER
    assert judged(flag=False, per_attempt=False) is Action.DEFER


def test_the_flag_does_not_let_the_id_of_a_newer_attempt_go():
    same = AttemptView(2, "A", "e1")
    other = AttemptView(2, "B", "e1")

    assert judged(job_attempt=2, others=(same,)) is Action.SKIP
    assert judged(job_attempt=2, others=(other,)) is Action.CANCEL  # an older attempt: the usual rule
    assert judged(job_attempt=2, flag=False) is Action.DEFER  # the usual rule: wait for the running one's id


def test_the_flag_does_not_move_the_decision_of_a_job_that_is_not_running():
    assert judged(running=False) is Action.CANCEL
    assert judged(running=False, per_attempt=False) is Action.DEFER


# -- The watch itself ----------------------------------------------------------------------------------------------


def a_cancel_context():
    return execution.attempt_cancel_context(
        CancellationCapability(declared=True, supported=True, id_scope=ATTEMPT_ID_SCOPE),
        remote.RemoteRegistration(endpoint="http://engine", mappings={}),
    )


async def test_the_watch_reads_at_most_once_per_interval_and_holds_no_transaction(db_session, owner, monkeypatch):  # noqa: F811
    job = await a_job(db_session, owner, state=JobState.RUNNING, lease_token="ours")
    reads: list[int] = []
    real = db_session.execute

    async def counting(*args, **kwargs):
        reads.append(1)
        return await real(*args, **kwargs)

    monkeypatch.setattr(db_session, "execute", counting)
    watch = execution.CancelWatch(db_session, job.id, 1, a_cancel_context(), interval_s=3600.0)

    for _ in range(5):
        await watch("engine-job")

    assert len(reads) == 1 and not watch.requested
    assert not db_session.in_transaction()  # nothing is held across the wait


async def test_the_watch_does_not_act_without_the_lease(db_session, owner, monkeypatch):  # noqa: F811
    job = await a_job(db_session, owner, state=JobState.RUNNING, cancellation_requested=True, lease_token="theirs")

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("claimed without the lease")

    monkeypatch.setattr(remote_attempts, "claim_one", forbidden)
    db_session.info[leases.lease_key(job.id)] = "ours"  # the reconciler gave the job to somebody else
    watch = execution.CancelWatch(db_session, job.id, 1, a_cancel_context(), interval_s=0.0)

    await watch("engine-job")

    assert watch.retired and not watch.requested
    assert not db_session.in_transaction()
