"""The run event stream (F6 B7): a ``job`` line when the run changes, a keep-alive comment while it is quiet, the end.

The stream reads the run once a second; here the poll interval is 0 and the run is a script of states, so nothing
sleeps and no database is read after the first lookup.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from openbinding_gateway.db.models import JobState
from openbinding_gateway.modules.execution.adapters import routes

pytestmark = pytest.mark.asyncio


@dataclass
class _Job:
    id: uuid.UUID
    state: JobState
    cancellation_requested: bool = False
    finished_at: datetime | None = None


class _Request:
    async def is_disconnected(self) -> bool:
        return False


def _script(monkeypatch, states: list[JobState], *, session_valid=lambda attempt: True) -> uuid.UUID:
    """The run reads ``states[0]`` at the first lookup, then one state per poll (the last one repeats)."""
    run = uuid.uuid4()
    polls = [0]

    def job(index: int) -> _Job:
        state = states[min(index, len(states) - 1)]
        return _Job(run, state, finished_at=datetime(2026, 11, 21, tzinfo=timezone.utc)
                    if state in (JobState.COMPLETED, JobState.FAILED) else None)

    async def organization(session, org, user):
        return SimpleNamespace(id=uuid.uuid4())

    async def first(session, organization, run_id, user):
        return job(0)

    async def get_in_org(session, organization_id, run_id):
        polls[0] += 1
        return job(polls[0])

    async def still_valid(session, user_id, session_id, *, settings):
        return session_valid(polls[0])

    @asynccontextmanager
    async def poll_session():
        yield None

    monkeypatch.setattr(routes, "_organization", organization)
    monkeypatch.setattr(routes, "_run", first)
    monkeypatch.setattr(routes.job_repository, "get_in_org", get_in_org)
    monkeypatch.setattr(routes, "session_still_valid", still_valid)
    monkeypatch.setattr(routes.db_base, "is_configured", lambda: True)
    monkeypatch.setattr(routes.db_base, "session_factory", lambda: poll_session)
    monkeypatch.setattr(routes, "EVENT_POLL_S", 0)
    return run


async def _lines(run: uuid.UUID, limit: int = 2000) -> list[str]:
    response = await routes.stream_run_events(org="o", run=run, request=_Request(),
                                              user=SimpleNamespace(id=uuid.uuid4()), session=None)
    out: list[str] = []
    async for chunk in response.body_iterator:
        out.append(chunk)
        if len(out) >= limit:
            break
    return out


async def test_a_quiet_run_gets_a_keep_alive_comment_every_fifteen_polls(monkeypatch) -> None:
    run = _script(monkeypatch, [JobState.RUNNING] * 16 + [JobState.COMPLETED])
    lines = await _lines(run)
    assert lines[0].startswith("event: job\n") and '"status":"running"' in lines[0]
    assert lines[1] == ": keep-alive\n\n"
    assert lines[2].startswith("event: job\n") and '"status":"completed"' in lines[2]
    assert len(lines) == 3  # a terminal status ends the stream


async def test_a_change_is_one_job_line_and_resets_the_quiet_count(monkeypatch) -> None:
    run = _script(monkeypatch, [JobState.QUEUED] * 10 + [JobState.RUNNING] * 20 + [JobState.FAILED])
    lines = await _lines(run)
    jobs = [line for line in lines if line.startswith("event: job")]
    keep_alives = [line for line in lines if line == ": keep-alive\n\n"]
    assert ['"status":"queued"' in jobs[0], '"status":"running"' in jobs[1], '"status":"failed"' in jobs[2]] == [True] * 3
    assert len(jobs) == 3
    # Ten quiet polls before the change (no comment), then twenty: one comment at fifteen.
    assert len(keep_alives) == 1
    assert lines.index(keep_alives[0]) == 2


async def test_the_session_check_still_ends_the_stream(monkeypatch) -> None:
    run = _script(monkeypatch, [JobState.RUNNING], session_valid=lambda polls: polls < 29)
    lines = await _lines(run)
    assert lines[-1] == "event: session-ended\ndata: {}\n\n"
    assert lines.count(": keep-alive\n\n") == 1  # at 15 quiet polls, before the check at 30


async def test_the_stream_still_ends_after_nine_hundred_polls(monkeypatch) -> None:
    run = _script(monkeypatch, [JobState.RUNNING])
    lines = await _lines(run)
    assert [line for line in lines if line.startswith("event:")] == [lines[0]]
    assert lines.count(": keep-alive\n\n") == 59  # 899 quiet polls after the first line
