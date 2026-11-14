"""Pricing tokens are believed only once SPACE's published keys say so, and only for their own account.

``SpacePricingGate`` verifies every token it reads or hands out with
``features.verify_pricing_token`` (ES256 against the JWKS of SPACE, ``exp``, ``iss``,
``aud``/``organizationId``), then checks the account with ``pricing_token_user_id``.
Anything else is ``PricingUnavailable``, which the routes answer as 503
``pricing_unavailable``: there is no unverified fallback. ``JwksSpace`` signs with keys it
generates, behind the real client; nothing leaves the process.
"""

from __future__ import annotations

import base64
import json
import time
import uuid

import jwt
import pytest

from _fake_space_http import JwksSpace, a_user, gate_over, new_key
from openbinding_gateway import space_client
from openbinding_gateway.space_client import PricingUnavailable

JWKS = "/api/v1/.well-known/jwks.json"


def _segment(document: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(document).encode()).decode().rstrip("=")


async def test_a_valid_token_gives_the_plan_its_features_and_limits():
    space = JwksSpace()
    gate = await gate_over(space)
    user = a_user()

    caps = await gate.caps(user)

    assert caps.plan == "FREE"  # from the token's own subscription claim: no contract read
    assert caps.allows("runs") is True
    assert caps.limit("maxRunMinutes") == 5
    assert space.fetches(f"/api/v1/contracts/{user}") == 0
    assert space.fetches(JWKS) == 1


async def test_the_pricing_token_handed_to_the_browser_is_verified_too():
    space = JwksSpace()
    gate = await gate_over(space)
    user = a_user()

    token = await gate.pricing_token(user)

    assert jwt.get_unverified_header(token)["alg"] == "ES256"
    space.forge = _wrong_user(space)
    with pytest.raises(PricingUnavailable):
        await gate.pricing_token(user)


def _tampered(space: JwksSpace):
    def forge(claims, user_id):
        header, _, signature = space.sign(claims).split(".")
        richer = {**claims, "pricingContext": {**claims["pricingContext"], "usageLimits": {"openbinding-maxRunMinutes": 1440}}}
        return f"{header}.{_segment(richer)}.{signature}"
    return forge


def _expired(space: JwksSpace):
    return lambda claims, user_id: space.sign({**claims, "iat": int(time.time()) - 7200, "exp": int(time.time()) - 3600})


def _wrong_audience(space: JwksSpace):
    return lambda claims, user_id: space.sign({**claims, "aud": "another-organization", "organizationId": "another-organization"})


def _wrong_user(space: JwksSpace):
    return lambda claims, user_id: space.sign({**claims, "userId": str(uuid.uuid4())})


def _hs256(space: JwksSpace):
    return lambda claims, user_id: jwt.encode(claims, "a-shared-secret-of-enough-length-1234567890", algorithm="HS256", headers={"kid": space.kid})


def _alg_none(space: JwksSpace):
    return lambda claims, user_id: f"{_segment({'alg': 'none', 'typ': 'JWT', 'kid': space.kid})}.{_segment(claims)}."


def _foreign_key(space: JwksSpace):
    stranger = new_key()
    return lambda claims, user_id: space.sign(claims, key=stranger)


@pytest.mark.parametrize(
    "forgery",
    [_tampered, _expired, _wrong_audience, _wrong_user, _hs256, _alg_none, _foreign_key],
    ids=["tampered", "expired", "wrong-aud", "wrong-userId", "HS256", "alg-none", "foreign-key"],
)
async def test_a_token_that_cannot_be_trusted_is_pricing_unavailable(forgery):
    space = JwksSpace()
    space.forge = forgery(space)
    gate = await gate_over(space)

    with pytest.raises(PricingUnavailable):
        await gate.caps(a_user())
    with pytest.raises(PricingUnavailable):
        await gate.pricing_token(a_user())


async def test_an_unknown_key_id_fetches_the_keys_again_once():
    space = JwksSpace()
    gate = await gate_over(space)
    user = a_user()
    await gate.caps(user)
    assert space.fetches(JWKS) == 1
    # Time passes beyond the client's refetch cooldown; SPACE rotates its signing key meanwhile.
    gate._client.features._verifier._last_fetch -= 60
    space.rotate()

    caps = await gate.caps(user)
    again = await gate.caps(user)

    assert caps.plan == again.plan == "FREE"
    assert space.fetches(JWKS) == 2


async def test_a_space_that_does_not_publish_its_keys_is_pricing_unavailable_not_trusted():
    space = JwksSpace(capabilities="contract-version")
    gate = await gate_over(space)

    with pytest.raises(PricingUnavailable):
        await gate.caps(a_user())
    assert await gate.publishes_token_keys() is False


async def test_without_an_organization_nothing_is_verified():
    from _fake_space_http import settings_for

    space = JwksSpace()
    gate = await gate_over(space, settings_for(space_organization_id=None))

    with pytest.raises(PricingUnavailable, match="SPACE_ORGANIZATION_ID"):
        await gate.caps(a_user())
    assert space.requests == []


# -- Through the API -------------------------------------------------------------


async def _signed_in(client, registration) -> dict[str, str]:
    details = registration()
    created = await client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await client.post(
        "/v1/auth/login", json={"username_or_email": details["username"], "password": details["password"]}
    )
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.mark.parametrize("forgery", [None, _tampered, _wrong_user], ids=["valid", "tampered", "wrong-userId"])
async def test_the_routes_answer_503_pricing_unavailable_for_an_untrusted_token(api_client, registration, forgery):
    space = JwksSpace()
    gate = await gate_over(space)
    previous = space_client.get_gate()
    space_client.set_gate(gate)
    try:
        headers = await _signed_in(api_client, registration)
        if forgery is not None:
            space.forge = forgery(space)

        usage = await api_client.get("/v1/users/me/usage", headers=headers)
        token = await api_client.get("/v1/users/me/pricing-token", headers=headers)
        me = await api_client.get("/v1/users/me", headers=headers)
    finally:
        space_client.set_gate(previous)
        await gate.aclose()

    assert me.status_code == 200, me.text  # the profile never asks SPACE
    if forgery is None:
        assert usage.status_code == 200, usage.text
        assert usage.json()["plan"] == "FREE"
        assert token.status_code == 200, token.text
    else:
        for response in (usage, token):
            assert response.status_code == 503, response.text
            assert response.json()["detail"]["code"] == "pricing_unavailable"
