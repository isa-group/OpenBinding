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
        or (method == "GET" and path == "/v1/resources/{name}")
    )


def test_the_route_table_has_the_v1_surface():
    assert len(ROUTES) > 100


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


def test_explore_is_not_in_the_open_allowlist():
    assert not any(path.startswith("/v1/explore") for path in OPEN_V1_PREFIXES)
    assert not any(path.startswith("/v1/explore") for path in OPEN_V1_GET_PATHS)
    assert required_permissions("/v1/explore/projects", "GET") == frozenset({"projects:read"})
    assert required_permissions("/v1/explore/publications", "GET")
    assert required_permissions("/v1/explore/engines", "GET")


def test_the_analysis_workspace_is_gone_and_the_neighbourhood_stays_a_job_read():
    neighbourhood = "/v1/jobs/{job_id}/analysis/neighborhood"

    assert not [route for route in ROUTES if route[1].startswith("/v1/analysis")]
    assert ("GET", neighbourhood) in ROUTES
    assert required_permissions(neighbourhood, "GET") == frozenset({"jobs:read"})
    # A retired /v1/analysis path is unrouted, so it is no longer classified either.
    assert required_permissions("/v1/analysis/pareto", "POST") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
    assert not hasattr(apikeys, "analysis_work_permissions")
    # Existing keys may hold these; both still guard kept operations (design D6).
    assert {"reports:write", "engines:execute"} <= set(ALL_PERMISSIONS)
    # The "analysis" alias lets a job-scoped key read the neighbourhood (design D5).
    jobs_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["job"]}})
    projects_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["project"]}})
    request = {"method": "GET", "path_params": {"job_id": "j1"}, "path": neighbourhood}
    assert allows_request(jobs_only, **request)
    assert not allows_request(projects_only, **request)


def test_the_library_report_and_resource_writes_are_gone_and_the_kept_reads_keep_their_permissions():
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    project = "/v1/organizations/{org}/projects/{project}"
    retired = {
        ("POST", "/v1/organizations/{org}/library"),
        ("PATCH", "/v1/artifacts/{artifact_id}"),
        ("POST", "/v1/artifacts/{artifact_id}/drafts"),
        ("POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/publish"),
        ("PUT", f"{project}/library/{{artifact_id}}"),
        ("POST", f"{project}/reports"),
        ("POST", f"{project}/publications"),
        ("POST", f"{project}/resources"),
        ("PATCH", f"{project}/resources/{{resource}}"),
    }
    assert not retired & set(ROUTES)
    # The kept operations of the same areas stay classified as before (design D6: reports:write still guards K3).
    kept = {
        ("GET", "/v1/organizations/{org}/library"): {"artifacts:read"},
        ("GET", "/v1/artifacts/{artifact_id}/versions"): {"artifacts:read"},
        ("POST", "/v1/artifacts/resolve"): {"artifacts:read"},
        ("GET", f"{project}/reports"): {"reports:read"},
        ("DELETE", f"{project}/publications/{{publication}}"): {"reports:write"},
        ("GET", f"{project}/resources/{{resource}}/revisions"): {"projects:read"},
    }
    for (method, path), permissions in kept.items():
        assert (method, path) in ROUTES
        assert required_permissions(path, method) == frozenset(permissions), (method, path)


def test_unknown_paths_are_denied_under_v1_and_untouched_elsewhere():
    assert required_permissions("/v1/brand-new", "GET") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
    assert required_permissions("/v1/resources/x/y", "GET") == frozenset({UNCLASSIFIED_ROUTE_PERMISSION})
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
