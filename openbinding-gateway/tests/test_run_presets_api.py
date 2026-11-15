"""The run presets of an organization: create, read, list, edit and delete them (F1 B13).

Presets follow the runs of their module: every member reads them (the options redacted below MEMBER, as a
run's), MEMBER and above write them (403 ``insufficient_role`` below), and a non-member learns nothing (404
on every route, before any If-Match handling). Only the shape of the settings is checked here; whether a
run can use them is decided when a run starts from the preset.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from _b1_helpers import gate, make_account, make_key, put_member  # noqa: F401
from _problem_helpers import make_org
from openbinding_gateway.db.models import AuditEvent, RunPreset
from openbinding_gateway.modules.execution.domain.presets import MAX_OPTIONS_BYTES

OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
HARMLESS = {"seed": 7, "time_budget_ms": 1000}
OPTIONS = {**HARMLESS, "auth": {"scheme": "bearer", "token": "tok-SECRET-1"}}
REFERENCE = {"namespace": "acme", "name": "solver", "version": "1.0.0", "digest": "sha256-" + "a" * 64}


def code(response) -> str:
    return response.json()["detail"]["code"]


async def owner(api_client, registration, db_session, gate):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    return account, headers, await make_org(api_client, headers)


async def create(api_client, headers, org, slug, **fields):
    body = {"slug": slug, "name": slug.title(), "engine": "random-search", "mode": "seeded",
            "optimization": OPTIMIZATION, **fields}
    response = await api_client.post(f"/v1/organizations/{org}/presets", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response


async def presets_in_db(db_session) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(RunPreset)))


async def test_a_preset_is_created_read_edited_and_deleted(api_client, registration, db_session, gate):  # noqa: F811
    account, headers, org = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/presets"

    created = await create(api_client, headers, org, "quick", description="A short random search", options=OPTIONS)

    body = created.json()
    assert created.headers["ETag"]
    assert (body["slug"], body["name"], body["description"]) == ("quick", "Quick", "A short random search")
    assert (body["engine"], body["mode"], body["registration"]) == ("random-search", "seeded", None)
    assert body["options"] == OPTIONS and body["optimization"] == OPTIMIZATION
    assert body["created_by_id"] == account["id"]

    by_slug = await api_client.get(f"{base}/quick", headers=headers)
    by_id = await api_client.get(f"{base}/{body['id']}", headers=headers)
    assert by_slug.status_code == by_id.status_code == 200
    assert by_slug.json() == by_id.json() == body
    assert by_slug.headers["ETag"] == created.headers["ETag"]

    edited = await api_client.patch(
        f"{base}/quick", headers=headers,
        json={"name": "Quicker", "engine": REFERENCE, "registration": REFERENCE, "options": {"seed": 1}},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["name"] == "Quicker" and edited.json()["engine"] == REFERENCE
    assert edited.json()["registration"] == REFERENCE and edited.json()["options"] == {"seed": 1}
    assert edited.json()["mode"] == "seeded" and edited.json()["optimization"] == OPTIMIZATION
    assert edited.headers["ETag"] != created.headers["ETag"]

    cleared = await api_client.patch(f"{base}/quick", headers=headers, json={"registration": None, "mode": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["registration"] is None and cleared.json()["mode"] is None

    deleted = await api_client.delete(f"{base}/quick", headers=headers)
    assert deleted.status_code == 204, deleted.text
    assert (await api_client.get(f"{base}/quick", headers=headers)).status_code == 404
    assert await presets_in_db(db_session) == 0
    actions = (await db_session.scalars(select(AuditEvent.action).where(AuditEvent.target_type == "RunPreset"))).all()
    assert sorted(actions) == ["run_preset.created", "run_preset.deleted", "run_preset.updated", "run_preset.updated"]


async def test_the_list_filters_by_text_and_pages(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/presets"
    await create(api_client, headers, org, "alpha")
    await create(api_client, headers, org, "beta", name="Beta genetic")
    await create(api_client, headers, org, "gamma")

    async def slugs(**params):
        response = await api_client.get(base, headers=headers, params=params)
        assert response.status_code == 200, response.text
        return [item["slug"] for item in response.json()["presets"]], response.json()["total"]

    assert await slugs() == (["alpha", "beta", "gamma"], 3)
    assert await slugs(q="GENE") == (["beta"], 1)
    assert await slugs(q="gam") == (["gamma"], 1)
    assert await slugs(q="%") == ([], 0)
    assert await slugs(limit=2) == (["alpha", "beta"], 3)
    assert await slugs(limit=2, offset=2) == (["gamma"], 3)
    page = await api_client.get(base, headers=headers, params={"limit": 2, "offset": 1})
    assert (page.json()["limit"], page.json()["offset"]) == (2, 1)
    assert (await api_client.get(base, headers=headers, params={"limit": 0})).status_code == 422


async def test_a_taken_slug_is_a_409_and_another_organization_may_take_it(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    other = await make_org(api_client, headers)
    await create(api_client, headers, org, "same")

    again = await api_client.post(
        f"/v1/organizations/{org}/presets", headers=headers, json={"slug": "same", "name": "S", "engine": "random-search"},
    )

    assert again.status_code == 409, again.text
    assert code(again) == "slug_conflict"
    await create(api_client, headers, other, "same")
    assert await presets_in_db(db_session) == 2


@pytest.mark.parametrize(
    ("fields", "pointer"),
    [
        ({"engine": ""}, "/engine"),
        ({"engine": 3}, "/engine"),
        ({"engine": {"name": "solver"}}, "/engine"),
        ({"engine": {**REFERENCE, "extra": "x"}}, "/engine"),
        ({"registration": "my-deployment"}, "/registration"),
        ({"registration": {**REFERENCE, "digest": ""}}, "/registration"),
        ({"mode": ""}, "/mode"),
        ({"mode": "m" * 65}, "/mode"),
        ({"mode": 1}, "/mode"),
        ({"options": []}, "/options"),
        ({"options": {"blob": "x" * MAX_OPTIONS_BYTES}}, "/options"),
        ({"optimization": "SINGLE"}, "/optimization"),
        ({"optimization": {"type": "FEW", "scalarization": "weighted-sum"}}, "/optimization/type"),
        ({"optimization": {"type": "SINGLE"}}, "/optimization/scalarization"),
        ({"optimization": {**OPTIMIZATION, "goal": "min"}}, "/optimization/goal"),
        ({"optimization": {**OPTIMIZATION, "weights": {"cost": 1}}}, "/optimization/weights"),
        ({"optimization": {**OPTIMIZATION, "weights": [{"criteria": "cost"}]}}, "/optimization/weights/0"),
        ({"optimization": {**OPTIMIZATION, "weights": [{"criteria": "cost", "value": True}]}}, "/optimization/weights/0"),
    ],
)
async def test_a_setting_of_the_wrong_shape_is_refused_where_it_is(
    api_client, registration, db_session, gate, fields, pointer  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    body = {"slug": "bad", "name": "Bad", "engine": "random-search", **fields}

    refused = await api_client.post(f"/v1/organizations/{org}/presets", headers=headers, json=body)

    assert refused.status_code == 422, refused.text
    assert refused.json()["code"] == "invalid_request_fields"
    assert [item["pointer"] for item in refused.json()["diagnostics"]] == [pointer]
    assert await presets_in_db(db_session) == 0


async def test_a_preset_needs_an_engine_and_names_only_its_fields(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/presets"
    await create(api_client, headers, org, "kept")

    no_engine = await api_client.post(base, headers=headers, json={"slug": "x", "name": "X"})
    unknown = await api_client.post(base, headers=headers, json={"slug": "x", "name": "X", "engine": "e", "seed": 1})
    bad_slug = await api_client.post(base, headers=headers, json={"slug": "Not A Slug", "name": "X", "engine": "e"})
    engine_cleared = await api_client.patch(f"{base}/kept", headers=headers, json={"engine": None})
    options_cleared = await api_client.patch(f"{base}/kept", headers=headers, json={"options": None})
    slug_edit = await api_client.patch(f"{base}/kept", headers=headers, json={"slug": "other"})

    assert no_engine.status_code == unknown.status_code == bad_slug.status_code == slug_edit.status_code == 422
    assert engine_cleared.status_code == options_cleared.status_code == 422
    assert engine_cleared.json()["code"] == options_cleared.json()["code"] == "invalid_request_fields"
    assert (await api_client.get(f"{base}/kept", headers=headers)).json()["engine"] == "random-search"


async def test_if_match_refuses_a_stale_tag_with_412_and_a_malformed_one_with_400(
    api_client, registration, db_session, gate  # noqa: F811
):
    _, headers, org = await owner(api_client, registration, db_session, gate)
    url = f"/v1/organizations/{org}/presets/guarded"
    tag = (await create(api_client, headers, org, "guarded")).headers["ETag"]

    first = await api_client.patch(url, headers={**headers, "If-Match": tag}, json={"name": "First"})
    stale = await api_client.patch(url, headers={**headers, "If-Match": tag}, json={"mode": "other"})
    malformed = await api_client.patch(url, headers={**headers, "If-Match": "not-a-tag"}, json={"name": "Third"})

    assert first.status_code == 200, first.text
    assert stale.status_code == 412, stale.text
    assert code(stale) == "precondition_failed"
    assert stale.headers["ETag"] == first.headers["ETag"]
    assert malformed.status_code == 400, malformed.text
    assert code(malformed) == "invalid_if_match"
    after = (await api_client.get(url, headers=headers)).json()
    assert (after["name"], after["mode"]) == ("First", "seeded")


async def test_a_viewer_reads_redacted_and_a_member_writes(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    member, member_headers = await make_account(api_client, registration, db_session, gate)
    await put_member(api_client, headers, org, viewer["id"], "VIEWER")
    await put_member(api_client, headers, org, member["id"], "MEMBER")
    await create(api_client, headers, org, "shared", options=OPTIONS)
    base = f"/v1/organizations/{org}/presets"

    listed = await api_client.get(base, headers=viewer_headers)
    one = await api_client.get(f"{base}/shared", headers=viewer_headers)
    assert listed.json()["total"] == 1
    assert one.status_code == 200 and one.json()["options"] == listed.json()["presets"][0]["options"] == HARMLESS
    assert "tok-SECRET" not in one.text + listed.text
    assert (await api_client.get(f"{base}/shared", headers=member_headers)).json()["options"] == OPTIONS

    viewer_writes = [
        await api_client.post(base, headers=viewer_headers, json={"slug": "v", "name": "V", "engine": "random-search"}),
        await api_client.patch(f"{base}/shared", headers=viewer_headers, json={"name": "V"}),
        await api_client.delete(f"{base}/shared", headers=viewer_headers),
    ]
    for response in viewer_writes:
        assert response.status_code == 403, response.text
        assert code(response) == "insufficient_role"

    assert (await api_client.post(base, headers=member_headers, json={"slug": "m", "name": "M", "engine": "e"})).status_code == 201
    assert (await api_client.patch(f"{base}/shared", headers=member_headers, json={"name": "Ours"})).status_code == 200
    assert (await api_client.delete(f"{base}/m", headers=member_headers)).status_code == 204


async def test_a_non_member_gets_a_404_on_every_route(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    created = await create(api_client, headers, org, "private")
    tag = created.headers["ETag"]
    _, outsider_headers, elsewhere = await owner(api_client, registration, db_session, gate)
    base = f"/v1/organizations/{org}/presets"
    missing_org = f"/v1/organizations/no-such-{uuid.uuid4().hex[:8]}/presets"

    outsider = [
        await api_client.get(base, headers=outsider_headers),
        await api_client.post(base, headers=outsider_headers, json={"slug": "x", "name": "X", "engine": "e"}),
        await api_client.get(f"{base}/private", headers=outsider_headers),
        await api_client.get(f"{base}/{created.json()['id']}", headers=outsider_headers),
        await api_client.patch(f"{base}/private", headers={**outsider_headers, "If-Match": tag}, json={"name": "X"}),
        await api_client.patch(f"{base}/private", headers={**outsider_headers, "If-Match": "bad"}, json={"name": "X"}),
        await api_client.delete(f"{base}/private", headers=outsider_headers),
    ]
    unknown = await api_client.get(missing_org, headers=outsider_headers)
    for response in outsider:
        assert response.status_code == 404, response.text
        assert response.json()["detail"] == unknown.json()["detail"]
        assert "ETag" not in response.headers

    # Another organization's preset, by id, through an organization the caller can read.
    foreign = f"/v1/organizations/{elsewhere}/presets/{created.json()['id']}"
    assert (await api_client.get(foreign, headers=outsider_headers)).status_code == 404
    assert (await api_client.delete(foreign, headers=outsider_headers)).status_code == 404
    assert (await api_client.get(f"{base}/private", headers=headers)).status_code == 200
    assert (await api_client.get(base)).status_code == 401


async def test_api_keys_read_with_jobs_read_and_write_with_engines_execute(api_client, registration, db_session, gate):  # noqa: F811
    _, headers, org = await owner(api_client, registration, db_session, gate)
    await create(api_client, headers, org, "keyed", options=OPTIONS)
    base = f"/v1/organizations/{org}/presets"
    reader = await make_key(api_client, headers, ["jobs:read"])
    runner = await make_key(api_client, headers, ["jobs:read", "engines:execute"])
    organizations = await make_key(api_client, headers, ["organizations:read", "organizations:write"])

    read = await api_client.get(f"{base}/keyed", headers=reader)
    assert read.status_code == 200, read.text
    # A key that cannot run engines reads redacted, as it reads runs.
    assert read.json()["options"] == HARMLESS
    assert (await api_client.get(f"{base}/keyed", headers=runner)).json()["options"] == OPTIONS
    refused = await api_client.post(base, headers=reader, json={"slug": "k", "name": "K", "engine": "e"})
    assert refused.status_code == 403, refused.text
    assert (await api_client.post(base, headers=runner, json={"slug": "k", "name": "K", "engine": "e"})).status_code == 201
    assert (await api_client.get(base, headers=organizations)).status_code == 403
