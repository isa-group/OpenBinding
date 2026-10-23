"""What the integration tests print when a job does not terminate.

The gateway answers ``GET /v1/jobs/{id}`` with the whole provenance, which is
long enough that the failure line was cut before ``status``. The line must say
where the job stayed, not repeat the request that created it. No gateway is
needed: the client talks to a canned transport and the clock is fake.
"""

from __future__ import annotations

import time

import httpx
import pytest

import test_engine_representation_regression as representation
import test_icsoc_regression as icsoc
import test_v1_gateway as conformance


WAITERS = {
    "conformance": conformance._wait_for_job,
    "representation": representation._wait_for_job,
    "icsoc": icsoc._wait,
}

PROVENANCE = {
    "engine": {"name": "random-search", "namespace": "builtin"},
    "limits": {"effectiveTimeoutSeconds": 1800},
    "optimization": {"type": "SINGLE", "scalarization": "weighted-sum"},
    "fileDigests": {f"file-{index}.json": "sha256:" + "0" * 64 for index in range(40)},
}


@pytest.fixture(autouse=True)
def fake_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [0.0]
    monkeypatch.setattr(time, "monotonic", lambda: now[0])
    monkeypatch.setattr(time, "sleep", lambda seconds: now.__setitem__(0, now[0] + seconds))


def _client(*bodies: dict) -> httpx.Client:
    """Answer each poll with the next body, repeating the last one."""

    remaining = list(bodies)

    def handler(request: httpx.Request) -> httpx.Response:
        body = remaining.pop(0) if len(remaining) > 1 else remaining[0]
        return httpx.Response(200, json=body)

    return httpx.Client(base_url="http://gateway", transport=httpx.MockTransport(handler))


def _failure(waiter, *bodies: dict) -> str:
    with _client(*bodies) as client, pytest.raises(pytest.fail.Exception) as raised:
        waiter(client, "job-1", {})
    return str(raised.value)


@pytest.mark.parametrize("name", WAITERS)
def test_a_job_that_never_terminates_is_reported_by_id_and_status(name: str) -> None:
    message = _failure(
        WAITERS[name],
        {"id": "job-1", "status": "queued", "provenance": PROVENANCE},
    )
    assert "job-1" in message
    assert "queued" in message


@pytest.mark.parametrize("name", WAITERS)
def test_the_failure_line_does_not_repeat_the_provenance(name: str) -> None:
    message = _failure(
        WAITERS[name],
        {"id": "job-1", "status": "running", "provenance": PROVENANCE},
    )
    assert "provenance" not in message
    assert "effectiveTimeoutSeconds" not in message
    assert "fileDigests" not in message
    assert len(message) < 400


@pytest.mark.parametrize("name", WAITERS)
def test_the_failure_line_carries_the_error_the_gateway_reported(name: str) -> None:
    message = _failure(
        WAITERS[name],
        {
            "id": "job-1",
            "status": "running",
            "error": {"code": "engine_unreachable", "message": "connection refused"},
            "provenance": PROVENANCE,
        },
    )
    assert "engine_unreachable" in message
    assert "connection refused" in message


@pytest.mark.parametrize("name", WAITERS)
def test_a_job_that_finishes_is_returned_whole(name: str) -> None:
    finished = {
        "id": "job-1",
        "status": "completed",
        "provenance": PROVENANCE,
        "result": {"termination": "FEASIBLE", "solutions": [{}]},
    }
    with _client(
        {"id": "job-1", "status": "queued", "provenance": PROVENANCE},
        {"id": "job-1", "status": "running", "provenance": PROVENANCE},
        finished,
    ) as client:
        assert WAITERS[name](client, "job-1", {}) == finished


@pytest.mark.parametrize("name", WAITERS)
def test_the_waiters_still_report_a_missing_job_as_an_http_error(name: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"title": "Job not found"})

    with httpx.Client(
        base_url="http://gateway", transport=httpx.MockTransport(handler)
    ) as client, pytest.raises(AssertionError) as raised:
        WAITERS[name](client, "job-1", {})
    assert "Job not found" in str(raised.value)
