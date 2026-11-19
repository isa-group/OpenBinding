"""An in-process SCORETech Identity for the tests: discovery, keys, the token endpoint, revoke and logout.

An ``httpx.MockTransport`` handler (it opens no socket) with RSA keys from ``cryptography`` and tokens signed
with PyJWT, after SPHERE's unit fixture (``api/src/test/unit-tests/scoretech-identity.test.ts``). Its tokens
take the shapes Identity's ``tentu-authentication-policy`` mapper leaves: **access tokens carry protocol claims
only** (``iss``, ``sub``, ``aud``, ``azp``, ``typ``, ``exp``, ``iat``, ``scope``, ``realm_access``); **ID tokens**
carry ``email``, ``email_verified`` (a boolean), ``name``, ``scoretech_display_name`` and ``scoretech_avatar`` in
Identity's shapes, and always ``roles: ["administrador"]``, so "Identity roles never make an administrator" is
tested everywhere.

``core.outbound`` resolves and pins every host before a transport sees the request, so ``install`` scripts
``socket.getaddrinfo`` for exactly the fake's two hosts (``identity.test``, the issuer, and ``keycloak.test``,
the transport) and the handler routes by ``Host`` and path. ``switches`` turn on the failure modes.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import socket
import time
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from ._settings import CLIENT_ID, CLIENT_SECRET, ISSUER

HOSTS = {"identity.test": "10.20.0.10", "keycloak.test": "10.20.0.11"}
REALM_PATH = urlsplit(ISSUER).path


def _rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


_KEYS = {"k1": _rsa_key(), "k2": _rsa_key(), "enc1": _rsa_key()}


def _jwk(kid: str, use: str, alg: str | None) -> dict:
    numbers = _KEYS[kid].public_key().public_numbers()

    def b64(value: int) -> str:
        raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    entry = {"kty": "RSA", "kid": kid, "use": use, "n": b64(numbers.n), "e": b64(numbers.e)}
    if alg:
        entry["alg"] = alg
    return entry


@dataclass
class FakeUser:
    sub: str
    email: str | None = "person@example.invalid"
    email_verified: bool = True
    first_name: str = "Walk"
    last_name: str = "Member"
    display_name: str = "Walk Member"
    avatar: dict | None = field(
        default_factory=lambda: {"kind": "initials", "backgroundColor": "graphite", "foregroundColor": "paper"}
    )
    roles: list[str] = field(default_factory=lambda: ["openbinding:access", "default-roles-score"])


@dataclass
class FakeIssuer:
    issuer: str = ISSUER
    client_id: str = CLIENT_ID
    client_secret: str = CLIENT_SECRET
    access_ttl: int = 300
    switches: set = field(default_factory=set)
    slow_seconds: float = 0.0
    rotated: bool = False
    users: dict = field(default_factory=dict)
    codes: dict = field(default_factory=dict)
    refresh_tokens: dict = field(default_factory=dict)
    grants: list = field(default_factory=list)
    revoked: list = field(default_factory=list)
    logouts: list = field(default_factory=list)
    jwks_fetches: int = 0
    requests: list = field(default_factory=list)
    signing_kid: str = "k1"

    # -- the browser side -----------------------------------------------------------------------------------

    def user(self, sub: str | None = None, **values) -> FakeUser:
        person = FakeUser(sub=sub or f"sub-{secrets.token_hex(6)}", **values)
        self.users[person.sub] = person
        return person

    def authorize(self, location: str, user: FakeUser) -> dict:
        """What Identity's login page does with an authorization URL: the callback query (``state``, ``code``)."""
        query = {key: values[0] for key, values in parse_qs(urlsplit(location).query).items()}
        assert query["client_id"] == self.client_id
        assert query["response_type"] == "code"
        assert query["code_challenge_method"] == "S256"
        code = secrets.token_urlsafe(24)
        self.codes[code] = {
            "user": user.sub,
            "redirect_uri": query["redirect_uri"],
            "challenge": query["code_challenge"],
            "nonce": query["nonce"],
        }
        return {"state": query["state"], "code": code, "iss": self.issuer}

    def end_sso(self, sub: str) -> None:
        """The person signed out of Identity elsewhere: every refresh token of theirs is dead."""
        for entry in self.refresh_tokens.values():
            if entry["user"] == sub:
                entry["active"] = False

    # -- tokens -----------------------------------------------------------------------------------------------

    def _sign(self, claims: dict, *, kind: str) -> str:
        headers = {"kid": self.signing_kid}
        if "no_kid" in self.switches:
            headers = {}
        if "rotated_kid" in self.switches:
            headers = {"kid": "k2"}
        if "enc_key_signed" in self.switches:
            return jwt.encode(claims, _KEYS["enc1"], algorithm="RS256", headers={"kid": "enc1"})
        if "alg_none" in self.switches:
            return jwt.encode(claims, None, algorithm="none", headers={"kid": "k1"})
        if "alg_hs256_secret" in self.switches:
            return jwt.encode(claims, self.client_secret, algorithm="HS256", headers={"kid": "k1"})
        if "alg_hs256_pubkey" in self.switches:
            pem = _jwk("k1", "sig", "RS256")["n"].encode()
            return jwt.encode(claims, pem, algorithm="HS256", headers={"kid": "k1"})
        key = _KEYS["k2"] if "rotated_kid" in self.switches else _KEYS[self.signing_kid]
        return jwt.encode(claims, key, algorithm="RS256", headers=headers)

    def _tokens(self, user: FakeUser, *, nonce: str | None, with_id: bool) -> dict:
        now = int(time.time())
        if "expired" in self.switches:
            now -= self.access_ttl + 60
        iat = now + 120 if "iat_future" in self.switches else now
        issuer = "https://wrong.test/realms/score" if "wrong_iss" in self.switches else self.issuer
        audience: object = ["someone-else"] if "wrong_aud" in self.switches else [self.client_id]
        azp = "someone-else" if "wrong_azp" in self.switches else self.client_id
        roles = [r for r in user.roles if r != "openbinding:access"] if "no_permission" in self.switches else user.roles
        access = {
            "iss": issuer,
            "sub": user.sub,
            "aud": audience,
            "azp": azp,
            "typ": "Bearer",
            "exp": now + self.access_ttl,
            "iat": iat,
            "scope": "openid profile email",
            "realm_access": {"roles": list(roles)},
        }
        if "access_has_email" in self.switches:
            access.update(email="leak@example.invalid", email_verified=True, scoretech_display_name="Leaked")
        refresh = secrets.token_urlsafe(32)
        self.refresh_tokens[refresh] = {"user": user.sub, "active": True, "used": False}
        body = {
            "access_token": self._sign(access, kind="access"),
            "refresh_token": refresh,
            "token_type": "Bearer",
            "expires_in": self.access_ttl,
            "refresh_expires_in": 43200,
        }
        if with_id and "refresh_without_id_token" not in self.switches or (with_id and nonce is not None):
            id_claims = {
                "iss": issuer,
                "sub": "someone-else" if "sub_mismatch" in self.switches else user.sub,
                "aud": [self.client_id, "another-app"] if "multi_aud_without_azp" in self.switches else self.client_id,
                "typ": "Access" if "id_typ_wrong" in self.switches else "ID",
                "exp": now + self.access_ttl,
                "iat": iat,
                "name": f"{user.first_name} {user.last_name}",
                "scoretech_display_name": user.display_name,
                "roles": ["administrador"],
                "scoretech_bio": "a bio that must never be stored",
                "phone_number": "+34600000000",
            }
            if "multi_aud_without_azp" not in self.switches:
                id_claims["azp"] = azp
            if nonce is not None:
                id_claims["nonce"] = "not-the-nonce" if "bad_nonce" in self.switches else nonce
            if user.email is not None and "no_email" not in self.switches:
                id_claims["email"] = user.email
                verified: object = user.email_verified and "email_unverified" not in self.switches
                if "email_verified_string" in self.switches:
                    verified = "true"
                id_claims["email_verified"] = verified
            if user.avatar is not None:
                id_claims["scoretech_avatar"] = user.avatar
            body["id_token"] = self._sign(id_claims, kind="id")
        return body

    # -- the HTTP side ----------------------------------------------------------------------------------------

    def discovery(self) -> dict:
        issuer = "https://evil.test/realms/score" if "discovery_issuer_mismatch" in self.switches else self.issuer
        token = "https://elsewhere.test/token" if "endpoint_off_prefix" in self.switches else f"{self.issuer}/protocol/openid-connect/token"
        return {
            "issuer": issuer,
            "authorization_endpoint": f"{self.issuer}/protocol/openid-connect/auth",
            "token_endpoint": token,
            "jwks_uri": f"{self.issuer}/protocol/openid-connect/certs",
            "end_session_endpoint": f"{self.issuer}/protocol/openid-connect/logout",
            "revocation_endpoint": f"{self.issuer}/protocol/openid-connect/revoke",
            "id_token_signing_alg_values_supported": ["HS256", "RS256", "ES256", "EdDSA"],
            "authorization_response_iss_parameter_supported": True,
        }

    def jwks(self) -> dict:
        keys = [_jwk("k1", "sig", "RS256"), _jwk("enc1", "enc", "RSA-OAEP")]
        if self.rotated:
            keys.append(_jwk("k2", "sig", "RS256"))
        return {"keys": keys}

    def _form(self, request: httpx.Request) -> dict:
        return {key: values[0] for key, values in parse_qs(request.content.decode()).items()}

    def _client_ok(self, form: dict) -> bool:
        return form.get("client_id") == self.client_id and form.get("client_secret") == self.client_secret

    def _token_endpoint(self, form: dict) -> httpx.Response:
        if not self._client_ok(form):
            return httpx.Response(401, json={"error": "invalid_client"})
        grant = form.get("grant_type")
        if grant == "authorization_code":
            entry = self.codes.pop(form.get("code", ""), None)
            if entry is None or entry["redirect_uri"] != form.get("redirect_uri"):
                return httpx.Response(400, json={"error": "invalid_grant"})
            verifier = form.get("code_verifier", "")
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            if challenge != entry["challenge"]:
                return httpx.Response(400, json={"error": "invalid_grant"})
            self.grants.append(("authorization_code", entry["user"]))
            return httpx.Response(200, json=self._tokens(self.users[entry["user"]], nonce=entry["nonce"], with_id=True))
        if grant == "refresh_token":
            token = form.get("refresh_token", "")
            entry = self.refresh_tokens.get(token)
            self.grants.append(("refresh_token", entry["user"] if entry else None))
            if entry is None or not entry["active"] or "revoked" in self.switches:
                return httpx.Response(400, json={"error": "invalid_grant"})
            if entry["used"]:
                # Keycloak with refresh-token reuse 0: a second use fails and ends the session.
                self.end_sso(entry["user"])
                self.reused = getattr(self, "reused", 0) + 1
                return httpx.Response(400, json={"error": "invalid_grant"})
            entry["used"] = True
            return httpx.Response(200, json=self._tokens(self.users[entry["user"]], nonce=None, with_id=True))
        return httpx.Response(400, json={"error": "unsupported_grant_type"})

    async def handle(self, request: httpx.Request) -> httpx.Response:
        host = request.headers.get("host", "")
        self.requests.append((request.method, host, request.url.path))
        if host not in HOSTS:
            return httpx.Response(404)
        if "down" in self.switches:
            return httpx.Response(503, json={"error": "temporarily_unavailable"})
        if self.slow_seconds:
            import asyncio

            await asyncio.sleep(self.slow_seconds)
        path = request.url.path
        if not path.startswith(REALM_PATH):
            return httpx.Response(404)
        rest = path[len(REALM_PATH):]
        if rest == "/.well-known/openid-configuration" and request.method == "GET":
            return httpx.Response(200, json=self.discovery())
        if rest == "/protocol/openid-connect/certs" and request.method == "GET":
            self.jwks_fetches += 1
            if "redirecting_jwks" in self.switches:
                return httpx.Response(302, headers={"location": f"{self.issuer}/elsewhere"})
            return httpx.Response(200, json=self.jwks())
        form = self._form(request) if request.method == "POST" else {}
        if rest == "/protocol/openid-connect/token":
            return self._token_endpoint(form)
        if rest == "/protocol/openid-connect/revoke":
            if not self._client_ok(form):
                return httpx.Response(401, json={"error": "invalid_client"})
            self.revoked.append(form.get("token"))
            entry = self.refresh_tokens.get(form.get("token", ""))
            if entry:
                entry["active"] = False
            return httpx.Response(200)
        if rest == "/protocol/openid-connect/logout":
            if not self._client_ok(form):
                return httpx.Response(401, json={"error": "invalid_client"})
            token = form.get("refresh_token", "")
            self.logouts.append(token)
            entry = self.refresh_tokens.get(token)
            if entry:
                self.end_sso(entry["user"])
            return httpx.Response(204)
        return httpx.Response(404)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def code_grants(self) -> int:
        return sum(1 for kind, _ in self.grants if kind == "authorization_code")

    def refresh_grants(self) -> int:
        return sum(1 for kind, _ in self.grants if kind == "refresh_token")


def script_dns(monkeypatch) -> None:
    """Resolve the fake's two hosts to fixed private addresses (the Identity policy admits them); others fail."""
    from openbinding_gateway.core import outbound

    guarded = outbound._getaddrinfo

    def resolve(host, port):
        if host in HOSTS:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (HOSTS[host], port))]
        return guarded(host, port)

    monkeypatch.setattr(outbound, "_getaddrinfo", resolve)


def authorization_query(location: str) -> dict:
    return {key: values[0] for key, values in parse_qs(urlsplit(location).query).items()}


def callback_path(query: dict) -> str:
    return f"/v1/auth/identity/callback?{urlencode(query)}"
