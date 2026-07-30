"""The guard between a stranger's URL and this deployment's own network.

Registering a federated engine is, structurally, asking the gateway to make a
request somewhere of the registrant's choosing. Inside the compose network that
somewhere could be ``engine-minizinc:3000``, ``postgres:5432``, the SPACE
instance holding every contract, or - on a cloud host - the metadata service
that hands out credentials to whoever asks.

These tests are the specification of "no". They are written as the attacks
rather than as the ranges, because a range with no attack beside it is a rule
somebody will later relax for looking arbitrary.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from openbinding_gateway.federation import ssrf
from openbinding_gateway.federation.ssrf import UnsafeUrl


def resolving_to(*addresses: str):
    """Pretend DNS answers with these, so the tests do not need a network."""
    infos = [(2, 1, 6, "", (address, 443)) for address in addresses]
    return patch("socket.getaddrinfo", return_value=infos)


# -- What this exists to stop -----------------------------------------------


def test_the_compose_network_is_not_reachable():
    # The engines beside us. A registered engine pointed here would let anybody
    # drive our solvers under someone else's quota.
    with resolving_to("172.18.0.4"):
        with pytest.raises(UnsafeUrl) as error:
            ssrf.resolve("http://engine-minizinc:3000/solve", require_https=False)

    assert "private" in str(error.value)


def test_the_database_is_not_reachable():
    with resolving_to("10.0.1.5"):
        with pytest.raises(UnsafeUrl):
            ssrf.resolve("http://postgres:5432", require_https=False)


def test_the_cloud_metadata_service_is_named_and_refused():
    with pytest.raises(UnsafeUrl) as error:
        ssrf.resolve("http://169.254.169.254/latest/meta-data/", require_https=False)

    assert "metadata" in str(error.value)


def test_the_gateway_cannot_be_pointed_at_itself():
    with pytest.raises(UnsafeUrl) as error:
        ssrf.resolve("http://127.0.0.1:8000/v1/solve", require_https=False)

    assert "loopback" in str(error.value)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000/solve",
        "http://[::1]:8000/solve",
        "http://0.0.0.0:8000/solve",
        "http://[::ffff:127.0.0.1]/solve",
        "http://192.168.1.10/solve",
        "http://10.0.0.1/solve",
        "http://172.16.0.1/solve",
        "http://169.254.1.1/solve",
        "http://100.64.0.1/solve",
        "http://[fd00::1]/solve",
        "http://[fe80::1]/solve",
    ],
)
def test_every_address_inside_a_network_is_refused(url):
    # localhost is the only one here that needs resolving; the rest are
    # literals, and a literal is checked without touching DNS.
    with resolving_to("127.0.0.1"):
        with pytest.raises(UnsafeUrl):
            ssrf.resolve(url, require_https=False)


def test_loopback_wearing_an_ipv6_hat_is_still_loopback():
    # ::ffff:127.0.0.1 is not is_loopback as far as Python is concerned, which
    # is exactly the sort of gap this is checking for.
    with pytest.raises(UnsafeUrl) as error:
        ssrf.resolve("http://[::ffff:127.0.0.1]/solve", require_https=False)

    assert "loopback" in str(error.value)


def test_a_name_that_resolves_inward_is_refused_however_public_it_looks():
    # The classic: a domain the attacker owns, an A record pointing at 127.0.0.1.
    # Checking the hostname would pass this; checking the address does not.
    with resolving_to("127.0.0.1"):
        with pytest.raises(UnsafeUrl):
            ssrf.resolve("https://totally-legitimate.example/solve", require_https=True)


def test_one_bad_address_out_of_several_is_enough_to_refuse():
    # A name answering both a public address and a loopback one is a name
    # trying something, and nothing guarantees a connection picks the good one.
    with resolving_to("93.184.216.34", "127.0.0.1"):
        with pytest.raises(UnsafeUrl):
            ssrf.resolve("https://acme.example/solve", require_https=True)


# -- Schemes and shapes -----------------------------------------------------


@pytest.mark.parametrize("url", ["file:///etc/passwd", "gopher://x/", "ftp://x/", "/no-scheme"])
def test_only_http_and_https_are_spoken(url):
    with pytest.raises(UnsafeUrl) as error:
        ssrf.resolve(url, require_https=False)

    assert "scheme" in str(error.value)


def test_plaintext_is_refused_where_the_deployment_says_so():
    # The instance and the credential both travel to a federated engine.
    with resolving_to("93.184.216.34"):
        with pytest.raises(UnsafeUrl) as error:
            ssrf.resolve("http://acme.example/solve", require_https=True)

    assert "https" in str(error.value)


def test_plaintext_is_allowed_where_it_is_not():
    # A developer testing against a local stub should not need a certificate
    # authority, so this is the deployment's call and not this module's.
    with resolving_to("93.184.216.34"):
        target = ssrf.resolve("http://acme.example/solve", require_https=False)

    assert target.host == "acme.example"


def test_credentials_in_the_url_are_refused():
    # They end up in logs, and here they would end up in a manifest that an
    # administrator reviews.
    with resolving_to("93.184.216.34"):
        with pytest.raises(UnsafeUrl) as error:
            ssrf.resolve("https://user:hunter2@acme.example/solve", require_https=True)

    assert "credentials" in str(error.value)


def test_a_url_with_no_host_is_refused():
    with pytest.raises(UnsafeUrl):
        ssrf.resolve("https:///solve", require_https=True)


def test_a_name_that_does_not_resolve_is_refused_rather_than_retried():
    import socket

    with patch("socket.getaddrinfo", side_effect=socket.gaierror("no such host")):
        with pytest.raises(UnsafeUrl) as error:
            ssrf.resolve("https://nope.example/solve", require_https=True)

    assert "resolve" in str(error.value)


# -- What it lets through, and what it hands back ---------------------------


def test_a_public_engine_is_allowed():
    with resolving_to("93.184.216.34"):
        target = ssrf.resolve("https://acme.example/solve", require_https=True)

    assert target.address == "93.184.216.34"


def test_the_checked_addresses_come_back_so_the_caller_can_pin_them():
    # This is the anti-rebinding measure, and the reason resolve() returns a
    # target rather than None: connecting by name would resolve a second time,
    # which is a second chance to answer with something else.
    with resolving_to("93.184.216.34", "93.184.216.35"):
        target = ssrf.resolve("https://acme.example/solve", require_https=True)

    assert list(target.addresses) == ["93.184.216.34", "93.184.216.35"]


def test_the_port_is_carried_through():
    with resolving_to("93.184.216.34"):
        assert ssrf.resolve("https://acme.example:8443/s", require_https=True).port == 8443


def test_a_missing_port_is_the_scheme_default():
    with resolving_to("93.184.216.34"):
        assert ssrf.resolve("https://acme.example/s", require_https=True).port == 443
        assert ssrf.resolve("http://acme.example/s", require_https=False).port == 80


def test_a_public_literal_needs_no_dns_at_all():
    with patch("socket.getaddrinfo", side_effect=AssertionError("should not resolve a literal")):
        target = ssrf.resolve("https://93.184.216.34/solve", require_https=True)

    assert target.address == "93.184.216.34"


def test_check_address_refuses_something_that_is_not_an_address():
    with pytest.raises(UnsafeUrl):
        ssrf.check_address("not-an-address")
