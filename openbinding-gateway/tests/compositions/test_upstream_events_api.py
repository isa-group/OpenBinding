"""The upstream events API (F6 A12): list, read and review, the 404 parity, and members-only counts on the views."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_account, put_member  # noqa: F401
from openbinding_gateway.db.models import AuditEvent, CompositionUpstreamEvent

from ._tomatometer import seeded
from ._watching import cycle

pytestmark = pytest.mark.asyncio


async def _ready(api_client, registration, db_session, gate, sphere, source, clocks, *scenarios):  # noqa: F811
    found = await seeded(api_client, registration, db_session, gate)
    await cycle(db_session, source)
    for scenario in scenarios:
        sphere.publish(scenario)
        clocks.advance(30)
        await cycle(db_session, source)
    return found


def _base(found) -> str:
    return f"/v1/organizations/{found.org}/compositions/tomatometer"


async def _person(api_client, registration, db_session, gate, found, role: str | None):  # noqa: F811
    account, headers = await make_account(api_client, registration, db_session, gate)
    if role is not None:
        assert (await put_member(api_client, found.headers, found.org, account["id"], role)).status_code in (200, 201)
    return headers


async def test_the_list_filters_and_pages(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks,
                         "brevo-professional-up", "brevo-professional-retired", "tomatometer-1.2.0")
    url = f"{_base(found)}/upstream-events"
    listed = await api_client.get(url, headers=found.headers)
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert [(e["subject"], e["category"]) for e in body["events"]] == [
        ("offering", "offering_changed"), ("binding", "binding_invalid"), ("binding", "values_changed")]
    assert body["counts"] == {"open": 3, "reviewed": 0, "resolved": 0, "noImpact": 0}
    assert {w["status"] for w in body["watches"]} == {"active"} and len(body["watches"]) == 4
    first, second = body["events"][2], body["events"][1]
    assert first["supersededBy"] == second["id"] and second["rebindingRecommended"] is True
    assert first["environments"] == ["production"] and first["version"]["label"] == "1.0.0"
    assert first["old"]["label"] == "2026-10" and first["new"]["label"] == "2026-11"
    binding = (await api_client.get(url, params={"subject": "binding", "category": "values_changed"},
                                    headers=found.headers)).json()["events"]
    assert [e["id"] for e in binding] == [first["id"]]
    page = (await api_client.get(url, params={"limit": 1}, headers=found.headers)).json()
    assert len(page["events"]) == 1 and page["nextBefore"]
    rest = (await api_client.get(url, params={"limit": 5, "before": page["nextBefore"]}, headers=found.headers)).json()
    assert [e["id"] for e in rest["events"]] == [second["id"], first["id"]]


async def test_the_detail_serves_the_stored_diff_with_an_etag(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks, "brevo-professional-up")
    event = await db_session.scalar(select(CompositionUpstreamEvent))
    read = await api_client.get(f"{_base(found)}/upstream-events/{event.id}", headers=found.headers)
    assert read.status_code == 200 and read.headers["ETag"]
    assert read.json()["diff"] == event.diff and read.json()["diff"]["global"][0]["delta"] == "50.000000"


async def test_a_member_reviews_once_with_a_note(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks, "brevo-professional-up")
    event = await db_session.scalar(select(CompositionUpstreamEvent))
    url = f"{_base(found)}/upstream-events/{event.id}"
    viewer = await _person(api_client, registration, db_session, gate, found, "VIEWER")
    assert (await api_client.post(f"{url}/review", json={}, headers=viewer)).status_code == 403
    tag = (await api_client.get(url, headers=found.headers)).headers["ETag"]
    stale = await api_client.post(f"{url}/review", json={"note": "x"}, headers={**found.headers, "If-Match": '"stale"'})
    assert stale.status_code == 412
    refused = await api_client.post(f"{url}/review", json={"note": "x", "state": "resolved"}, headers=found.headers)
    assert refused.status_code == 422
    reviewed = await api_client.post(f"{url}/review", json={"note": "Seen; re-solving"},
                                     headers={**found.headers, "If-Match": tag})
    assert reviewed.status_code == 200, reviewed.text
    body = reviewed.json()
    assert (body["state"], body["note"], body["reviewedBy"]["username"]) == ("reviewed", "Seen; re-solving",
                                                                            found.user.username)
    assert reviewed.headers["ETag"] != tag
    again = await api_client.post(f"{url}/review", json={}, headers=found.headers)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "event_not_reviewable"
    audit = await db_session.scalar(select(AuditEvent).where(AuditEvent.action == "composition.upstream_event_reviewed"))
    assert audit.detail["noteLength"] == len("Seen; re-solving") and "Seen" not in str(audit.detail)


async def test_the_404_parity(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks, "brevo-professional-up")
    event = await db_session.scalar(select(CompositionUpstreamEvent))
    outsider = await _person(api_client, registration, db_session, gate, found, None)
    url = f"{_base(found)}/upstream-events"
    private = await api_client.get(url, headers=outsider)
    missing = await api_client.get(f"/v1/organizations/{found.org}/compositions/nothing/upstream-events",
                                   headers=outsider)
    assert private.status_code == missing.status_code == 404 and private.json() == missing.json()
    assert (await api_client.get(url)).status_code == 401
    made_public = await api_client.patch(_base(found), json={"visibility": "public"}, headers=found.headers)
    assert made_public.status_code == 200, made_public.text
    for path in (url, f"{url}/{event.id}"):
        hidden = await api_client.get(path, headers=outsider)
        assert hidden.status_code == 404 and hidden.json()["detail"] == "Upstream event not found." or \
            hidden.json().get("detail", {}) in ("Upstream event not found.",) or "Upstream event not found." in hidden.text
    # The public reader's views carry no counts.
    assert (await api_client.get(_base(found), headers=outsider)).json()["upstream"] is None
    public_list = await api_client.get("/v1/compositions", headers=outsider)
    assert all("upstream" not in item for item in public_list.json()["compositions"])
    # Another composition's event id is the same 404 for a member.
    other = await api_client.post(f"/v1/organizations/{found.org}/compositions", headers=found.headers,
                                  json={"slug": "other", "name": "Other"})
    assert other.status_code == 201
    foreign = await api_client.get(f"/v1/organizations/{found.org}/compositions/other/upstream-events/{event.id}",
                                   headers=found.headers)
    assert foreign.status_code == 404 and "Upstream event not found." in foreign.text


async def test_members_see_counts_on_every_view(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks,
                         "brevo-professional-up", "brevo-professional-retired", "tomatometer-1.2.0")
    base = _base(found)
    composition = (await api_client.get(base, headers=found.headers)).json()["upstream"]
    # The two Brevo events of 1.0.0 count once (stacked); the offering event counts while open.
    assert composition == {"open": 2, "reviewed": 0, "bindingInvalid": 1, "worst": "binding_invalid"}
    listed = (await api_client.get(f"/v1/organizations/{found.org}/compositions", headers=found.headers)).json()
    assert listed["compositions"][0]["upstream"] == composition
    mine = (await api_client.get("/v1/users/me/compositions", headers=found.headers)).json()
    assert mine["compositions"][0]["upstream"] == composition
    production = (await api_client.get(f"{base}/environments/production", headers=found.headers)).json()["upstream"]
    assert production["open"] == 2 and production["worst"] == "binding_invalid" and production["resolvedBy"] is None
    versions = {v["label"]: v["upstream"] for v in
                (await api_client.get(f"{base}/versions", headers=found.headers)).json()["versions"]}
    assert versions["1.0.0"]["open"] == 1 and versions["1.0.0"]["bindingInvalid"] == 1
    assert versions["1.1.0"] == {"open": 1, "reviewed": 0, "bindingInvalid": 0, "worst": "offering_changed"}
    upstream_view = (await api_client.get(f"{base}/upstream", params={"version": "1.0.0"}, headers=found.headers)).json()
    watched = [entry["watch"] for entry in upstream_view["entries"] if entry.get("watch")]
    assert watched and all(w["status"] == "active" for w in watched)


async def test_a_resolving_seal_not_adopted_shows_on_the_environment(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    import yaml

    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks, "brevo-professional-up")
    base = _base(found)
    sphere.source._cache.clear()
    document = yaml.safe_load((await api_client.get(f"{base}/versions/1.0.0/content", headers=found.headers)).text)
    document["version"] = "1.2.0"
    document.pop("problem")
    document.pop("evidence", None)
    document["binding"]["dailySummary"]["from"]["version"] = "6fff00000000000000000001"
    sealed = await api_client.post(f"{base}/versions", content=yaml.safe_dump(document, sort_keys=False).encode(),
                                   headers={**found.headers, "content-type": "application/yaml"})
    assert sealed.status_code == 201, sealed.text
    environment = await api_client.get(f"{base}/environments/production", headers=found.headers)
    upstream = environment.json()["upstream"]
    assert (upstream["open"], upstream["resolvedBy"]["version"]["label"]) == (0, "1.2.0")


async def test_the_callers_list_names_only_their_organizations(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks, "brevo-professional-up")
    mine = await api_client.get("/v1/users/me/upstream-events", headers=found.headers)
    assert mine.status_code == 200
    (row,) = mine.json()["events"]
    assert row["organization"]["slug"] == found.org and row["composition"]["slug"] == "tomatometer"
    outsider = await _person(api_client, registration, db_session, gate, found, None)
    assert (await api_client.get("/v1/users/me/upstream-events", headers=outsider)).json()["events"] == []
    assert (await api_client.get("/v1/users/me/upstream-events")).status_code == 401


async def test_reading_and_reviewing_never_move_the_environment_or_its_feed(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks, "brevo-professional-up")
    base = _base(found)
    before = await api_client.get(f"{base}/environments/production", headers=found.headers)
    feed = await api_client.get(f"{base}/environments/production/composition", headers=found.headers)
    event = await db_session.scalar(select(CompositionUpstreamEvent))
    await api_client.get(f"{base}/upstream-events", headers=found.headers)
    assert (await api_client.post(f"{base}/upstream-events/{event.id}/review", json={},
                                  headers=found.headers)).status_code == 200
    after = await api_client.get(f"{base}/environments/production", headers=found.headers)
    again = await api_client.get(f"{base}/environments/production/composition", headers=found.headers)
    assert after.headers["ETag"] == before.headers["ETag"] and again.headers["ETag"] == feed.headers["ETag"]
    assert after.json()["upstream"]["reviewed"] == 1 and after.json()["upstream"]["open"] == 0


async def test_no_route_resolves_an_event(api_client, registration, db_session, gate, sphere, source, clocks):  # noqa: F811
    from fastapi.routing import APIRoute

    from openbinding_gateway.main import app

    found = await _ready(api_client, registration, db_session, gate, sphere, source, clocks, "brevo-professional-up")
    writes = set()
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute) and "upstream-events" in route.path:
                writes |= {(method, route.path) for method in route.methods & {"POST", "PUT", "PATCH", "DELETE"}}
    assert writes == {("POST", "/v1/organizations/{org}/compositions/{composition}/upstream-events/{event}/review")}
    event = await db_session.scalar(select(CompositionUpstreamEvent))
    url = f"{_base(found)}/upstream-events/{event.id}"
    assert (await api_client.post(f"{url}/review", json={}, headers=found.headers)).json()["state"] == "reviewed"
    assert (await api_client.post(f"{url}/review", json={}, headers=found.headers)).status_code == 409
