"""Paging, sorting and faceting the composition lists (F2c G6).

The three lists (an organization's, every public one, and the caller's own across organizations) take owners,
kinds, a sort by name, update, tasks or cost with its order, and bounds on tasks, providers and cost; each
answers its total and the facets of every match, not one page: the organizations with their counts, and SPHERE's
ten-bucket histogram of each number, from what the latest versions stored. Each facet ignores its own filter.
An organization's list shows anybody but a member its public compositions only, and answers an organization that
publishes nothing as a missing one.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from _b1_helpers import gate, make_account  # noqa: F401
from openbinding_gateway.modules.compositions.application import listing
from test_compositions_public_list import create, patch, seal

GOLDEN_HISTOGRAM = {
    "min": 1.0,
    "max": 50.0,
    "data": [
        {"value": "0-1.11", "count": 1},
        {"value": "1.11-2.22", "count": 1},
        {"value": "2.22-3.33", "count": 1},
        {"value": "3.33-4.44", "count": 1},
        {"value": "4.44-5.56", "count": 0},
        {"value": "5.56-6.67", "count": 0},
        {"value": "6.67-7.78", "count": 0},
        {"value": "7.78-8.89", "count": 0},
        {"value": "8.89-10", "count": 0},
        {"value": "10+", "count": 2},
    ],
}


def document(slug: str, tasks: int, cost: float | None, label: str = "1.0.0", kind: str = "workflow") -> bytes:
    names = [f"t{index}" for index in range(1, tasks + 1)]
    lines = [
        'syntaxVersion: "1.0"', f"composition: {slug}", f"version: {label}", f"kind: {kind}", "workflow:",
        f"  seq: [{', '.join(names)}]", "binding:",
        *[f"  {name}: {{candidate: c{index}}}" for index, name in enumerate(names, 1)],
    ]
    lines += ["values:", f"  cost: {{value: {cost}, unit: EUR}}"] if cost is not None else ["values: {}"]
    return ("\n".join(lines) + "\n").encode("utf-8")


async def composed(client, headers, org: str, slug: str, tasks: int, cost: float | None, **fields) -> str:
    base = await create(client, headers, org, slug)
    await seal(client, headers, base, document(slug, tasks, cost, kind=fields.pop("kind", "workflow")))
    if fields:
        await patch(client, headers, base, **fields)
    return base


def entry(org: str, slug: str, **numbers) -> listing.Entry:
    return listing.Entry(
        SimpleNamespace(slug=slug, name=slug.title(), id=uuid.uuid4(), updated_at=datetime.now(timezone.utc)),
        SimpleNamespace(slug=org, name=org.title()), None, {name: numbers.get(name) for name in listing.RANGES},
    )


# -- the facets, as numbers -------------------------------------------------------------------------------


def test_a_histogram_is_spheres_ten_buckets_up_to_the_80th_percentile():
    assert listing.histogram([3, 1, 50, 2, 10, 4]) == GOLDEN_HISTOGRAM
    assert listing.histogram([]) == {"min": None, "max": None, "data": []}
    same = listing.histogram([2, 2])
    assert same["data"][-1] == {"value": "2+", "count": 2} and sum(bucket["count"] for bucket in same["data"]) == 2


def test_each_facet_ignores_its_own_filter_and_counts_every_match():
    entries = [
        entry("acme", "a", tasks=2, providers=2, cost=10.0),
        entry("acme", "b", tasks=5, providers=3, cost=None),
        entry("beta", "c", tasks=8, providers=4, cost=30.0),
        entry("beta", "d"),
    ]
    bounds = listing.Bounds({"tasks": 3}, {})

    listed = listing.arrange(entries, owners={"beta"}, bounds=bounds, sort="tasks", order="desc", limit=1, offset=0)

    assert listed.total == 1 and [item.composition.slug for item in listed.entries] == ["c"]
    # Owners ignore the owners filter (acme still offered) but keep the tasks bound.
    assert listed.facets["owners"] == [
        {"slug": "acme", "name": "Acme", "count": 1}, {"slug": "beta", "name": "Beta", "count": 1},
    ]
    # Tasks ignores its own bound but keeps the owners filter; cost keeps both.
    assert (listed.facets["ranges"]["tasks"]["min"], listed.facets["ranges"]["tasks"]["max"]) == (8.0, 8.0)
    assert listed.facets["ranges"]["cost"]["min"] == 30.0
    # A composition without the number sorts last, whichever the order.
    ordered = listing.arrange(entries, owners=None, bounds=listing.Bounds({}, {}), sort="cost", order="asc",
                              limit=10, offset=0)
    assert [item.composition.slug for item in ordered.entries] == ["a", "c", "b", "d"]
    reverse = listing.arrange(entries, owners=None, bounds=listing.Bounds({}, {}), sort="cost", order="desc",
                              limit=10, offset=0)
    assert [item.composition.slug for item in reverse.entries] == ["c", "a", "b", "d"]


# -- the lists over HTTP ----------------------------------------------------------------------------------


async def test_the_organization_list_sorts_bounds_and_facets(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = (await api_client.post("/v1/organizations", headers=headers, json={"name": "Faceted"})).json()["slug"]
    await composed(api_client, headers, org, "small", 1, 5)
    await composed(api_client, headers, org, "mid", 3, 20)
    await composed(api_client, headers, org, "big", 6, None, kind="pipeline")
    await create(api_client, headers, org, "empty")
    url = f"/v1/organizations/{org}/compositions"

    by_tasks = await api_client.get(url, headers=headers, params={"sort": "tasks", "order": "desc"})
    by_cost = await api_client.get(url, headers=headers, params={"sort": "cost"})
    bounded = await api_client.get(url, headers=headers, params={"min_cost": 10, "max_tasks": 5})
    kinds = await api_client.get(url, headers=headers, params={"kinds": "pipeline,system"})
    paged = await api_client.get(url, headers=headers, params={"sort": "tasks", "limit": 1, "offset": 1})

    assert [row["slug"] for row in by_tasks.json()["compositions"]] == ["big", "mid", "small", "empty"]
    assert [row["slug"] for row in by_cost.json()["compositions"]] == ["small", "mid", "big", "empty"]
    assert [row["slug"] for row in bounded.json()["compositions"]] == ["mid"] and bounded.json()["total"] == 1
    assert [row["slug"] for row in kinds.json()["compositions"]] == ["big"]
    assert [row["slug"] for row in paged.json()["compositions"]] == ["mid"] and paged.json()["total"] == 4
    facets = by_tasks.json()["facets"]
    assert facets["owners"] == [{"slug": org, "name": "Faceted", "count": 4}]
    assert (facets["ranges"]["tasks"]["min"], facets["ranges"]["tasks"]["max"]) == (1.0, 6.0)
    assert (facets["ranges"]["providers"]["min"], facets["ranges"]["providers"]["max"]) == (1.0, 6.0)
    assert (facets["ranges"]["cost"]["min"], facets["ranges"]["cost"]["max"]) == (5.0, 20.0)
    assert sum(bucket["count"] for bucket in facets["ranges"]["cost"]["data"]) == 2
    assert (await api_client.get(url, headers=headers, params={"kinds": "nope"})).status_code == 422


async def test_each_row_carries_its_latest_versions_figures(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = (await api_client.post("/v1/organizations", headers=headers, json={"name": "Figured"})).json()["slug"]
    await composed(api_client, headers, org, "priced", 3, 20, visibility="public")
    await composed(api_client, headers, org, "unpriced", 2, None)
    await create(api_client, headers, org, "empty")

    rows = {
        row["slug"]: row for row in
        (await api_client.get(f"/v1/organizations/{org}/compositions", headers=headers)).json()["compositions"]
    }
    one = (await api_client.get(f"/v1/organizations/{org}/compositions/priced", headers=headers)).json()
    public = [
        row for row in (await api_client.get("/v1/compositions", params={"organization": org})).json()["compositions"]
    ]

    assert rows["priced"]["latest_version"]["figures"] == {"tasks": 3, "providers": 3, "cost": 20.0, "cost_unit": "EUR"}
    assert rows["unpriced"]["latest_version"]["figures"] == {
        "tasks": 2, "providers": 2, "cost": None, "cost_unit": None,
    }
    assert rows["empty"]["latest_version"] is None
    assert one["latest_version"]["figures"] == rows["priced"]["latest_version"]["figures"]
    assert public[0]["latest_version"]["figures"]["cost"] == 20.0


async def test_a_non_member_reads_only_what_an_organization_publishes(
    api_client, registration, db_session, gate,  # noqa: F811
):
    _, headers = await make_account(api_client, registration, db_session, gate)
    _, stranger = await make_account(api_client, registration, db_session, gate)
    org = (await api_client.post("/v1/organizations", headers=headers, json={"name": "Half public"})).json()["slug"]
    quiet = (await api_client.post("/v1/organizations", headers=headers, json={"name": "All private"})).json()["slug"]
    await composed(api_client, headers, org, "shown", 2, 1, visibility="public")
    await composed(api_client, headers, org, "hidden", 2, 1)
    await composed(api_client, headers, quiet, "secret", 2, 1)

    anonymous = await api_client.get(f"/v1/organizations/{org}/compositions")
    outsider = await api_client.get(f"/v1/organizations/{org}/compositions", headers=stranger)
    member = await api_client.get(f"/v1/organizations/{org}/compositions", headers=headers)
    nothing = await api_client.get(f"/v1/organizations/{quiet}/compositions", headers=stranger)
    missing = await api_client.get("/v1/organizations/no-such-org/compositions", headers=stranger)

    assert [row["slug"] for row in anonymous.json()["compositions"]] == ["shown"]
    assert anonymous.json()["compositions"][0]["created_by_id"] is None
    assert anonymous.headers["cache-control"] == "private, no-cache"
    assert [row["slug"] for row in outsider.json()["compositions"]] == ["shown"]
    assert sorted(row["slug"] for row in member.json()["compositions"]) == ["hidden", "shown"]
    assert nothing.status_code == 404 and nothing.json() == missing.json()


async def test_the_public_and_own_lists_filter_by_owner(api_client, registration, db_session, gate):  # noqa: F811
    _, headers = await make_account(api_client, registration, db_session, gate)
    member_account, member = await make_account(api_client, registration, db_session, gate)
    tag = uuid.uuid4().hex[:6]
    first = (await api_client.post("/v1/organizations", headers=headers, json={"name": f"First {tag}"})).json()
    second = (await api_client.post("/v1/organizations", headers=headers, json={"name": f"Second {tag}"})).json()
    child = (await api_client.post(
        "/v1/organizations", headers=headers, json={"name": f"Child {tag}", "parent_id": first["id"]},
    )).json()
    await composed(api_client, headers, first["slug"], f"one-{tag}", 2, 3, visibility="public")
    await composed(api_client, headers, second["slug"], f"two-{tag}", 4, 9, visibility="public")
    await composed(api_client, headers, child["slug"], f"three-{tag}", 1, None)
    added = await api_client.put(
        f"/v1/organizations/{first['slug']}/members/{member_account['id']}", headers=headers,
        json={"user_id": member_account["id"], "role": "VIEWER"},
    )
    assert added.status_code == 200

    public = await api_client.get("/v1/compositions", params={"q": tag, "owners": second["slug"]})
    assert [row["slug"] for row in public.json()["compositions"]] == [f"two-{tag}"]
    assert {owner["slug"] for owner in public.json()["facets"]["owners"]} == {first["slug"], second["slug"]}
    by_cost = await api_client.get("/v1/compositions", params={"q": tag, "sort": "cost", "order": "desc"})
    assert [row["slug"] for row in by_cost.json()["compositions"]] == [f"two-{tag}", f"one-{tag}"]

    own = await api_client.get("/v1/users/me/compositions", headers=member)
    assert own.status_code == 200, own.text
    assert sorted(row["slug"] for row in own.json()["compositions"]) == [f"one-{tag}", f"three-{tag}"]
    assert own.json()["total"] == 2
    narrowed = await api_client.get("/v1/users/me/compositions", headers=member, params={"owners": child["slug"]})
    assert [row["slug"] for row in narrowed.json()["compositions"]] == [f"three-{tag}"]
    assert (await api_client.get("/v1/users/me/compositions")).status_code == 401
