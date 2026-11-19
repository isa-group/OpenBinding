"""A version's margins over HTTP (F4 A8): members only, from a stored evaluation and the offering it read.

A declared TomatoMeter document names the offering ``sphere/tomatometer`` (read from the recorded SPHERE set at seal)
and a subscription of 35 USD a month: the margins are the ``mailgun-foundation`` golden's, labelled declared.
"""

from __future__ import annotations

import uuid

import pytest

from _b1_helpers import gate, make_key  # noqa: F401
from _environment_api import code, env, seal, team

pytestmark = pytest.mark.asyncio


def offered(label: str, subscription: str = "35", extra: str = "") -> str:
    return f"""\
syntaxVersion: "1.0"
composition: tomato
version: {label}
kind: workflow
workflow:
  seq: [t1]
binding:
  t1: {{candidate: c1a}}
values:
  subscription: {{value: {subscription}, unit: USD/month}}
{extra}offering: {{sphere: sphere/tomatometer}}
"""


async def offered_team(api_client, registration, db_session, gate):  # noqa: F811
    t = await team(api_client, registration, db_session, gate)
    t.versions["2.0.0"] = await seal(api_client, t.owner, t.base, offered("2.0.0"))
    return t


async def test_margins_per_plan_from_the_stored_evaluation(api_client, registration, db_session, gate, sphere):  # noqa: F811
    t = await offered_team(api_client, registration, db_session, gate)
    url = f"{t.base}/versions/2.0.0/margins"
    calls = len(sphere.requests)

    answer = await api_client.get(f"{url}?users=1000", headers=t.viewer)

    assert answer.status_code == 200, answer.text
    assert len(sphere.requests) == calls  # stored data only
    body = answer.json()
    assert body["version"]["label"] == "2.0.0"
    assert body["evaluation"]["valuesStatus"] == "declared" and body["evaluation"]["outcome"] == "declared"
    assert body["offering"]["status"] == "read" and body["offering"]["versionName"] == "1.0.0"
    assert body["offering"]["currency"] == "USD" and body["offering"]["snapshot"]
    assert body["cost"] == {"name": "subscription", "value": "35.000000", "unit": "USD/month", "monthly": "35.000000"}
    assert body["status"] == "ok" and body["warnings"] == ["declared_values"] and body["apportionment"] == "uniform"
    assert body["costPerUser"] == "0.035000" and body["users"] == 1000
    margins = {"+".join([row["plan"], *row["addOns"]]): row["margin"] for row in body["rows"]}
    assert margins["basic"] == "-0.035000" and margins["premium+exportAsJson"] == "11.955000"

    without = (await api_client.get(url, headers=t.viewer)).json()
    assert without["status"] == "users_required" and all(row["margin"] is None for row in without["rows"])
    pinned = await api_client.get(f"{url}?users=1000&evaluation={body['evaluation']['id']}", headers=t.viewer)
    assert pinned.json() == body
    # A version without an offering.
    plain = (await api_client.get(f"{t.base}/versions/1.0.0/margins?users=10", headers=t.viewer)).json()
    assert plain["status"] == "no_offering" and plain["rows"] == [] and plain["offering"] is None


async def test_the_inputs_are_checked(api_client, registration, db_session, gate, sphere):  # noqa: F811
    t = await offered_team(api_client, registration, db_session, gate)
    url = f"{t.base}/versions/2.0.0/margins"
    other = t.versions["1.0.0"]

    for query in ("users=0", "users=1000000001", "users=x", "evaluation=nope"):
        assert (await api_client.get(f"{url}?{query}", headers=t.owner)).status_code == 422, query
    unknown_billing = await api_client.get(f"{url}?billing=annual", headers=t.owner)
    assert unknown_billing.status_code == 422 and code(unknown_billing) == "unknown_billing"
    unknown_cost = await api_client.get(f"{url}?cost=latency", headers=t.owner)
    assert unknown_cost.status_code == 422 and code(unknown_cost) == "unknown_cost"
    foreign = await api_client.get(f"{url}?evaluation={other['current_evaluation_id']}", headers=t.owner)
    assert foreign.status_code == 404 and code(foreign) == "evaluation_not_found"
    assert (await api_client.get(f"{url}?evaluation={uuid.uuid4()}", headers=t.owner)).status_code == 404
    assert (await api_client.get(f"{t.base}/versions/9.9.9/margins", headers=t.owner)).status_code == 404


async def test_margins_are_for_members_only(api_client, registration, db_session, gate, sphere):  # noqa: F811
    t = await offered_team(api_client, registration, db_session, gate)
    url = f"{t.base}/versions/2.0.0/margins?users=10"

    private = await api_client.get(url, headers=t.outsider)
    assert private.status_code == 404 and private.json()["detail"]["error"] == "Composition not found."
    assert (await api_client.patch(t.base, headers=t.owner, json={"visibility": "public"})).status_code == 200
    public = await api_client.get(url, headers=t.outsider)
    assert public.status_code == 404 and public.json()["detail"]["error"] == "Version not found."
    assert (await api_client.get(url)).status_code == 401
    reader = await make_key(api_client, t.viewer, ["compositions:read"])
    assert (await api_client.get(url, headers=reader)).status_code == 200
    without = await make_key(api_client, t.viewer, ["problems:read"])
    assert (await api_client.get(url, headers=without)).status_code == 403


async def test_reading_margins_never_moves_the_feed(api_client, registration, db_session, gate, sphere):  # noqa: F811
    t = await offered_team(api_client, registration, db_session, gate)
    created = await env(api_client, t)
    adopted = await api_client.post(
        f"{t.environments}/production/adopt", headers={**t.owner, "If-Match": created.headers["ETag"]},
        json={"version": "2.0.0"},
    )
    assert adopted.status_code == 200
    evaluation = adopted.json()["environment"]["inEffect"]["evaluation"]["id"]
    key = {"X-API-Key": (await api_client.post(f"{t.environments}/production/keys", headers=t.owner, json={})).json()["secret"]}
    before = await api_client.get(f"{t.environments}/production/composition", headers=key)

    for query in ("users=1000", f"users=10&evaluation={evaluation}", ""):
        assert (await api_client.get(f"{t.base}/versions/2.0.0/margins?{query}", headers=t.owner)).status_code == 200

    after = await api_client.get(f"{t.environments}/production/composition", headers=key)
    assert after.headers["ETag"] == before.headers["ETag"] and after.content == before.content
