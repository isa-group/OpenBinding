"""What the rest of the gateway reads of identity.

Code outside ``modules/identity`` reaches the module through this package only
(``tests/test_modules_cross_import.py``).
"""

from . import sessions
from .admission import KeyAdmission, owner_may_use_keys
from .research import apply_plan_rule, institutional_email, upgrade_to_research
from .sessions import active_for_token, end_all, session_still_valid
from .config import auth_config_view, managed_by_identity, refuse_outside, requires_provider, startup_warnings
from .provisioning import PSEUDONYM_PREFIX, username_reserved, username_unavailable
from .ports import OidcClient, OneTimeStore, SessionLock
from .stores import IdentityStoreNotConfigured, get_lock, get_oidc, get_store, set_lock, set_oidc, set_store

__all__ = [
    "KeyAdmission",
    "owner_may_use_keys",
    "apply_plan_rule",
    "institutional_email",
    "upgrade_to_research",
    "active_for_token",
    "end_all",
    "session_still_valid",
    "sessions",
    "PSEUDONYM_PREFIX",
    "username_reserved",
    "username_unavailable",
    "IdentityStoreNotConfigured",
    "OidcClient",
    "OneTimeStore",
    "SessionLock",
    "auth_config_view",
    "managed_by_identity",
    "requires_provider",
    "refuse_outside",
    "startup_warnings",
    "get_lock",
    "get_oidc",
    "get_store",
    "set_lock",
    "set_oidc",
    "set_store",
]
