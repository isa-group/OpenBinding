"""B4 at head cd0e05f: the engine answered, the canonical re-evaluation by BIM failed.

Closed here: an answer that was not re-evaluated is never recorded as a valid
result (the job is FAILED, ``termination`` UNKNOWN, no solutions).

Open here (``xfail(strict=True)``): the engine's raw answer is a local variable
of ``run_claimed_job`` and is lost with the failure, the failure has no
explicit diagnostic code, and there is no authorized way to retry the
evaluation without running the engine again.
"""

from __future__ import annotations

import json

import pytest
from bim_client import BimServiceError

from openbinding_gateway.db.models import JobState
from openbinding_gateway.integrations import bim
from openbinding_gateway.services import execution

from ._helpers import (
    account_with_snapshot,
    answer,
    only_job,
    persisted_anywhere,
    precondition,
    submit,
)

OPEN = pytest.mark.xfail(strict=True, raises=AssertionError)

#: Present only in the engine's raw answer, so finding it means the raw answer was kept.
MARKER = "raw-engine-marker-7f3a"


@pytest.fixture
def bim_down(monkeypatch):
    async def unavailable(self, *_args, **_kwargs):
        raise BimServiceError("service_unavailable", "the service could not be reached (ConnectError)")

    monkeypatch.setattr(bim.AsyncBim, "reevaluate", unavailable)


@pytest.fixture
def engine_answers(monkeypatch):
    async def solve(*_args, **_kwargs):
        return answer(engineRun=MARKER)

    monkeypatch.setattr(execution, "solve_remote", solve)


async def _failed_job(api_client, db_session, registration):
    headers, snapshot_id = await account_with_snapshot(api_client, registration)
    await submit(api_client, headers, snapshot_id)
    job = await only_job(db_session)
    precondition(job.state is JobState.FAILED, f"the job ended {job.state.value}, not failed")
    return headers, job


async def test_an_unevaluated_result_is_never_recorded_as_valid(
    api_client, db_session, registration, bim_down, engine_answers
):
    """Closed: no COMPLETED, no solutions, no termination other than UNKNOWN."""
    _, job = await _failed_job(api_client, db_session, registration)

    assert job.state is JobState.FAILED
    assert job.termination == "UNKNOWN"
    assert job.result["solutions"] == []
    assert MARKER not in json.dumps(job.result)


@OPEN
async def test_a_bim_failure_during_reevaluation_keeps_the_engines_raw_result(
    api_client, db_session, registration, bim_down, engine_answers
):
    """B4 open: ``services/execution.py:335-357`` – the raw answer is only in memory when BIM raises."""
    await _failed_job(api_client, db_session, registration)

    assert await persisted_anywhere(db_session, MARKER)


@OPEN
async def test_a_failed_reevaluation_has_an_explicit_diagnostic_code(
    api_client, db_session, registration, bim_down, engine_answers
):
    """B4 open: the job says ``Execution failed: <exception text>`` and no ``code`` (fail_persisted_job, execution.py:52)."""
    _, job = await _failed_job(api_client, db_session, registration)

    assert job.result.get("code") in {"reevaluation_unavailable", "reevaluation_failed"}


@OPEN
async def test_there_is_an_authorized_way_to_retry_the_evaluation(
    api_client, db_session, registration, bim_down, engine_answers
):
    """B4 open: ``routes/jobs.py`` has cancel and retry (which runs the engine again), nothing re-evaluates."""
    headers, job = await _failed_job(api_client, db_session, registration)

    response = await api_client.post(f"/v1/jobs/{job.id}/reevaluate", headers=headers)

    assert response.status_code in (200, 202)
