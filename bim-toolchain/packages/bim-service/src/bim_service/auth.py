"""Service-to-service authentication: static bearer tokens from a file.

* The file named by ``BIM_SERVICE_TOKENS_FILE`` holds one token per line, one or two of them (two during a
  rotation: the old and the new one are both accepted).  A token has at least 32 printable ASCII characters.
* Tokens are never read from the environment, never logged and compared in constant time.
* Without a valid file the service does not start (fail closed).  ``BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1`` turns
  authentication off, but only when no file is configured at all: a configured file that is wrong is an error
  whatever that flag says.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from pathlib import Path
from typing import Sequence

from .settings import BimServiceSettings, ServiceConfigError

logger = logging.getLogger("bim_service")

MIN_TOKEN_LENGTH = 32
MAX_TOKENS = 2


class Authenticator:
    """Decides whether an ``Authorization`` header carries one of the accepted tokens."""

    def __init__(self, tokens: Sequence[str] = (), *, anonymous: bool = False) -> None:
        # Only fixed-length digests are kept and compared, so neither the comparison nor the stored
        # values depend on the length or the content of a token.
        self._digests = tuple(hashlib.sha256(token.encode("ascii")).digest() for token in tokens)
        self.anonymous = anonymous

    @property
    def token_count(self) -> int:
        return len(self._digests)

    def authorize(self, authorization: bytes | None) -> bool:
        """Whether ``authorization`` (the raw header value) is ``Bearer <accepted token>``."""
        if self.anonymous:
            return True
        if not authorization:
            return False
        scheme, _, presented = authorization.strip().partition(b" ")
        if scheme.lower() != b"bearer" or not presented.strip():
            return False
        probe = hashlib.sha256(presented.strip()).digest()
        accepted = False
        for expected in self._digests:
            # No early exit: every accepted token is compared whatever the outcome of the previous one.
            accepted |= hmac.compare_digest(probe, expected)
        return accepted

    def __repr__(self) -> str:
        return f"Authenticator(tokens={self.token_count}, anonymous={self.anonymous})"


def read_tokens(path: Path) -> list[str]:
    """The tokens of ``path``; :class:`ServiceConfigError` (never mentioning a token) if the file is unusable."""
    try:
        text = path.read_text(encoding="utf-8")
        mode = path.stat().st_mode
    except (OSError, UnicodeDecodeError) as exc:
        raise ServiceConfigError(f"the tokens file {str(path)!r} cannot be read as UTF-8 text") from exc
    if mode & 0o004:
        logger.warning("the tokens file %s is readable by every user of the host", path)
    tokens: list[str] = []
    for number, line in enumerate(text.splitlines(), start=1):
        token = line.strip()
        if not token:
            continue
        if len(token) < MIN_TOKEN_LENGTH:
            raise ServiceConfigError(
                f"line {number} of the tokens file has fewer than {MIN_TOKEN_LENGTH} characters"
            )
        if not all(33 <= ord(character) < 127 for character in token):
            raise ServiceConfigError(f"line {number} of the tokens file has characters other than printable ASCII")
        tokens.append(token)
    if not tokens:
        raise ServiceConfigError("the tokens file holds no token")
    if len(tokens) > MAX_TOKENS:
        raise ServiceConfigError(f"the tokens file holds more than {MAX_TOKENS} tokens")
    if len(set(tokens)) != len(tokens):
        raise ServiceConfigError("the tokens file repeats a token")
    return tokens


def load_authenticator(settings: BimServiceSettings) -> Authenticator:
    """The authenticator the settings call for, or :class:`ServiceConfigError` (fail closed)."""
    if settings.tokens_file:
        tokens = read_tokens(Path(os.fspath(settings.tokens_file)))
        logger.info("bearer authentication enabled with %d token(s)", len(tokens))
        return Authenticator(tokens)
    if settings.allow_anonymous_dev:
        logger.warning(
            "BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1: the service accepts requests WITHOUT authentication; "
            "never use this outside local development"
        )
        return Authenticator(anonymous=True)
    raise ServiceConfigError(
        "BIM_SERVICE_TOKENS_FILE is not set and anonymous access is not enabled: refusing to start "
        "(BIM_SERVICE_ALLOW_ANONYMOUS_DEV=1 is for local development only)"
    )
