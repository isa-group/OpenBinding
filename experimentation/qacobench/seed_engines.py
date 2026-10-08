#!/usr/bin/env python3
"""Register the three benchmark engines in a fresh, isolated gateway database."""

from __future__ import annotations

import asyncio
import os
import sys

from sqlalchemy import select

from openbinding_gateway.db import base
from openbinding_gateway.db.models import User, UserRole

sys.path.insert(0, "/app/tools")
from seed_dev import ensure_engine_revisions  # noqa: E402


async def main() -> None:
    base.init_engine(os.environ["DATABASE_URL"])
    try:
        async with base.session_factory()() as session:
            admin = await session.scalar(select(User).where(User.role == UserRole.ADMIN))
            if admin is None:
                raise RuntimeError("gateway administrator has not been bootstrapped")
            revisions = await ensure_engine_revisions(session, admin)
            expected = {"minizinc-csp", "random-search", "evolutionary-heuristics"}
            found = {revision.name for revision in revisions}
            if not expected <= found:
                raise RuntimeError(f"missing benchmark engine registrations: {sorted(expected - found)}")
            print(f"registered benchmark engines: {', '.join(sorted(expected))}")
    finally:
        await base.dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
