"""The first administrator of a SCORETech Identity deployment, by ``sub``.

``BOOTSTRAP_ADMIN_SUB`` names an Identity subject of the configured issuer; that account becomes an administrator
at provisioning or sign-in while no active administrator exists (the rule of ``db/bootstrap.py``). Identity's
own roles never make anybody an administrator; afterwards administrators promote whom they choose.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import Settings
from ....db.models import User, UserRole
from ..domain.claims import IdentityClaims
from . import sessions


async def promote_if_bootstrap(db: AsyncSession, settings: Settings, user: User, claims: IdentityClaims) -> bool:
    sub = (settings.bootstrap_admin_sub or "").strip()
    if settings.auth_provider != "scoretech" or not sub or user.role is UserRole.ADMIN:
        return False
    if claims.issuer != settings.identity_issuer or claims.subject != sub:
        return False
    active_admins = await db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.role == UserRole.ADMIN, User.is_active.is_(True), User.deleted_at.is_(None))
    )
    if active_admins:
        return False
    user.role = UserRole.ADMIN
    sessions.audit(db, "account.admin.bootstrapped", actor=user.id, target=user.id, detail={"basis": "sub"})
    await db.flush()
    return True
