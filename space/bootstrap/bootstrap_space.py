#!/usr/bin/env python3
"""Mint the scoped SPACE keys used by OpenBinding's server-side control planes.

Run once per environment, after SPACE is up and before the gateway is pointed
at it:

    python space/bootstrap/bootstrap_space.py --url http://localhost:5403

It never uploads pricing. Immutable Pricing2Yaml versions come from SPHERE and
are deployed by OpenBinding's authenticated pricing control room.

Three things about SPACE's authorisation model shape this script, and all three
were learned by being refused by a running instance rather than from the
documentation:

* Signing in as an administrator yields a **user** key (``usr_``), and a user
  key cannot register a service. Services and contracts belong to an
  organization, so what the gateway needs is an **organization** key (``org_``).
* Every SPACE installation starts with a default organization, which already
  carries a key scoped ``ALL``.
* ``ALL`` is more than the gateway ever uses. ``MANAGEMENT`` covers registering
  the service, creating and novating contracts, and evaluating features;
  ``ALL`` additionally permits deleting contracts and services, which the
  gateway has no code to do. So this mints a ``MANAGEMENT`` key rather than
  handing over the one that is already there.

Written against the pinned SPACE v1.5.0 tag.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

try:
    import httpx
except ImportError:  # pragma: no cover - a setup problem, not a runtime one
    sys.exit("This script needs httpx: pip install httpx")

DEFAULT_URL = "http://localhost:5403"

#: Least privilege that still covers everything the gateway does.
GATEWAY_SCOPE = "MANAGEMENT"
DESTRUCTIVE_SCOPE = "ALL"


class BootstrapError(RuntimeError):
    pass


def _api(base_url: str) -> str:
    return base_url.rstrip("/") + "/api/v1"


def _fail(response: httpx.Response, doing: str) -> BootstrapError:
    return BootstrapError(f"SPACE refused to {doing} ({response.status_code}): {response.text[:300]}")


def authenticate(client: httpx.Client, base_url: str, username: str, password: str) -> str:
    """Sign in as an administrator. Comes back with a user key."""
    response = client.post(
        f"{_api(base_url)}/users/authenticate",
        json={"username": username, "password": password},
    )
    if response.status_code == 401:
        raise BootstrapError("SPACE rejected those administrator credentials.")
    if response.status_code >= 400:
        raise _fail(response, "authenticate")

    body = response.json()
    api_key = body.get("apiKey") or (body.get("user") or {}).get("apiKey")
    if not api_key:
        raise BootstrapError(
            "SPACE authenticated but returned no API key. Response was: " + json.dumps(body)[:300]
        )
    return api_key


def default_organization(client: httpx.Client, base_url: str, user_key: str) -> dict:
    """The organization services and contracts will belong to."""
    response = client.get(f"{_api(base_url)}/organizations/", headers={"x-api-key": user_key})
    if response.status_code >= 400:
        raise _fail(response, "list organizations")

    organizations = response.json().get("data") or []
    if not organizations:
        raise BootstrapError("This SPACE instance has no organization to register a service in.")

    for organization in organizations:
        if organization.get("default"):
            return organization
    return organizations[0]


def organization_key(
    client: httpx.Client,
    base_url: str,
    user_key: str,
    organization: dict,
    scope: str,
) -> str:
    """Return or mint one organization key with the exact requested scope."""
    for key in organization.get("apiKeys") or []:
        if key.get("scope") == scope:
            return key["key"]

    response = client.post(
        f"{_api(base_url)}/organizations/{organization['id']}/api-keys",
        headers={"x-api-key": user_key},
        json={"scope": scope},
    )
    if response.status_code >= 400:
        raise _fail(response, f"mint an {scope} key")

    updated = response.json()
    for key in updated.get("apiKeys") or []:
        if key.get("scope") == scope:
            return key["key"]
    raise BootstrapError(f"SPACE accepted the request but returned no {scope} key.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Create OpenBinding's scoped SPACE keys.")
    parser.add_argument("--url", default=os.getenv("SPACE_URL", DEFAULT_URL))
    parser.add_argument("--username", default=os.getenv("SPACE_ADMIN_USER", "admin"))
    parser.add_argument(
        "--password",
        default=os.getenv("SPACE_ADMIN_PASSWORD"),
        help="Prompted for when not given. SPACE ships with a well-known default; change it.",
    )
    parser.add_argument(
        "--include-destructive-key",
        action="store_true",
        help="Also mint the separately stored ALL key used only for exact archived-version deletion.",
    )
    arguments = parser.parse_args()

    password: str | None = arguments.password or getpass.getpass(
        f"SPACE password for {arguments.username}: "
    )

    try:
        with httpx.Client(timeout=30.0) as client:
            print(f"Authenticating with SPACE at {arguments.url} ...")
            user_key = authenticate(client, arguments.url, arguments.username, password)

            organization = default_organization(client, arguments.url, user_key)
            print(f"Using organization '{organization.get('name')}'.")

            org_key = organization_key(
                client, arguments.url, user_key, organization, GATEWAY_SCOPE
            )
            print(f"Organization key scoped {GATEWAY_SCOPE} ready.")
            destructive_key = (
                organization_key(
                    client, arguments.url, user_key, organization, DESTRUCTIVE_SCOPE
                )
                if arguments.include_destructive_key
                else None
            )
    except BootstrapError as error:
        print(f"\n{error}", file=sys.stderr)
        return 1
    except httpx.RequestError as error:
        print(f"\nSPACE is not reachable at {arguments.url}: {error}", file=sys.stderr)
        return 1

    print("\nPut these in OpenBinding's .env:\n")
    print("SPACE_ENABLED=true")
    print(f"SPACE_URL={arguments.url}")
    print(f"SPACE_API_KEY={org_key}")
    if destructive_key:
        print(f"SPACE_DESTRUCTIVE_API_KEY={destructive_key}")
    print(
        f"\nThe normal key has {GATEWAY_SCOPE} scope over the whole\n"
        "organization. It is not an OpenBinding API key and must never be given to\n"
        "an account holder: it can read every contract."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
