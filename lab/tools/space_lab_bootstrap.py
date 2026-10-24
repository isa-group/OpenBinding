"""Bootstrap of the lab SPACE: organization, MANAGEMENT api key, the ``openbinding`` service and the seed contracts.

This is the one module allowed to call SPACE's HTTP API directly (the constitution 16.1 exception of ADR 0022,
``docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md``): ``space-python-client`` has no organization,
api-key, user or service operation.  Contracts go through the client.  The tool imports nothing from the gateway,
reads no variable of SPHERE, holds no SPHERE key and sends nothing to SPHERE (SPACE reads the public link itself).
It never writes a file and never prints, logs or raises the admin password or an api key: error messages are built
from the item, method, route, status code or exception type only.  Keys stay in memory.

Idempotence is by lookup before each create.  Output: one JSON line on stdout; on failure one line on stderr, status 1.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
from space_client import SpaceApiError, SpaceClientFactory

SPHERE_LINK = "https://sphere.score.us.es/p/6ab0a323697330667ccce891"
SERVICE_NAME = "openbinding"
ORGANIZATION_NAME = "openbinding"
SOURCE = "sphere"
POLICY = "all_last"
# Same namespace and users as openbinding-gateway/tools/seed_lab.py (a test compares both texts).
SEED_NAMESPACE = uuid.UUID("6f1d3a52-8c0e-4b7a-9d21-0f5e7c3a9b10")
SYNTHETIC_USERS = ("lab-admin", "lab-owner", "lab-orgadmin", "lab-member", "lab-viewer", "lab-outsider")
FAILED_STATUSES = ("failed", "blocked", "degraded")
API = "/api/v1"


def synthetic_user_id(username: str) -> str:
    return str(uuid.uuid5(SEED_NAMESPACE, f"user:{username}"))


class BootstrapError(Exception):
    """A step failed; the message names the item and never carries a response body, header or secret."""


@dataclass(frozen=True)
class Config:
    space_url: str
    admin_user: str
    admin_password: str = field(repr=False)
    plan: str = "FREE"
    poll_attempts: int = 60
    poll_seconds: float = 5

    @classmethod
    def from_environ(cls, environ: Mapping[str, str]) -> Config:
        password = environ.get("SPACE_ADMIN_PASSWORD", "")
        if not password:
            raise BootstrapError("configuration: SPACE_ADMIN_PASSWORD is required")
        return cls(
            space_url=environ.get("SPACE_URL") or "http://space-api:3000",
            admin_user=environ.get("SPACE_ADMIN_USER") or "lab-space-admin",
            admin_password=password,
            plan=environ.get("SPACE_BOOTSTRAP_PLAN") or "FREE",
        )


async def _call(client: httpx.AsyncClient, item: str, method: str, route: str, key: str | None = None,
                body: Any = None) -> Any:
    """One request; the decoded JSON body.  Failures name the item, method, route and status only."""
    headers = {"x-api-key": key} if key else {}
    try:
        response = await client.request(method, f"{API}{route}", headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise BootstrapError(f"{item}: {method} {route} failed ({type(exc).__name__})") from None
    if not 200 <= response.status_code < 300:
        raise BootstrapError(f"{item}: {method} {route} returned status {response.status_code}")
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise BootstrapError(f"{item}: {method} {route} returned a body that is not JSON") from None


def _management_key(org: Mapping[str, Any]) -> str | None:
    keys = [k for k in org.get("apiKeys") or [] if isinstance(k, Mapping) and k.get("scope") == "MANAGEMENT"]
    return keys[-1].get("key") if keys else None


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version))


def _active_versions(body: Any) -> list[str]:
    """Active versions from the list shape or the ``{'activePricings': {...}}`` map shape."""
    if isinstance(body, Mapping):
        active = body.get("activePricings") or {}
        return [str(k) for k in active] if isinstance(active, Mapping) else [str(v) for v in active]
    versions = []
    for entry in body if isinstance(body, list) else []:
        if isinstance(entry, Mapping) and str(entry.get("status", "active")).lower() == "active" and entry.get("version"):
            versions.append(str(entry["version"]))
    return versions


async def _wait_for_sync(client, config, key, sleep) -> None:
    route = f"/services/{SERVICE_NAME}/synchronization"
    for attempt in range(config.poll_attempts):
        body = await _call(client, "synchronization", "GET", route, key)
        status = str(body.get("status", "")).lower() if isinstance(body, Mapping) else ""
        if status == "ready":
            return
        if status in FAILED_STATUSES:
            raise BootstrapError(f"synchronization: the service synchronization is {status}")
        if attempt + 1 < config.poll_attempts:
            await sleep(config.poll_seconds)
    raise BootstrapError(f"synchronization: not ready after {config.poll_attempts} polls")


async def _contracts(contracts: Any, config: Config, version: str) -> dict[str, str]:
    from space_client.types.models import BillingPeriodToCreate, ContractToCreate, UserContact

    result: dict[str, str] = {}
    for username in SYNTHETIC_USERS:
        user_id = synthetic_user_id(username)
        try:
            try:
                existing = await contracts.get_contract(user_id)
            except SpaceApiError as exc:
                if exc.status_code != 404:
                    raise
                existing = None
            if existing is None:
                await contracts.add_contract(ContractToCreate(
                    user_contact=UserContact(user_id=user_id, username=user_id, email=f"{username}@example.org", phone=""),
                    billing_period=BillingPeriodToCreate(auto_renew=True, renewal_days=30),
                    contracted_services={SERVICE_NAME: version},
                    subscription_plans={SERVICE_NAME: config.plan},
                    subscription_add_ons={},
                ))
        except Exception as exc:  # noqa: BLE001 - only the type reaches the message
            raise BootstrapError(f"contracts: {username} failed ({type(exc).__name__})") from None
        result[username] = "exists" if existing is not None else "created"
    return result


async def bootstrap(config: Config, *, transport: httpx.AsyncBaseTransport | None = None, contracts: Any = None,
                    sleep: Callable[[float], Any] = asyncio.sleep) -> dict[str, Any]:
    # The HTTP sequence comes from the documentation of SPACE's main branch and is UNVERIFIED against a live v1.7.1.
    report: dict[str, Any] = {}
    async with httpx.AsyncClient(base_url=config.space_url, transport=transport, timeout=30.0) as client:
        auth = await _call(client, "authentication", "POST", "/users/authenticate",
                           body={"username": config.admin_user, "password": config.admin_password})
        admin_key = auth.get("apiKey") if isinstance(auth, Mapping) else None
        if not admin_key:
            raise BootstrapError("authentication: the response holds no api key")

        orgs = await _call(client, "organization", "GET", "/organizations", admin_key)
        if not isinstance(orgs, list):
            raise BootstrapError("organization: GET /organizations returned no list")
        org =next((o for o in orgs if isinstance(o, Mapping) and o.get("name") == ORGANIZATION_NAME), None)
        report["organization"] = "exists" if org else "created"
        if org is None:
            org = await _call(client, "organization", "POST", "/organizations", admin_key,
                              {"name": ORGANIZATION_NAME, "owner": config.admin_user})
        if not isinstance(org, Mapping) or not org.get("id"):
            raise BootstrapError("organization: the organization has no id")
        key = _management_key(org)
        report["apiKey"] = "exists" if key else "created"
        if key is None:
            # UNVERIFIED: that the organization lookup returns the value of an existing key.
            created = await _call(client, "apiKey", "POST", f"/organizations/{org.get('id')}/api-keys", admin_key,
                                  {"scope": "MANAGEMENT"})
            key = _management_key(created) if isinstance(created, Mapping) else None
            if not key:
                raise BootstrapError("apiKey: the response holds no MANAGEMENT key")

        services = await _call(client, "service", "GET", "/services", key)
        if not isinstance(services, list):
            raise BootstrapError("service: GET /services returned no list")
        service = next((s for s in services if isinstance(s, Mapping) and s.get("name") == SERVICE_NAME), None)
        report["service"] = "exists" if service else "created"
        if service is not None:
            if (service.get("source"), service.get("permanentUrl"), service.get("policy")) != (SOURCE, SPHERE_LINK, POLICY):
                raise BootstrapError("service: the existing openbinding service has another source, link or policy")
            report["synchronization"] = "skipped"
        else:
            created = await _call(client, "service", "POST", "/services", key,
                                  {"source": SOURCE, "permanentUrl": SPHERE_LINK, "policy": POLICY})
            if not isinstance(created, Mapping) or created.get("name") != SERVICE_NAME:
                raise BootstrapError("service: the created service is not named openbinding")
            await _call(client, "synchronization", "POST", f"/services/{SERVICE_NAME}/synchronization/run", key)
            await _wait_for_sync(client, config, key, sleep)
            report["synchronization"] = "ready"

        versions = _active_versions(await _call(client, "pricing", "GET", f"/services/{SERVICE_NAME}/pricings", key))
        if not versions:
            raise BootstrapError("pricing: the openbinding service has no active pricing version")
        version = max(versions, key=_version_key)

        sdk = None
        if contracts is None:
            sdk = SpaceClientFactory.connect_async(config.space_url, key, 30000)
            contracts = sdk.contracts
        try:
            report["contracts"] = await _contracts(contracts, config, version)
        finally:
            if sdk is not None:
                await sdk.close()
    return report


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    try:
        config = Config.from_environ(os.environ if environ is None else environ)
        report = asyncio.run(bootstrap(config))
    except BootstrapError as exc:
        print(f"space_lab_bootstrap: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
