"""API-key authorization is deny-by-default under /v1.

Walks the real FastAPI route table, so a /v1 route added later without a
permission (or an entry in the open allowlist) fails here instead of being
silently open to every API key.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import Depends
from fastapi.routing import APIRoute

from _b1_helpers import make_account, make_key, gate  # noqa: F401,F811
from openbinding_gateway.access.dependencies import get_current_user
from openbinding_gateway.main import app
from openbinding_gateway.security import apikeys
from openbinding_gateway.security.apikeys import (
    ALL_PERMISSIONS,
    OPEN_V1_GET_PATHS,
    OPEN_V1_PREFIXES,
    UNCLASSIFIED_ROUTE_PERMISSION,
    allows_request,
    required_permissions,
)


def v1_routes() -> list[tuple[str, str]]:
    found = set()
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute) and route.path.startswith("/v1"):
                found.update((method, route.path) for method in route.methods - {"HEAD", "OPTIONS"})
    return sorted(found)


ROUTES = v1_routes()


def is_open(method: str, path: str) -> bool:
    return (
        path.startswith(OPEN_V1_PREFIXES)
        or (method == "GET" and path in OPEN_V1_GET_PATHS)
    )


def test_the_route_table_has_the_v1_surface():
    assert len(ROUTES) == 114


def test_the_unclassified_permission_cannot_be_granted():
    assert UNCLASSIFIED_ROUTE_PERMISSION not in ALL_PERMISSIONS


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_v1_route_is_open_by_allowlist_or_needs_a_permission(method, path):
    permissions = required_permissions(path, method)

    assert UNCLASSIFIED_ROUTE_PERMISSION not in permissions, f"classify {method} {path}"
    if permissions:
        assert permissions <= set(ALL_PERMISSIONS)
    else:
        assert is_open(method, path), f"{method} {path} is open but not in the allowlist"


def test_pricing_administration_has_no_permission_and_no_route():
    assert "pricing:admin" not in ALL_PERMISSIONS
    assert not [route for route in ROUTES if route[1].startswith("/v1/admin/pricing")]
    # Every /v1/admin route is an account administration route.
    assert required_permissions("/v1/admin/pricing/validate", "POST") == frozenset({"admin:accounts:write"})
    assert ("GET", "/v1/pricing") not in ROUTES


def test_explore_is_gone_and_reports_need_no_permission():
    assert not [route for route in ROUTES if route[1].startswith("/v1/explore")]
    assert not {"reports:read", "reports:write"} & set(ALL_PERMISSIONS)


def test_the_analysis_workspace_is_gone_and_the_neighbourhood_stays_a_run_read():
    neighbourhood = "/v1/organizations/{org}/runs/{run}/neighborhood"

    assert not [route for route in ROUTES if route[1].startswith("/v1/analysis")]
    assert ("GET", neighbourhood) in ROUTES
    assert required_permissions(neighbourhood, "GET") == frozenset({"jobs:read"})
    # A retired /v1/analysis path is unrouted, so it is no longer classified either.
    assert required_permissions("/v1/analysis/pareto", "POST") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
    assert not hasattr(apikeys, "analysis_work_permissions")
    # Existing keys may hold it; it still guards kept operations (design D6).
    assert "engines:execute" in ALL_PERMISSIONS
    # A run-scoped key reads the neighbourhood: the last fixed segment is ``runs``.
    runs_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["run"]}})
    projects_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["project"]}})
    request = {"method": "GET", "path_params": {"org": "acme", "run": "r1"}, "path": neighbourhood}
    assert allows_request(runs_only, **request)
    assert not allows_request(projects_only, **request)


def test_the_runs_of_an_organization_are_jobs_reads_and_engine_executions():
    runs = "/v1/organizations/{org}/runs"

    assert not [route for route in ROUTES if route[1].startswith("/v1/jobs") or route[1] == "/v1/users/me/jobs"]
    assert required_permissions(runs, "GET") == required_permissions(f"{runs}/{{run}}", "GET") == frozenset({"jobs:read"})
    assert required_permissions(f"{runs}/{{run}}/events", "GET") == frozenset({"jobs:read"})
    for path in (runs, f"{runs}/{{run}}/cancel", f"{runs}/{{run}}/retry", f"{runs}/{{run}}/reevaluate"):
        assert required_permissions(path, "POST") == frozenset({"engines:execute"}), path
    # The organizations fallback does not reach the runs, and the runs branch does not take the study runs.
    assert "organizations:write" not in required_permissions(runs, "POST")
    study_runs = "/v1/organizations/{org}/studies/{study}/runs"
    assert required_permissions(study_runs, "POST") == frozenset({"studies:write"})
    assert required_permissions(f"{study_runs}/{{run_id}}", "GET") == frozenset({"studies:read"})


def test_the_studies_of_an_organization_are_study_reads_and_writes():
    studies = "/v1/organizations/{org}/studies"
    study_routes = [route for route in ROUTES if route[1].startswith(studies)]
    assert len(study_routes) >= 12
    for method, path in study_routes:
        expected = "studies:read" if method == "GET" else "studies:write"
        assert required_permissions(path, method) == frozenset({expected}), (method, path)
    assert not [route for route in ROUTES if "/projects/{project}/studies" in route[1]]


def test_the_library_reports_and_project_resources_are_gone():
    project = "/v1/organizations/{org}/projects/{project}"
    retired = {
        ("POST", "/v1/organizations/{org}/library"),
        ("PATCH", "/v1/artifacts/{artifact_id}"),
        ("POST", "/v1/artifacts/{artifact_id}/drafts"),
        ("POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/publish"),
        ("PUT", f"{project}/library/{{artifact_id}}"),
        ("GET", f"{project}/reports"),
        ("POST", f"{project}/reports"),
        ("GET", f"{project}/publications"),
        ("POST", f"{project}/publications"),
        ("DELETE", f"{project}/publications/{{publication}}"),
        ("POST", f"{project}/resources"),
        ("PATCH", f"{project}/resources/{{resource}}"),
        # The artifact store, the library and the project resources went in F0b B7.
        ("GET", "/v1/organizations/{org}/library"),
        ("GET", "/v1/artifacts/{artifact_id}/versions"),
        ("GET", "/v1/artifacts/{artifact_id}/versions/{version_id}/content"),
        ("POST", "/v1/artifacts/resolve"),
        ("GET", f"{project}/resources"),
        ("GET", f"{project}/resources/{{resource}}/revisions"),
    }
    assert not retired & set(ROUTES)
    assert not [route for route in ROUTES if route[1].startswith("/v1/artifacts") or "/library" in route[1]]


def test_unknown_paths_are_denied_under_v1_and_untouched_elsewhere():
    assert required_permissions("/v1/brand-new", "GET") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
    assert required_permissions("/v1/resources", "GET") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
    assert required_permissions("/v1/schemas/Instance", "GET") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
    assert required_permissions("/v1/dialects", "DELETE") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
    assert required_permissions("/health", "GET") == frozenset()


async def test_an_unclassified_route_is_forbidden_to_a_key_but_not_to_a_session(
    api_client, registration, db_session, gate  # noqa: F811
):
    async def probe(user=Depends(get_current_user)) -> dict:
        return {"ok": True}

    app.add_api_route("/v1/zz-unclassified-probe", probe, methods=["GET"])
    try:
        _, session_headers = await make_account(api_client, registration, db_session, gate, admin=True)
        key_headers = await make_key(api_client, session_headers, list(ALL_PERMISSIONS))

        with_key = await api_client.get("/v1/zz-unclassified-probe", headers=key_headers)
        with_session = await api_client.get("/v1/zz-unclassified-probe", headers=session_headers)
    finally:
        app.router.routes[:] = [
            route for route in app.router.routes
            if getattr(route, "path", None) != "/v1/zz-unclassified-probe"
        ]

    assert with_key.status_code == 403, with_key.text
    assert with_key.json()["detail"]["code"] == "insufficient_api_key_permission"
    assert with_key.json()["detail"]["missing_permissions"] == [UNCLASSIFIED_ROUTE_PERMISSION]
    assert with_session.status_code == 200
