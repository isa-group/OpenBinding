"""Orphan API keys: a person's ``obk_`` keys work only while the person still holds an Identity account.

Plan §5. In ``scoretech`` mode a personal key works only while its owner's ``last_identity_refresh_at`` (a sign-in
or a session renewal) is within ``API_KEY_ORPHAN_DAYS``; an account that never signed in with Identity (created in
``local`` mode, or seeded) is refused. The rule hangs off the owner, never off a key: the key rows and their
grants are not touched, and the next sign-in brings the keys back. Environment-owned feed keys (``obe_``) have
no owning person and are outside it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from ....core.settings import Settings
from ....db.models import User, utcnow
from ..domain.rules import key_owner_admitted
from .sessions import as_utc


@dataclass(frozen=True)
class KeyAdmission:
    admitted: bool
    #: When the owner's keys stop (or stopped) working; ``None`` in ``local`` mode.
    suspended_at: datetime | None


def owner_may_use_keys(user: User, *, settings: Settings, now: datetime | None = None) -> KeyAdmission:
    if settings.auth_provider != "scoretech":
        return KeyAdmission(admitted=True, suspended_at=None)
    now = now or utcnow()
    last = as_utc(user.last_identity_refresh_at)
    if last is None:
        return KeyAdmission(admitted=False, suspended_at=as_utc(user.created_at) or now)
    return KeyAdmission(
        admitted=key_owner_admitted(last, now, settings.api_key_orphan_days),
        suspended_at=last + timedelta(days=settings.api_key_orphan_days),
    )
