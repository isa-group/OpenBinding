"""No PostgreSQL test may skip for a reason other than the missing ``TEST_DATABASE_URL``.

The compose-shape checks once skipped in the lab run because they looked for ``compose.pgtest.json``
inside the image; they now live in ``tests/test_pg_harness.py``.  This keeps such a skip from coming back
here, and runs in the container too (it reads only this directory).
"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent


def test_the_only_skip_in_this_directory_is_the_missing_database_url():
    offenders = [
        path.name
        for path in HERE.glob("*.py")
        if path.name not in {"_two_sessions.py", Path(__file__).name}
        and "pytest.skip(" in path.read_text(encoding="utf-8")
    ]
    assert not offenders, offenders
    assert "TEST_DATABASE_URL" in (HERE / "_two_sessions.py").read_text(encoding="utf-8")
