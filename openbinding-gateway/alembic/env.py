"""Alembic's entry point, wired to the gateway's own configuration.

The database URL comes from ``core.settings`` rather than from ``alembic.ini``,
so a deployment sets ``DATABASE_URL`` once and both the running gateway and its
migrations agree about where they are pointing.

``render_as_batch`` is on because the test database is SQLite, which cannot
alter a column in place: Alembic has to rebuild the table instead, and it only
does that when asked.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy import pool

from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.base import Base
from openbinding_gateway.db import models  # noqa: F401  (imported for its side effect: table registration)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def database_url() -> str:
    url = get_settings().database_url
    if not url:
        raise RuntimeError(
            "No DATABASE_URL configured. Migrations need to know which database to change."
        )
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    config.set_main_option("sqlalchemy.url", database_url())
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
