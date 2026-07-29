"""The database connection, and the declarative base every table hangs off.

The gateway ran for its whole life without a database - jobs lived in a dict
that a restart emptied - so nothing here can be assumed to exist. The engine is
created when the application starts and disposed when it stops, and everything
that needs a session asks for one through ``get_session``, which is what makes
the tests able to hand out a SQLite session instead.

The naming convention on the metadata is not decoration: without it Alembic
invents constraint names, and a migration that has to drop a constraint on
SQLite - where dropping means rebuilding the table - cannot find it again.
"""

from __future__ import annotations

from typing import AsyncIterator, Optional

from sqlalchemy import MetaData
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Declarative base for every table the gateway owns."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


_engine: Optional[AsyncEngine] = None
_sessionmaker: Optional[async_sessionmaker[AsyncSession]] = None


def init_engine(database_url: str, *, echo: bool = False) -> AsyncEngine:
    """Open the connection pool. Called once, from the application's lifespan."""
    global _engine, _sessionmaker

    _engine = create_async_engine(database_url, echo=echo, pool_pre_ping=True)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def dispose_engine() -> None:
    """Close the connection pool. Called once, when the application stops."""
    global _engine, _sessionmaker

    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


def is_configured() -> bool:
    """Whether a database has been opened.

    Endpoints that need one can then say so plainly instead of failing on a
    ``None`` several frames deeper.
    """
    return _sessionmaker is not None


def session_factory() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        raise RuntimeError(
            "No database configured. Set DATABASE_URL to enable the accounts module."
        )
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding a session that commits or rolls back with the request."""
    async with session_factory()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
