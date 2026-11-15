"""The surface F0b retired stays retired: ``tools/check_retired_surface.py`` in the gateway suite.

No route path holds a retired fragment (projects, the raw BIM API, the artifact store and library, the old
Composition2Yaml, ``/v1/jobs``), no modelled table is retired, and no entitlement id is spelled outside the
entitlement map. Each check is also shown to see what it looks for.
"""

from __future__ import annotations

import subprocess
import sys

import pytest
from fastapi import APIRouter, FastAPI

from _paths import GATEWAY_ROOT, gateway_tool
from openbinding_gateway.db import models  # noqa: F401  (every table)
from openbinding_gateway.db.base import Base
from openbinding_gateway.main import app

surface = gateway_tool("check_retired_surface")


def test_no_route_of_the_gateway_is_retired():
    paths = surface.route_paths(app)

    # Guards against a walk that finds nothing, which would make "no retired route" mean nothing.
    assert len(paths) > 80
    assert {"/v1/bim/validate", "/v1/organizations/{org}/runs", "/v1/engines/protocol"} <= set(paths)
    assert surface.retired_routes(paths) == []


@pytest.mark.parametrize(
    "path",
    [
        "/v1/organizations/{org}/projects",
        "/v1/instances/validate",
        "/v1/snapshots/{snapshot}",
        "/v1/validate",
        "/v1/profiles",
        "/v1/dialects",
        "/v1/examples/{path}",
        "/v1/artifacts/{artifact}",
        "/v1/organizations/{org}/library",
        "/v1/compositions/compile",
        "/v1/jobs/{job_id}",
    ],
)
def test_a_retired_route_is_found_also_inside_an_included_router(path):
    planted = FastAPI()
    router = APIRouter()
    router.add_api_route(path, lambda: None)
    router.add_api_route("/v1/bim/validate", lambda: None)
    planted.include_router(router)

    assert surface.retired_routes(surface.route_paths(planted)) == [path]


def test_the_bim_services_live_under_v1_bim_only():
    assert surface.retired_routes(["/v1/bim/validate", "/v1/bim/templates/{template}"]) == []
    assert surface.retired_routes(["/v1/validate", "/v1/examples"]) == ["/v1/validate", "/v1/examples"]


def test_no_modelled_table_is_retired():
    assert surface.retired_tables(Base.metadata.tables) == []
    assert surface.retired_tables(["jobs", "projects", "artifacts"]) == ["artifacts", "projects"]


def test_no_entitlement_id_is_a_string_literal_outside_the_map():
    assert surface.ENTITLEMENT_MAP.is_file()
    assert surface.ids_outside_the_map() == []


def test_the_scan_sees_a_spelled_id(tmp_path):
    planted = tmp_path / "planted.py"
    planted.write_text(
        'caps.limit("maxApiKeys")\nservice.feature_refusal(caps, "runs")\nquery.limit(1)\ncaps.limit(ids.MAX_API_KEYS)\n',
        encoding="utf-8",
    )
    (tmp_path / "entitlement_map.py").write_text('caps.limit("maxApiKeys")\n', encoding="utf-8")

    assert surface.spelled_ids(planted, tmp_path) == ["planted.py:1", "planted.py:2"]
    assert surface.ids_outside_the_map(tmp_path, tmp_path / "entitlement_map.py") == ["planted.py:1", "planted.py:2"]


def test_the_tool_passes_on_this_checkout():
    done = subprocess.run(
        [sys.executable, "tools/check_retired_surface.py"], cwd=GATEWAY_ROOT, capture_output=True, text=True, check=False,
    )

    assert done.returncode == 0, done.stdout + done.stderr
    assert "no retired route, table or spelled entitlement id" in done.stdout


def test_the_composition2yaml_services_are_not_the_retired_language():
    services = [f"/v1/compositions/{name}" for name in ("validate", "parse", "serialise", "diff", "schema")]
    assert surface.retired_routes(services) == []
    retired = [f"/v1/compositions/{name}" for name in ("compile", "package", "import", "language")]
    assert surface.retired_routes(retired) == retired
