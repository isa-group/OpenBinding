"""M9.6: the sponsorship proposal operations and the administrator transfer are gone.

Rows 35 to 41 of the removed-operations table (design.md §2.1) answer like any
path no route matches, with or without a session, and no route of the
application serves them any more.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from fastapi.routing import APIRoute

from openbinding_gateway.main import app

REMOVED = [
    ("POST", "/v1/admin/organizations/{uuid}/sponsor"),
    ("GET", "/v1/sponsor-proposals/{uuid}"),
    ("GET", "/v1/users/me/sponsor-proposals"),
    ("GET", "/v1/organizations/isa-demo/sponsor-proposals"),
    ("POST", "/v1/sponsor-proposals/{uuid}/accept"),
    ("POST", "/v1/sponsor-proposals/{uuid}/decline"),
    ("POST", "/v1/sponsor-proposals/{uuid}/cancel"),
]

TEMPLATES = {
    "/v1/admin/organizations/{organization_id}/sponsor",
    "/v1/sponsor-proposals/{proposal_id}",
    "/v1/users/me/sponsor-proposals",
    "/v1/organizations/{org}/sponsor-proposals",
    "/v1/sponsor-proposals/{proposal_id}/accept",
    "/v1/sponsor-proposals/{proposal_id}/decline",
    "/v1/sponsor-proposals/{proposal_id}/cancel",
}


def concrete(path: str) -> str:
    return path.replace("{uuid}", str(uuid.uuid4()))


def routes() -> list[APIRoute]:
    """Every API route, looking inside included routers as the other route-table tests do."""
    found = []
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute):
                found.append(route)
    return found


@pytest_asyncio.fixture
async def session_headers(api_client, registration) -> dict[str, str]:
    details = registration()
    created = await api_client.post("/v1/auth/register", json=details)
    assert created.status_code == 201, created.text
    login = await api_client.post(
        "/v1/auth/login",
        json={"username_or_email": details["username"], "password": details["password"]},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.mark.parametrize(("method", "path"), REMOVED)
async def test_a_removed_operation_answers_like_an_unrouted_path(api_client, session_headers, method, path):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    unrouted = await api_client.get("/v1/m96-never-routed")
    assert unrouted.status_code == 404

    for headers in ({}, session_headers):
        response = await api_client.request(method, concrete(path), headers=headers, json={})
        assert response.status_code == 404, (method, path, response.text)
        assert response.json() == unrouted.json()


@pytest.mark.parametrize(("method", "path"), REMOVED)
def test_no_route_serves_a_removed_path(method, path):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    target = concrete(path)
    serving = [route.path_format for route in routes() if route.path_regex.match(target)]
    assert serving == [], (method, path, serving)


def test_the_route_table_and_the_document_have_no_removed_template():
    # [utest->req~gateway-api-removed-operations-not-documented~1]
    routed = {route.path_format for route in routes()}
    documented = set(app.openapi()["paths"])

    assert not routed & TEMPLATES
    assert not documented & TEMPLATES
    assert "SponsorProposalView" not in app.openapi()["components"]["schemas"]
