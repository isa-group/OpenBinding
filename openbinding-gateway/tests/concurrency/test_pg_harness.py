"""The guard in front of the PostgreSQL tests, checked without a database.

These run in the lab container too (they need nothing but ``_two_sessions``).  The shape of
``compose.pgtest.json`` is checked by ``tests/test_pg_harness.py``, which needs a checkout.
"""

from __future__ import annotations

import pytest

from ._two_sessions import check_test_database_url, require_test_database_url


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+asyncpg://u:p@localhost:5432/test_openbinding",
        "postgresql://u:p@localhost/test",
    ],
)
def test_guard_accepts_postgresql_test_databases(url):
    check_test_database_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "sqlite+aiosqlite:///:memory:",
        "sqlite+aiosqlite:///test.db",
        "mysql+aiomysql://u:p@localhost/test",
        "postgresql+asyncpg://u:p@localhost/openbinding",
        "postgresql+asyncpg://u:p@localhost/",
        "postgresql+asyncpg://u:p@localhost/prod_test",
        "",
        "not a url",
    ],
)
def test_guard_refuses_other_dialects_and_names(url):
    with pytest.raises(ValueError):
        check_test_database_url(url)


def _outcome(monkeypatch, url) -> str:
    if url is None:
        monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    else:
        monkeypatch.setenv("TEST_DATABASE_URL", url)
    try:
        require_test_database_url()
    except pytest.skip.Exception:
        return "skipped"
    except pytest.fail.Exception:
        return "failed"
    return "ok"


def test_unset_variable_skips(monkeypatch):
    assert _outcome(monkeypatch, None) == "skipped"


@pytest.mark.parametrize(
    "url", ["sqlite+aiosqlite:///:memory:", "postgresql+asyncpg://u:p@h/openbinding", ""]
)
def test_defined_but_unusable_variable_fails_rather_than_skips(monkeypatch, url):
    assert _outcome(monkeypatch, url) == "failed"


def test_defined_and_valid_variable_passes(monkeypatch):
    assert _outcome(monkeypatch, "postgresql+asyncpg://u:p@h/test_x") == "ok"
