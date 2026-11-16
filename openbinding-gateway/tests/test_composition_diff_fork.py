"""Comparing two versions of a composition and forking one into another organization (F1 B10).

A diff reads both stored contents in the stored mode and answers SPHERE's PricingDiff shape with a
``comparison``. A fork, ported from SPHERE's ``forkPricing``, creates a new composition in another
organization whose first version is the source's document under the new slug, sealed again through the
same pipeline, with ``based_on`` and an immutable ``forked_from`` snapshot.
"""

from __future__ import annotations

import uuid
from dataclasses import replace

from sqlalchemy import func, select

from _b1_helpers import gate, make_account, put_member  # noqa: F401
from _composition_helpers import CountingPort, document_for, linked_problem
from _problem_helpers import make_org
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import text
from openbinding_gateway.core.settings import SphereRegistry, get_settings
from openbinding_gateway.db.models import AuditEvent, CompositionVersion, User
from openbinding_gateway.integrations import bim

YAML = {"content-type": "application/yaml"}
SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}

DECLARED = """\
syntaxVersion: "1.0"
composition: shop
version: {label}
kind: workflow
workflow:
  seq: [t1, t2]
binding:
  t1: {{candidate: {candidate}{source}}}
  t2: {{local: true}}
values:
  trust: 0.9
  latency: {{value: {latency}, unit: ms}}
"""


def declared(label: str = "1.0.0", *, candidate: str = "c1a", latency: int = 30, source: str = "") -> str:
    return DECLARED.format(label=label, candidate=candidate, latency=latency, source=source)


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


async def source_org(api_client, registration, db_session, gate):  # noqa: F811
    """An OWNER of an organization with a problem and a composition ``shop``, and of a second organization."""
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user)
    await db_session.commit()
    org = linked.organization.slug
    created = await api_client.post(
        f"/v1/organizations/{org}/compositions", headers=headers,
        json={"slug": "shop", "name": "Shop", "description": "The shop"},
    )
    assert created.status_code == 201, created.text
    target = await make_org(api_client, headers)
    return headers, linked, f"/v1/organizations/{org}/compositions/shop", target


async def seal(api_client, headers, base, source: str):
    response = await api_client.post(f"{base}/versions", content=source.encode("utf-8"), headers={**headers, **YAML})
    assert response.status_code == 201, response.text
    return response.json()["version"]


async def content(api_client, headers, base, version: str) -> str:
    response = await api_client.get(f"{base}/versions/{version}/content", headers=headers)
    assert response.status_code == 200, response.text
    return response.text


def rows(found: dict) -> list[tuple]:
    listed = [("general", None, c["path"], c["before"], c["after"]) for c in found["general"]]
    for section in found["sections"]:
        for entry in section["entries"]:
            listed += [(section["key"], entry["name"], c["path"], c["before"], c["after"]) for c in entry["changes"]]
    return listed


# --------------------------------------------------------------------------- diff


async def test_a_diff_lists_a_value_a_binding_and_a_from_change(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base, _ = await source_org(api_client, registration, db_session, gate)
    pinned = ", from: {sphere: acme/greeter, version: v1, plan: basic}"
    first = await seal(api_client, headers, base, declared("1.0.0", source=pinned))
    await seal(api_client, headers, base, declared("1.1.0", latency=40, source=pinned))
    await seal(api_client, headers, base, declared("1.2.0", candidate="c1b", latency=40, source=pinned))
    last = await seal(api_client, headers, base, declared("1.3.0", candidate="c1b", latency=40, source=pinned.replace("v1", "v2")))

    value = await api_client.get(f"{base}/diff", headers=headers, params={"from": "1.0.0", "to": "1.1.0"})
    binding = await api_client.get(f"{base}/diff", headers=headers, params={"from": "2", "to": "3"})
    source = await api_client.get(f"{base}/diff", headers=headers)

    assert value.status_code == binding.status_code == source.status_code == 200, value.text
    assert rows(value.json()) == [("values", "latency", "value", 30, 40)]
    assert value.json()["sections"][1]["entries"][0]["kind"] == "changed"
    assert value.json()["comparison"] == {
        "comparable": True, "problemRefChanged": False, "compilationChanged": False,
        "valueStatus": {"before": "declared", "after": "declared"},
    }
    assert rows(binding.json()) == [("binding", "t1", "candidate", "c1a", "c1b")]
    # By default: the latest version against the one before it.
    assert source.json()["from"]["label"] == "1.2.0" and source.json()["to"] == {"id": last["id"], "label": "1.3.0"}
    assert rows(source.json()) == [("binding", "t1", "from.version", "v1", "v2")]
    assert source.json()["totals"] == {"added": 0, "removed": 0, "changed": 1}

    by_id = await api_client.get(f"{base}/diff", headers=headers, params={"from": first["id"], "to": last["id"]})
    assert by_id.status_code == 200, by_id.text
    assert by_id.json()["from"] == {"id": first["id"], "label": "1.0.0"}
    assert rows(by_id.json()) == [
        ("binding", "t1", "candidate", "c1a", "c1b"),
        ("binding", "t1", "from.version", "v1", "v2"),
        ("values", "latency", "value", 30, 40),
    ]
    to_only = await api_client.get(f"{base}/diff", headers=headers, params={"to": "2"})
    assert (to_only.json()["from"]["label"], to_only.json()["to"]["label"]) == ("1.0.0", "1.1.0")
    itself = await api_client.get(f"{base}/diff", headers=headers, params={"from": "1", "to": "1"})
    assert itself.json()["isEmpty"] is True


async def test_a_diff_needs_two_versions_for_its_defaults(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base, _ = await source_org(api_client, registration, db_session, gate)

    empty = await api_client.get(f"{base}/diff", headers=headers)
    await seal(api_client, headers, base, declared())
    one = await api_client.get(f"{base}/diff", headers=headers)
    first = await api_client.get(f"{base}/diff", headers=headers, params={"to": "1.0.0"})
    unknown = await api_client.get(f"{base}/diff", headers=headers, params={"from": "9.9.9"})

    assert empty.status_code == one.status_code == first.status_code == 422, one.text
    assert code(empty) == code(one) == code(first) == "diff_version_missing"
    assert unknown.status_code == 404


async def test_a_diff_between_a_linked_and_a_declared_version_shows_no_value_change(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base, _ = await source_org(api_client, registration, db_session, gate)
    await seal(api_client, headers, base, document_for(linked, SIMPLE_BINDING))
    plain = text.read_stored(document_for(linked, SIMPLE_BINDING).replace("version: 1.0.0", "version: 2.0.0"))
    await seal(api_client, headers, base, text.serialise(replace(plain, problem=None, evidence=None)))

    response = await api_client.get(f"{base}/diff", headers=headers)

    assert response.status_code == 200, response.text
    found = response.json()
    assert found["comparison"] == {
        "comparable": False, "problemRefChanged": True, "compilationChanged": True,
        "valueStatus": {"before": "verified", "after": "declared"},
    }
    assert found["sections"][1]["entries"] == []
    assert {change["path"] for change in found["general"]} == {"problem.ref", "problem.compilation"}


async def test_a_diff_reads_versions_whose_registry_left_the_settings_and_a_fork_refuses_them(
    api_client, registration, db_session, gate, monkeypatch,  # noqa: F811
):
    headers, _, base, target = await source_org(api_client, registration, db_session, gate)
    monkeypatch.setattr(get_settings(), "sphere_registries", {"onprem": SphereRegistry(url="https://sphere.onprem.example")})
    pinned = ", from: {sphere: acme/greeter, registry: onprem, version: v1, plan: basic}"
    await seal(api_client, headers, base, declared("1.0.0", source=pinned))
    await seal(api_client, headers, base, declared("1.1.0", latency=35, source=pinned))
    monkeypatch.setattr(get_settings(), "sphere_registries", {})

    compared = await api_client.get(f"{base}/diff", headers=headers)
    forked = await api_client.post(
        f"{base}/fork", headers=headers, json={"version": "1.1.0", "targetOrganization": target},
    )

    assert compared.status_code == 200, compared.text
    assert rows(compared.json()) == [("values", "latency", "value", 30, 35)]
    assert forked.status_code == 422, forked.text
    assert code(forked) == "composition_invalid"
    assert [item["code"] for item in forked.json()["diagnostics"]] == [codes.FROM_REGISTRY_UNKNOWN]
    assert (await api_client.get(f"/v1/organizations/{target}/compositions/shop", headers=headers)).status_code == 404


async def test_a_non_member_cannot_diff(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base, _ = await source_org(api_client, registration, db_session, gate)
    await seal(api_client, headers, base, declared())
    await seal(api_client, headers, base, declared("1.1.0", latency=31))
    _, outsider = await make_account(api_client, registration, db_session, gate)

    response = await api_client.get(f"{base}/diff", headers=outsider)

    assert response.status_code == 404 and code(response) == "not_found"


# --------------------------------------------------------------------------- fork


async def test_a_fork_copies_the_document_into_another_organization(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base, target = await source_org(api_client, registration, db_session, gate)
    source = await seal(api_client, headers, base, declared())
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        response = await api_client.post(
            f"{base}/fork", headers=headers,
            json={"version": "1", "targetOrganization": target, "slug": "shop-copy", "name": "Shop copy"},
        )

    assert response.status_code == 201, response.text
    assert port.calls.get("evaluate", 0) == 0 and port.calls.get("compile", 0) == 0
    body = response.json()
    assert body["droppedProblem"] is False
    composition, version = body["composition"], body["version"]
    assert composition["organization"]["slug"] == target and composition["slug"] == "shop-copy"
    assert composition["name"] == "Shop copy" and composition["description"] == "The shop"
    assert composition["kind"] == "workflow" and composition["version_count"] == 1
    assert composition["latest_version"]["id"] == version["id"]
    assert composition["latest_version"]["verified"] is version["verified"] is False
    assert response.headers["ETag"] and response.headers["Location"] == f"/v1/organizations/{target}/compositions/shop-copy"
    assert version["ordinal"] == 1 and version["label"] == source["label"] and version["values_status"] == "declared"
    assert version["values"] == source["values"]
    source_id = (await api_client.get(base, headers=headers)).json()["id"]
    assert version["based_on"] == {"composition_id": source_id, "version_id": source["id"], "label": "1.0.0"}
    assert version["forked_from"] == {
        "compositionId": source_id,
        "versionId": source["id"],
        "label": "1.0.0",
        "organization": {
            "id": str(linked.organization.id), "name": linked.organization.slug, "displayName": linked.organization.name,
        },
        "slug": "shop",
        "name": "Shop",
        "droppedProblem": False,
    }

    copied = await content(api_client, headers, f"/v1/organizations/{target}/compositions/shop-copy", "1")
    original = await content(api_client, headers, base, "1")
    assert copied == original.replace("composition: shop\n", "composition: shop-copy\n")
    assert copied != original

    audited = (await db_session.scalars(select(AuditEvent).where(AuditEvent.action == "composition.forked"))).all()
    assert len(audited) == 1 and str(audited[0].target_id) == composition["id"]


async def test_a_fork_takes_the_source_slug_and_reports_a_taken_one(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base, target = await source_org(api_client, registration, db_session, gate)
    await seal(api_client, headers, base, declared())

    first = await api_client.post(f"{base}/fork", headers=headers, json={"version": "1.0.0", "targetOrganization": target})
    again = await api_client.post(f"{base}/fork", headers=headers, json={"version": "1.0.0", "targetOrganization": target})
    named = await api_client.post(
        f"{base}/fork", headers=headers, json={"version": "1.0.0", "targetOrganization": target, "slug": "shop"},
    )

    assert first.status_code == 201, first.text
    assert first.json()["composition"]["slug"] == "shop" and first.json()["composition"]["name"] == "Shop"
    assert again.status_code == 200, again.text
    assert again.json() == {
        "nameTaken": True,
        "existingComposition": {"id": first.json()["composition"]["id"], "slug": "shop", "name": "Shop"},
    }
    assert named.status_code == 409 and code(named) == "slug_conflict"
    # Nothing else was written in the target: one composition, one version.
    listed = await api_client.get(f"/v1/organizations/{target}/compositions", headers=headers)
    assert listed.json()["total"] == 1
    assert await db_session.scalar(select(func.count()).select_from(CompositionVersion).where(
        CompositionVersion.composition_id == uuid.UUID(first.json()["composition"]["id"]),
    )) == 1


async def test_a_fork_into_the_source_organization_is_refused(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base, _ = await source_org(api_client, registration, db_session, gate)
    await seal(api_client, headers, base, declared())

    by_slug = await api_client.post(
        f"{base}/fork", headers=headers,
        json={"version": "1.0.0", "targetOrganization": linked.organization.slug, "slug": "other"},
    )
    by_id = await api_client.post(
        f"{base}/fork", headers=headers,
        json={"version": "1.0.0", "targetOrganization": str(linked.organization.id), "slug": "other"},
    )

    assert by_slug.status_code == by_id.status_code == 409
    assert code(by_slug) == code(by_id) == "composition_fork_same_organization"


async def test_a_linked_version_is_forked_only_without_its_problem(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base, target = await source_org(api_client, registration, db_session, gate)
    source = await seal(api_client, headers, base, document_for(linked, SIMPLE_BINDING))
    assert source["values_status"] == "verified"
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        refused = await api_client.post(f"{base}/fork", headers=headers, json={"version": "1", "targetOrganization": target})
        dropped = await api_client.post(
            f"{base}/fork", headers=headers, json={"version": "1", "targetOrganization": target, "dropProblem": True},
        )

    assert refused.status_code == 409 and code(refused) == "composition_fork_problem_unreadable"
    assert dropped.status_code == 201, dropped.text
    assert port.calls.get("evaluate", 0) == 0 and port.calls.get("compile", 0) == 0
    body = dropped.json()
    version = body["version"]
    assert body["droppedProblem"] is True and version["forked_from"]["droppedProblem"] is True
    assert version["values_status"] == "declared" and version["problem"] is None
    # The values the toolchain computed for the source, now declared.
    assert version["values"] == source["values"]

    copied = text.read_stored(await content(api_client, headers, f"/v1/organizations/{target}/compositions/shop", "1"))
    original = text.read_stored(await content(api_client, headers, base, "1"))
    assert copied.problem is None and copied.evidence.evaluated_by == "declared"
    assert copied.binding == original.binding and copied.values == original.values
    assert copied.workflow == original.workflow


async def test_deleting_the_source_leaves_the_fork_intact(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base, target = await source_org(api_client, registration, db_session, gate)
    await seal(api_client, headers, base, declared())
    forked = await api_client.post(f"{base}/fork", headers=headers, json={"version": "1", "targetOrganization": target})
    assert forked.status_code == 201, forked.text

    assert (await api_client.delete(base, headers=headers)).status_code == 204

    fork_base = f"/v1/organizations/{target}/compositions/shop"
    kept = await api_client.get(f"{fork_base}/versions/1", headers=headers)
    assert kept.status_code == 200, kept.text
    assert kept.json()["based_on"] == forked.json()["version"]["based_on"]
    assert kept.json()["forked_from"]["slug"] == "shop"
    assert (await api_client.get(f"{fork_base}/versions/1/content", headers=headers)).status_code == 200


async def test_who_may_fork(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base, target = await source_org(api_client, registration, db_session, gate)
    await seal(api_client, headers, base, declared())
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    await put_member(api_client, headers, target, viewer["id"], "VIEWER")
    _, outsider_headers = await make_account(api_client, registration, db_session, gate)
    own_target = await make_org(api_client, outsider_headers)

    payload = {"version": "1", "targetOrganization": target}
    # The source is unreadable to whoever is not in its organization: a 404, as for a missing one.
    unreadable = await api_client.post(f"{base}/fork", headers=outsider_headers, json={**payload, "targetOrganization": own_target})
    # A reader of the source who is only a viewer of the target, and a target the caller cannot read.
    weak = await api_client.post(f"{base}/fork", headers=viewer_headers, json=payload)
    hidden = await api_client.post(
        f"{base}/fork", headers=headers, json={**payload, "targetOrganization": f"missing-{uuid.uuid4().hex[:6]}"},
    )
    missing = await api_client.post(f"{base}/fork", headers=headers, json={**payload, "version": "7.7.7"})
    malformed = await api_client.post(f"{base}/fork", headers=headers, json={"version": "1"})

    assert unreadable.status_code == 404 and code(unreadable) == "not_found"
    assert weak.status_code == 404  # the viewer cannot read the source organization either
    assert hidden.status_code == 404 and missing.status_code == 404
    assert malformed.status_code == 422

    await put_member(api_client, headers, linked.organization.slug, viewer["id"], "VIEWER")
    too_weak = await api_client.post(f"{base}/fork", headers=viewer_headers, json=payload)
    assert too_weak.status_code == 403 and code(too_weak) == "organization_forbidden"
