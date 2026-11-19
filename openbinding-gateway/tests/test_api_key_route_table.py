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
    assert len(ROUTES) == 189


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
    # The keyed SPHERE proxy and its permission went in F3; OpenBinding's pricing is /v1/plans/pricing, open.
    assert not [route for route in ROUTES if route[1].startswith("/v1/pricing")]
    assert "pricing" + ":read" not in ALL_PERMISSIONS
    assert required_permissions("/v1/plans/pricing", "GET") == frozenset() and is_open("GET", "/v1/plans/pricing")


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
    problems_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["problem"]}})
    request = {"method": "GET", "path_params": {"org": "acme", "run": "r1"}, "path": neighbourhood}
    assert allows_request(runs_only, **request)
    assert not allows_request(problems_only, **request)


def test_the_facts_of_a_compilation_are_a_problem_read():
    facts = "/v1/organizations/{org}/problems/{problem}/revisions/{revision}/compilations/{compilation}/facts"

    assert ("GET", facts) in ROUTES
    assert required_permissions(facts, "GET") == frozenset({"problems:read"})
    # A problem-scoped key reads them; a run-scoped one does not.
    request = {"method": "GET", "path_params": {"org": "acme", "problem": "p", "revision": "1", "compilation": "c"}, "path": facts}
    assert allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["problem"]}}), **request)
    assert not allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["run"]}}), **request)


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


def test_projects_are_gone_with_their_permissions_and_boundary():
    assert not [route for route in ROUTES if "/projects" in route[1] or "{project}" in route[1]]
    assert not {"projects:read", "projects:write"} & set(ALL_PERMISSIONS)
    assert "projects" not in apikeys.BOUNDARY_FIELDS
    # The organization tree holds only the organization, its avatar, members, invitations, audit, problems, runs,
    # run presets, studies, compositions, connections, SPHERE discovery and pricing snapshots.
    sections = {route[1].split("/")[4] for route in ROUTES if route[1].startswith("/v1/organizations/{org}/")}
    assert sections == {
        "avatar", "avatar-colors", "hierarchy", "profile", "owner", "members", "invitations", "audit", "problems", "runs", "presets", "studies",
        "compositions", "connections", "sphere", "pricing-snapshots",
    }
    # A stored boundary that still names projects is malformed, and a malformed boundary denies everything.
    stale = SimpleNamespace(grants={"boundary": {"projects": ["p"]}})
    assert not allows_request(stale, method="GET", path_params={"org": "acme"}, path="/v1/organizations/{org}")


def test_the_library_reports_and_project_resources_are_gone():
    retired = {
        ("POST", "/v1/organizations/{org}/library"),
        ("PATCH", "/v1/artifacts/{artifact_id}"),
        ("POST", "/v1/artifacts/{artifact_id}/drafts"),
        ("POST", "/v1/artifacts/{artifact_id}/versions/{version_id}/publish"),
        # The artifact store, the library and the project resources went in F0b B7.
        ("GET", "/v1/organizations/{org}/library"),
        ("GET", "/v1/artifacts/{artifact_id}/versions"),
        ("GET", "/v1/artifacts/{artifact_id}/versions/{version_id}/content"),
        ("POST", "/v1/artifacts/resolve"),
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


def test_the_composition2yaml_services_need_compositions_read_and_the_schema_is_open():
    language = [route for route in ROUTES if route[1].startswith("/v1/compositions/")]

    assert sorted(language) == [
        ("GET", "/v1/compositions/schema"),
        ("POST", "/v1/compositions/diff"),
        ("POST", "/v1/compositions/parse"),
        ("POST", "/v1/compositions/serialise"),
        ("POST", "/v1/compositions/validate"),
    ]
    for method, path in language:
        expected = frozenset() if method == "GET" else frozenset({"compositions:read"})
        assert required_permissions(path, method) == expected, path
    assert is_open("GET", "/v1/compositions/schema")
    assert {"compositions:read", "compositions:write"} <= set(ALL_PERMISSIONS)


def test_the_public_compositions_of_every_organization_are_a_composition_read():
    assert ("GET", "/v1/compositions") in ROUTES
    assert required_permissions("/v1/compositions", "GET") == frozenset({"compositions:read"})
    assert not is_open("GET", "/v1/compositions")
    # A key scoped to compositions lists them; one scoped to problems does not.
    request = {"method": "GET", "path_params": {}, "path": "/v1/compositions"}
    assert allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["composition"]}}), **request)
    assert not allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["problem"]}}), **request)


def test_the_compositions_of_an_organization_have_their_own_permissions():
    compositions = "/v1/organizations/{org}/compositions"
    read, write = frozenset({"compositions:read"}), frozenset({"compositions:write"})

    assert required_permissions(compositions, "GET") == read
    assert required_permissions(f"{compositions}/{{composition}}/versions", "GET") == read
    assert required_permissions(f"{compositions}/{{composition}}/versions/check", "POST") == read
    assert required_permissions(f"{compositions}/{{composition}}/versions/{{version}}/evaluate", "POST") == read
    assert required_permissions(compositions, "POST") == write
    assert required_permissions(f"{compositions}/{{composition}}", "PATCH") == write
    assert required_permissions(f"{compositions}/{{composition}}", "DELETE") == write
    assert required_permissions(f"{compositions}/{{composition}}/versions", "POST") == write
    assert required_permissions(f"{compositions}/{{composition}}/diff", "GET") == read
    assert required_permissions(f"{compositions}/{{composition}}/fork", "POST") == write
    assert required_permissions(f"{compositions}/{{composition}}/evaluate", "POST") == read
    assert required_permissions(f"{compositions}/{{composition}}/neighborhood", "GET") == read
    assert required_permissions(f"{compositions}/{{composition}}/versions/{{version}}/evaluations", "POST") == write
    assert required_permissions(f"{compositions}/{{composition}}/derive", "POST") == write
    # The organizations fallthrough does not reach them: an org-admin key gains no composition write.
    assert "organizations:write" not in required_permissions(compositions, "POST")
    # A composition-scoped key reaches them, by kind and by slug; a problem-scoped one does not.
    request = {"method": "GET", "path_params": {"org": "acme", "composition": "shop"}, "path": f"{compositions}/{{composition}}"}
    assert allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["composition"]}}), **request)
    assert not allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["problem"]}}), **request)
    assert allows_request(SimpleNamespace(grants={"boundary": {"slugs": ["shop"]}}), **request)
    assert not allows_request(SimpleNamespace(grants={"boundary": {"slugs": ["other"]}}), **request)


def test_the_compositions_of_an_organization_are_composition_reads_and_writes():
    compositions = "/v1/organizations/{org}/compositions"
    # The environment routes have their own permissions (test_environment_*).
    routes = sorted(route for route in ROUTES if route[1].startswith(compositions) and "/environments" not in route[1])

    assert routes == [
        ("DELETE", f"{compositions}/{{composition}}"),
        ("GET", compositions),
        ("GET", f"{compositions}/{{composition}}"),
        ("GET", f"{compositions}/{{composition}}/diff"),
        ("GET", f"{compositions}/{{composition}}/download"),
        ("GET", f"{compositions}/{{composition}}/graph"),
        ("GET", f"{compositions}/{{composition}}/neighborhood"),
        ("GET", f"{compositions}/{{composition}}/upstream"),
        ("GET", f"{compositions}/{{composition}}/versions"),
        ("GET", f"{compositions}/{{composition}}/versions/{{version}}"),
        ("GET", f"{compositions}/{{composition}}/versions/{{version}}/content"),
        ("GET", f"{compositions}/{{composition}}/versions/{{version}}/margins"),
        ("PATCH", f"{compositions}/{{composition}}"),
        ("POST", compositions),
        ("POST", f"{compositions}/{{composition}}/derive"),
        ("POST", f"{compositions}/{{composition}}/evaluate"),
        ("POST", f"{compositions}/{{composition}}/fork"),
        ("POST", f"{compositions}/{{composition}}/versions"),
        ("POST", f"{compositions}/{{composition}}/versions/check"),
        ("POST", f"{compositions}/{{composition}}/versions/{{version}}/evaluations"),
    ]
    for method, path in routes:
        # Checking a document against its problem, or evaluating another binding, writes nothing;
        # re-evaluating a version stores its evaluation, and deriving one seals it.
        reads = method == "GET" or path.endswith(("/versions/check", "/evaluate"))
        expected = "compositions:read" if reads else "compositions:write"
        assert required_permissions(path, method) == frozenset({expected}), (method, path)
        # The organizations fallback does not reach them.
        assert not {"organizations:read", "organizations:write"} & required_permissions(path, method)
    composition_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["composition"]}})
    problems_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["problem"]}})
    request = {"method": "GET", "path_params": {"org": "acme", "composition": "c"}, "path": f"{compositions}/{{composition}}"}
    assert allows_request(composition_only, **request)
    assert not allows_request(problems_only, **request)


def test_the_run_presets_of_an_organization_are_jobs_reads_and_engine_executions():
    presets = "/v1/organizations/{org}/presets"
    routes = sorted(route for route in ROUTES if route[1].startswith(presets))

    assert routes == [
        ("DELETE", f"{presets}/{{preset}}"),
        ("GET", presets),
        ("GET", f"{presets}/{{preset}}"),
        ("PATCH", f"{presets}/{{preset}}"),
        ("POST", presets),
    ]
    for method, path in routes:
        # Configuring how engines run is what creating a run needs.
        expected = "jobs:read" if method == "GET" else "engines:execute"
        assert required_permissions(path, method) == frozenset({expected}), (method, path)
        assert not {"organizations:read", "organizations:write"} & required_permissions(path, method)
    request = {"method": "GET", "path_params": {"org": "acme", "preset": "quick"}, "path": f"{presets}/{{preset}}"}
    assert allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["preset"]}}), **request)
    assert not allows_request(SimpleNamespace(grants={"boundary": {"resourceKinds": ["run"]}}), **request)
    assert allows_request(SimpleNamespace(grants={"boundary": {"slugs": ["quick"]}}), **request)
    assert not allows_request(SimpleNamespace(grants={"boundary": {"slugs": ["other"]}}), **request)


ENVIRONMENT_ROUTES = [route for route in ROUTES if "/environments" in route[1]]


def test_environment_routes_are_composition_routes():
    """No new resource kind: a key bounded to a composition reaches its environments, and no other's."""
    assert ENVIRONMENT_ROUTES
    params = {"org": "acme", "composition": "tomato", "environment": "production", "key": "k"}
    compositions_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["compositions"]}})
    problems_only = SimpleNamespace(grants={"boundary": {"resourceKinds": ["problems"]}})
    this_one = SimpleNamespace(grants={"boundary": {"slugs": ["tomato"]}})
    another = SimpleNamespace(grants={"boundary": {"slugs": ["other"]}})
    for method, path in ENVIRONMENT_ROUTES:
        request = {"method": method, "path_params": params, "path": path}
        assert allows_request(compositions_only, **request), path
        assert not allows_request(problems_only, **request), path
        assert allows_request(this_one, **request), path
        assert not allows_request(another, **request), path


def test_environment_crud_permissions():
    base = "/v1/organizations/{org}/compositions/{composition}/environments"
    assert required_permissions(base, "GET") == frozenset({"compositions:read"})
    assert required_permissions(base, "POST") == frozenset({"compositions:write"})
    for method in ("PATCH", "DELETE"):
        assert required_permissions(f"{base}/{{environment}}", method) == frozenset({"compositions:write"})
    assert required_permissions(f"{base}/{{environment}}", "GET") == frozenset({"compositions:read"})


def test_adopting_needs_its_own_permission():
    """Adopting changes what an application runs: ``compositions:write`` does not imply it."""
    adopt = "/v1/organizations/{org}/compositions/{composition}/environments/{environment}/adopt"
    assert ("POST", adopt) in ROUTES
    assert required_permissions(adopt, "POST") == frozenset({"compositions:adopt"})
    assert required_permissions("/v1/organizations/acme/compositions/tomato/environments/production/adopt", "POST") == (
        frozenset({"compositions:adopt"})
    )
    assert "compositions:adopt" not in apikeys.ADMIN_PERMISSIONS
    history = "/v1/organizations/{org}/compositions/{composition}/environments/{environment}/adoptions"
    assert required_permissions(history, "GET") == frozenset({"compositions:read"})


def test_feed_keys_are_administered_with_keys_write():
    keys = "/v1/organizations/{org}/compositions/{composition}/environments/{environment}/keys"
    expected = frozenset({"compositions:write", "keys:write"})
    assert required_permissions(keys, "POST") == expected
    assert required_permissions(f"{keys}/{{key}}", "DELETE") == expected
    assert required_permissions("/v1/organizations/a/compositions/b/environments/c/keys/d", "DELETE") == expected


def test_the_feed_is_a_composition_read():
    feed = "/v1/organizations/{org}/compositions/{composition}/environments/{environment}/composition"
    assert ("GET", feed) in ROUTES
    assert required_permissions(feed, "GET") == frozenset({"compositions:read"})


def test_checking_an_environment_is_a_composition_read():
    check = "/v1/organizations/{org}/compositions/{composition}/environments/{environment}/check"
    assert ("POST", check) in ROUTES
    assert required_permissions(check, "POST") == frozenset({"compositions:read"})
