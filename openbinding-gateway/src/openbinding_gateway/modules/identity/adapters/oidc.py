"""The SCORETech Identity OIDC client: discovery, keys, the token endpoint and RS256-only verification.

Adapted from SPHERE's ``ScoretechIdentityService`` (``api/src/main/services/ScoretechIdentityService.ts``,
discovery, grant and verify; SCORELabUS/SPHERE@73779a8a, MIT, "Copyright (c) 2024 Alejandro García
Fernández"), stricter where SPHERE is lax:

- every request goes through ``core.outbound`` (pinned address, no proxy, no redirect, size cap); the
  transport URL (labs) replaces only the issuer prefix, and every endpoint must lie under ``issuer + "/"``;
- discovery must name exactly the configured issuer and is cached an hour, failures are not cached;
- keys come only from discovery's ``jwks_uri``: ``kty=RSA``, ``use=sig`` (or absent), a ``kid``, ``alg``
  absent or ``RS256``; an unknown ``kid`` refetches at most once per 30 s, cached keys serve up to an hour when
  a refetch fails;
- ``RS256`` is pinned and checked in the header before any key lookup; ``crit`` is refused;
- both tokens are checked for ``iss``, ``aud`` containing the client and ``azp`` naming it (Identity's managed
  applications add the audience mapper to access tokens), ``typ`` when present, ``exp`` and ``iat`` with 30 s
  of leeway; the ID token for ``nonce`` at login and the same ``sub``; the access token for the permission
  OpenBinding requires.

Errors are the closed ones of ``domain.errors``; nothing here logs a token, a code or the secret.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from urllib.parse import urlencode, urlsplit

import httpx
import jwt

from ....core import outbound
from ....core.settings import Settings
from ..domain.claims import IdentityClaims, TokenSet, display_name_of, email_of, parse_avatar, permissions_of
from ..domain.errors import IdentityEnded, IdentityUnavailable, PermissionMissing, TokenRejected

logger = logging.getLogger(__name__)

ALGORITHM = "RS256"
LEEWAY_S = 30
DISCOVERY_TTL_S = 3600
JWKS_TTL_S = 600
JWKS_STALE_MAX_S = 3600
UNKNOWN_KID_REFETCH_S = 30
MAX_EXPIRES_IN = 86400
MAX_DOCUMENT_BYTES = 256 * 1024

_transport: httpx.AsyncBaseTransport | None = None


def set_identity_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """The transport the Identity client uses when it is built without one (tests install the fake issuer)."""
    global _transport
    _transport = transport


class IdentityOidc:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.issuer = settings.identity_issuer
        self.client_id = settings.scoretech_identity_client_id or ""
        secret = settings.scoretech_identity_client_secret
        self._secret = secret.get_secret_value() if secret else ""
        self.callback_url = settings.identity_callback_url
        self.required_permission = (settings.scoretech_identity_required_permission or "").strip()
        self._prefix = (settings.scoretech_identity_transport_url or "").rstrip("/") or None
        reached = self._prefix or self.issuer
        self._policy = outbound.OutboundPolicy(
            https_only=urlsplit(reached).scheme == "https",
            allow_internal=True,
            max_bytes=MAX_DOCUMENT_BYTES,
            connect_timeout_s=3.0,
            read_timeout_s=10.0,
            total_timeout_s=10.0,
        )
        self._transport = transport
        self._monotonic = monotonic
        self._discovery: tuple[dict, float] | None = None
        self._discovery_lock = asyncio.Lock()
        self._keys: dict[str, jwt.PyJWK] = {}
        self._keys_at: float | None = None
        self._unknown_refetch_at: float | None = None
        self._keys_lock = asyncio.Lock()

    # -- transport --------------------------------------------------------------------------------------------

    def _rewrite(self, url: str) -> str:
        if not isinstance(url, str) or not url.startswith(self.issuer + "/"):
            raise IdentityUnavailable(message="endpoint_off_prefix")
        return self._prefix + url[len(self.issuer):] if self._prefix else url

    def _chosen_transport(self) -> httpx.AsyncBaseTransport | None:
        return self._transport if self._transport is not None else _transport

    async def _get_json(self, url: str) -> dict:
        try:
            response = await outbound.fetch(self._rewrite(url), policy=self._policy, transport=self._chosen_transport())
        except outbound.OutboundError as error:
            logger.info("identity_unavailable reason=%s", error.code)
            raise IdentityUnavailable(message=error.code) from error
        if response.status != 200:
            logger.info("identity_unavailable reason=status_%s", response.status)
            raise IdentityUnavailable(message=f"status_{response.status}")
        try:
            value = json.loads(response.body)
        except ValueError as error:
            raise IdentityUnavailable(message="malformed_json") from error
        if not isinstance(value, dict):
            raise IdentityUnavailable(message="malformed_json")
        return value

    async def _post(self, url: str, form: dict[str, str]) -> outbound.OutboundResponse:
        try:
            return await outbound.post_form(
                self._rewrite(url), form, policy=self._policy, transport=self._chosen_transport()
            )
        except outbound.OutboundError as error:
            logger.info("identity_unavailable reason=%s", error.code)
            raise IdentityUnavailable(message=error.code) from error

    # -- discovery and keys -----------------------------------------------------------------------------------

    async def discovery(self) -> dict:
        cached = self._discovery
        if cached is not None and self._monotonic() - cached[1] < DISCOVERY_TTL_S:
            return cached[0]
        async with self._discovery_lock:
            cached = self._discovery
            if cached is not None and self._monotonic() - cached[1] < DISCOVERY_TTL_S:
                return cached[0]
            value = await self._get_json(self.issuer + "/.well-known/openid-configuration")
            if value.get("issuer") != self.issuer:
                logger.warning("identity_unavailable reason=discovery_issuer_mismatch")
                raise IdentityUnavailable(message="discovery_issuer_mismatch")
            for name in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
                self._rewrite(value.get(name))
            for name in ("end_session_endpoint", "revocation_endpoint"):
                if value.get(name) is not None:
                    self._rewrite(value.get(name))
            self._discovery = (value, self._monotonic())
            return value

    async def _refresh_keys(self) -> None:
        metadata = await self.discovery()
        document = await self._get_json(metadata["jwks_uri"])
        keys: dict[str, jwt.PyJWK] = {}
        for entry in document.get("keys") or []:
            if not isinstance(entry, dict):
                continue
            if entry.get("kty") != "RSA" or entry.get("use", "sig") != "sig" or entry.get("alg", ALGORITHM) != ALGORITHM:
                continue
            kid = entry.get("kid")
            if not isinstance(kid, str) or not kid:
                continue
            try:
                keys[kid] = jwt.PyJWK(entry, algorithm=ALGORITHM)
            except (jwt.PyJWKError, jwt.InvalidKeyError, ValueError, TypeError):
                continue
        self._keys = keys
        self._keys_at = self._monotonic()

    async def _key(self, kid: str) -> jwt.PyJWK:
        async with self._keys_lock:
            now = self._monotonic()
            fresh = False
            if self._keys_at is None or now - self._keys_at >= JWKS_TTL_S:
                try:
                    await self._refresh_keys()
                    fresh = True
                except IdentityUnavailable:
                    if self._keys_at is None or now - self._keys_at >= JWKS_STALE_MAX_S:
                        raise
            key = self._keys.get(kid)
            if key is not None:
                return key
            if fresh:
                self._unknown_refetch_at = now
            elif self._unknown_refetch_at is None or now - self._unknown_refetch_at >= UNKNOWN_KID_REFETCH_S:
                self._unknown_refetch_at = now
                await self._refresh_keys()
                key = self._keys.get(kid)
                if key is not None:
                    return key
            raise TokenRejected(message="unknown_kid")

    # -- browser URL ------------------------------------------------------------------------------------------

    async def authorization_url(self, params: dict[str, str], *, register: bool = False) -> str:
        """The public authorization (or registration) endpoint with ``params``; never rewritten."""
        endpoint = (await self.discovery())["authorization_endpoint"]
        if register:
            endpoint = endpoint[: -len("/auth")] + "/registrations" if endpoint.endswith("/auth") else endpoint
        return f"{endpoint}?{urlencode(params)}"

    # -- token endpoint ---------------------------------------------------------------------------------------

    async def _grant(self, parameters: dict[str, str], *, id_token_required: bool) -> TokenSet:
        metadata = await self.discovery()
        response = await self._post(
            metadata["token_endpoint"],
            {"client_id": self.client_id, "client_secret": self._secret, **parameters},
        )
        try:
            value = json.loads(response.body) if response.body else {}
        except ValueError:
            value = {}
        if not isinstance(value, dict):
            value = {}
        if response.status != 200:
            if value.get("error") == "invalid_grant":
                raise IdentityEnded(message="invalid_grant")
            logger.info("identity_unavailable reason=token_status_%s", response.status)
            raise IdentityUnavailable(message=f"token_status_{response.status}")
        access, refresh, kind = value.get("access_token"), value.get("refresh_token"), value.get("token_type")
        expires_in, id_token = value.get("expires_in"), value.get("id_token")
        refresh_expires = value.get("refresh_expires_in")
        if (
            not isinstance(access, str)
            or not isinstance(refresh, str)
            or not isinstance(kind, str)
            or kind.lower() != "bearer"
            or isinstance(expires_in, bool)
            or not isinstance(expires_in, int)
            or not 0 < expires_in <= MAX_EXPIRES_IN
            or (id_token is not None and not isinstance(id_token, str))
            or (id_token_required and not id_token)
        ):
            logger.info("identity_unavailable reason=incomplete_token_response")
            raise IdentityUnavailable(message="incomplete_token_response")
        if isinstance(refresh_expires, bool) or not isinstance(refresh_expires, int) or refresh_expires <= 0:
            refresh_expires = None
        return TokenSet(
            access_token=access,
            refresh_token=refresh,
            expires_in=expires_in,
            id_token=id_token or None,
            refresh_expires_in=refresh_expires,
        )

    async def exchange_code(self, code: str, verifier: str) -> TokenSet:
        return await self._grant(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.callback_url,
                "code_verifier": verifier,
            },
            id_token_required=True,
        )

    async def refresh(self, refresh_token: str) -> TokenSet:
        return await self._grant(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}, id_token_required=False
        )

    async def revoke(self, refresh_token: str) -> bool:
        """Revoke a refresh token at ``revocation_endpoint``; best effort, ``True`` when Identity accepted it."""
        try:
            metadata = await self.discovery()
            endpoint = metadata.get("revocation_endpoint")
            if not endpoint:
                return False
            response = await self._post(
                endpoint,
                {
                    "client_id": self.client_id,
                    "client_secret": self._secret,
                    "token": refresh_token,
                    "token_type_hint": "refresh_token",
                },
            )
            return response.status == 200
        except IdentityUnavailable as error:
            logger.info("identity_revoke_failed reason=%s", error)
            return False

    async def end_session(self, refresh_token: str) -> bool:
        """End the SSO session behind ``refresh_token`` at ``end_session_endpoint``; best effort."""
        try:
            metadata = await self.discovery()
            endpoint = metadata.get("end_session_endpoint")
            if not endpoint:
                return False
            response = await self._post(
                endpoint,
                {"client_id": self.client_id, "client_secret": self._secret, "refresh_token": refresh_token},
            )
            return response.status in (200, 204)
        except IdentityUnavailable as error:
            logger.info("identity_end_session_failed reason=%s", error)
            return False

    # -- verification -----------------------------------------------------------------------------------------

    async def _decode(self, token: str, *, kind: str) -> dict:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as error:
            raise TokenRejected(message=f"{kind}_malformed") from error
        if header.get("alg") != ALGORITHM:
            raise TokenRejected(message=f"{kind}_algorithm")
        if "crit" in header:
            raise TokenRejected(message=f"{kind}_crit")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise TokenRejected(message=f"{kind}_no_kid")
        key = await self._key(kid)
        try:
            claims = jwt.decode(
                token,
                key.key,
                algorithms=[ALGORITHM],
                issuer=self.issuer,
                leeway=LEEWAY_S,
                options={"require": ["exp", "iat", "iss", "sub"], "verify_aud": False},
            )
        except jwt.InvalidTokenError as error:
            raise TokenRejected(message=f"{kind}_{type(error).__name__}") from error
        iat = claims.get("iat")
        if not isinstance(iat, (int, float)) or iat > time.time() + LEEWAY_S:
            raise TokenRejected(message=f"{kind}_iat")
        audience = claims.get("aud")
        audiences = [audience] if isinstance(audience, str) else audience if isinstance(audience, list) else []
        if self.client_id not in audiences:
            raise TokenRejected(message=f"{kind}_aud")
        azp = claims.get("azp")
        if kind == "access" or azp is not None or len(audiences) > 1:
            if azp != self.client_id:
                raise TokenRejected(message=f"{kind}_azp")
        typ = claims.get("typ")
        expected = "ID" if kind == "id" else "Bearer"
        if typ is not None and typ != expected:
            raise TokenRejected(message=f"{kind}_typ")
        if not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise TokenRejected(message=f"{kind}_sub")
        return claims

    async def verify(
        self, tokens: TokenSet, *, nonce: str | None = None, subject: str | None = None
    ) -> IdentityClaims:
        """The claims OpenBinding keeps, from a verified access token and (when present) ID token.

        Raises ``TokenRejected`` for any check that fails and ``PermissionMissing`` when the access token lacks
        the required permission; both before any account is looked up.
        """
        await self.discovery()
        access = await self._decode(tokens.access_token, kind="access")
        if subject is not None and access["sub"] != subject:
            raise TokenRejected(message="subject_changed")
        profile: dict | None = None
        if tokens.id_token:
            profile = await self._decode(tokens.id_token, kind="id")
            if profile["sub"] != access["sub"]:
                raise TokenRejected(message="id_subject_mismatch")
        if nonce is not None:
            if profile is None or not isinstance(profile.get("nonce"), str) or profile["nonce"] != nonce:
                raise TokenRejected(message="nonce")
        permissions = permissions_of(access)
        if self.required_permission and self.required_permission not in permissions:
            raise PermissionMissing(message="permission_missing")
        if profile is None:
            return IdentityClaims(issuer=self.issuer, subject=access["sub"], permissions=permissions)
        email, verified = email_of(profile)
        return IdentityClaims(
            issuer=self.issuer,
            subject=access["sub"],
            email=email,
            email_verified=verified,
            display_name=display_name_of(profile),
            avatar=parse_avatar(profile.get("scoretech_avatar")),
            permissions=permissions,
            profile_from_id_token=True,
        )
