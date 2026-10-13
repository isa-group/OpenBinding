"""The ``error`` of a failed job is a sentence of the catalog, never the text of an exception.

An exception that stops a job may name the host of a private engine, quote what
the engine wrote or carry a driver message with an address in it. The job shows
a fixed sentence for a stable ``code`` and a ``correlationId``; the raw reason
goes to the log, masked and bounded, next to the same id, and nowhere in the
database.

Nothing here reaches a network: engines are ``httpx.MockTransport`` or a stub of
``solve_remote``, and the host that does not resolve is under ``.invalid``.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from datetime import timedelta

import httpx
import pytest
import pytest_asyncio
from bim_client import BimServiceError
from sqlalchemy import select

from _pricing import pricing_catalog
from analysis_b3_b4_b6._helpers import (
    account_with_snapshot,
    answer,
    only_job,
    persisted_anywhere,
    precondition,
    submit,
)
from openbinding_gateway.core import public_errors
from openbinding_gateway.core.public_errors import (
    JOB_FAILURES,
    TRUNCATION_MARK,
    bounded,
    classify_job_failure,
    job_failure_fields,
    scrub_text,
)
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, JobState, User, UserRole, utcnow
from openbinding_gateway.db.platform_models import ApiErrorEvent
from openbinding_gateway.integrations import bim
from openbinding_gateway.jobs import leases, reconciler
from openbinding_gateway.security.redaction import GENERIC_ERROR, redact_error, redact_result
from openbinding_gateway.security.secrets import SecretsUnavailable
from openbinding_gateway.services import execution
from openbinding_gateway.v1 import remote
from openbinding_gateway.v1.remote import RemoteEngineError, RemoteRegistration

PRIVATE_HOST = "private-engine.invalid"
INTERNAL_HOST = "db-internal.corp"
INTERNAL_ADDRESS = "10.1.2.3"
HEX32 = re.compile(r"^[0-9a-f]{32}$")


@pytest.fixture
def logs(caplog, monkeypatch) -> pytest.LogCaptureFixture:
    """The log of the failure, even after a test that configured logging in-process (alembic does)."""
    for logger in (public_errors.logger, execution.logger, reconciler.logger):
        monkeypatch.setattr(logger, "disabled", False)
    caplog.set_level(logging.INFO)
    return caplog


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


async def a_job(session, owner, *, state=JobState.RUNNING, age_s=0.0, **extra) -> Job:
    job = Job(
        owner_id=owner.id,
        engine_id="random-search",
        engine_job_id="engine-1",
        service_url="http://engine",
        state=state,
        requested_budget_s=60.0,
        created_at=utcnow() - timedelta(seconds=age_s),
        **extra,
    )
    session.add(job)
    await session.commit()
    return job


async def a_submitted_job(api_client, db_session, registration) -> tuple[dict[str, str], Job]:
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)
    job = await only_job(db_session)
    precondition(job.state is JobState.FAILED, f"the job ended {job.state.value}, not failed")
    return headers, job


def engine_says(monkeypatch, error: BaseException) -> None:
    async def solve(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(execution, "solve_remote", solve)


def logged(caplog) -> str:
    return "\n".join(record.getMessage() for record in caplog.records)


def assert_a_catalog_failure(result: dict, code: str) -> None:
    assert result["code"] == code
    assert result["error"] == JOB_FAILURES[code]
    assert HEX32.match(result["correlationId"])
    assert result["termination"] == "UNKNOWN" and result["solutions"] == []


# -- The catalog -----------------------------------------------------------------


def test_every_sentence_of_the_catalog_is_short_fixed_text():
    assert {"engine_unreachable", "engine_rejected", "engine_timeout", "engine_error",
            "bim_evaluation_failed", "lease_lost", "job_abandoned", "internal_error"} <= set(JOB_FAILURES)
    for code, sentence in JOB_FAILURES.items():
        assert re.fullmatch(r"[a-z][a-z0-9_]*", code)
        assert 0 < len(sentence) <= 120, code
        assert "://" not in sentence and "{" not in sentence, code
    assert len(set(JOB_FAILURES.values())) == len(JOB_FAILURES), "two codes share one sentence"


def test_the_fields_of_a_failed_job_are_the_sentence_the_code_and_the_id():
    fields = job_failure_fields("engine_timeout", "c" * 32)

    assert fields == {"error": JOB_FAILURES["engine_timeout"], "code": "engine_timeout", "correlationId": "c" * 32}


def test_a_code_outside_the_catalog_becomes_internal_error():
    assert job_failure_fields("made up: see http://x.invalid", "c" * 32)["code"] == "internal_error"
    assert job_failure_fields("boom", "c" * 32)["error"] == JOB_FAILURES["internal_error"]


# -- Classification by type of exception -------------------------------------------


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (RemoteEngineError("x", code="engine_timeout"), "engine_timeout"),
        (RemoteEngineError("x", code="engine_rejected"), "engine_rejected"),
        (RemoteEngineError("x"), "engine_error"),
        (RemoteEngineError("x", code="not in the catalog"), "engine_error"),
        (httpx.ConnectTimeout("timed out"), "engine_timeout"),
        (httpx.ConnectError("refused"), "engine_unreachable"),
        (TimeoutError("late"), "engine_timeout"),
        (BimServiceError("service_unavailable", "could not be reached"), "bim_evaluation_failed"),
        (SecretsUnavailable("no key"), "credential_unavailable"),
        (RuntimeError(f"connection to {INTERNAL_HOST} failed"), "internal_error"),
        (ValueError("anything"), "internal_error"),
    ],
)
def test_an_exception_is_classified_by_its_type(error, code):
    assert classify_job_failure(error) == code


# -- What the transport says, and what it calls it -------------------------------


def _engine(monkeypatch, handler):
    monkeypatch.setattr(remote, "validate_endpoint", lambda endpoint, **kwargs: None)

    async def solve(**kwargs):
        return await remote.solve_remote(
            RemoteRegistration(f"https://{PRIVATE_HOST}", {"job": "/jobs/{id}"}),
            {},
            {},
            {},
            transport=httpx.MockTransport(handler),
            timeout_s=0.5,
            **kwargs,
        )

    return solve


@pytest.mark.parametrize(
    ("handler", "code"),
    [
        (lambda request: httpx.Response(503, text="engine down"), "engine_rejected"),
        (lambda request: httpx.Response(200, content=b"<html>not json"), "engine_protocol_error"),
        (lambda request: httpx.Response(202, json={"unexpected": True}), "engine_protocol_error"),
    ],
)
async def test_the_transport_names_what_went_wrong_with_a_stable_code(monkeypatch, handler, code):
    solve = _engine(monkeypatch, handler)

    with pytest.raises(RemoteEngineError) as raised:
        await solve()

    assert raised.value.code == code
    assert classify_job_failure(raised.value) == code


async def test_an_engine_that_cannot_be_reached_is_unreachable(monkeypatch):
    def refuse(request):
        raise httpx.ConnectError(f"All connection attempts failed to {PRIVATE_HOST}")

    with pytest.raises(RemoteEngineError) as raised:
        await _engine(monkeypatch, refuse)()

    assert raised.value.code == "engine_unreachable"


async def test_an_engine_that_is_too_slow_is_a_timeout(monkeypatch):
    def slow(request):
        raise httpx.ReadTimeout("slow")

    with pytest.raises(RemoteEngineError) as raised:
        await _engine(monkeypatch, slow)()

    assert raised.value.code == "engine_timeout"


async def test_a_job_that_never_finishes_is_a_timeout(monkeypatch):
    def handler(request):
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job-1", "status": "queued"})
        return httpx.Response(200, json={"id": "job-1", "status": "running", "created_at": 1})

    with pytest.raises(RemoteEngineError) as raised:
        await _engine(monkeypatch, handler)()

    assert raised.value.code == "engine_timeout"


async def test_what_an_engine_writes_about_its_failure_is_bounded_and_coded(monkeypatch):
    written = "traceback at " + "x" * 200_000

    def handler(request):
        if request.method == "POST":
            return httpx.Response(202, json={"id": "job-1", "status": "queued"})
        return httpx.Response(200, json={"id": "job-1", "status": "failed", "created_at": 1, "error": written})

    with pytest.raises(RemoteEngineError) as raised:
        await _engine(monkeypatch, handler)()

    assert raised.value.code == "engine_failed"
    assert len(str(raised.value)) <= remote.MAX_ENGINE_ERROR_TEXT
    assert str(raised.value).endswith(TRUNCATION_MARK)


async def test_a_result_the_caller_refuses_without_a_category_is_a_protocol_error(monkeypatch):
    async def refuse(answer_):
        raise RemoteEngineError("no canonical binding decision")

    solve = _engine(monkeypatch, lambda request: httpx.Response(200, json={"termination": "FEASIBLE"}))

    with pytest.raises(RemoteEngineError) as raised:
        await solve(validate_result=refuse)

    assert raised.value.code == "engine_protocol_error"


# -- Bounding and masking text -----------------------------------------------------


def test_a_text_over_the_bound_is_cut_with_a_mark():
    text = bounded("y" * 5000, 100)

    assert len(text) == 100 and text.endswith(TRUNCATION_MARK)
    assert bounded("short", 100) == "short"


def test_a_logged_text_hides_hosts_addresses_urls_and_credentials():
    text = (
        f"connect to https://{PRIVATE_HOST}:8443/solve failed; host='{INTERNAL_HOST}' "
        f"({INTERNAL_ADDRESS}:5432) [2001:db8::1]:443 token=abc123 also {INTERNAL_HOST}"
    )

    scrubbed = scrub_text(text)

    for secret in (PRIVATE_HOST, INTERNAL_HOST, INTERNAL_ADDRESS, "2001:db8", "abc123", "8443"):
        assert secret not in scrubbed, secret
    assert "connect to" in scrubbed and "failed" in scrubbed


def test_a_logged_text_is_bounded_even_when_it_is_a_megabyte():
    assert len(scrub_text("z" * 1_000_000)) <= public_errors.MAX_LOGGED_TEXT


# -- The job the owner reads -------------------------------------------------------


async def test_an_unreachable_engine_shows_its_sentence_and_not_its_host(
    api_client, db_session, registration, monkeypatch, logs
):
    real_solve = remote.solve_remote

    async def solve(*_args, **_kwargs):
        return await real_solve(RemoteRegistration(f"https://{PRIVATE_HOST}:8443", {}), {}, {}, {}, timeout_s=2.0)

    monkeypatch.setattr(execution, "solve_remote", solve)

    headers, job = await a_submitted_job(api_client, db_session, registration)
    response = await api_client.get(f"/v1/jobs/{job.id}", headers=headers)

    assert response.status_code == 200
    assert_a_catalog_failure(response.json()["result"], "engine_unreachable")
    assert response.json()["error"] == JOB_FAILURES["engine_unreachable"]
    assert PRIVATE_HOST not in response.text
    assert PRIVATE_HOST not in repr(job.result)


async def test_the_reason_is_in_the_log_with_the_id_of_the_job_and_not_in_the_database(
    api_client, db_session, registration, monkeypatch, logs
):
    engine_says(monkeypatch, RemoteEngineError(f"engine request failed: connect to https://{PRIVATE_HOST}:8443 refused"))

    _, job = await a_submitted_job(api_client, db_session, registration)

    log = logged(logs)
    assert f"correlation_id={job.result['correlationId']}" in log
    assert "RemoteEngineError" in log and "engine request failed" in log and "refused" in log
    assert f"code={job.result['code']}" in log and str(job.id) in log
    assert PRIVATE_HOST not in log, "the host is masked in the log too"
    assert not await persisted_anywhere(db_session, PRIVATE_HOST)
    assert not await persisted_anywhere(db_session, "refused")


async def test_an_unexpected_exception_is_an_internal_error_and_its_text_stays_out_of_every_table(
    api_client, db_session, registration, monkeypatch, logs
):
    engine_says(monkeypatch, RuntimeError(f"connection to server at {INTERNAL_HOST} ({INTERNAL_ADDRESS}), port 5432 failed"))

    headers, job = await a_submitted_job(api_client, db_session, registration)
    body = (await api_client.get(f"/v1/jobs/{job.id}", headers=headers)).text

    assert_a_catalog_failure(job.result, "internal_error")
    for leak in (INTERNAL_HOST, INTERNAL_ADDRESS, "RuntimeError", "connection to server at", "Traceback"):
        assert leak not in body, leak
        assert not await persisted_anywhere(db_session, leak), leak
    assert "RuntimeError" in logged(logs) and "connection to server at" in logged(logs)


async def test_an_engine_that_writes_a_novel_gets_a_short_error(api_client, db_session, registration, monkeypatch, logs):
    engine_says(monkeypatch, RemoteEngineError("x" * 100_000, code="engine_failed"))

    _, job = await a_submitted_job(api_client, db_session, registration)

    assert_a_catalog_failure(job.result, "engine_failed")
    assert len(job.result["error"]) <= 1024
    assert "xxxx" not in repr(job.result)
    assert max(len(record.getMessage()) for record in logs.records) < 4096, "the log is bounded too"


async def test_a_failed_evaluation_is_bim_evaluation_failed(api_client, db_session, registration, monkeypatch, logs):
    async def solve(*_args, **_kwargs):
        return answer()

    async def unavailable(self, *_args, **_kwargs):
        raise BimServiceError("service_unavailable", f"the service at {INTERNAL_HOST} could not be reached")

    monkeypatch.setattr(execution, "solve_remote", solve)
    monkeypatch.setattr(bim.AsyncBim, "reevaluate", unavailable)

    _, job = await a_submitted_job(api_client, db_session, registration)

    assert_a_catalog_failure(job.result, "bim_evaluation_failed")
    assert INTERNAL_HOST not in repr(job.result)
    assert "BimServiceError" in logged(logs)


async def test_a_failure_event_for_the_administration_holds_the_sentence_and_not_the_text(
    api_client, db_session, registration, monkeypatch, logs
):
    engine_says(monkeypatch, RemoteEngineError(f"engine request failed: connect to {PRIVATE_HOST} refused"))

    _, job = await a_submitted_job(api_client, db_session, registration)

    events = (await db_session.execute(select(ApiErrorEvent))).scalars().all()
    failures = [event for event in events if event.endpoint == f"/v1/jobs/{job.id}"]
    assert len(failures) == 1
    assert JOB_FAILURES[job.result["code"]] in repr(failures[0].detail)
    assert PRIVATE_HOST not in repr(failures[0].detail)


async def test_a_failure_recorded_directly_is_a_catalog_failure(db_session, owner, logs):
    job = await a_job(db_session, owner, state=JobState.QUEUED)
    await leases.claim_job(db_session, job.id)
    await db_session.commit()

    await execution.fail_persisted_job(
        job, db_session, "engine_rejected", time.monotonic(), cause=RemoteEngineError(f"{PRIVATE_HOST} said no")
    )

    await db_session.refresh(job)
    assert job.state is JobState.FAILED
    assert_a_catalog_failure(job.result, "engine_rejected")
    assert PRIVATE_HOST not in repr(job.result) and PRIVATE_HOST not in logged(logs)


async def test_a_code_nobody_classified_is_stored_as_internal_error(db_session, owner, logs):
    job = await a_job(db_session, owner, state=JobState.QUEUED)
    await leases.claim_job(db_session, job.id)
    await db_session.commit()

    await execution.fail_persisted_job(job, db_session, f"free text from {INTERNAL_HOST}", time.monotonic())

    await db_session.refresh(job)
    assert_a_catalog_failure(job.result, "internal_error")
    assert INTERNAL_HOST not in repr(job.result)


async def test_the_fallback_that_fails_a_job_after_a_broken_commit_stores_no_exception_text(
    db_session, owner, monkeypatch, logs
):
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from openbinding_gateway.db import base as db_base

    job = await a_job(db_session, owner, state=JobState.QUEUED)
    factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", lambda: factory)

    async def worker(job_id_text, session):
        assert await leases.claim_job(session, uuid.UUID(job_id_text)) is not None
        await session.commit()
        raise RuntimeError(f"commit to {INTERNAL_HOST} failed")

    monkeypatch.setattr(execution, "finish_persisted_job", worker)

    with pytest.raises(RuntimeError):
        await execution.run_persisted_job(str(job.id))

    await db_session.refresh(job)
    assert_a_catalog_failure(job.result, "internal_error")
    assert INTERNAL_HOST not in repr(job.result)
    assert f"correlation_id={job.result['correlationId']}" in logged(logs)


# -- A job failed by the sweep ---------------------------------------------------------


async def test_a_job_failed_by_the_sweep_has_a_stable_code(db_session, owner, logs):
    job = await a_job(db_session, owner, age_s=60.0 + reconciler.ABANDONED_GRACE_S + 1)

    assert await reconciler.sweep_abandoned(db_session) == 1

    await db_session.refresh(job)
    assert job.state is JobState.FAILED and job.termination == "UNKNOWN"
    assert_a_catalog_failure(job.result, "job_abandoned")
    assert f"correlation_id={job.result['correlationId']}" in logged(logs)


async def test_a_job_whose_worker_was_lost_twice_fails_with_lease_lost(db_session, owner):
    job = await a_job(db_session, owner, state=JobState.QUEUED)
    for ran_for_s in (30, 45):
        assert await leases.claim_job(db_session, job.id) is not None
        lease_until = utcnow() - timedelta(seconds=1)
        job.lease_until = lease_until
        job.claimed_at = lease_until - timedelta(seconds=leases.LEASE_S + ran_for_s)
        await db_session.commit()
        await reconciler.sweep_abandoned(db_session)
        await db_session.refresh(job)

    assert job.state is JobState.FAILED
    assert_a_catalog_failure(job.result, "lease_lost")


async def test_the_result_of_a_swept_job_keeps_its_provenance(db_session, owner):
    job = await a_job(
        db_session, owner, age_s=60.0 + reconciler.ABANDONED_GRACE_S + 1, provenance={"engine": {"id": "random-search"}}
    )

    await reconciler.sweep_abandoned(db_session)

    await db_session.refresh(job)
    assert job.result["provenance"] == {"engine": {"id": "random-search"}}


# -- What a VIEWER reads ------------------------------------------------------------------


def test_redact_error_reads_the_code_a_failed_job_carries():
    assert redact_error({"code": "queue_timeout", "error": "queue_timeout: waited"}) == (
        f"{GENERIC_ERROR} (category: queue_timeout)"
    )
    assert redact_error({"code": "engine_unreachable", "error": f"{PRIVATE_HOST} refused"}) == (
        f"{GENERIC_ERROR} (category: engine_unreachable)"
    )


def test_redact_error_still_reads_the_older_names_and_ignores_a_code_that_is_not_a_name():
    assert redact_error({"errorCode": "engine_error"}) == f"{GENERIC_ERROR} (category: engine_error)"
    assert redact_error({"error_code": "engine_error"}) == f"{GENERIC_ERROR} (category: engine_error)"
    assert redact_error({"code": f"failed at http://{PRIVATE_HOST}"}) == GENERIC_ERROR
    assert redact_error({"code": 500}) == GENERIC_ERROR
    assert redact_error({"error": f"{PRIVATE_HOST} refused"}) == GENERIC_ERROR


async def test_a_viewer_sees_the_category_of_a_job_the_queue_timed_out(db_session, owner):
    job = await a_job(db_session, owner, state=JobState.QUEUED, age_s=get_settings().queue_timeout_s + 1)
    assert await reconciler.sweep_abandoned(db_session) == 1
    await db_session.refresh(job)

    redacted = redact_result(job.result)

    assert redacted["error"] == f"{GENERIC_ERROR} (category: queue_timeout)"


async def test_a_viewer_sees_the_category_of_a_job_the_sweep_failed(db_session, owner):
    job = await a_job(db_session, owner, age_s=60.0 + reconciler.ABANDONED_GRACE_S + 1)
    await reconciler.sweep_abandoned(db_session)
    await db_session.refresh(job)

    redacted = redact_result(job.result)

    assert redacted["error"] == f"{GENERIC_ERROR} (category: job_abandoned)"
    assert redacted["correlationId"] == job.result["correlationId"]
