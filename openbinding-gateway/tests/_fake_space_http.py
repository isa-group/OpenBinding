"""A SPACE that signs pricing tokens with ES256 and publishes its keys, behind the real client, offline.

``SpacePricingGate`` drives the installed ``space-python-client``; only the client's HTTP
transport is replaced (``httpx.MockTransport``) by ``JwksSpace``, which answers the few
endpoints the gateway uses for pricing: the healthcheck (``X-Space-Capabilities``), the
pricing token, the JWKS, the YAML of a pricing version and the version for new contracts.
The keys are generated per instance; nothing leaves the process.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from _pricing import PRICING_YAML
from _space_tokens import ORGANIZATION
from openbinding_gateway.core.settings import Settings
from openbinding_gateway.space_client import SpacePricingGate
from space_client import AsyncSpaceClient, SpaceConnectionOptions

SERVICE = "openbinding"
VERSION = "0.2.0"
ISSUER = "space"
CAPABILITIES = "pricing-token-jwks,pricing-yaml,contract-version"


def new_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def public_jwk(key: ec.EllipticCurvePrivateKey, kid: str) -> dict[str, Any]:
    jwk = json.loads(ECAlgorithm.to_jwk(key.public_key()))
    return {**jwk, "kid": kid, "alg": "ES256", "use": "sig"}


class JwksSpace:
    """The pricing endpoints of one SPACE, answering as a SPACE with ``pricing-token-jwks`` does."""

    def __init__(self, *, capabilities: str | None = CAPABILITIES, yaml_text: str | None = None):
        self.capabilities = capabilities
        self.key = new_key()
        self.kid = "key-1"
        self.published: list[tuple[str, ec.EllipticCurvePrivateKey]] = [(self.kid, self.key)]
        self.yaml_text = PRICING_YAML.read_text(encoding="utf-8") if yaml_text is None else yaml_text
        self.plan = "FREE"
        self.features = {"runs": True, "studies": True, "federatedEngines": True, "repository": True, "apiAccess": True}
        self.limits: dict[str, Any] = {"maxRunMinutes": 5, "maxConcurrentRuns": 1, "maxApiKeys": 2}
        #: Changes the claims (or replaces the token) before it is handed out: ``(claims, user_id) -> token or None``.
        self.forge: Callable[[dict[str, Any], str], str | None] | None = None
        self.requests: list[httpx.Request] = []

    # -- tokens ---------------------------------------------------------------

    def claims_for(self, user_id: str) -> dict[str, Any]:
        now = int(time.time())
        return {
            "sub": f"urn:space:{ORGANIZATION}:{user_id}",
            "userId": user_id,
            "organizationId": ORGANIZATION,
            "aud": ORGANIZATION,
            "iss": ISSUER,
            "iat": now,
            "exp": now + 900,
            "features": {f"{SERVICE}-{name}": {"eval": value} for name, value in self.features.items()},
            "pricingContext": {
                "features": {f"{SERVICE}-{name}": value for name, value in self.features.items()},
                "usageLimits": {f"{SERVICE}-{name}": value for name, value in self.limits.items()},
            },
            "subscription": {
                "contractedServices": {SERVICE: VERSION},
                "subscriptionPlans": {SERVICE: self.plan},
                "subscriptionAddOns": {},
                "contractVersion": "v1",
            },
        }

    def sign(self, claims: dict[str, Any], *, key: ec.EllipticCurvePrivateKey | None = None, kid: str | None = None) -> str:
        return jwt.encode(claims, key or self.key, algorithm="ES256", headers={"kid": kid or self.kid})

    def token_for(self, user_id: str) -> str:
        claims = self.claims_for(user_id)
        if self.forge is not None:
            forged = self.forge(claims, user_id)
            if forged is not None:
                return forged
        return self.sign(claims)

    def rotate(self) -> None:
        """Sign with a new key and publish it next to the old one (the JWKS is fetched again for it)."""
        self.key, self.kid = new_key(), f"key-{len(self.published) + 1}"
        self.published.append((self.kid, self.key))

    # -- HTTP -----------------------------------------------------------------

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = dict(extra or {})
        if self.capabilities is not None:
            headers["X-Space-Capabilities"] = self.capabilities
        return headers

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/api/v1/healthcheck":
            return httpx.Response(200, json={"message": "Service is up and running!"}, headers=self._headers())
        if path == "/api/v1/.well-known/jwks.json":
            if self.capabilities is None or "pricing-token-jwks" not in self.capabilities:
                return httpx.Response(404, json={"error": "not found"}, headers=self._headers())
            keys = [public_jwk(key, kid) for kid, key in self.published]
            return httpx.Response(
                200, json={"keys": keys}, headers=self._headers({"Cache-Control": "public, max-age=300"})
            )
        if path.startswith("/api/v1/features/") and path.endswith("/pricing-token") and request.method == "POST":
            user_id = path.split("/")[4]
            return httpx.Response(200, json={"pricingToken": self.token_for(user_id)}, headers=self._headers())
        if path == f"/api/v1/services/{SERVICE}/pricings/new-contracts":
            return httpx.Response(
                200,
                json={"version": VERSION, "yamlUrl": f"/services/{SERVICE}/pricings/{VERSION}", "source": "default"},
                headers=self._headers(),
            )
        if path.startswith(f"/api/v1/services/{SERVICE}/pricings/") and request.url.params.get("format") == "yaml":
            return httpx.Response(
                200, text=self.yaml_text, headers=self._headers({"Content-Type": "application/yaml"})
            )
        return httpx.Response(404, json={"error": f"no route for {request.method} {path}"}, headers=self._headers())

    def fetches(self, path: str) -> int:
        return sum(1 for request in self.requests if request.url.path == path)


def settings_for(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "_env_file": None,
        "space_pricing_version": VERSION,
        "space_organization_id": ORGANIZATION,
        "space_token_leeway_s": 0,
    }
    values.update(overrides)
    return Settings(**values)


async def gate_over(space: JwksSpace, settings: Settings | None = None) -> SpacePricingGate:
    """A gate over the real client, whose HTTP goes to ``space``."""
    client = AsyncSpaceClient(SpaceConnectionOptions(url="https://space.invalid", api_key="k"))
    await client._http_client.aclose()
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(space.handle))
    return SpacePricingGate(settings or settings_for(), client=client)


def a_user() -> uuid.UUID:
    return uuid.uuid4()
