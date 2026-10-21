from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_two_sessions_are_independent_connections(two_sessions):
    first, second = two_sessions

    assert first is not second
    assert (await first.execute(text("SELECT 1"))).scalar_one() == 1
    assert (await second.execute(text("SELECT 1"))).scalar_one() == 1

    pid_first = (await first.execute(text("SELECT pg_backend_pid()"))).scalar_one()
    pid_second = (await second.execute(text("SELECT pg_backend_pid()"))).scalar_one()
    assert pid_first != pid_second
