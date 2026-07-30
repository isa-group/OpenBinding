"""Deciding whether a URL a stranger gave us is safe to fetch.

Registering a federated engine hands the gateway a URL and asks it to make
requests. That is a server-side request forgery primitive by construction, and
the thing it forges requests *into* is this deployment's own compose network:
``http://engine-minizinc:3000``, ``http://postgres:5432``, the SPACE instance
holding every contract, and on a cloud host ``http://169.254.169.254``, which
hands out credentials to anybody who asks.

So every URL crosses this module first, and it says no by default.

The check has to be on the **resolved address**, not the hostname. A name that
resolves to 127.0.0.1 is as dangerous as writing 127.0.0.1, and a name whose
owner controls its DNS can answer one address for our check and another for the
request a moment later - a rebind. That is why ``resolve`` hands back the
addresses it approved: the caller connects to those, not to the name.

What is deliberately *not* here: a domain allowlist. This is a feature for
solvers we do not know about, so an allowlist would defeat it. The defence is
that the destination is a public address, that it stays the one we checked, and
that the response is bounded.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import List, Optional, Sequence
from urllib.parse import urlparse

#: The schemes worth speaking. Everything else - file://, gopher://, ftp:// -
#: exists in this list's absence for a reason.
ALLOWED_SCHEMES = {"http", "https"}

#: Where a cloud instance keeps its credentials. Link-local already covers it,
#: and it is named anyway because it is the address this whole module exists
#: for and a reader should see it.
CLOUD_METADATA = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
}

#: How long to wait for a name to resolve. A hostname that cannot answer in
#: this long is not one to route solves through.
RESOLVE_TIMEOUT_S = 5.0


class UnsafeUrl(ValueError):
    """The URL may not be fetched, and the message says why.

    A ``ValueError`` because that is what callers turn into a 422: this is a
    problem with what was submitted, not with the gateway.
    """


@dataclass(frozen=True)
class SafeTarget:
    """A URL that passed, and the addresses it passed *as*.

    ``addresses`` is the point. Connecting by hostname after checking the
    hostname re-resolves it, and a second resolution is a second chance for the
    name's owner to answer with something else. Callers pin these.
    """

    url: str
    host: str
    port: int
    addresses: Sequence[str]

    @property
    def address(self) -> str:
        """The address to connect to."""
        return self.addresses[0]


def _rejection(address: ipaddress._BaseAddress) -> Optional[str]:
    """Why this address is not somewhere we will send a request, if it is not.

    Each clause is a range that means "inside somebody's network rather than on
    the internet", and every one of them has been used to reach a service that
    believed it was unreachable.
    """
    if address in CLOUD_METADATA:
        return "the cloud instance metadata service"
    if address.is_loopback:
        return "a loopback address"
    if address.is_link_local:
        return "a link-local address"
    if address.is_private:
        return "a private address"
    if address.is_reserved:
        return "a reserved address"
    if address.is_multicast:
        return "a multicast address"
    if address.is_unspecified:
        return "an unspecified address"

    if isinstance(address, ipaddress.IPv4Address):
        # Carrier-grade NAT. Not "private" by Python's reckoning, and routable
        # to a neighbour on the same carrier.
        if address in ipaddress.ip_network("100.64.0.0/10"):
            return "a carrier-grade NAT address"

    if isinstance(address, ipaddress.IPv6Address):
        # An IPv4 address wearing an IPv6 hat. ::ffff:127.0.0.1 is loopback
        # however it is spelled, and Python's is_loopback does not say so.
        mapped = getattr(address, "ipv4_mapped", None)
        if mapped is not None:
            return _rejection(mapped) or None
        sixtofour = getattr(address, "sixtofour", None)
        if sixtofour is not None:
            return _rejection(sixtofour) or None
        teredo = getattr(address, "teredo", None)
        if teredo is not None:
            for part in teredo:
                reason = _rejection(part)
                if reason:
                    return reason

    return None


def check_address(candidate: str) -> None:
    """Raise unless this address is one we will send a request to."""
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError as error:
        raise UnsafeUrl(f"{candidate!r} is not an IP address.") from error

    reason = _rejection(address)
    if reason:
        raise UnsafeUrl(
            f"{candidate} is {reason}. A federated engine has to be reachable "
            f"on the public internet, so that registering one cannot be used to "
            f"reach services inside this deployment."
        )


def resolve(url: str, *, require_https: bool) -> SafeTarget:
    """Check a URL and return the addresses it is allowed to be fetched at.

    ``require_https`` is the deployment's call rather than this module's: a
    production gateway must not send somebody's instance over plaintext, and a
    developer testing against a local stub over http should not have to run a
    certificate authority to do it.
    """
    parsed = urlparse(url)

    if parsed.scheme not in ALLOWED_SCHEMES:
        raise UnsafeUrl(
            f"{parsed.scheme or 'a URL with no scheme'} is not a scheme this "
            f"gateway will fetch. Use http or https."
        )

    if require_https and parsed.scheme != "https":
        raise UnsafeUrl(
            "A federated engine must be reached over https: the instance and the "
            "credential travel to it."
        )

    if parsed.username or parsed.password:
        # Credentials in a URL end up in logs, and here they would end up in a
        # manifest somebody else can read.
        raise UnsafeUrl("Do not put credentials in the URL; register them separately.")

    host = parsed.hostname
    if not host:
        raise UnsafeUrl(f"{url!r} names no host.")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    addresses = _addresses_for(host, port)
    for address in addresses:
        check_address(address)

    return SafeTarget(url=url, host=host, port=port, addresses=addresses)


def _addresses_for(host: str, port: int) -> List[str]:
    """Every address the name resolves to, or the literal it already is.

    **Every** address, not the first: a name answering one public address and
    one loopback address is a name trying something, and connecting is not
    guaranteed to pick the one that was checked.
    """
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        pass

    original_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(RESOLVE_TIMEOUT_S)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as error:
        raise UnsafeUrl(f"{host!r} does not resolve: {error}.") from error
    finally:
        socket.setdefaulttimeout(original_timeout)

    addresses: List[str] = []
    for info in infos:
        address = info[4][0]
        if address not in addresses:
            addresses.append(address)

    if not addresses:
        raise UnsafeUrl(f"{host!r} resolves to nothing.")
    return addresses
