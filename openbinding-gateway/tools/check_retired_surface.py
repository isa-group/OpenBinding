#!/usr/bin/env python3
"""Check that the surface F0b retired stays retired.

F0b removed projects, the raw BIM API (instances, snapshots, the old validators, profiles, dialects and
examples), the artifact store and the library, the problem-authoring Composition2Yaml and the ``/v1/jobs``
routes. Nothing is in production, so none of them has an alias or a redirect; this tool fails when any of
them comes back:

* no route path of the gateway contains a retired fragment (``RETIRED_PATH_FRAGMENTS``); the BIM services
  live under ``/v1/bim`` only, so a bare ``/v1/validate`` or ``/v1/examples`` is retired too;
* no table of ``Base.metadata`` is a retired one (``RETIRED_TABLES``, which the schema tests also check
  against the migrated database);
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

#: Path fragments of the routes F0b removed. A route whose path contains one of them is back.
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
    "/v1/compositions",
    "/v1/jobs",
)

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
    from openbinding_gateway.db.base import Base
    from openbinding_gateway.main import app

    lines = [f"retired route: {path}" for path in retired_routes(route_paths(app))]
    lines += [f"retired table: {name}" for name in retired_tables(Base.metadata.tables)]
    lines += [f"entitlement id outside the map: {hit}" for hit in ids_outside_the_map()]
    return lines


def main() -> int:
    sys.path.insert(0, str(GATEWAY_ROOT / "src"))
    found = findings()
    for line in found:
        print(line)
    if not found:
        print("check_retired_surface: no retired route, table or spelled entitlement id")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
