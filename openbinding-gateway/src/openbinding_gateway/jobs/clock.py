"""Which clock decides that a lease has lapsed.

Replicas of the API and the workers run on different hosts, and a lease written
with one host's clock and judged with another's expires early on a host that runs
ahead. On PostgreSQL every timestamp that takes part in a lease or a publication
decision therefore comes from the database: ``now()`` and interval arithmetic
inside the very statement that reads or writes the column, so no process clock is
involved. ``now()`` is the time the transaction started, and every statement
using it runs in a short transaction of its own.

SQLite is a single-process test and development database. There the Python
clock is used, through :func:`utcnow` below, which is the one thing a test
replaces to freeze or move time.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import Float, Interval, cast, func, literal, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from ..db.models import utcnow as _process_utcnow


def utcnow() -> datetime:
    """The process clock; only SQLite ever reads it. Tests replace this function."""
    return _process_utcnow()


def uses_db_clock(session: AsyncSession) -> bool:
    return session.sync_session.get_bind().dialect.name == "postgresql"


def _interval(seconds: float | ColumnElement) -> ColumnElement:
    zero = literal_column("0")
    amount = seconds if isinstance(seconds, ColumnElement) else literal(float(seconds))
    return func.make_interval(zero, zero, zero, zero, zero, zero, cast(amount, Float), type_=Interval)


def now(session: AsyncSession) -> datetime | ColumnElement:
    """The current time, as something a statement can compare or store."""
    return func.now() if uses_db_clock(session) else utcnow()


def after(
    session: AsyncSession,
    seconds: float | ColumnElement,
    *,
    since: datetime | ColumnElement | None = None,
) -> datetime | ColumnElement:
    """``seconds`` (a number or an SQL expression) after ``since``, by default the current time.

    Pass the ``now(session)`` already used in the same statement as ``since`` so
    that two columns written together are exactly ``seconds`` apart.
    """
    base = now(session) if since is None else since
    if uses_db_clock(session):
        return base + _interval(seconds)
    if isinstance(seconds, ColumnElement):
        raise TypeError("an SQL expression of seconds needs the database clock")
    return base + timedelta(seconds=seconds)


def before(session: AsyncSession, seconds: float) -> datetime | ColumnElement:
    """The current time minus ``seconds``."""
    return after(session, -seconds)


async def read_now(session: AsyncSession) -> datetime:
    """The current time as a value, for the decisions that are made in Python.

    On PostgreSQL this asks the database, so even a decision taken in the process
    is taken against the database's clock; the statement that acts on it checks
    the condition again in SQL.
    """
    if uses_db_clock(session):
        return (await session.execute(select(func.now()))).scalar_one()
    return utcnow()
