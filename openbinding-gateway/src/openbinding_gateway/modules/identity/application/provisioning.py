"""First-time SCORETech Identity users, and what follows every sign-in.

Until first-time users can choose a username, an unknown identity is refused (``signin_failed``) and its
Identity session ended.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from ....core.settings import Settings
from ....db.models import User
from ..domain.claims import IdentityClaims, TokenSet


async def start_pending(db: AsyncSession, settings: Settings, claims: IdentityClaims, tokens: TokenSet, *, return_to: str):
    from .flows import Outcome, end_upstream, error_target

    await end_upstream(tokens)
    return Outcome(target=error_target(settings, "signin_failed"))


async def after_sign_in(db: AsyncSession, settings: Settings, user: User, claims: IdentityClaims) -> None:
    """What every Identity sign-in and renewal does after the claims are synchronised."""
    return None
