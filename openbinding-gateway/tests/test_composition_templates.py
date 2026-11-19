"""Composition templates (F4 B2): the catalog, and a member's composition made from one in one action.

The catalog is open to anybody; ``from-template`` makes the template's problem (revision 1, then one per SPHERE
recipe, on the recorded SPHERE) and a composition whose first version is derived from the manifest's binding, with
its offering read when sealed. Nothing is written for a taken slug or with SPHERE off; once the problem exists a
failure keeps it and answers 502 ``template_incomplete``, never a composition without its version.
"""

from __future__ import annotations

import json
import re

import pytest
import yaml
from sqlalchemy import func, select

from _b1_helpers import gate, make_key  # noqa: F401
from _environment_api import code
from _paths import GATEWAY_ROOT
from _repo import REPO_ROOT
from openbinding_gateway.db.models import (
    AuditEvent,
    BindingCase,
    BindingCaseRevision,
    Composition,
    CompositionEnvironment,
    OrganizationMembership,
    OrganizationRole,
)
from openbinding_gateway.modules.compositions.application import templates
from openbinding_gateway.space_client import PlanCaps

from problems._sphere_helpers import member

pytestmark = pytest.mark.asyncio

CATALOG = "/v1/compositions/templates"
MANIFESTS = REPO_ROOT / "examples" / "templates"
DROPBOX = "/api/v1/public/pricings/6ab0a323697330667ccce9c1"


def url(org: str) -> str:
    return f"/v1/organizations/{org}/compositions/from-template"


def manifest(name: str) -> dict:
    return json.loads((MANIFESTS / f"{name}.json").read_text(encoding="utf-8"))


async def counts(db_session) -> tuple[int, int, int]:
    return (
        int(await db_session.scalar(select(func.count()).select_from(BindingCase))),
        int(await db_session.scalar(select(func.count()).select_from(BindingCaseRevision))),
        int(await db_session.scalar(select(func.count()).select_from(Composition))),
    )


# -- The catalog ------------------------------------------------------------------------------------------------


def test_every_manifest_is_valid_and_its_paths_are_in_the_image():
    found = templates.catalog()
    assert [item.id for item in found] == sorted(path.stem for path in MANIFESTS.glob("*.json"))
    assert {item.id for item in found} == {"fms", "tomatometer"}
    # The gateway image copies examples/ (manifests, bundles, recipes and packages alike).
    dockerfile = (GATEWAY_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r"^COPY .*examples/? ", dockerfile, re.MULTILINE), "the gateway image no longer copies examples/"
    for item in found:
        problem = item.problem
        for relative in [problem.get("bundle"), problem.get("package"), *item.recipes]:
            if relative is not None:
                assert relative.startswith("examples/") and (REPO_ROOT / relative).exists(), relative
    # No manifest is a BIM package: the corpus does not grow (no instance.json under examples/templates).
    assert not list(MANIFESTS.rglob("instance.json"))


def test_a_manifest_outside_the_schema_or_examples_is_refused():
    document = manifest("tomatometer")
    with pytest.raises(ValueError):
        templates._parse({**document, "id": "other"}, "tomatometer")
    with pytest.raises(ValueError):
        templates._parse({**document, "problem": {**document["problem"], "bundle": "examples/../../etc/passwd"}},
                         "tomatometer")
    with pytest.raises(ValueError):
        templates._parse({**document, "extra": True}, "tomatometer")


async def test_anybody_reads_the_catalog(api_client):
    listed = await api_client.get(CATALOG)

    assert listed.status_code == 200, listed.text
    body = listed.json()["templates"]
    assert [item["id"] for item in body] == ["fms", "tomatometer"]
    tomatometer = body[1]
    assert tomatometer == {
        "id": "tomatometer", "title": "TomatoMeter composite", "summary": manifest("tomatometer")["summary"],
        "kind": "application", "tasks": ["login", "dailySummary", "export", "quotes"], "hasOffering": True,
        "available": True, "unavailableReason": None,
    }
    assert body[0]["hasOffering"] is False and body[0]["available"] is True

    one = await api_client.get(f"{CATALOG}/tomatometer")
    assert one.status_code == 200, one.text
    detail = one.json()
    assert detail["problem"] == {"slug": "tomatometer-email", "name": "TomatoMeter e-mail", "revisions": 3}
    assert detail["composition"]["binding"]["dailySummary"] == "email.brevo.professional"
    assert detail["composition"]["offering"] == {"sphere": "sphere/tomatometer"}
    assert detail["operation"] == {"expectedUsers": 1000}
    for unknown in ("nothing", "Tomatometer", "%2E%2E", "..%2Ffms", "tomatometer.json"):
        missing = await api_client.get(f"{CATALOG}/{unknown}")
        assert missing.status_code == 404, unknown


async def test_with_sphere_off_the_sphere_template_is_unavailable(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    monkeypatch.setattr(templates, "sphere_available", lambda: False)
    body = (await api_client.get(CATALOG)).json()["templates"]
    by_id = {item["id"]: item for item in body}
    assert by_id["tomatometer"]["available"] is False
    assert by_id["tomatometer"]["unavailableReason"] == "sphere_disabled"
    assert by_id["fms"]["available"] is True

    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    before = await counts(db_session)
    refused = await api_client.post(url(org), headers=headers, json={"template": "tomatometer"})
    assert refused.status_code == 409 and code(refused) == "template_needs_sphere"
    assert await counts(db_session) == before


# -- Instantiation ----------------------------------------------------------------------------------------------


async def test_a_member_starts_tomatometer_from_its_template(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, organization, _ = await member(api_client, registration, db_session, gate)

    made = await api_client.post(url(org), headers=headers, json={"template": "tomatometer"})

    assert made.status_code == 201, made.text
    body = made.json()
    assert body["template"] == "tomatometer"
    assert body["problem"] == {"slug": "tomatometer-email", "revision": 3}
    assert body["composition"]["slug"] == "tomatometer" and body["composition"]["kind"] == "application"
    assert body["version"]["label"] == "1.0.0" and body["version"]["values_status"] == "verified"
    assert body["evaluation"]["outcome"] == "verified"
    assert body["operation"] == {"expectedUsers": 1000}
    assert made.headers["Location"] == f"/v1/organizations/{org}/compositions/tomatometer"
    assert made.headers["ETag"]

    revisions = (await db_session.scalars(
        select(BindingCaseRevision.revision).join(BindingCase).where(BindingCase.organization_id == organization.id)
        .order_by(BindingCaseRevision.revision)
    )).all()
    assert revisions == [1, 2, 3]
    content = await api_client.get(f"/v1/organizations/{org}/compositions/tomatometer/versions/1.0.0/content",
                                   headers=headers)
    document = yaml.safe_load(content.text)
    spec = manifest("tomatometer")["composition"]
    assert document["problem"]["ref"] == f"{org}/problems/tomatometer-email@3"
    assert document["workflow"] == spec["workflow"]
    assert {task: entry["candidate"] for task, entry in document["binding"].items()} == spec["binding"]
    assert document["binding"]["dailySummary"]["from"] == {
        "sphere": "danruilop1/brevo", "version": "6ade2d444b2b5b01c587d80d", "plan": "PROFESSIONAL",
    }
    assert document["binding"]["export"]["from"]["sphere"] == "atenea/dropbox"
    assert document["binding"]["export"]["from"]["plan"] == "PLUS"
    assert document["offering"] == {"sphere": "sphere/tomatometer"}
    assert document["evidence"]["manual"] is True
    # No environment is created; the operation hints are only defaults.
    assert not (await db_session.scalars(select(CompositionEnvironment))).all()
    actions = set((await db_session.scalars(select(AuditEvent.action))).all())
    assert {"problem.created", "problem.sphere_applied", "composition.created", "composition.instantiated"} <= actions

    # The same template again, under other slugs, makes a second pair.
    again = await api_client.post(url(org), headers=headers, json={
        "template": "tomatometer", "slug": "tm-two", "name": "TomatoMeter two", "problemSlug": "tm-two-email",
    })
    assert again.status_code == 201, again.text
    assert again.json()["composition"]["name"] == "TomatoMeter two"
    assert again.json()["problem"] == {"slug": "tm-two-email", "revision": 3}


async def test_fms_gives_a_verified_version_without_an_offering(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)

    made = await api_client.post(url(org), headers=headers, json={"template": "fms"})

    assert made.status_code == 201, made.text
    body = made.json()
    assert body["problem"] == {"slug": "fms", "revision": 1}
    assert body["composition"]["kind"] == "system"
    assert body["version"]["values_status"] == "verified" and body["evaluation"]["outcome"] == "verified"
    assert body["operation"] == {"expectedUsers": None}
    content = await api_client.get(f"/v1/organizations/{org}/compositions/fms/versions/1.0.0/content", headers=headers)
    document = yaml.safe_load(content.text)
    spec = manifest("fms")["composition"]
    assert "offering" not in document
    assert document["workflow"] == spec["workflow"]
    bound = {task: entry["candidate"] for task, entry in document["binding"].items() if "candidate" in entry}
    assert bound == spec["binding"]


async def test_a_taken_slug_writes_nothing(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    created = await api_client.post(f"/v1/organizations/{org}/compositions", headers=headers,
                                    json={"slug": "fms", "name": "Mine"})
    assert created.status_code == 201
    before = await counts(db_session)

    taken = await api_client.post(url(org), headers=headers, json={"template": "fms"})
    assert taken.status_code == 409 and code(taken) == "slug_conflict"
    assert taken.json()["detail"]["field"] == "slug"
    assert await counts(db_session) == before

    made = await api_client.post(url(org), headers=headers, json={"template": "fms", "slug": "fleet"})
    assert made.status_code == 201, made.text
    before = await counts(db_session)
    problem_taken = await api_client.post(url(org), headers=headers, json={"template": "fms", "slug": "fleet-two"})
    assert problem_taken.status_code == 409 and code(problem_taken) == "slug_conflict"
    assert problem_taken.json()["detail"]["field"] == "problemSlug"
    assert await counts(db_session) == before


async def test_a_sphere_failure_after_the_problem_keeps_it_and_makes_no_composition(
    api_client, registration, db_session, gate, sphere,  # noqa: F811
):
    headers, org, organization, _ = await member(api_client, registration, db_session, gate)
    organization_id = organization.id
    # The test's own transaction ends here: the gateway's session shares this connection and rolls back its own.
    await db_session.commit()
    sphere.not_found(DROPBOX)

    failed = await api_client.post(url(org), headers=headers, json={"template": "tomatometer"})

    assert failed.status_code == 502, failed.text
    detail = failed.json()["detail"]
    assert detail["code"] == "template_incomplete"
    assert detail["problem"] == "tomatometer-email" and detail["revision"] == 2
    assert detail["cause"]
    problem = await db_session.scalar(select(BindingCase).where(BindingCase.organization_id == organization_id))
    assert problem is not None and problem.slug == "tomatometer-email"
    assert not (await db_session.scalars(select(Composition).where(Composition.organization_id == organization_id))).all()


async def test_quotas_entitlements_and_roles(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    headers, org, organization, _ = await member(api_client, registration, db_session, gate)
    real = gate.caps

    async def no_room(user_id):
        base = await real(user_id)
        return PlanCaps(plan=base.plan, features=base.features, limits={**base.limits, "maxProblems": 0})

    async def no_repository(user_id):
        base = await real(user_id)
        return PlanCaps(plan=base.plan, features={**base.features, "repository": False}, limits=base.limits)

    before = await counts(db_session)
    monkeypatch.setattr(gate, "caps", no_room)
    full = await api_client.post(url(org), headers=headers, json={"template": "fms"})
    assert full.status_code == 402 and full.json()["detail"]["quota"]["limit_id"] == "maxProblems"
    monkeypatch.setattr(gate, "caps", no_repository)
    unentitled = await api_client.post(url(org), headers=headers, json={"template": "fms"})
    assert unentitled.status_code == 403 and code(unentitled) == "feature_not_entitled"
    monkeypatch.setattr(gate, "caps", real)
    assert await counts(db_session) == before

    viewer_headers, _, _, viewer = await member(api_client, registration, db_session, gate)
    db_session.add(OrganizationMembership(organization_id=organization.id, user_id=viewer.id, role=OrganizationRole.VIEWER))
    await db_session.commit()
    denied = await api_client.post(url(org), headers=viewer_headers, json={"template": "fms"})
    assert denied.status_code == 403 and code(denied) == "organization_forbidden"
    outsider_headers, _, _, _ = await member(api_client, registration, db_session, gate)
    hidden = await api_client.post(url(org), headers=outsider_headers, json={"template": "fms"})
    assert hidden.status_code == 404
    unknown = await api_client.post(url(org), headers=headers, json={"template": "nothing"})
    assert unknown.status_code == 404
    bad = await api_client.post(url(org), headers=headers, json={"template": "../fms"})
    assert bad.status_code == 422
    assert (await api_client.post(url(org), json={"template": "fms"})).status_code == 401
    assert await counts(db_session) == before


async def test_a_personal_key_needs_both_writes_and_both_kinds(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)

    async def bounded(permissions, kinds):
        created = await api_client.post("/v1/users/me/api-keys", headers=headers, json={
            "name": "template key", "permissions": permissions, "engine_access": {"all": True, "engines": []},
            "boundary": {"resource_kinds": kinds},
        })
        assert created.status_code == 201, created.text
        return {"X-API-Key": created.json()["secret"]}

    write_only = await make_key(api_client, headers, ["compositions:write"])
    refused = await api_client.post(url(org), headers=write_only, json={"template": "nothing"})
    assert refused.status_code == 403 and code(refused) == "insufficient_api_key_permission"
    assert refused.json()["detail"]["missing_permissions"] == ["problems:write"]

    both = ["compositions:write", "problems:write"]
    narrow = await bounded(both, ["compositions"])
    boundary = await api_client.post(url(org), headers=narrow, json={"template": "nothing"})
    assert boundary.status_code == 403 and code(boundary) == "api_key_boundary"

    wide = await bounded(both, ["compositions", "problems"])
    passes = await api_client.post(url(org), headers=wide, json={"template": "nothing"})
    assert passes.status_code == 404  # past the key's checks: no such template
    made = await api_client.post(url(org), headers=wide, json={"template": "fms"})
    assert made.status_code == 201, made.text
