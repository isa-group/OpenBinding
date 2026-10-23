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

Separately, ``SEED_DEFAULT_ADMIN=true`` opts an installation with no accounts at
all into an ``admin`` account whose password is ``BOOTSTRAP_ADMIN_PASSWORD``.
No password is built in, and without the opt-in nothing is seeded.

The bootstrap writes accounts only. It reads no pricing and chooses no plan
from one: the administrator's plan is ``BOOTSTRAP_ADMIN_PLAN`` when configured;
otherwise the account is created without a plan and SPACE assigns the
contract's.
"""

from __future__ import annotations

import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.settings import Settings, get_settings
from ..security.passwords import hash_password, password_complaint
from .models import User, UserRole

logger = logging.getLogger(__name__)

#: The name of the account an opted-in, empty installation gets. There is no
#: built-in password: it comes from the operator.
DEFAULT_ADMIN_USERNAME = "admin"


def operational_plan(settings: Settings | None = None) -> str:
    """The plan of the bootstrap administrator: ``BOOTSTRAP_ADMIN_PLAN``, else none (``""``)."""
    return ((settings or get_settings()).bootstrap_admin_plan or "").strip()


async def ensure_administrator(session: AsyncSession, settings: Settings) -> bool:
    """Seed or promote the configured administrator. Returns whether anything changed."""
    username = (settings.bootstrap_admin_username or "").strip()
    if not username:
        return False
    plan = operational_plan(settings)

    result = await session.execute(select(User).where(User.username == username))
    account = result.scalars().first()

    # Keep the configured bootstrap administrator on the plan required by the
    # deployment, even when the account predates SPACE. Without a configured
    # plan the account's current one is left alone.
    if account is not None and account.role is UserRole.ADMIN:
        if not plan:
            return False
        changed = account.plan_cache != plan
        account.plan_cache = plan
        if changed:
            account.contract_pending = True
            await session.flush()
            logger.info("Kept '%s' on the %s plan", username, plan)
        return changed

    existing_admins = await session.scalar(
        select(func.count()).select_from(User).where(User.role == UserRole.ADMIN)
    )
    if existing_admins:
        return False

    if account is not None:
        account.role = UserRole.ADMIN
        if plan:
            account.plan_cache = plan
        account.contract_pending = True
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

    # `example.org` rather than `localhost`: the API models validate emails,
    # and a domain without a dot is rejected - which turned the whole user
    # listing into a 500 the first time such an account appeared in it.
    email = (settings.bootstrap_admin_email or f"{username}@example.org").lower()
    session.add(_administrator(username, email, password, plan))
    await session.flush()
    logger.info("Created the first administrator, '%s'", username)
    return True


def _administrator(username: str, email: str, password: str, plan: str) -> User:
    """The configured administrator, on ``plan`` (empty: SPACE assigns it)."""
    return User(
        username=username,
        email=email,
        password_hash=hash_password(password),
        role=UserRole.ADMIN,
        plan_cache=plan,
        # No contract yet; the same reconciliation an ordinary registration
        # relies on will settle it.
        contract_pending=True,
    )


async def seed_default_administrator(
    session: AsyncSession, settings: Settings | None = None, password: str | None = None
) -> bool:
    """Give an empty database its first ``admin`` account. Returns whether it did.

    Two conditions, both required. The operator opted in
    (``settings.seed_default_admin``, ``SEED_DEFAULT_ADMIN``), and there are
    **no accounts at all**, so this can never take over an installation that is
    in use - not even one whose administrators have all been deactivated, which
    is a situation that wants a human rather than a surprise account.

    The password is ``password`` or else ``BOOTSTRAP_ADMIN_PASSWORD``; there is
    no built-in one. Without it, or if it fails ``password_complaint``, nothing
    is created. The warning never includes the password.
    """
    settings = settings or get_settings()
    if not settings.seed_default_admin:
        return False

    any_user = await session.scalar(select(func.count()).select_from(User))
    if any_user:
        return False

    if password is None:
        password = settings.bootstrap_admin_password
    if not password:
        logger.warning(
            "SEED_DEFAULT_ADMIN is set but no password was given, so '%s' was not "
            "created. Set BOOTSTRAP_ADMIN_PASSWORD.",
            DEFAULT_ADMIN_USERNAME,
        )
        return False
    complaint = password_complaint(password)
    if complaint:
        logger.warning(
            "SEED_DEFAULT_ADMIN is set but the password is unusable, so '%s' was not "
            "created: %s",
            DEFAULT_ADMIN_USERNAME,
            complaint,
        )
        return False

    session.add(_administrator(
        DEFAULT_ADMIN_USERNAME,
        f"{DEFAULT_ADMIN_USERNAME}@example.org",
        password,
        operational_plan(settings),
    ))
    await session.flush()
    return True
