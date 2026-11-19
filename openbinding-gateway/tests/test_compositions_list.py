"""The composition list's ``?run=`` filter: the versions derived from a run, and where each is in effect (F4 A10).

The run page offers "Adopt in environment" without a route of its own and without chaining derive and adopt: it asks
which sealed versions came from the run. Members only: anybody else gets the unknown-run answer, an empty list, so
no environment slug leaks through the public list.
"""

from __future__ import annotations

import uuid

import pytest

from _b1_helpers import gate, make_account, put_member  # noqa: F401
from _composition_helpers import bim_binding, finished_run, first_binding, linked_problem
from openbinding_gateway.db.models import User

pytestmark = pytest.mark.asyncio


async def setup(api_client, registration, db_session, gate):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user)
    await db_session.commit()
    org = linked.organization.slug
    base = f"/v1/organizations/{org}/compositions"
    for slug in ("shop", "other"):
        assert (await api_client.post(base, headers=headers, json={"slug": slug, "name": slug})).status_code == 201
    run = await finished_run(db_session, linked, [bim_binding(linked, first_binding(linked.compilation.ir))])
    derived = await api_client.post(f"{base}/shop/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})
    assert derived.status_code == 201, derived.text
    return headers, org, base, run, derived.json()["version"]


async def test_the_versions_derived_from_a_run_and_where_they_are_in_effect(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, base, run, version = await setup(api_client, registration, db_session, gate)

    listed = await api_client.get(f"{base}?run={run.id}", headers=headers)

    assert listed.status_code == 200, listed.text
    (item,) = listed.json()["compositions"]
    assert item["slug"] == "shop"
    assert item["derivedVersions"] == [
        {"id": version["id"], "label": "1.0.0", "sealedAt": item["derivedVersions"][0]["sealedAt"], "inEffect": []},
    ]
    environment = await api_client.post(f"{base}/shop/environments", headers=headers, json={"slug": "staging", "name": "S"})
    adopted = await api_client.post(
        f"{base}/shop/environments/staging/adopt", headers={**headers, "If-Match": environment.headers["ETag"]},
        json={"version": "1.0.0"},
    )
    assert adopted.status_code == 200, adopted.text
    again = (await api_client.get(f"{base}?run={run.id}", headers=headers)).json()
    assert again["compositions"][0]["derivedVersions"][0]["inEffect"] == ["staging"]

    plain = (await api_client.get(base, headers=headers)).json()
    assert {item["slug"] for item in plain["compositions"]} == {"shop", "other"}
    assert all(item["derivedVersions"] is None for item in plain["compositions"])
    for unknown in (str(uuid.uuid4()), "not-a-run"):
        assert (await api_client.get(f"{base}?run={unknown}", headers=headers)).json()["compositions"] == []


async def test_only_members_learn_what_a_run_derived(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, base, run, _ = await setup(api_client, registration, db_session, gate)
    environment = await api_client.post(f"{base}/shop/environments", headers=headers, json={"slug": "production", "name": "P"})
    await api_client.post(
        f"{base}/shop/environments/production/adopt", headers={**headers, "If-Match": environment.headers["ETag"]},
        json={"version": "1.0.0"},
    )
    assert (await api_client.patch(f"{base}/shop", headers=headers, json={"visibility": "public"})).status_code == 200
    _, outsider = await make_account(api_client, registration, db_session, gate)

    for caller in ({}, outsider):
        public = await api_client.get(base, headers=caller)
        assert [item["slug"] for item in public.json()["compositions"]] == ["shop"]
        filtered = await api_client.get(f"{base}?run={run.id}", headers=caller)
        assert filtered.status_code == 200 and filtered.json()["compositions"] == []
        assert "production" not in filtered.text and "inEffect" not in filtered.text
