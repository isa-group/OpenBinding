"""SPHERE imports over HTTP: ``sphere/expand``, ``sphere/apply`` and ``sphere/recipe``, on the recorded SPHERE.

A member previews a recipe and applies it; apply stores exactly what the preview showed, as an ordinary revision
with origin ``sphere`` and one value origin per generated value; races and retries answer 409 or the same revision.
"""

from __future__ import annotations

import copy
import importlib
import json
import uuid

import pytest
from sqlalchemy import func, select

from _b1_helpers import gate  # noqa: F401
from _problem_helpers import ZIP, package_bytes, upload_problem
from _repo import REPO_ROOT
from openbinding_gateway.db.models import (
    AuditEvent,
    BindingCaseRevision,
    OrganizationMembership,
    OrganizationRole,
    ProblemValueOrigin,
)
from openbinding_gateway.modules.problems.application import problems as problems_module
from openbinding_gateway.space_client import PlanCaps

from problems._sphere_helpers import RUNNER, base_archive, member, tool

pytestmark = pytest.mark.asyncio
#: The module, not the function ``sphere.expand`` its package exports under the same name.
expand_module = importlib.import_module("openbinding_gateway.modules.problems.application.sphere.expand")

EMAIL = json.loads((REPO_ROOT / "examples" / "tomatometer" / "email-recipe.json").read_text())
STORAGE = json.loads((REPO_ROOT / "examples" / "tomatometer" / "storage-recipe.json").read_text())
GOLDEN_DIGEST = (tool.DEFAULT_OUT / "tomatometer-email.package.digest").read_text().strip()


def other_digest(recipe: dict) -> str:
    """The package digest a new problem from ``recipe`` would have (what its preview on a free slug answers)."""
    from bim_core.package import load_package
    from openbinding_gateway.modules.problems.application.sphere import generate
    from openbinding_gateway.modules.problems.domain.sphere.recipe import parse_recipe

    parsed, _ = parse_recipe(recipe)
    return load_package(generate(parsed, tool.recorded_sources(parsed), name="storage").archive()).package_digest


def _url(org: str, problem: str, action: str) -> str:
    return f"/v1/organizations/{org}/problems/{problem}/sphere/{action}"


async def _flagship_problem(api_client, headers, org) -> dict:
    return await upload_problem(api_client, headers, org, archive=base_archive(), slug="tomatometer-email")


async def _expand(api_client, headers, org, problem, recipe, base):
    response = await api_client.post(_url(org, problem, "expand"), json={"recipe": recipe, "base": base}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def _apply(api_client, headers, org, problem, recipe, base, digest, **extra):
    return await api_client.post(
        _url(org, problem, "apply"),
        json={"recipe": recipe, "base": base, "expect": {"packageDigest": digest}, **extra}, headers=headers,
    )


async def test_expand_on_the_flagship_shows_the_golden_candidates(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    await _flagship_problem(api_client, headers, org)
    view = await _expand(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1})
    assert view["valid"] is True, view["diagnostics"]
    assert view["packageDigest"] == GOLDEN_DIGEST
    golden = RUNNER.generated("tomatometer-email")
    assert [(c["key"], c["eligible"]) for c in view["candidates"]] == [(c["key"], c["eligible"]) for c in golden.candidates]
    assert {d["code"] for d in view["diagnostics"]} >= {"sphere_limit_assumed", "sphere_plan_private"}
    assert view["changes"]["removed"] == [] and "sphere-email/email.mailgun.foundation" in view["changes"]["added"]
    assert {s["owner"] for s in view["snapshots"]} == {"danruilop1"}
    assert all(s["versionName"] == "2026-10" and s["latest"] is True for s in view["snapshots"])
    foundation = next(c for c in view["facts"]["candidates"] if c["key"] == "sphere-email/email.mailgun.foundation")
    assert foundation["origins"]["subscription"]["source"]["kind"] == "priced"
    assert foundation["origins"]["subscription"]["source"]["pricing"]["versionLabel"] == "2026-10"
    assert foundation["provenance"]["sphere"] == "danruilop1/mailgun"
    assert view["recipe"]["tasks"][0]["from"][0]["sphere"]["version"] == "6ade36454b2b5b01c587db3d"


async def test_expand_on_a_free_slug_previews_a_new_problem(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    view = await _expand(api_client, headers, org, "storage", STORAGE, None)
    assert view["valid"] is True, view["diagnostics"]
    assert view["changes"]["added"] == sorted(c["key"] for c in view["candidates"])
    listed = await api_client.get(f"/v1/organizations/{org}/problems", headers=headers)
    assert listed.json()["total"] == 0


async def test_latest_is_resolved_and_pinned(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    recipe = copy.deepcopy(STORAGE)
    recipe["tasks"][0]["from"][0]["sphere"]["version"] = "latest"
    view = await _expand(api_client, headers, org, "storage", recipe, None)
    assert view["valid"] is True, view["diagnostics"]
    # Dropbox's latest by date is 2021, the version the example names.
    assert view["recipe"]["tasks"][0]["from"][0]["sphere"]["version"] == "687e4b68102baa50f3a5c7b7"
    refused = await _apply(api_client, headers, org, "storage", recipe, None, view["packageDigest"])
    assert refused.status_code == 422 and refused.json()["code"] == "sphere_recipe_invalid"
    assert refused.json()["diagnostics"][0]["code"] == "sphere_version_unpinned"


async def test_expand_reports_findings_with_a_200(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    await _flagship_problem(api_client, headers, org)
    sphere.not_found("/api/v1/public/pricings/6ade2f3b40e55445692b09aa")
    view = await _expand(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1})
    assert view["valid"] is False and view["facts"] is None
    unreadable = [d for d in view["diagnostics"] if d["code"] == "sphere_source_unreadable"]
    assert unreadable == [{"code": "sphere_source_unreadable", "severity": "error", "at": "/tasks/0/from/4",
                           "message": "This pricing version is not found or not visible.", "reason": "not_found"}]

    old = copy.deepcopy(STORAGE)
    old["tasks"][0]["from"][0]["sphere"]["version"] = "687e4b68102baa50f3a5c7b5"  # Dropbox 2023, Pricing2Yaml 2.1
    view = await _expand(api_client, headers, org, "storage", old, None)
    assert "sphere_syntax_unsupported" in {d["code"] for d in view["diagnostics"]}

    shape = await _expand(api_client, headers, org, "storage", {"recipeVersion": "1"}, None)
    assert shape["valid"] is False and {d["code"] for d in shape["diagnostics"]} == {"sphere_recipe_shape"}


async def test_a_compiler_refusal_is_a_finding_in_expand_and_a_422_in_apply(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    await _flagship_problem(api_client, headers, org)
    broken = copy.deepcopy(EMAIL)
    broken["tasks"][0]["properties"]["availability"]["map"] = {"true": 1.5, "false": 0.99}  # outside the ratio domain
    view = await _expand(api_client, headers, org, "tomatometer-email", broken, {"revision": 1})
    assert view["valid"] is False
    assert any(d["code"] == "feature_value_domain" for d in view["diagnostics"]), view["diagnostics"]
    golden_like = await _expand(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1})
    refused = await _apply(api_client, headers, org, "tomatometer-email", broken, {"revision": 1},
                           golden_like["packageDigest"])
    # The package the recipe generates is compiled before anything is stored: refused as an upload is.
    assert refused.status_code == 422 and refused.json()["code"] == "invalid_instance", refused.text
    assert any(d["code"] == "feature_value_domain" for d in refused.json()["diagnostics"])


async def test_apply_stores_what_the_preview_showed(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    await _flagship_problem(api_client, headers, org)
    view = await _expand(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1})
    calls = len(sphere.requests)
    applied = await _apply(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1}, view["packageDigest"])
    assert applied.status_code == 201, applied.text
    assert len(sphere.requests) == calls  # apply after expand reads nothing from SPHERE
    body = applied.json()
    assert body["revision"]["revision"] == 2 and body["revision"]["origin"] == "sphere"
    assert body["revision"]["package_digest"] == view["packageDigest"]
    provenance = body["revision"]["provenance"]
    assert provenance["producer"] == "openbinding-sphere-import" and provenance["recipeDigest"] == view["recipeDigest"]
    assert provenance["recipe"] == view["recipe"]
    assert body["revision"]["sphere"]["recipeDigest"] == view["recipeDigest"]
    assert {s["versionLabel"] for s in body["revision"]["sphere"]["sources"]} == {"2026-10"}

    filtered = await api_client.get(f"/v1/organizations/{org}/problems", params={"origin": "sphere"}, headers=headers)
    assert [p["slug"] for p in filtered.json()["problems"]] == ["tomatometer-email"]
    revision = await db_session.scalar(select(BindingCaseRevision).where(BindingCaseRevision.id == uuid.UUID(body["revision"]["id"])))
    rows = (await db_session.scalars(select(ProblemValueOrigin).where(ProblemValueOrigin.revision_id == revision.id))).all()
    golden = RUNNER.generated("tomatometer-email").origins
    assert sorted((r.candidate_key, r.target, r.source_kind, r.value) for r in rows) == sorted(
        (o["candidateKey"], o["target"], o["sourceKind"], o["value"]) for o in golden
    )
    assert all(r.snapshot_id is not None for r in rows if r.pricing_id)
    audit = await db_session.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == "problem.sphere_applied"))
    assert audit == 1

    again = await _apply(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1}, view["packageDigest"])
    assert again.status_code == 200 and again.json()["revision"]["id"] == body["revision"]["id"]
    assert await db_session.scalar(select(func.count()).select_from(ProblemValueOrigin)) == len(rows)

    recipe = await api_client.get(_url(org, "tomatometer-email", "recipe"), headers=headers)
    assert recipe.status_code == 200 and recipe.json()["revision"] == 2 and recipe.json()["recipe"] == view["recipe"]
    first = await api_client.get(_url(org, "tomatometer-email", "recipe"), params={"revision": 1}, headers=headers)
    assert first.status_code == 404

    changed = copy.deepcopy(EMAIL)
    changed["demand"]["monthlyEmails"]["value"] = 60000
    next_view = await _expand(api_client, headers, org, "tomatometer-email", changed, {"revision": 2})
    assert next_view["changes"]["changed"] == [] and next_view["changes"]["added"] == []
    third = await _apply(api_client, headers, org, "tomatometer-email", changed, {"revision": 2}, next_view["packageDigest"])
    assert third.status_code == 201 and third.json()["revision"]["revision"] == 3
    # A retry of revision 3's apply on its stale base is the same revision; other content on it is refused.
    retried = await _apply(api_client, headers, org, "tomatometer-email", changed, {"revision": 2}, next_view["packageDigest"])
    assert retried.status_code == 200 and retried.json()["revision"]["revision"] == 3
    other = copy.deepcopy(EMAIL)
    other["demand"]["monthlyEmails"]["value"] = 90000
    other_view = await _expand(api_client, headers, org, "tomatometer-email", other, {"revision": 2})
    stale = await _apply(api_client, headers, org, "tomatometer-email", other, {"revision": 2}, other_view["packageDigest"])
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "revision_moved"
    assert stale.json()["detail"]["latest"] == 3


async def test_a_new_problem_from_sphere_and_its_retries(api_client, registration, db_session, gate, sphere):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    view = await _expand(api_client, headers, org, "storage", STORAGE, None)
    created = await _apply(api_client, headers, org, "storage", STORAGE, None, view["packageDigest"], name="Storage")
    assert created.status_code == 201, created.text
    assert created.json()["problem"]["name"] == "Storage" and created.json()["revision"]["origin"] == "sphere"
    repeated = await _apply(api_client, headers, org, "storage", STORAGE, None, view["packageDigest"])
    assert repeated.status_code == 200 and repeated.json()["revision"]["id"] == created.json()["revision"]["id"]
    other = copy.deepcopy(STORAGE)
    other["demand"]["storageGB"]["value"] = 2500
    other_view = await api_client.post(_url(org, "storage", "expand"), json={"recipe": other, "base": None}, headers=headers)
    assert other_view.status_code == 409 and other_view.json()["detail"]["code"] == "problem_exists"
    taken = await _apply(api_client, headers, org, "storage", other, None, other_digest(other))
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "problem_exists"


async def test_an_editor_save_between_preview_and_insert_wins(api_client, registration, db_session, gate, sphere, monkeypatch):  # noqa: F811
    headers, org, _, user = await member(api_client, registration, db_session, gate)
    uploaded = await _flagship_problem(api_client, headers, org)
    view = await _expand(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1})
    real = problems_module._lock_account
    saved = {}

    async def save_first(session, user_id):
        monkeypatch.setattr(problems_module, "_lock_account", real)
        problem = await problems_module.problem_by_ref(
            session, uuid.UUID(uploaded["problem"]["organization_id"]), "tomatometer-email"
        )
        saved["upload"] = await problems_module.add_revision(
            session, problem, package_bytes(REPO_ROOT / "examples" / "demo" / "01_simple_seq"), user,
        )
        await real(session, user_id)

    monkeypatch.setattr(problems_module, "_lock_account", save_first)
    refused = await _apply(api_client, headers, org, "tomatometer-email", EMAIL, {"revision": 1}, view["packageDigest"])
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "revision_moved", refused.text
    assert saved["upload"].revision.revision == 2
    revisions = await api_client.get(f"/v1/organizations/{org}/problems/tomatometer-email/revisions", headers=headers)
    assert [r["revision"] for r in revisions.json()] == [1, 2]
    assert revisions.json()[1]["origin"] == "upload"


async def test_quotas_and_roles(api_client, registration, db_session, gate, sphere, monkeypatch):  # noqa: F811
    headers, org, organization, _ = await member(api_client, registration, db_session, gate)
    view = await _expand(api_client, headers, org, "storage", STORAGE, None)
    real = gate.caps

    async def caps(user_id):
        base = await real(user_id)
        return PlanCaps(plan=base.plan, features=base.features, limits={**base.limits, "maxProblems": 0})

    monkeypatch.setattr(gate, "caps", caps)
    refused = await _apply(api_client, headers, org, "storage", STORAGE, None, view["packageDigest"])
    assert refused.status_code == 402 and refused.json()["detail"]["quota"]["limit_id"] == "maxProblems"
    monkeypatch.setattr(gate, "caps", real)

    viewer_headers, _, _, viewer = await member(api_client, registration, db_session, gate)
    db_session.add(OrganizationMembership(organization_id=organization.id, user_id=viewer.id, role=OrganizationRole.VIEWER))
    await db_session.commit()
    denied = await api_client.post(_url(org, "storage", "expand"), json={"recipe": STORAGE, "base": None},
                                   headers=viewer_headers)
    assert denied.status_code == 403
    denied = await _apply(api_client, viewer_headers, org, "storage", STORAGE, None, view["packageDigest"])
    assert denied.status_code == 403


async def test_no_sphere_read_while_compiling_and_a_body_limit(api_client, registration, db_session, gate, sphere, monkeypatch):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    real = expand_module.compile_package
    seen = {}

    async def watched(archive):
        before = len(sphere.requests)
        result = await real(archive)
        seen["during"] = len(sphere.requests) - before
        return result

    monkeypatch.setattr(expand_module, "compile_package", watched)
    view = await _expand(api_client, headers, org, "storage", STORAGE, None)
    assert view["valid"] and seen == {"during": 0}
    assert sphere.requests  # the preview read SPHERE, before compiling
    big = {"recipe": {**STORAGE, "padding": "x" * (300 * 1024)}, "base": None}
    too_big = await api_client.post(_url(org, "storage", "expand"), json=big, headers=headers)
    assert too_big.status_code == 413


async def test_the_recipe_of_a_problem_never_generated_is_not_found(api_client, registration, db_session, gate):  # noqa: F811
    headers, org, _, _ = await member(api_client, registration, db_session, gate)
    await upload_problem(api_client, headers, org, slug="plain")
    missing = await api_client.get(_url(org, "plain", "recipe"), headers=headers)
    assert missing.status_code == 404
    assert ZIP  # the upload helpers' media type


def test_the_openapi_component_is_the_recipe_schema_file():
    """One schema, no second model: the component ``SphereImportRecipe`` is the gateway's schema file, its internal
    references pointed into the component."""
    from pathlib import Path

    from openbinding_gateway.main import app
    from openbinding_gateway.modules.problems.domain.sphere import recipe as recipe_module

    path = Path(recipe_module.__file__).resolve().parents[2] / "resources" / "sphere-recipe" / "1" / "recipe.schema.json"
    text = path.read_text().replace('"#/$defs/', '"#/components/schemas/SphereImportRecipe/$defs/')
    schemas = app.openapi()["components"]["schemas"]
    assert schemas["SphereImportRecipe"] == json.loads(text)
    for component in ("SphereExpandRequest", "SphereApplyRequest", "SphereRecipeView"):
        assert schemas[component]["properties"]["recipe"] == {"$ref": "#/components/schemas/SphereImportRecipe"}
