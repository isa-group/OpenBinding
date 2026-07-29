"""Making sure a gateway with accounts has somebody who can administer it.

Registration is open, and everybody who registers is an ordinary user. Without
this, a fresh deployment has no administrator and no way to acquire one:
promoting an account is an administrator's privilege, so the first one cannot
be created through the API at all. Somebody would have to reach into the
database, which is precisely the thing an administration API exists to avoid.

So the first administrator is seeded from configuration, once, at startup:

    BOOTSTRAP_ADMIN_USERNAME=alice
    BOOTSTRAP_ADMIN_EMAIL=alice@example.org
    BOOTSTRAP_ADMIN_PASSWORD=...

If that account already exists it is promoted rather than recreated, so an
administrator who registered normally can be granted the role by restarting
with their username set. And nothing happens at all once any administrator
exists, so leaving the variables in place is harmless.
"""

from __future__ import annotations

import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import Settings
from ..security.passwords import hash_password, password_complaint
from .models import Plan, User, UserRole

logger = logging.getLogger(__name__)


async def ensure_administrator(session: AsyncSession, settings: Settings) -> bool:
    """Seed or promote the configured administrator. Returns whether anything changed."""
    username = (settings.bootstrap_admin_username or "").strip()
    if not username:
        return False

    existing_admins = await session.scalar(
        select(func.count()).select_from(User).where(User.role == UserRole.ADMIN)
    )
    if existing_admins:
        return False

    result = await session.execute(select(User).where(User.username == username))
    account = result.scalars().first()

    if account is not None:
        account.role = UserRole.ADMIN
        await session.flush()
        logger.info("Promoted '%s' to administrator", username)
        return True

    password = settings.bootstrap_admin_password
    if not password:
        logger.warning(
            "No administrator exists and BOOTSTRAP_ADMIN_PASSWORD is unset, so '%s' "
            "cannot be created. Register that account and restart, or set the password.",
            username,
        )
        return False

    complaint = password_complaint(password)
    if complaint:
        logger.warning("The bootstrap administrator password is unusable: %s", complaint)
        return False

    email = (settings.bootstrap_admin_email or f"{username}@localhost").lower()
    session.add(
        User(
            username=username,
            email=email,
            password_hash=hash_password(password),
            role=UserRole.ADMIN,
            plan_cache=Plan.BASIC,
            # No contract yet; the same reconciliation an ordinary registration
            # relies on will settle it.
            contract_pending=True,
        )
    )
    await session.flush()
    logger.info("Created the first administrator, '%s'", username)
    return True
