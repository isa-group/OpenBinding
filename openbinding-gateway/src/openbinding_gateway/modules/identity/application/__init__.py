"""What the rest of the gateway reads of identity.

Code outside ``modules/identity`` reaches the module through this package only
(``tests/test_modules_cross_import.py``).
"""

from . import sessions
from .accounts import AccountIdentityFacts, IdentityLink, identity_facts
from .cookies import presented_session, refuse_foreign_origin, set_session_cookie
from .admission import KeyAdmission, owner_may_use_keys
from .research import apply_plan_rule, institutional_email, upgrade_to_research
from .sessions import access_token_for, active_for_token, end_all, open_local, remaining_seconds, session_still_valid
from .config import auth_config_view, managed_by_identity, refuse_outside, requires_provider, startup_warnings
from .provisioning import PSEUDONYM_PREFIX, username_reserved, username_unavailable
from .ports import AccountHook, OidcClient, OneTimeStore, SessionLock
from .stores import (
    IdentityStoreNotConfigured,
    get_account_hook,
    get_lock,
    get_oidc,
    get_store,
    set_account_hook,
    set_lock,
    set_oidc,
    set_store,
)

__all__ = [
    "AccountIdentityFacts",
    "IdentityLink",
    "identity_facts",
    "KeyAdmission",
    "owner_may_use_keys",
    "apply_plan_rule",
    "institutional_email",
    "upgrade_to_research",
    "access_token_for",
    "active_for_token",
    "open_local",
    "presented_session",
    "refuse_foreign_origin",
    "remaining_seconds",
    "set_session_cookie",
    "end_all",
    "session_still_valid",
    "sessions",
    "PSEUDONYM_PREFIX",
    "username_reserved",
    "username_unavailable",
    "IdentityStoreNotConfigured",
    "AccountHook",
    "OidcClient",
    "OneTimeStore",
    "SessionLock",
    "auth_config_view",
    "managed_by_identity",
    "requires_provider",
    "refuse_outside",
    "startup_warnings",
    "get_account_hook",
    "get_lock",
    "get_oidc",
    "get_store",
    "set_account_hook",
    "set_lock",
    "set_oidc",
    "set_store",
]
