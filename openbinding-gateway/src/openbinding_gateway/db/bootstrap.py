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

#: The account a brand-new installation gets, so there is somebody who can
#: create a real one. Short and well known on purpose - it is meant to be used
#: once and replaced, in the same spirit as SPACE's own admin/space4all.
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "4dm1n"
#: `example.org` rather than `localhost`: the API models validate emails,
#: and a domain without a dot is rejected - which turned the whole user
#: listing into a 500 the first time this account appeared in it.
DEFAULT_ADMIN_EMAIL = "admin@example.org"


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

    # Same reason as DEFAULT_ADMIN_EMAIL: a domain with no dot fails the
    # email validation every response model applies.
    email = (settings.bootstrap_admin_email or f"{username}@example.org").lower()
    session.add(_administrator(username, email, password))
    await session.flush()
    logger.info("Created the first administrator, '%s'", username)
    return True


def _administrator(username: str, email: str, password: str) -> User:
    return User(
        username=username,
        email=email,
        password_hash=hash_password(password),
        role=UserRole.ADMIN,
        plan_cache=Plan.BASIC,
        # No contract yet; the same reconciliation an ordinary registration
        # relies on will settle it.
        contract_pending=True,
    )


async def seed_default_administrator(session: AsyncSession) -> bool:
    """Give an empty database one throwaway administrator. Returns whether it did.

    Only when there are **no accounts at all**, so this can never take over an
    installation that is in use - not even one whose administrators have all
    been deactivated, which is a situation that wants a human rather than a
    surprise account with a guessable password.

    The credentials are deliberately weak and well known. They exist so that
    somebody can sign in once, create a real administrator, and delete this
    one; they are not a login anybody should keep. ``ensure_administrator``
    is the configured, non-guessable path for a deployment that knows who its
    administrator is up front.
    """
    any_user = await session.scalar(select(func.count()).select_from(User))
    if any_user:
        return False

    session.add(
        _administrator(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD)
    )
    await session.flush()
    return True
