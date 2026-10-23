#!/usr/bin/env python3
"""Give a fresh installation somebody who can administer it.

Registration is open and produces ordinary users, so a brand-new deployment
has no administrator and no way to acquire one: promoting an account is itself
an administrator's privilege. This breaks that circle.

    python tools/seed_admin.py

It does nothing unless the database has **no accounts at all**, so it cannot
take over an installation that is in use, and running it twice is harmless.

The account it creates is `admin`. Its password is BOOTSTRAP_ADMIN_PASSWORD when
that is set (and then it is not printed); otherwise a random one is generated
and shown once, here, in the terminal. There is no built-in password. Sign in,
create a real administrator, and deactivate this account. Anything longer-lived
should be configured instead, with BOOTSTRAP_ADMIN_USERNAME and
BOOTSTRAP_ADMIN_PASSWORD, which the gateway applies at startup.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from openbinding_gateway.core.settings import get_settings  # noqa: E402
from openbinding_gateway.db.base import dispose_engine, init_engine, session_factory  # noqa: E402
from openbinding_gateway.db.bootstrap import (  # noqa: E402
    DEFAULT_ADMIN_USERNAME,
    seed_default_administrator,
)

BANNER = "=" * 68


async def main() -> int:
    # Running this tool is the opt-in; the environment is not asked.
    settings = get_settings().model_copy(update={"seed_default_admin": True})
    database_url = settings.database_url or os.getenv("DATABASE_URL")
    if not database_url:
        print(
            "No DATABASE_URL configured, so there is no database to seed.\n"
            "Set it and try again - the same value the gateway uses.",
            file=sys.stderr,
        )
        return 1

    configured_password = settings.bootstrap_admin_password
    password = configured_password or secrets.token_urlsafe(16)

    init_engine(database_url)
    try:
        async with session_factory()() as session:
            seeded = await seed_default_administrator(session, settings, password)
            await session.commit()
    except Exception as error:  # noqa: BLE001 - the message is the whole point
        print(f"The database could not be seeded: {error}", file=sys.stderr)
        print("Have the migrations been applied? Try: alembic upgrade head", file=sys.stderr)
        return 1
    finally:
        await dispose_engine()

    if not seeded:
        print("Nothing was created: the database already has accounts, or the")
        print("BOOTSTRAP_ADMIN_PASSWORD given is unusable (see the warning above).")
        print("Promote somebody with an existing administrator, or set")
        print("BOOTSTRAP_ADMIN_USERNAME and restart the gateway.")
        return 0

    print(BANNER)
    print("  Created the first administrator.")
    print()
    print(f"      username   {DEFAULT_ADMIN_USERNAME}")
    if configured_password:
        print("      password   the value of BOOTSTRAP_ADMIN_PASSWORD")
    else:
        print(f"      password   {password}")
        print()
        print("  This password is shown once and stored only as a hash.")
    print()
    print("  Sign in, create a real administrator from the admin page, and")
    print("  then deactivate this one.")
    print(BANNER)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
