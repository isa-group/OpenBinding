"""Service-to-service authentication: static bearer tokens from a file, each bound to a tenant.

* The file named by ``BIM_SERVICE_TOKENS_FILE`` holds one token per line.  A line is either ``<token>`` (the tenant
  is ``default``) or ``<tenant> <token>``: a tenant label, spaces or tabs, the token.  A tenant has one or two tokens
  (two during its rotation: the old and the new one are both accepted), a token belongs to exactly one tenant and the
  file names at most 64 tenants.  A token has at least 32 printable ASCII characters.
* The tenant bound to the token that authenticated a request is the identity of the caller: the per-tenant share of
  concurrency is keyed by it and never by anything the request says about itself (``X-BIM-Tenant`` is informative).
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
import re
from pathlib import Path
from typing import Sequence, Union

from .settings import BimServiceSettings, ServiceConfigError

logger = logging.getLogger("bim_service")

MIN_TOKEN_LENGTH = 32
MAX_TOKENS_PER_TENANT = 2
MAX_TENANTS = 64
#: Tenant of a line that carries only a token.
DEFAULT_TENANT = "default"
#: Identity of every caller when authentication is off (local development only).
ANONYMOUS_TENANT = "anonymous"
#: What a tenant label looks like, in the tokens file and in the informative ``X-BIM-Tenant`` header.
TENANT_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}")

#: A token (tenant ``default``) or a ``(tenant, token)`` pair.
TokenEntry = Union[str, tuple[str, str]]


def _entry(item: TokenEntry) -> tuple[str, str]:
    return (DEFAULT_TENANT, item) if isinstance(item, str) else item


class Authenticator:
    """Tells which tenant, if any, an ``Authorization`` header authenticates."""

    def __init__(self, tokens: Sequence[TokenEntry] = (), *, anonymous: bool = False) -> None:
        # Only fixed-length digests are kept and compared, so neither the comparison nor the stored
        # values depend on the length or the content of a token.
        self._entries = tuple(
            (tenant, hashlib.sha256(token.encode("ascii")).digest()) for tenant, token in map(_entry, tokens)
        )
        self.anonymous = anonymous

    @property
    def token_count(self) -> int:
        return len(self._entries)

    @property
    def tenant_count(self) -> int:
        """Distinct tenants that can authenticate (1 in anonymous mode)."""
        return 1 if self.anonymous else len({tenant for tenant, _ in self._entries})

    def identify(self, authorization: bytes | None) -> str | None:
        """The tenant bound to the token of ``authorization`` (the raw header value), or ``None`` if it has none."""
        if self.anonymous:
            return ANONYMOUS_TENANT
        if not authorization:
            return None
        scheme, _, presented = authorization.strip().partition(b" ")
        if scheme.lower() != b"bearer" or not presented.strip():
            return None
        probe = hashlib.sha256(presented.strip()).digest()
        identity: str | None = None
        for tenant, expected in self._entries:
            # No early exit: every accepted token is compared whatever the outcome of the previous one.
            if hmac.compare_digest(probe, expected):
                identity = tenant
        return identity

    def __repr__(self) -> str:
        return f"Authenticator(tokens={self.token_count}, tenants={self.tenant_count}, anonymous={self.anonymous})"


def read_tokens(path: Path) -> list[tuple[str, str]]:
    """The ``(tenant, token)`` pairs of ``path``; :class:`ServiceConfigError` if the file is unusable.

    An error names a line number at most: never a token, and no label either (a malformed line may be a token).
    """
    try:
        text = path.read_text(encoding="utf-8")
        mode = path.stat().st_mode
    except (OSError, UnicodeDecodeError) as exc:
        raise ServiceConfigError(f"the tokens file {str(path)!r} cannot be read as UTF-8 text") from exc
    if mode & 0o004:
        logger.warning("the tokens file %s is readable by every user of the host", path)
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()
    per_tenant: dict[str, int] = {}
    for number, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        fields = re.split(r"[ \t]+", line)
        if len(fields) > 2:
            raise ServiceConfigError(f"line {number} of the tokens file is neither '<token>' nor '<tenant> <token>'")
        tenant, token = (DEFAULT_TENANT, fields[0]) if len(fields) == 1 else (fields[0], fields[1])
        if len(fields) == 2 and not TENANT_PATTERN.fullmatch(tenant):
            raise ServiceConfigError(f"line {number} of the tokens file has a tenant label that is not valid")
        if len(token) < MIN_TOKEN_LENGTH:
            raise ServiceConfigError(
                f"line {number} of the tokens file has fewer than {MIN_TOKEN_LENGTH} characters"
            )
        if not all(33 <= ord(character) < 127 for character in token):
            raise ServiceConfigError(f"line {number} of the tokens file has characters other than printable ASCII")
        if token in seen:
            raise ServiceConfigError(
                f"line {number} of the tokens file repeats a token (a token belongs to one tenant only)"
            )
        seen.add(token)
        per_tenant[tenant] = per_tenant.get(tenant, 0) + 1
        if per_tenant[tenant] > MAX_TOKENS_PER_TENANT:
            raise ServiceConfigError(
                f"line {number} of the tokens file gives a tenant more than {MAX_TOKENS_PER_TENANT} tokens"
            )
        if len(per_tenant) > MAX_TENANTS:
            raise ServiceConfigError(f"line {number} of the tokens file names more than {MAX_TENANTS} tenants")
        entries.append((tenant, token))
    if not entries:
        raise ServiceConfigError("the tokens file holds no token")
    return entries


def load_authenticator(settings: BimServiceSettings) -> Authenticator:
    """The authenticator the settings call for, or :class:`ServiceConfigError` (fail closed)."""
    if settings.tokens_file:
        entries = read_tokens(Path(os.fspath(settings.tokens_file)))
        authenticator = Authenticator(entries)
        logger.info(
            "bearer authentication enabled with %d token(s) for %d tenant(s)",
            authenticator.token_count,
            authenticator.tenant_count,
        )
        return authenticator
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
