"""The reconciler purges old error events at most once an hour."""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest

from openbinding_gateway import analysis_jobs, job_dispatch, sponsor_proposals, telemetry
from openbinding_gateway.db import base as db_base
from openbinding_gateway.jobs import reconciler


class _Session:
    def __init__(self) -> None:
        self.commits = 0

    async def __aenter__(self) -> "_Session":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def commit(self) -> None:
        self.commits += 1


@pytest.fixture
def sweeps(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    state = SimpleNamespace(clock=1000.0, purges=0, sweeps=0, fail=False, remaining=0, sessions=[])

    async def sleep(_: float) -> None:
        if state.remaining <= 0:
            raise asyncio.CancelledError
        state.remaining -= 1

    async def zero(*_: object, **__: object) -> int:
        return 0

    async def zero_lock(*_: object, **__: object) -> bool:
        return True

    async def sweep(*_: object, **__: object) -> int:
        state.sweeps += 1
        return 0

    async def purge(session: object, days: int = 90) -> int:
        assert days == 90
        state.purges += 1
        if state.fail:
            raise RuntimeError("boom")
        return 3

    def factory() -> object:
        def make() -> _Session:
            state.sessions.append(_Session())
            return state.sessions[-1]

        return make

    monkeypatch.setattr(reconciler, "_last_purge", None)
    monkeypatch.setattr(reconciler, "time", SimpleNamespace(monotonic=lambda: state.clock))
    monkeypatch.setattr(reconciler.asyncio, "sleep", sleep)
    monkeypatch.setattr(db_base, "is_configured", lambda: True)
    monkeypatch.setattr(db_base, "session_factory", factory)
    monkeypatch.setattr(reconciler, "acquire_cycle_lock", zero_lock)
    monkeypatch.setattr(reconciler, "sweep_abandoned", sweep)
    monkeypatch.setattr(job_dispatch, "redeliver_queued_jobs", zero)
    monkeypatch.setattr(sponsor_proposals, "sweep_expired", zero)
    monkeypatch.setattr(analysis_jobs, "redeliver_analysis", zero)
    monkeypatch.setattr(telemetry, "purge_old_error_events", purge)
    return state


async def _run(state: SimpleNamespace, sweeps: int) -> None:
    state.remaining = sweeps
    with pytest.raises(asyncio.CancelledError):
        await reconciler.run_reconciler(interval_s=0)


async def test_purge_runs_on_first_sweep_and_not_on_the_next(
    sweeps: SimpleNamespace, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger=reconciler.logger.name):
        await _run(sweeps, 2)
    assert sweeps.sweeps == 2
    assert sweeps.purges == 1
    assert "Purged 3 old error event(s)" in caplog.text


async def test_purge_runs_again_after_an_hour(sweeps: SimpleNamespace) -> None:
    await _run(sweeps, 1)
    sweeps.clock += 3599
    await _run(sweeps, 1)
    assert sweeps.purges == 1
    sweeps.clock += 1
    await _run(sweeps, 1)
    assert sweeps.purges == 2


async def test_purge_failure_does_not_abort_the_sweep(
    sweeps: SimpleNamespace, caplog: pytest.LogCaptureFixture
) -> None:
    sweeps.fail = True
    with caplog.at_level(logging.WARNING, logger=reconciler.logger.name):
        await _run(sweeps, 1)
    assert sweeps.purges == 1
    assert "Purging old error events failed" in caplog.text
    assert "sweep failed" not in caplog.text
    # sessions[0] holds the cycle lock; the sweep itself runs on the next one.
    assert sweeps.sessions[1].commits == 2
