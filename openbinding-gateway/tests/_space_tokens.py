"""Pricing tokens for SPACE client doubles whose subject is not the verification itself.

The gateway believes a pricing token only after ``features.verify_pricing_token`` (SPACE's
JWKS) and its own check that the token names the account. The doubles here stand in for a
SPACE that verified the token: they decode it unverified and, when it names nobody, name
the account the token was asked for. ``tests/test_pricing_token_jwks.py`` exercises the
real verification with ES256 keys.
"""

from __future__ import annotations

from space_client.types.pricing_token import PricingTokenPayload, decode_pricing_token

#: The SPACE organization the doubles' tokens are issued for (``SPACE_ORGANIZATION_ID``).
ORGANIZATION = "org-test"


def trusted_payload(token: str, user_id: object) -> PricingTokenPayload:
    """The payload of ``token`` as a verified one, issued for ``user_id`` unless it names someone."""
    payload = decode_pricing_token(str(token))
    if payload.user_id is None and payload.sub is None:
        payload.user_id = str(user_id)
    return payload
