"""The closed failures of sign-in. Messages are internal; only ``code`` ever reaches a person."""

from __future__ import annotations

#: The codes the callback may put in ``/authentication?identity_error=`` (docs/ERRORS.md, "redirect codes").
IDENTITY_ERROR_CODES = (
    "signin_failed",
    "account_not_linked",
    "access_denied",
    "unavailable",
    "expired",
    "account_disabled",
)


class IdentityError(Exception):
    """A sign-in failure with a closed ``code``. Never carries a token, a code or a secret."""

    code = "signin_failed"

    def __init__(self, code: str | None = None, message: str = "") -> None:
        if code is not None:
            self.code = code
        super().__init__(message or self.code)


class IdentityUnavailable(IdentityError):
    """Identity could not be reached or answered something unusable (timeouts, 5xx, a malformed answer)."""

    code = "unavailable"


class IdentityEnded(IdentityError):
    """Identity says the session is over (``invalid_grant`` at the token endpoint)."""

    code = "session_ended"


class TokenRejected(IdentityError):
    """A token failed verification (signature, issuer, audience, nonce, …); ``code`` is ``signin_failed``."""

    code = "signin_failed"


class PermissionMissing(IdentityError):
    """The access token lacks the permission OpenBinding requires (``SCORETECH_IDENTITY_REQUIRED_PERMISSION``)."""

    code = "access_denied"
