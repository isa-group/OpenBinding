"""M9.6: the removed operations are not routed (design.md §2.1, ``req~gateway-api-removed-operations-not-routed~1``).

Each removed operation answers like any path no route matches: ``404`` with the
body of ``GET /v1/m96-never-routed``, or ``405`` with an ``Allow`` header that
names only the kept method(s) when its path stays for another method. The
kept operations of the same areas (design.md §2.2) stay routed.

Both tables are data: a slice that removes more operations adds its rows to
``REMOVED`` (and the kept neighbours to ``KEPT``); the tests below need no change.
"""

from __future__ import annotations

import re
import uuid
from typing import NamedTuple

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import func, select

from _b1_helpers import gate, make_account, make_key  # noqa: F401
from openbinding_gateway.db.base import Base
from openbinding_gateway.main import app

UNROUTED = "/v1/m96-never-routed"

#: Values of the path parameters (the scenario of the requirement); any other parameter gets a random UUID.
PARAMETERS = {"org": "isa-demo", "project": "p1", "report": "r1", "resource": "r1"}


class Removed(NamedTuple):
    row: str
    method: str
    template: str
    after: int


class Kept(NamedTuple):
    row: str
    method: str
    template: str


#: The removed-operations table of design.md §2.1, as far as the slices that landed have removed it.
REMOVED = [
    Removed("1", "GET", "/v1/analysis/sources", 404),
    Removed("2", "POST", "/v1/analysis/query", 404),
    Removed("3", "POST", "/v1/analysis/candidate", 404),
    Removed("4", "POST", "/v1/analysis/export", 404),
    Removed("5", "POST", "/v1/analysis/reports", 404),
    Removed("6", "POST", "/v1/analysis/pareto", 404),
    Removed("7", "GET", "/v1/analysis/pareto/{task_id}", 404),
    Removed("8", "POST", "/v1/analysis/pareto/{task_id}/cancel", 404),
    Removed("35", "POST", "/v1/admin/organizations/{organization_id}/sponsor", 404),
    Removed("36", "GET", "/v1/sponsor-proposals/{proposal_id}", 404),
    Removed("37", "GET", "/v1/users/me/sponsor-proposals", 404),
    Removed("38", "GET", "/v1/organizations/{org}/sponsor-proposals", 404),
    Removed("39", "POST", "/v1/sponsor-proposals/{proposal_id}/accept", 404),
    Removed("40", "POST", "/v1/sponsor-proposals/{proposal_id}/decline", 404),
    Removed("41", "POST", "/v1/sponsor-proposals/{proposal_id}/cancel", 404),
]

#: The kept operations of design.md §2.2 next to the removed ones above.
KEPT = [
    Kept("K1", "GET", "/v1/jobs/{job_id}/analysis/neighborhood"),
]


def concrete(template: str) -> str:
    return re.sub(r"\{(\w+)\}", lambda match: PARAMETERS.get(match[1], str(uuid.uuid4())), template)


def api_routes() -> list[APIRoute]:
    """Every API route, looking inside included routers as the other route-table tests do."""
    found = []
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute):
                found.append(route)
    return found


def methods_serving(path: str) -> set[str]:
    """The methods of every route whose path pattern matches ``path``."""
    return {method for route in api_routes() if route.path_regex.match(path) for method in route.methods}


def by_row(entries) -> dict:
    return {"argvalues": entries, "ids": [f"{entry.row}-{entry.method}-{entry.template}" for entry in entries]}


async def row_counts(db_session) -> dict[str, int]:
    return {
        table.name: (await db_session.execute(select(func.count()).select_from(table))).scalar_one()
        for table in Base.metadata.sorted_tables
    }


def assert_answers_like_its_row(entry: Removed, response, unrouted) -> None:
    assert response.status_code == entry.after, (entry, response.text)
    if entry.after == 404:
        assert response.json() == unrouted.json(), (entry, response.text)
    else:
        allowed = {method.strip() for method in response.headers["allow"].split(",")}
        assert "GET" in allowed and entry.method not in allowed, (entry, allowed)


@pytest.mark.parametrize("entry", **by_row(REMOVED))
async def test_a_removed_operation_answers_with_the_status_of_its_row(api_client, entry):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    unrouted = await api_client.get(UNROUTED)
    assert unrouted.status_code == 404

    response = await api_client.request(entry.method, concrete(entry.template), json={})

    assert_answers_like_its_row(entry, response, unrouted)


@pytest.mark.parametrize("entry", **by_row(REMOVED))
def test_no_route_serves_a_removed_operation(entry):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    serving = methods_serving(concrete(entry.template))

    assert entry.method not in serving, (entry, serving)
    if entry.after == 404:
        assert serving == set(), (entry, serving)
    else:
        assert "GET" in serving, (entry, serving)


@pytest.mark.parametrize("entry", **by_row(KEPT))
def test_a_kept_operation_of_a_retired_area_is_still_routed(entry):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    templates = {route.path_format for route in api_routes() if entry.method in route.methods}

    assert entry.template in templates
    assert entry.method in methods_serving(concrete(entry.template))


async def test_a_session_gets_the_same_answer_and_writes_nothing(
    api_client, registration, db_session, gate  # noqa: F811
):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    _, headers = await make_account(api_client, registration, db_session, gate)
    unrouted = await api_client.get(UNROUTED)
    entries = [entry for entry in REMOVED if entry.row in {"1", "37"}]
    before = await row_counts(db_session)

    for entry in entries:
        response = await api_client.request(entry.method, concrete(entry.template), headers=headers)
        assert_answers_like_its_row(entry, response, unrouted)

    assert await row_counts(db_session) == before


async def test_an_api_key_gets_the_unrouted_answer_and_not_a_permission_refusal(
    api_client, registration, db_session, gate  # noqa: F811
):
    # [utest->req~gateway-api-removed-operations-not-routed~1]
    _, session = await make_account(api_client, registration, db_session, gate)
    key = await make_key(api_client, session, ["jobs:read", "engines:execute"])
    unrouted = await api_client.get(UNROUTED)

    response = await api_client.post("/v1/analysis/pareto", headers=key, json={"sources": [str(uuid.uuid4())]})

    assert response.status_code == 404, response.text
    assert response.json() == unrouted.json()
