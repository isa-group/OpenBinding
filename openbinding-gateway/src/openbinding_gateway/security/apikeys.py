"""Personal API keys: how they are minted, stored and recognised.

A key looks like ``obk_<prefix>_<secret>``. The three parts each earn their
place: ``obk_`` makes a leaked key identifiable at a glance - by its owner, by a
secret scanner, and by the gateway when it has to tell a key from a session
token in the same header - the prefix names a row without being enough to use
it, and the secret is 256 bits of randomness.

Only a SHA-256 of the whole key is stored. That is deliberately not argon2:
password hashing is slow on purpose because passwords are guessable, and this
secret is not - it is uniformly random, so there is nothing to guess and no
reason to spend 100 ms of CPU on every API request proving it.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping, Optional

PREFIX_MARKER = "obk"
#: Bytes of randomness in the secret half.
SECRET_BYTES = 32
#: Hex characters in the lookup prefix. Eight is plenty to make collisions
#: negligible while staying short enough to show in a list.
PREFIX_HEX_CHARS = 8


class ApiKeyPermission(str, Enum):
    """One independently grantable API capability.

    API-key security schemes cannot carry OAuth scopes in OpenAPI, so these
    values are persisted with the key and documented on operations through an
    OpenBinding extension.  Keeping the vocabulary closed makes an unknown or
    misspelled permission fail closed instead of turning into future access.
    """

    ACCOUNT_READ = "account:read"
    ACCOUNT_WRITE = "account:write"
    KEYS_READ = "keys:read"
    KEYS_WRITE = "keys:write"
    INSTANCES_READ = "instances:read"
    INSTANCES_WRITE = "instances:write"
    INSTANCES_ANALYZE = "instances:analyze"
    JOBS_READ = "jobs:read"
    ENGINES_READ = "engines:read"
    ENGINES_EXECUTE = "engines:execute"
    ENGINES_REGISTER = "engines:register"
    ENGINES_PUBLISH = "engines:publish"
    ENGINES_MODERATE = "engines:moderate"
    EXTENSIONS_REGISTER = "extensions:register"
    EXTENSIONS_MODERATE = "extensions:moderate"
    ORGANIZATIONS_READ = "organizations:read"
    ORGANIZATIONS_WRITE = "organizations:write"
    PROJECTS_READ = "projects:read"
    PROJECTS_WRITE = "projects:write"
    STUDIES_READ = "studies:read"
    STUDIES_WRITE = "studies:write"
    REPORTS_READ = "reports:read"
    REPORTS_WRITE = "reports:write"
    ARTIFACTS_READ = "artifacts:read"
    ARTIFACTS_WRITE = "artifacts:write"
    NOTIFICATIONS_READ = "notifications:read"
    PRICING_READ = "pricing:read"
    PRICING_ADMIN = "pricing:admin"
    ADMIN_ACCOUNTS_READ = "admin:accounts:read"
    ADMIN_ACCOUNTS_WRITE = "admin:accounts:write"


ALL_PERMISSIONS = tuple(permission.value for permission in ApiKeyPermission)
ADMIN_PERMISSIONS = frozenset(
    {
        ApiKeyPermission.ENGINES_MODERATE.value,
        ApiKeyPermission.EXTENSIONS_MODERATE.value,
        ApiKeyPermission.ADMIN_ACCOUNTS_READ.value,
        ApiKeyPermission.ADMIN_ACCOUNTS_WRITE.value,
        ApiKeyPermission.PRICING_ADMIN.value,
    }
)
ENGINE_LIMITED_PERMISSIONS = frozenset(
    {
        ApiKeyPermission.ENGINES_READ.value,
        ApiKeyPermission.ENGINES_EXECUTE.value,
        ApiKeyPermission.ENGINES_REGISTER.value,
        ApiKeyPermission.ENGINES_PUBLISH.value,
        ApiKeyPermission.ENGINES_MODERATE.value,
        ApiKeyPermission.INSTANCES_ANALYZE.value,
        ApiKeyPermission.JOBS_READ.value,
        ApiKeyPermission.STUDIES_READ.value,
        ApiKeyPermission.STUDIES_WRITE.value,
    }
)
ENGINE_REF_FIELDS = ("namespace", "name", "version", "digest")


@dataclass(frozen=True)
class MintedKey:
    """A freshly minted key: what to show once, and what to keep."""

    #: The whole key. Shown to its owner exactly once and never stored.
    secret: str
    #: The lookup half, stored in the clear.
    prefix: str
    #: What actually goes in the database.
    secret_hash: str


def hash_key(full_key: str) -> str:
    return hashlib.sha256(full_key.encode("utf-8")).hexdigest()


def mint() -> MintedKey:
    prefix = f"{PREFIX_MARKER}_{secrets.token_hex(PREFIX_HEX_CHARS // 2)}"
    full_key = f"{prefix}_{secrets.token_urlsafe(SECRET_BYTES)}"
    return MintedKey(secret=full_key, prefix=prefix, secret_hash=hash_key(full_key))


def looks_like_api_key(credential: str) -> bool:
    """Whether this credential is one of ours rather than a session token.

    The two arrive in the same header, so something has to decide which
    resolution to attempt. The marker is what makes that decidable without
    trying both and hoping.
    """
    return credential.startswith(f"{PREFIX_MARKER}_")


def prefix_of(credential: str) -> Optional[str]:
    """The lookup prefix inside a key, or ``None`` if it is not shaped like one."""
    parts = credential.split("_")
    if len(parts) < 3 or parts[0] != PREFIX_MARKER:
        return None
    if not parts[1]:
        return None
    return f"{PREFIX_MARKER}_{parts[1]}"


def matches(credential: str, stored_hash: str) -> bool:
    """Whether a presented key is the one this hash was made from.

    Compared in constant time. The prefix already narrowed this to a single
    row, so the comparison is only ever against one candidate - but a timing
    difference here would still leak, one byte at a time, what that row holds.
    """
    return hmac.compare_digest(hash_key(credential), stored_hash)


BOUNDARY_FIELDS = ("methods", "organizations", "projects", "resourceKinds", "slugs")


def grants_document(
    permissions: list[str],
    *,
    all_engines: bool,
    engines: list[Mapping[str, str]],
    boundary: Mapping[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Return the one canonical JSON shape stored beside a key."""

    document = {
        "permissions": sorted(set(permissions)),
        "allEngines": bool(all_engines),
        "engines": [
            {field: str(reference[field]) for field in ENGINE_REF_FIELDS}
            for reference in engines
        ],
    }
    if boundary:
        document["boundary"] = {
            field: sorted(set(str(value) for value in boundary.get(field, [])))
            for field in BOUNDARY_FIELDS
            if boundary.get(field) is not None
        }
    return document


def boundary_of(api_key: Any) -> dict[str, frozenset[str]] | None:
    """Optional exact request boundary; malformed restrictions deny all."""

    grants = getattr(api_key, "grants", None)
    if not isinstance(grants, Mapping):
        return {}
    if "boundary" not in grants:
        return None
    boundary = grants.get("boundary")
    if not isinstance(boundary, Mapping) or set(boundary) - set(BOUNDARY_FIELDS):
        return {}
    parsed: dict[str, frozenset[str]] = {}
    for field, values in boundary.items():
        if not isinstance(values, list) or not all(isinstance(value, str) and value for value in values):
            return {}
        parsed[str(field)] = frozenset(values)
    return parsed


def boundary_is_subset(
    child: Mapping[str, list[str]], parent: dict[str, frozenset[str]] | None
) -> bool:
    """A child key may narrow an inherited boundary, never remove it."""

    if parent is None:
        return True
    for field, allowed in parent.items():
        requested = child.get(field)
        if requested is None or not set(requested) <= allowed:
            return False
    return True


def allows_request(api_key: Any, *, method: str, path_params: Mapping[str, Any], path: str) -> bool:
    """Apply optional method/entity restrictions after capability checks."""

    boundary = boundary_of(api_key)
    if boundary is None:
        return True
    if boundary == {}:
        return False
    methods = boundary.get("methods")
    if methods is not None and method.upper() not in methods:
        return False
    aliases = {
        "organizations": ("org", "organization", "organization_id", "org_id"),
        "projects": ("project", "project_id"),
        "slugs": ("slug", "case", "collection", "study", "report", "publication", "resource"),
    }
    for field, names in aliases.items():
        allowed = boundary.get(field)
        if allowed is None:
            continue
        values = {str(path_params[name]) for name in names if name in path_params}
        if values and not values <= allowed:
            return False
    kinds = boundary.get("resourceKinds")
    if kinds is not None:
        aliases = {
            "organizations": {"organization", "organizations"},
            "members": {"member", "members"},
            "invitations": {"invitation", "invitations"},
            "projects": {"project", "projects"},
            "cases": {"case", "cases"},
            "resources": {"resource", "resources"},
            "collections": {"collection", "collections"},
            "studies": {"study", "studies"},
            "runs": {"run", "runs"},
            "cells": {"cell", "cells"},
            "reports": {"report", "reports"},
            "publications": {"publication", "publications"},
            "artifacts": {"artifact", "artifacts"},
            "jobs": {"job", "jobs"},
            "instances": {"instance", "instances"},
            "engines": {"engine", "engines"},
            "engine-registrations": {"engine-registration", "engine-registrations"},
            "dialects": {"dialect", "dialects"},
            "profiles": {"profile", "profiles"},
            "pricing": {"pricing"},
            "notifications": {"notification", "notifications"},
        }
        # The last fixed collection in FastAPI's route template is the most
        # specific resource. Thus `/projects/{project}/cases` is a case
        # request, not a project request merely because it passes through one.
        target = next(
            (aliases[segment] for segment in reversed(path.split("/")) if segment in aliases),
            frozenset(),
        )
        if not target or not target & kinds:
            return False
    return True


def permissions_of(api_key: Any) -> frozenset[str]:
    """Known permissions on a key; malformed policy data grants nothing."""

    grants = getattr(api_key, "grants", None)
    if not isinstance(grants, Mapping):
        return frozenset()
    permissions = grants.get("permissions")
    if not isinstance(permissions, list) or not all(
        isinstance(permission, str) for permission in permissions
    ):
        return frozenset()
    known = set(ALL_PERMISSIONS)
    return frozenset(permission for permission in permissions if permission in known)


def exact_engine_reference(value: Any) -> tuple[str, str, str, str] | None:
    """A hashable immutable Engine reference, or ``None`` when malformed."""

    if not isinstance(value, Mapping) or set(value) != set(ENGINE_REF_FIELDS):
        return None
    fields = tuple(value.get(field) for field in ENGINE_REF_FIELDS)
    if not all(isinstance(field, str) and field for field in fields):
        return None
    return fields  # type: ignore[return-value]


def engine_access_of(api_key: Any) -> tuple[bool, frozenset[tuple[str, str, str, str]]]:
    """The Engine boundary on a key; malformed policy data fails closed."""

    grants = getattr(api_key, "grants", None)
    if not isinstance(grants, Mapping):
        return False, frozenset()
    all_engines = grants.get("allEngines")
    engines = grants.get("engines")
    if not isinstance(all_engines, bool) or not isinstance(engines, list):
        return False, frozenset()
    references = [exact_engine_reference(reference) for reference in engines]
    if any(reference is None for reference in references):
        return False, frozenset()
    exact = frozenset(reference for reference in references if reference is not None)
    # Ambiguous policy documents are denied rather than interpreted loosely.
    if all_engines and exact:
        return False, frozenset()
    return all_engines, exact


def authenticated_api_key(user: Any) -> Any | None:
    """The key that authenticated this request, or ``None`` for a session."""

    return getattr(user, "_authenticated_api_key", None)


def allows_engine(user: Any, reference: Mapping[str, str]) -> bool:
    """Whether this caller may discover or execute one exact Engine revision."""

    api_key = authenticated_api_key(user)
    if api_key is None:
        return True
    wanted = exact_engine_reference(reference)
    if wanted is None:
        return False
    all_engines, engines = engine_access_of(api_key)
    return all_engines or wanted in engines


def required_permissions(path: str, method: str) -> frozenset[str]:
    """Permissions required by one protected route.

    This table is shared by runtime authorization and OpenAPI generation, so a
    documented permission cannot silently drift away from enforcement.
    ``path`` may be either the concrete URL or FastAPI's path template.
    """

    method = method.upper()
    if path.startswith("/v1/users/me/api-keys"):
        return frozenset(
            {ApiKeyPermission.KEYS_READ.value}
            if method == "GET"
            else {ApiKeyPermission.KEYS_WRITE.value}
        )
    if path == "/v1/auth/cas/link-intent":
        return frozenset({ApiKeyPermission.ACCOUNT_WRITE.value})
    if path.startswith("/v1/users/me/jobs"):
        return frozenset({ApiKeyPermission.JOBS_READ.value})
    if path.startswith("/v1/users/me"):
        return frozenset(
            {ApiKeyPermission.ACCOUNT_READ.value}
            if method == "GET"
            else {ApiKeyPermission.ACCOUNT_WRITE.value}
        )
    if path.startswith("/v1/admin"):
        if path.startswith("/v1/admin/pricing"):
            return frozenset({ApiKeyPermission.PRICING_ADMIN.value})
        return frozenset(
            {ApiKeyPermission.ADMIN_ACCOUNTS_READ.value}
            if method == "GET"
            else {ApiKeyPermission.ADMIN_ACCOUNTS_WRITE.value}
        )
    if "/projects" in path:
        if any(token in path for token in ("/studies", "/runs")):
            return frozenset(
                {ApiKeyPermission.STUDIES_READ.value}
                if method == "GET"
                else {ApiKeyPermission.STUDIES_WRITE.value}
            )
        if any(token in path for token in ("/reports", "/publications")):
            return frozenset(
                {ApiKeyPermission.REPORTS_READ.value}
                if method == "GET"
                else {ApiKeyPermission.REPORTS_WRITE.value}
            )
        if "/artifacts" in path:
            return frozenset(
                {ApiKeyPermission.ARTIFACTS_READ.value}
                if method == "GET"
                else {ApiKeyPermission.ARTIFACTS_WRITE.value}
            )
        return frozenset(
            {ApiKeyPermission.PROJECTS_READ.value}
            if method == "GET"
            else {ApiKeyPermission.PROJECTS_WRITE.value}
        )
    if path.startswith("/v1/organizations"):
        return frozenset(
            {ApiKeyPermission.ORGANIZATIONS_READ.value}
            if method == "GET"
            else {ApiKeyPermission.ORGANIZATIONS_WRITE.value}
        )
    if path.startswith("/v1/invitations"):
        return frozenset({ApiKeyPermission.ORGANIZATIONS_WRITE.value})
    if path.startswith("/v1/notifications"):
        return frozenset({ApiKeyPermission.NOTIFICATIONS_READ.value})
    if path.startswith("/v1/pricing"):
        return frozenset({ApiKeyPermission.PRICING_READ.value})
    if path.endswith("/approve") or path.endswith("/reject"):
        if path.startswith("/v1/engine-registrations"):
            return frozenset({ApiKeyPermission.ENGINES_MODERATE.value})
        return frozenset({ApiKeyPermission.EXTENSIONS_MODERATE.value})
    if path == "/v1/dialects" and method == "POST":
        return frozenset({ApiKeyPermission.EXTENSIONS_REGISTER.value})
    if path == "/v1/resources" and method == "POST":
        return frozenset({ApiKeyPermission.EXTENSIONS_REGISTER.value})
    if path == "/v1/catalog":
        return frozenset({ApiKeyPermission.ENGINES_READ.value})
    if path.startswith("/v1/engines"):
        return frozenset(
            {ApiKeyPermission.ENGINES_READ.value}
            if method == "GET"
            else {ApiKeyPermission.ENGINES_REGISTER.value}
        )
    if path.startswith("/v1/engine-registrations"):
        if path.endswith("/publication-request"):
            return frozenset({ApiKeyPermission.ENGINES_PUBLISH.value})
        if method == "GET":
            return frozenset({ApiKeyPermission.ENGINES_READ.value})
        return frozenset({ApiKeyPermission.ENGINES_REGISTER.value})
    if path == "/v1/analyze":
        return frozenset({ApiKeyPermission.INSTANCES_ANALYZE.value})
    if path.startswith("/v1/instances"):
        return frozenset(
            {ApiKeyPermission.INSTANCES_READ.value}
            if method == "GET"
            else {ApiKeyPermission.INSTANCES_WRITE.value}
        )
    if path.startswith("/v1/jobs"):
        return frozenset(
            {ApiKeyPermission.JOBS_READ.value}
            if method == "GET"
            else {ApiKeyPermission.ENGINES_EXECUTE.value}
        )
    return frozenset()
