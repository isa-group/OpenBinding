"""What the rest of the gateway reads of identity.

Code outside ``modules/identity`` reaches the module through this package only
(``tests/test_modules_cross_import.py``).
"""

from .config import auth_config_view, refuse_outside, startup_warnings
from .ports import OidcClient, OneTimeStore, SessionLock
from .stores import IdentityStoreNotConfigured, get_lock, get_oidc, get_store, set_lock, set_oidc, set_store

__all__ = [
    "IdentityStoreNotConfigured",
    "OidcClient",
    "OneTimeStore",
    "SessionLock",
    "auth_config_view",
    "refuse_outside",
    "startup_warnings",
    "get_lock",
    "get_oidc",
    "get_store",
    "set_lock",
    "set_oidc",
    "set_store",
]
