"""Hashing and checking passwords.

Argon2id rather than bcrypt: bcrypt silently truncates at 72 bytes, which turns
a long passphrase into a shorter one without telling anybody, and argon2 is the
current password-hashing recommendation besides.

``needs_rehash`` is exposed because the parameters below will be raised one day,
and a login is the only moment a plaintext password exists to re-hash with.
"""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

#: Defaults from argon2-cffi, which tracks the RFC 9106 recommendations.
_hasher = PasswordHasher()

#: Long enough to keep a pasted passphrase workable, short enough that nobody
#: can make the hasher chew through a megabyte per login attempt.
MAX_PASSWORD_BYTES = 1024
MIN_PASSWORD_LENGTH = 10


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Whether the password matches, without distinguishing why it did not.

    Every failure mode - wrong password, corrupt hash, a hash from some other
    library - answers the same way, because the caller's only sound response to
    any of them is to refuse the login.
    """
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def password_complaint(password: str) -> str | None:
    """Why this password is unusable, or ``None`` if it is fine.

    Length is the only rule. Composition rules push people towards predictable
    substitutions without buying much, and the upper bound is here to stop a
    request from turning into unbounded hashing work rather than to constrain
    anybody's choice.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters long."
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        return f"Password must be at most {MAX_PASSWORD_BYTES} bytes long."
    return None
