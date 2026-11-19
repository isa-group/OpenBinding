"""RS256-only verification of SCORETech Identity tokens against the fake issuer (T3-T6, O4, O5)."""

from __future__ import annotations

import time

import jwt
import pytest

from openbinding_gateway.modules.identity.adapters.oidc import IdentityOidc
from openbinding_gateway.modules.identity.domain.claims import TokenSet, parse_avatar
from openbinding_gateway.modules.identity.domain.errors import (
    IdentityEnded,
    IdentityUnavailable,
    PermissionMissing,
    TokenRejected,
)

from ._settings import ISSUER, TRANSPORT, scoretech_settings
from .fake_issuer import _KEYS, FakeIssuer, script_dns


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def issuer(monkeypatch):
    script_dns(monkeypatch)
    return FakeIssuer()


def client_for(fake: FakeIssuer, **overrides) -> IdentityOidc:
    return IdentityOidc(scoretech_settings(**overrides), transport=fake.transport(), monotonic=overrides.pop("clock", None) or time.monotonic)


async def sign_in(fake: FakeIssuer, client: IdentityOidc, user=None) -> tuple[TokenSet, str]:
    user = user or fake.user()
    verifier = "v" * 43
    import base64
    import hashlib

    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    location = await client.authorization_url(
        {
            "client_id": client.client_id,
            "response_type": "code",
            "redirect_uri": client.callback_url,
            "state": "s",
            "nonce": "the-nonce",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    query = fake.authorize(location, user)
    return await client.exchange_code(query["code"], verifier), "the-nonce"


async def test_the_happy_path_reads_the_profile_from_the_id_token(issuer) -> None:
    client = client_for(issuer)
    user = issuer.user(email="Ana@Example.Invalid", avatar={"kind": "preset", "assetId": "owl"})
    tokens, nonce = await sign_in(issuer, client, user)
    claims = await client.verify(tokens, nonce=nonce)
    assert claims.issuer == ISSUER and claims.subject == user.sub
    assert claims.email == "ana@example.invalid" and claims.email_verified is True
    assert claims.display_name == "Walk Member"
    assert claims.avatar == {"kind": "preset", "assetId": "owl"}
    assert "openbinding:access" in claims.permissions
    assert claims.profile_from_id_token is True
    assert "access_token" not in repr(tokens) and tokens.access_token not in repr(tokens)


@pytest.mark.parametrize(
    "switch",
    [
        "bad_nonce",
        "wrong_aud",
        "multi_aud_without_azp",
        "wrong_azp",
        "wrong_iss",
        "alg_none",
        "alg_hs256_secret",
        "alg_hs256_pubkey",
        "enc_key_signed",
        "no_kid",
        "rotated_kid",
        "expired",
        "iat_future",
        "id_typ_wrong",
        "sub_mismatch",
    ],
)
async def test_every_forgery_and_mismatch_is_refused(issuer, switch) -> None:
    client = client_for(issuer)
    issuer.switches.add(switch)
    tokens, nonce = await sign_in(issuer, client)
    with pytest.raises(TokenRejected) as error:
        await client.verify(tokens, nonce=nonce)
    assert error.value.code == "signin_failed"


async def test_a_missing_permission_is_its_own_refusal(issuer) -> None:
    client = client_for(issuer)
    issuer.switches.add("no_permission")
    tokens, nonce = await sign_in(issuer, client)
    with pytest.raises(PermissionMissing) as error:
        await client.verify(tokens, nonce=nonce)
    assert error.value.code == "access_denied"
    unchecked = client_for(issuer, scoretech_identity_required_permission="")
    assert (await unchecked.verify(tokens, nonce=nonce)).subject


async def test_a_jwks_with_only_the_enc_key_gives_no_usable_key(issuer, monkeypatch) -> None:
    client = client_for(issuer)
    tokens, nonce = await sign_in(issuer, client)
    monkeypatch.setattr(issuer, "jwks", lambda: {"keys": [k for k in FakeIssuer.jwks(issuer)["keys"] if k["use"] == "enc"]})
    with pytest.raises(TokenRejected):
        await client.verify(tokens, nonce=nonce)


async def test_an_unknown_kid_is_refetched_once_per_30_seconds_and_rotation_is_accepted(issuer) -> None:
    clock = Clock()
    client = IdentityOidc(scoretech_settings(), transport=issuer.transport(), monotonic=clock)
    tokens, nonce = await sign_in(issuer, client)
    await client.verify(tokens, nonce=nonce)
    assert issuer.jwks_fetches == 1
    issuer.switches.add("rotated_kid")
    rotated, nonce = await sign_in(issuer, client)
    clock.now += 31
    with pytest.raises(TokenRejected):
        await client.verify(rotated, nonce=nonce)
    assert issuer.jwks_fetches == 2
    clock.now += 5
    issuer.rotated = True
    with pytest.raises(TokenRejected):
        await client.verify(rotated, nonce=nonce)
    assert issuer.jwks_fetches == 2, "a second unknown kid within 30 s is not refetched"
    clock.now += 30
    assert (await client.verify(rotated, nonce=nonce)).subject
    assert issuer.jwks_fetches == 3


async def test_cached_keys_serve_through_a_jwks_outage_for_an_hour(issuer) -> None:
    clock = Clock()
    client = IdentityOidc(scoretech_settings(), transport=issuer.transport(), monotonic=clock)
    tokens, nonce = await sign_in(issuer, client)
    await client.verify(tokens, nonce=nonce)
    clock.now += 700
    issuer.switches.add("redirecting_jwks")
    assert (await client.verify(tokens, nonce=nonce)).subject
    clock.now += 3000
    with pytest.raises(IdentityUnavailable):
        await client.verify(tokens, nonce=nonce)


async def test_discovery_must_name_the_issuer_and_keep_endpoints_under_it(issuer) -> None:
    issuer.switches.add("discovery_issuer_mismatch")
    with pytest.raises(IdentityUnavailable):
        await client_for(issuer).discovery()
    issuer.switches.clear()
    issuer.switches.add("endpoint_off_prefix")
    with pytest.raises(IdentityUnavailable):
        await client_for(issuer).discovery()


async def test_a_failed_discovery_is_not_cached(issuer) -> None:
    client = client_for(issuer)
    issuer.switches.add("down")
    with pytest.raises(IdentityUnavailable):
        await client.discovery()
    issuer.switches.clear()
    assert (await client.discovery())["issuer"] == ISSUER


async def test_a_redirecting_jwks_is_refused(issuer) -> None:
    client = client_for(issuer)
    tokens, nonce = await sign_in(issuer, client)
    issuer.switches.add("redirecting_jwks")
    with pytest.raises(IdentityUnavailable):
        await client.verify(tokens, nonce=nonce)


async def test_the_transport_rewrite_reaches_the_transport_host_and_checks_the_public_issuer(issuer) -> None:
    client = client_for(issuer, scoretech_identity_transport_url=TRANSPORT)
    tokens, nonce = await sign_in(issuer, client)
    claims = await client.verify(tokens, nonce=nonce)
    assert claims.issuer == ISSUER
    hosts = {host for _, host, _ in issuer.requests}
    assert hosts == {"keycloak.test"}
    location = await client.authorization_url({"a": "b"})
    assert location.startswith(ISSUER + "/protocol/openid-connect/auth?")


async def test_the_registration_screen_uses_the_registrations_endpoint(issuer) -> None:
    location = await client_for(issuer).authorization_url({"a": "b"}, register=True)
    assert location.startswith(ISSUER + "/protocol/openid-connect/registrations?")


async def test_leeway_edges(issuer) -> None:
    client = client_for(issuer)
    await client.discovery()

    def signed(**claims) -> str:
        now = int(time.time())
        body = {
            "iss": ISSUER, "sub": "s", "aud": [client.client_id], "azp": client.client_id,
            "iat": now, "exp": now + 60, "realm_access": {"roles": ["openbinding:access"]},
        }
        body.update(claims)
        return jwt.encode(body, _KEYS["k1"], algorithm="RS256", headers={"kid": "k1"})

    now = int(time.time())
    accepted = TokenSet(access_token=signed(exp=now - 29), refresh_token="r", expires_in=60)
    assert (await client.verify(accepted)).subject == "s"
    for bad in (signed(exp=now - 31), signed(iat=now + 31)):
        with pytest.raises(TokenRejected):
            await client.verify(TokenSet(access_token=bad, refresh_token="r", expires_in=60))
    crit = jwt.encode(
        {"iss": ISSUER, "sub": "s", "aud": client.client_id, "azp": client.client_id, "iat": now, "exp": now + 60},
        _KEYS["k1"], algorithm="RS256", headers={"kid": "k1", "crit": ["x"], "x": 1},
    )
    with pytest.raises(TokenRejected):
        await client.verify(TokenSet(access_token=crit, refresh_token="r", expires_in=60))


async def test_email_verified_must_be_the_boolean_true(issuer) -> None:
    client = client_for(issuer)
    issuer.switches.add("email_verified_string")
    tokens, nonce = await sign_in(issuer, client)
    claims = await client.verify(tokens, nonce=nonce)
    assert claims.email_verified is False


async def test_an_access_token_carrying_profile_claims_never_feeds_the_profile(issuer) -> None:
    client = client_for(issuer)
    issuer.switches.update({"access_has_email", "refresh_without_id_token"})
    tokens, nonce = await sign_in(issuer, client)
    refreshed = await client.refresh(tokens.refresh_token)
    assert refreshed.id_token is None
    claims = await client.verify(refreshed)
    assert claims.email is None and claims.display_name is None and claims.profile_from_id_token is False


async def test_refresh_tokens_are_single_use_and_invalid_grant_ends_the_session(issuer) -> None:
    client = client_for(issuer)
    tokens, _ = await sign_in(issuer, client)
    renewed = await client.refresh(tokens.refresh_token)
    assert renewed.refresh_token != tokens.refresh_token
    with pytest.raises(IdentityEnded):
        await client.refresh(tokens.refresh_token)


async def test_a_refresh_must_keep_the_subject(issuer) -> None:
    client = client_for(issuer)
    tokens, _ = await sign_in(issuer, client)
    with pytest.raises(TokenRejected):
        await client.verify(tokens, subject="somebody-else")


async def test_an_incomplete_token_answer_is_unavailable(issuer, monkeypatch) -> None:
    client = client_for(issuer)
    original = issuer._tokens

    def without_refresh(*args, **kwargs):
        body = original(*args, **kwargs)
        body.pop("refresh_token")
        return body

    monkeypatch.setattr(issuer, "_tokens", without_refresh)
    with pytest.raises(IdentityUnavailable):
        await sign_in(issuer, client)


async def test_end_session_and_revoke_are_posted_with_the_client(issuer) -> None:
    client = client_for(issuer)
    tokens, _ = await sign_in(issuer, client)
    assert await client.end_session(tokens.refresh_token) is True
    assert issuer.logouts == [tokens.refresh_token]
    assert await client.revoke(tokens.refresh_token) is True
    assert issuer.revoked == [tokens.refresh_token]
    issuer.switches.add("down")
    assert await client.end_session("x") is False


@pytest.mark.parametrize(
    ("value", "parsed"),
    [
        ({"kind": "preset", "assetId": "owl"}, {"kind": "preset", "assetId": "owl"}),
        ({"kind": "preset", "assetId": "owl", "backgroundColor": "graphite"}, {"kind": "preset", "assetId": "owl"}),
        (
            {"kind": "initials", "backgroundColor": "graphite", "foregroundColor": "paper"},
            {"kind": "initials", "backgroundColor": "#212529", "foregroundColor": "#ffffff"},
        ),
        (
            {"kind": "icon", "assetId": "leaf", "backgroundColor": "#AABBCC", "foregroundColor": "tentu"},
            {"kind": "icon", "assetId": "leaf", "backgroundColor": "#aabbcc", "foregroundColor": "#be1d37"},
        ),
        ({"kind": "icon", "assetId": "avatar-5", "backgroundColor": "black", "foregroundColor": "white"}, None),
        ({"kind": "initials", "backgroundColor": "red", "foregroundColor": "paper"}, None),
        ({"kind": "photo", "url": "https://x"}, None),
        ("owl", None),
    ],
)
def test_identity_avatar_descriptors_parse_to_hex(value, parsed) -> None:
    assert parse_avatar(value) == parsed


async def test_an_unscripted_host_fails_closed(monkeypatch) -> None:
    import socket

    from openbinding_gateway.core import outbound

    def unresolvable(host, port):
        raise socket.gaierror(f"no address for {host}")

    monkeypatch.setattr(outbound, "_getaddrinfo", unresolvable)
    fake = FakeIssuer()
    client = IdentityOidc(scoretech_settings(), transport=fake.transport())
    with pytest.raises(IdentityUnavailable):
        await client.discovery()
    assert fake.requests == [] and fake.grants == []
