#!/usr/bin/env python3
"""Check that the surface F0b retired stays retired.

F0b removed projects, the raw BIM API (instances, snapshots, the old validators, profiles, dialects and
examples), the artifact store and the library, the problem-authoring Composition2Yaml and the ``/v1/jobs``
routes; F5 removed the refresh tokens, the local logout and US CAS (its routes, settings and ``cas_verified``).
Nothing is in production, so none of them has an alias or a redirect; this tool fails when any of
them comes back:

* no route path of the gateway contains a retired fragment (``RETIRED_PATH_FRAGMENTS``); the BIM services
  live under ``/v1/bim`` only, so a bare ``/v1/validate`` or ``/v1/examples`` is retired too;
* no table of ``Base.metadata`` is a retired one (``RETIRED_TABLES``, which the schema tests also check
  against the migrated database);
* no setting of ``Settings`` is a retired one (``RETIRED_SETTINGS``), and no schema of the OpenAPI document has a
  retired property (``RETIRED_SCHEMA_PROPERTIES``);
* no entitlement id is spelled as a string literal outside ``modules/plans/domain/entitlement_map.py``
  (decision D15: the map is the only place the pricing ids are written).

    python tools/check_retired_surface.py       # exit 1 and one line per finding when something is back

``tests/test_retired_surface.py`` runs the same checks in the gateway suite.
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Iterable
from pathlib import Path

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
SOURCE = GATEWAY_ROOT / "src" / "openbinding_gateway"
ENTITLEMENT_MAP = SOURCE / "modules" / "plans" / "domain" / "entitlement_map.py"

#: Path fragments of the routes F0b (and later phases) removed. A route whose path contains one of them is back.
RETIRED_PATH_FRAGMENTS = (
    "/projects",
    "/v1/instances",
    "/v1/snapshots",
    "/v1/validate",
    "/v1/profiles",
    "/v1/dialects",
    "/v1/examples",
    "/v1/artifacts",
    "/library",
    # The operations of the old problem-authoring language. ``/v1/compositions`` itself is the
    # Composition2Yaml services' prefix again (F1).
    "/v1/compositions/compile",
    "/v1/compositions/package",
    "/v1/compositions/import",
    "/v1/compositions/language",
    "/v1/jobs",
    # F3: the keyed SPHERE proxy; OpenBinding's pricing is /v1/plans/pricing (the fragment does not match it).
    "/v1/pricing/",
    # F5-B: one session model. The browser's session is the HttpOnly cookie, renewed at /v1/auth/identity/session and
    # ended at /v1/auth/identity/logout; the refresh token and the local logout are gone.
    "/v1/auth/refresh",
    "/v1/auth/logout",
    # F5-B: US CAS. SCORETech Identity is the only external sign-in; accounts link no identities by hand.
    "/v1/auth/cas/",
    "/v1/users/me/identities",
)

#: Settings of retired features (F5-B: US CAS). None may come back as a field of ``Settings``.
RETIRED_SETTINGS = frozenset({
    "cas_enabled",
    "cas_environment",
    "cas_base_url",
    "cas_state_ttl_s",
    "cas_exchange_ttl_s",
    "cas_store_backend",
})

#: Properties of retired views. None may be a property of a schema of the OpenAPI document.
RETIRED_SCHEMA_PROPERTIES = frozenset({
    # F5-B: US CAS. RESEARCH rests on ``email_verified`` and ``institutional_email``.
    "cas_verified",
})

#: Tables that features removed before or during F0b used to own. None may be modelled or migrated again.
RETIRED_TABLES = frozenset({
    # Before F0b (M9.6 and the pricing and federation work).
    "analysis_tasks",
    "federated_engines",
    "pricing_releases",
    "sponsor_proposals",
    # F0b B1: the leftovers of the features F0a removed.
    "artifact_evidence",
    "collection_items",
    "collection_revisions",
    "collections",
    "publications",
    "reports",
    "v1_dialect_revisions",
    "v1_registered_resource_revisions",
    # F0b B5: problems hang off the organization; snapshots fused into revisions and compilations.
    "case_artifacts",
    "v1_binding_ir",
    "v1_instance_resources",
    "v1_instance_snapshots",
    # F0b B6: runs move under the organization; the write-only run provenance copy goes (D28).
    "v1_job_provenance",
    # F0b B7: study runs freeze their definitions; the artifact store and the project resources go.
    "artifact_case_references",
    "artifact_dependencies",
    "artifact_drafts",
    "artifact_publications",
    "artifact_versions",
    "artifacts",
    "project_artifacts",
    "project_resource_revisions",
    "project_resources",
    # F0b B8: projects go; the organization is the only container.
    "projects",
    # F5-B: one session model (identity_sessions) replaces the rotated refresh tokens.
    "refresh_tokens",
})

#: The calls that take an entitlement id, and which positional argument it is.
ID_ARGUMENT = {"limit": 0, "allows": 0, "feature_refusal": 1, "require_feature": 1}


def route_paths(app) -> list[str]:
    """Every path the application routes, the included routers' routes among them."""
    from fastapi.routing import APIRoute
    from starlette.routing import Route

    found: set[str] = set()
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, (APIRoute, Route)):
                found.add(route.path)
    return sorted(found)


def retired_routes(paths: Iterable[str]) -> list[str]:
    """The paths that contain a retired fragment."""
    return [path for path in paths if any(fragment in path for fragment in RETIRED_PATH_FRAGMENTS)]


def retired_tables(table_names: Iterable[str]) -> list[str]:
    """The table names that are retired."""
    return sorted(RETIRED_TABLES.intersection(table_names))


def retired_settings(field_names: Iterable[str]) -> list[str]:
    """The settings that are retired."""
    return sorted(RETIRED_SETTINGS.intersection(field_names))


def retired_properties(openapi: dict) -> list[str]:
    """``Schema.property`` for every retired property of a schema of an OpenAPI document."""
    found = []
    for name, schema in sorted(openapi.get("components", {}).get("schemas", {}).items()):
        for prop in schema.get("properties", {}) or {}:
            if prop in RETIRED_SCHEMA_PROPERTIES:
                found.append(f"{name}.{prop}")
    return found


def spelled_ids(path: Path, root: Path = SOURCE) -> list[str]:
    """``file:line`` of every string literal passed as an entitlement id in one source file."""
    found: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        name = function.attr if isinstance(function, ast.Attribute) else getattr(function, "id", None)
        position = ID_ARGUMENT.get(name or "")
        if position is None or len(node.args) <= position:
            continue
        argument = node.args[position]
        if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
            found.append(f"{path.relative_to(root)}:{node.lineno}")
    return found


def ids_outside_the_map(source: Path = SOURCE, entitlement_map: Path = ENTITLEMENT_MAP) -> list[str]:
    """Every entitlement id spelled as a literal anywhere in ``source`` but the entitlement map."""
    return [hit for path in sorted(source.rglob("*.py")) if path != entitlement_map for hit in spelled_ids(path, source)]


def findings() -> list[str]:
    """One line per piece of retired surface that is back; empty when there is none."""
    from openbinding_gateway.db import models  # noqa: F401  (every table)
    from openbinding_gateway.core.settings import Settings
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.main import app

    lines = [f"retired route: {path}" for path in retired_routes(route_paths(app))]
    lines += [f"retired table: {name}" for name in retired_tables(Base.metadata.tables)]
    lines += [f"retired setting: {name}" for name in retired_settings(Settings.model_fields)]
    lines += [f"retired property: {name}" for name in retired_properties(app.openapi())]
    lines += [f"entitlement id outside the map: {hit}" for hit in ids_outside_the_map()]
    return lines


def main() -> int:
    sys.path.insert(0, str(GATEWAY_ROOT / "src"))
    found = findings()
    for line in found:
        print(line)
    if not found:
        print("check_retired_surface: no retired route, table, setting, property or spelled entitlement id")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
