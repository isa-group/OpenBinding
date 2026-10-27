"""Bootstrap of the REMOTE SPACE (https://space.score.us.es): the ``openbinding`` service and the seed contracts.

The tool holds one credential, a MANAGEMENT api key of that SPACE (``SPACE_API_KEY``), sent as ``x-api-key`` on every
request to the host of ``SPACE_URL``.  It never authenticates a user and never touches an organization or an api key.

This is the one module allowed to call SPACE's HTTP API directly (the constitution 16.1 exception of ADR 0022,
``docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md``): ``space-python-client`` has no service operation.
Contracts go through the client.  The tool imports nothing from the gateway, reads no variable of SPHERE, holds no
SPHERE key and sends nothing to SPHERE (SPACE reads the public link itself).  It never writes a file and never
prints, logs or raises the api key: error messages are built from the item, method, route, status code or exception
type only, so a SPACE answer that echoes the key leaks nothing.  The key stays in memory.  The tool's own client
ignores the environment, and ``main`` removes the proxy variables from the process before the contracts client of
``space-python-client`` (which would read them) is built.

Idempotence is by lookup before each create.  Output: one JSON line on stdout; on failure one line on stderr, status 1.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import urllib.parse
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
from space_client import SpaceApiError, SpaceClientFactory

# [impl->req~lab-space-remote-bootstrap~1]
# [impl->req~lab-space-remote-bootstrap-secrets~1]
DEFAULT_SPACE_URL = "https://space.score.us.es"
SPHERE_LINK = "https://sphere.score.us.es/p/6ab0a323697330667ccce891"
SERVICE_NAME = "openbinding"
SOURCE = "sphere"
POLICY = "all_last"
# Same namespace and users as openbinding-gateway/tools/seed_lab.py (a test compares both texts).
SEED_NAMESPACE = uuid.UUID("6f1d3a52-8c0e-4b7a-9d21-0f5e7c3a9b10")
SYNTHETIC_USERS = ("lab-admin", "lab-owner", "lab-orgadmin", "lab-member", "lab-viewer", "lab-outsider")
FAILED_STATUSES = ("failed", "blocked", "degraded")
API = "/api/v1"
SDK_TIMEOUT_MS = 30000
MAX_BODY_BYTES = 1024 * 1024
VERSION_PATTERN = re.compile(r"[0-9]{1,9}(\.[0-9]{1,9})*([-+][0-9A-Za-z.-]{1,64})?")


def synthetic_user_id(username: str) -> str:
    return str(uuid.uuid5(SEED_NAMESPACE, f"user:{username}"))


class BootstrapError(Exception):
    """A step failed; the message names the item and never carries a response body, header or secret."""


# [impl->req~lab-space-remote-bootstrap~1]
# [impl->req~lab-space-remote-bootstrap-secrets~1]
@dataclass(frozen=True)
class Config:
    space_url: str
    api_key: str = field(repr=False)
    plan: str = "FREE"
    poll_attempts: int = 60
    poll_seconds: float = 5

    @classmethod
    def from_environ(cls, environ: Mapping[str, str]) -> Config:
        api_key = environ.get("SPACE_API_KEY", "")
        if not api_key:
            raise BootstrapError("configuration: SPACE_API_KEY is required")
        space_url = _normalised_url(environ.get("SPACE_URL") or DEFAULT_SPACE_URL)
        if space_url is None:
            raise BootstrapError("configuration: SPACE_URL must be an https URL with a host, no credentials, "
                                 "no path, query or fragment")
        return cls(space_url=space_url, api_key=api_key, plan=environ.get("SPACE_BOOTSTRAP_PLAN") or "FREE")


def _normalised_url(url: str) -> str | None:
    """``https://<netloc>`` for an https URL with a host and nothing else (a path of ``/`` is dropped), else None.

    Checked inline (the tool imports nothing from the gateway): whitespace, control characters and backslashes are
    refused as a whole, so no parser difference can move the host.
    """
    if "\\" in url or any(c.isspace() or not c.isprintable() for c in url) or "?" in url or "#" in url:
        return None
    try:
        parts = urllib.parse.urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError:
        return None
    if not (parts.scheme == "https" and parts.hostname and "@" not in parts.netloc
            and parts.username is None and parts.password is None):
        return None
    if parts.query or parts.fragment or parts.path not in ("", "/"):
        return None
    return f"https://{parts.netloc}"


def _scrub_proxy_environment() -> None:
    """Remove the proxy variables from the process environment.  The contracts client of ``space-python-client``
    builds its own HTTP client, which reads them; the key must not travel through a proxy."""
    # Every name ending in ``_proxy`` in any case: the HTTP clients read the proxy variables.  The CA variables stay
    # (they only pick trust anchors).
    for name in [n for n in os.environ if n.lower().endswith("_proxy")]:
        os.environ.pop(name, None)


async def _call(client: httpx.AsyncClient, item: str, method: str, route: str, key: str, body: Any = None) -> Any:
    """One request with the api key; the decoded JSON body.  Failures name the item, method, route and status only.

    A body over ``MAX_BODY_BYTES`` is refused while it is read, before any decoding.  Errors are raised outside the
    ``except`` blocks, so no exception text travels as their context.
    """
    failure = status = None
    chunks: list[bytes] = []
    size = 0
    try:
        async with client.stream(method, f"{API}{route}", headers={"x-api-key": key}, json=body) as response:
            status = response.status_code
            if 200 <= status < 300:
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_BODY_BYTES:
                        break
                    chunks.append(chunk)
    except Exception as exc:  # noqa: BLE001 - only the type reaches the message (an odd key can fail while encoding)
        failure = type(exc).__name__
    if failure is not None:
        raise BootstrapError(f"{item}: {method} {route} failed ({failure})")
    if not 200 <= status < 300:
        raise BootstrapError(f"{item}: {method} {route} returned status {status}")
    if size > MAX_BODY_BYTES:
        raise BootstrapError(f"{item}: {method} {route} returned a body over 1 MiB")
    content = b"".join(chunks)
    if not content:
        return None
    decoded = failure = None
    try:
        decoded = json.loads(content)
    except ValueError:
        failure = "not JSON"
    if failure is not None:
        raise BootstrapError(f"{item}: {method} {route} returned a body that is not JSON")
    return decoded


def _service_settings(service: Mapping[str, Any]) -> tuple[Any, Any, Any]:
    """(source, permanentUrl, policy): from the ``sphere`` sub-document of a service created from SPHERE, else from the
    top level.  UNVERIFIED against a live v1.7.1 (read from the source at ef4dc894)."""
    sphere = service.get("sphere") if isinstance(service.get("sphere"), Mapping) else {}
    return tuple(sphere.get(name) if sphere.get(name) is not None else service.get(name)
                 for name in ("source", "permanentUrl", "policy"))


def _sync_status(body: Any) -> str:
    """``configuration.status``, else a top-level ``status``.  UNVERIFIED against a live v1.7.1."""
    if not isinstance(body, Mapping):
        return ""
    configuration = body.get("configuration")
    status = configuration.get("status") if isinstance(configuration, Mapping) else None
    return str(status or body.get("status") or "").lower()


def _field(source: Any, *names: str) -> Any:
    """A field of a client model or of a plain dict."""
    for name in names:
        if isinstance(source, Mapping) and name in source:
            return source[name]
        if source is not None and hasattr(source, name):
            return getattr(source, name)
    return None


def _confirmed(contract: Any, version: str, plan: str) -> bool:
    services = _field(contract, "contracted_services", "contractedServices")
    plans = _field(contract, "subscription_plans", "subscriptionPlans")
    return (isinstance(services, Mapping) and isinstance(plans, Mapping)
            and services.get(SERVICE_NAME) == version and plans.get(SERVICE_NAME) == plan)


def _version_key(version: str) -> tuple[tuple[int, ...], int]:
    """Numeric core first; a release ranks above its pre-release (``-...``); ``+build`` is ignored."""
    core = re.split(r"[-+]", version, maxsplit=1)[0]
    pre_release = "-" in version.split("+", 1)[0]
    return tuple(int(part) for part in core.split(".")), 0 if pre_release else 1


def _active_versions(body: Any) -> list[str]:
    """Active versions from the list shape (an entry whose ``status`` is not ``active`` is ignored) or the
    ``{'activePricings': {...}}`` map shape.  The shape is UNVERIFIED against a live v1.7.1, so both are accepted."""
    if isinstance(body, Mapping):
        active = body.get("activePricings") or {}
        return [str(k) for k in active] if isinstance(active, Mapping) else [str(v) for v in active]
    versions = []
    for entry in body if isinstance(body, list) else []:
        if isinstance(entry, Mapping) and str(entry.get("status", "active")).lower() == "active" and entry.get("version"):
            versions.append(str(entry["version"]))
    return versions


def _valid_versions(versions: list[str]) -> list[str]:
    """Only version-shaped strings are used (they end up in a contract and a route): the others are ignored."""
    return [v for v in versions if VERSION_PATTERN.fullmatch(v)]


async def _wait_for_sync(client, config, key, sleep) -> int:
    """Poll until ``ready``; the number of polls before the one that saw it (0: ready at the first look)."""
    route = f"/services/{SERVICE_NAME}/synchronization"
    for attempt in range(config.poll_attempts):
        status = _sync_status(await _call(client, "synchronization", "GET", route, key))
        if status == "ready":
            return attempt
        if status in FAILED_STATUSES:
            raise BootstrapError(f"synchronization: the service synchronization is {status}")
        if attempt + 1 < config.poll_attempts:
            await sleep(config.poll_seconds)
    raise BootstrapError(f"synchronization: not ready after {config.poll_attempts} polls")


async def _lookup_contract(contracts: Any, user_id: str) -> Any:
    """The user's contract, or None when missing (the client returns None or raises SpaceApiError 404)."""
    try:
        return await contracts.get_contract(user_id)
    except SpaceApiError as exc:
        if exc.status_code == 404:
            return None
        raise


async def _contracts(contracts: Any, config: Config, version: str) -> dict[str, str]:
    from space_client.types.models import BillingPeriodToCreate, ContractToCreate, UserContact

    result: dict[str, str] = {}
    for username in SYNTHETIC_USERS:
        user_id = synthetic_user_id(username)
        failure = existing = stored = None
        try:
            existing = await _lookup_contract(contracts, user_id)
            if existing is None:
                await contracts.add_contract(ContractToCreate(
                    user_contact=UserContact(user_id=user_id, username=user_id, email=f"{username}@example.org", phone=""),
                    billing_period=BillingPeriodToCreate(auto_renew=True, renewal_days=30),
                    contracted_services={SERVICE_NAME: version},
                    subscription_plans={SERVICE_NAME: config.plan},
                    subscription_add_ons={},
                ))
                # add_contract returns None on a 4xx without raising: only reading it back confirms it.
                stored = await _lookup_contract(contracts, user_id)
        except Exception as exc:  # noqa: BLE001 - only the type reaches the message
            failure = type(exc).__name__
        if failure is not None:
            raise BootstrapError(f"contracts: {username} failed ({failure})")
        if existing is None and not _confirmed(stored, version, config.plan):
            raise BootstrapError(f"contracts: {username} not confirmed")
        result[username] = "exists" if existing is not None else "created"
    return result


# [impl->req~lab-space-remote-bootstrap-secrets~1]
def _connect(config: Config, key: str) -> Any:
    failure = None
    _scrub_proxy_environment()  # the SDK builds an httpx client that would read them, nothing is restored
    try:
        return SpaceClientFactory.connect_async(config.space_url, key, SDK_TIMEOUT_MS)
    except Exception as exc:  # noqa: BLE001 - only the type reaches the message
        failure = type(exc).__name__
    raise BootstrapError(f"contracts: the SPACE client could not be created ({failure})")


async def _close(sdk: Any, *, quiet: bool = False) -> None:
    failure = None
    try:
        await sdk.close()
    except Exception as exc:  # noqa: BLE001 - only the type reaches the message
        failure = type(exc).__name__
    if failure is not None and not quiet:
        raise BootstrapError(f"contracts: closing the SPACE client failed ({failure})")


# [impl->req~lab-space-remote-bootstrap~1]
async def bootstrap(config: Config, *, transport: httpx.AsyncBaseTransport | None = None, contracts: Any = None,
                    sleep: Callable[[float], Any] = asyncio.sleep) -> dict[str, Any]:
    # The HTTP sequence comes from the documentation of SPACE's main branch and is UNVERIFIED against a live v1.7.1.
    report: dict[str, Any] = {}
    async with httpx.AsyncClient(base_url=config.space_url, transport=transport, timeout=30.0,
                                 follow_redirects=False, trust_env=False) as client:
        key = config.api_key
        services = await _call(client, "service", "GET", "/services", key)
        if not isinstance(services, list):
            raise BootstrapError("service: GET /services returned no list")
        service = next((s for s in services if isinstance(s, Mapping) and s.get("name") == SERVICE_NAME), None)
        report["service"] = "exists" if service else "created"
        if service is not None:
            if "source" not in service and "sphere" not in service:
                # a summary entry of the list: the settings are read from the service itself (read-only)
                service = await _call(client, "service", "GET", f"/services/{SERVICE_NAME}", key)
                if not isinstance(service, Mapping):
                    raise BootstrapError(f"service: GET /services/{SERVICE_NAME} returned no document")
            if _service_settings(service) != (SOURCE, SPHERE_LINK, POLICY):
                raise BootstrapError("service: the existing openbinding service has another source, link or policy")
            # An existing service is not run again: ready is skipped, a synchronization in progress is awaited.
            polls = await _wait_for_sync(client, config, key, sleep)
            report["synchronization"] = "skipped" if polls == 0 else "ready"
        else:
            created = await _call(client, "service", "POST", "/services", key,
                                  {"source": SOURCE, "permanentUrl": SPHERE_LINK, "policy": POLICY})
            if not isinstance(created, Mapping) or created.get("name") != SERVICE_NAME:
                raise BootstrapError("service: the created service is not named openbinding")
            await _call(client, "synchronization", "POST", f"/services/{SERVICE_NAME}/synchronization/run", key)
            await _wait_for_sync(client, config, key, sleep)
            report["synchronization"] = "ready"

        versions = _valid_versions(
            _active_versions(await _call(client, "pricing", "GET", f"/services/{SERVICE_NAME}/pricings", key)))
        if not versions:
            raise BootstrapError("pricing: the openbinding service has no active pricing version")
        version = max(versions, key=_version_key)

        sdk = None
        if contracts is None:
            sdk = _connect(config, key)
            contracts = getattr(sdk, "contracts", None)
        try:
            report["contracts"] = await _contracts(contracts, config, version)
        except BaseException:
            if sdk is not None:
                await _close(sdk, quiet=True)
            raise
        if sdk is not None:
            await _close(sdk)
    return report


# [impl->req~lab-space-remote-bootstrap~1]
# [impl->req~lab-space-remote-bootstrap-secrets~1]
def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    _scrub_proxy_environment()  # before any client is built, whatever the mapping given for the configuration
    try:
        config = Config.from_environ(os.environ if environ is None else environ)
        report = asyncio.run(bootstrap(config))
    except BootstrapError as exc:
        print(f"space_lab_bootstrap: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - an unexpected error is reported by its type only, never its text
        print(f"space_lab_bootstrap: unexpected {type(exc).__name__}", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
