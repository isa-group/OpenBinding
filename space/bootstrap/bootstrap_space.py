#!/usr/bin/env python3
"""Put OpenBinding's pricing into a SPACE instance, and hand back a key for it.

Run once per environment, after SPACE is up and before the gateway is pointed
at it:

    python space/bootstrap/bootstrap_space.py --url http://localhost:5403

It is safe to run twice. A service that already exists is reported and left
alone, so re-running after a partial failure finishes the job rather than
undoing it.

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

Written against SPACE 1.0.0. Pin the version you deploy.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Optional

try:
    import httpx
except ImportError:  # pragma: no cover - a setup problem, not a runtime one
    sys.exit("This script needs httpx: pip install httpx")

PRICING_PATH = Path(__file__).resolve().parents[1] / "pricing" / "openbinding.yml"
SERVICE_NAME = "openbinding"
DEFAULT_URL = "http://localhost:5403"

#: Least privilege that still covers everything the gateway does.
GATEWAY_SCOPE = "MANAGEMENT"


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


def management_key(
    client: httpx.Client, base_url: str, user_key: str, organization: dict
) -> str:
    """An organization key scoped to what the gateway does, minting one if needed."""
    for key in organization.get("apiKeys") or []:
        if key.get("scope") == GATEWAY_SCOPE:
            return key["key"]

    response = client.post(
        f"{_api(base_url)}/organizations/{organization['id']}/api-keys",
        headers={"x-api-key": user_key},
        json={"scope": GATEWAY_SCOPE},
    )
    if response.status_code >= 400:
        raise _fail(response, f"mint a {GATEWAY_SCOPE} key")

    updated = response.json()
    for key in updated.get("apiKeys") or []:
        if key.get("scope") == GATEWAY_SCOPE:
            return key["key"]
    raise BootstrapError(f"SPACE accepted the request but returned no {GATEWAY_SCOPE} key.")


def service_exists(client: httpx.Client, base_url: str, org_key: str) -> bool:
    response = client.get(
        f"{_api(base_url)}/services/{SERVICE_NAME}", headers={"x-api-key": org_key}
    )
    return response.status_code == 200


def create_service(client: httpx.Client, base_url: str, org_key: str) -> None:
    """Register the service, uploading the pricing as the file SPACE expects.

    A multipart upload rather than a JSON body, which is why this does not
    simply POST the parsed document.
    """
    with open(PRICING_PATH, "rb") as handle:
        response = client.post(
            f"{_api(base_url)}/services",
            headers={"x-api-key": org_key},
            files={"pricing": (PRICING_PATH.name, handle, "application/yaml")},
        )

    if response.status_code >= 400:
        raise _fail(response, "register the service")


def main() -> int:
    parser = argparse.ArgumentParser(description="Register OpenBinding's pricing with SPACE.")
    parser.add_argument("--url", default=os.getenv("SPACE_URL", DEFAULT_URL))
    parser.add_argument("--username", default=os.getenv("SPACE_ADMIN_USER", "admin"))
    parser.add_argument(
        "--password",
        default=os.getenv("SPACE_ADMIN_PASSWORD"),
        help="Prompted for when not given. SPACE ships with a well-known default; change it.",
    )
    arguments = parser.parse_args()

    password: Optional[str] = arguments.password or getpass.getpass(
        f"SPACE password for {arguments.username}: "
    )

    if not PRICING_PATH.exists():
        print(f"No pricing document at {PRICING_PATH}", file=sys.stderr)
        return 1

    try:
        with httpx.Client(timeout=30.0) as client:
            print(f"Authenticating with SPACE at {arguments.url} ...")
            user_key = authenticate(client, arguments.url, arguments.username, password)

            organization = default_organization(client, arguments.url, user_key)
            print(f"Using organization '{organization.get('name')}'.")

            org_key = management_key(client, arguments.url, user_key, organization)
            print(f"Organization key scoped {GATEWAY_SCOPE} ready.")

            if service_exists(client, arguments.url, org_key):
                print(f"Service '{SERVICE_NAME}' is already registered; leaving it alone.")
            else:
                print(f"Registering service '{SERVICE_NAME}' with {PRICING_PATH.name} ...")
                create_service(client, arguments.url, org_key)
                print("Registered.")
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
    print(
        f"\nThat key speaks for the service, with {GATEWAY_SCOPE} scope over the whole\n"
        "organization. It is not an OpenBinding API key and must never be given to\n"
        "an account holder: it can read every contract."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
