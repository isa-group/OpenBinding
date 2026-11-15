"""Study engines started from run presets (F2b B6).

A study engine may be ``{"preset": <slug or id>}``. Each run expands it, with the run-preset functions, into the
exact engine revision, mode, optimization and options the preset holds, and freezes them with the preset as
provenance, so editing the preset later changes the next run and never a run that exists.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from _problem_helpers import upload_problem
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import Job, StudyCell, StudyRun
from openbinding_gateway.models.platform import StudyDefinition
from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.services import execution
from openbinding_gateway.services.engines import engine_ref

OPTIMIZATION = {"type": "SINGLE", "scalarization": "weighted-sum"}
BASE = "/v1/organizations/lab"
REFERENCE = {"namespace": "acme", "name": "solver", "version": "1.0.0", "digest": "sha256-" + "a" * 64}


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


def message(response) -> str:
    body = response.json()
    return body["detail"]["error"] if isinstance(body.get("detail"), dict) else body["detail"]


async def solve(*args, **kwargs):
    return {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": {
        "t1": {"resource": "catalog", "id": "c1a"},
        "t2": {"resource": "catalog", "id": "c2a"},
        "t3": {"resource": "catalog", "id": "c3a"},
    }}}]}


@pytest.fixture
async def lab(api_client, db_session, registration, gate, monkeypatch):  # noqa: F811
    """An organization ``lab`` with a problem, a preset ``quick`` and the random-search engine as a study names it."""
    monkeypatch.setattr(get_settings(), "job_dispatch_mode", "inline")
    monkeypatch.setattr(execution, "solve_remote", solve)
    _, headers = await make_account(api_client, registration, db_session, gate)
    created = await api_client.post("/v1/organizations", headers=headers, json={"slug": "lab", "name": "Lab"})
    assert created.status_code == 201, created.text
    revision = (await upload_problem(api_client, headers, "lab", slug="checkout"))["revision"]
    quick = await preset(api_client, headers, "quick", options={"iterations": 50})
    exact = {
        **engine_ref(routes._manifest("random-search"), "bim.builtin"), "mode": "seeded", "optimization": OPTIMIZATION,
    }
    return {"headers": headers, "revision": revision, "preset": quick, "exact": exact}


async def preset(api_client, headers, slug, org="lab", **fields):
    body = {"slug": slug, "name": slug.title(), "engine": "random-search", "mode": "seeded",
            "optimization": OPTIMIZATION, **fields}
    response = await api_client.post(f"/v1/organizations/{org}/presets", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def study(api_client, lab, engines, slug="compare", seeds=(1,), parameter_sets=({},)):
    return await api_client.post(f"{BASE}/studies", headers=lab["headers"], json={
        "slug": slug, "name": slug.title(), "definition": {
            "revision_ids": [lab["revision"]["id"]], "engines": engines,
            "parameter_sets": list(parameter_sets), "seeds": list(seeds),
        },
    })


async def run(api_client, lab, slug="compare"):
    response = await api_client.post(f"{BASE}/studies/{slug}/runs", headers=lab["headers"])
    assert response.status_code == 202, response.text
    return response.json()


def test_a_definition_takes_a_preset_entry_and_refuses_a_malformed_one():
    revision = uuid.uuid4()
    exact = {**REFERENCE, "mode": "m", "optimization": OPTIMIZATION}
    StudyDefinition(revision_ids=[revision], engines=[{"preset": "quick"}, exact])
    StudyDefinition(revision_ids=[revision], engines=[
        {**exact, "options": {"a": 1}, "preset": {"id": str(uuid.uuid4()), "slug": "quick"}},
    ])
    for engines in (
        [{"preset": ""}],
        [{"preset": "quick", "mode": "m"}],
        [{**exact, "preset": "quick"}],
        [{**exact, "options": "fast"}],
        [{"preset": "quick"}, {"preset": "quick"}],
    ):
        with pytest.raises(ValueError):
            StudyDefinition(revision_ids=[revision], engines=engines)
    # Options are part of an engine's identity: the same revision with other options is another engine.
    StudyDefinition(revision_ids=[revision], engines=[exact, {**exact, "options": {"iterations": 5}}])
    with pytest.raises(ValueError, match="duplicate"):
        StudyDefinition(revision_ids=[revision], engines=[exact, {**exact, "options": {}}])


async def test_a_run_expands_the_preset_and_freezes_it_with_its_provenance(api_client, db_session, lab):
    created = await study(api_client, lab, [{"preset": "quick"}], seeds=(1, 2), parameter_sets=({}, {"time_budget_ms": 500}))
    assert created.status_code == 201, created.text
    assert created.json()["definition"]["engines"] == [{"preset": "quick"}]

    made = await run(api_client, lab)

    expected = {
        **{key: lab["exact"][key] for key in ("namespace", "name", "version", "digest")},
        "mode": "seeded", "optimization": OPTIMIZATION, "options": {"iterations": 50},
        "preset": {"id": lab["preset"]["id"], "slug": "quick"},
    }
    assert made["definition"]["engines"] == [expected]
    cells = (await db_session.scalars(
        select(StudyCell).where(StudyCell.study_run_id == uuid.UUID(made["id"])).order_by(StudyCell.ordinal)
    )).all()
    assert len(cells) == 4 and all(cell.engine_ref == expected for cell in cells)
    jobs = {cell.id: await db_session.get(Job, cell.job_id) for cell in cells}
    for cell in cells:
        job = jobs[cell.id]
        # The preset's options under the cell's parameter set, with the cell's seed.
        assert job.options == {"iterations": 50, **cell.parameters, "seed": cell.seed}
        assert job.provenance["preset"] == {"id": lab["preset"]["id"], "slug": "quick"}
        assert job.provenance["mode"] == "seeded"


async def test_a_parameter_set_wins_an_option_the_preset_also_gives(api_client, db_session, lab):
    assert (await study(api_client, lab, [{"preset": "quick"}], parameter_sets=({"iterations": 7},))).status_code == 201

    made = await run(api_client, lab)

    cell = await db_session.scalar(select(StudyCell).where(StudyCell.study_run_id == uuid.UUID(made["id"])))
    assert (await db_session.get(Job, cell.job_id)).options == {"iterations": 7, "seed": 1}


async def test_editing_the_preset_changes_the_next_run_and_never_a_frozen_one(api_client, db_session, lab):
    assert (await study(api_client, lab, [{"preset": "quick"}])).status_code == 201
    first = await run(api_client, lab)
    preset_url = f"{BASE}/presets/quick"
    etag = (await api_client.get(preset_url, headers=lab["headers"])).headers["ETag"]
    edited = await api_client.patch(
        preset_url, headers={**lab["headers"], "If-Match": etag}, json={"options": {"iterations": 9}},
    )
    assert edited.status_code == 200, edited.text

    second = await run(api_client, lab)

    again = await api_client.get(f"{BASE}/studies/compare/runs/{first['id']}", headers=lab["headers"])
    assert again.json()["definition"] == first["definition"]
    assert again.json()["definition_digest"] == first["definition_digest"]
    assert first["definition"]["engines"][0]["options"] == {"iterations": 50}
    assert second["definition"]["engines"][0]["options"] == {"iterations": 9}
    stored = await db_session.get(StudyRun, uuid.UUID(first["id"]))
    assert stored.definition["engines"][0]["options"] == {"iterations": 50}


async def test_unknown_foreign_and_federated_presets_are_refused(api_client, db_session, lab):
    unknown = await study(api_client, lab, [{"preset": "nowhere"}])
    assert unknown.status_code == 422 and code(unknown) == "preset_not_found"

    other = await api_client.post("/v1/organizations", headers=lab["headers"], json={"slug": "elsewhere", "name": "E"})
    assert other.status_code == 201, other.text
    foreign = await preset(api_client, lab["headers"], "theirs", org="elsewhere")
    for ref in ("theirs", foreign["id"]):
        refused = await study(api_client, lab, [{"preset": ref}])
        assert refused.status_code == 422 and code(refused) == "preset_not_found", refused.text

    await preset(api_client, lab["headers"], "federated", engine=REFERENCE, registration=REFERENCE)
    federated = await study(api_client, lab, [{"preset": "federated"}])
    assert federated.status_code == 422 and code(federated) == "preset_federated"
    assert "cannot join a study yet" in message(federated)

    await preset(api_client, lab["headers"], "loose", optimization=None)
    incomplete = await study(api_client, lab, [{"preset": "loose"}])
    assert incomplete.status_code == 422 and code(incomplete) == "preset_incomplete"


async def test_a_preset_deleted_after_the_study_was_saved_refuses_the_run(api_client, db_session, lab):
    assert (await study(api_client, lab, [{"preset": "quick"}])).status_code == 201
    etag = (await api_client.get(f"{BASE}/presets/quick", headers=lab["headers"])).headers["ETag"]
    deleted = await api_client.delete(f"{BASE}/presets/quick", headers={**lab["headers"], "If-Match": etag})
    assert deleted.status_code == 204, deleted.text

    refused = await api_client.post(f"{BASE}/studies/compare/runs", headers=lab["headers"])

    assert refused.status_code == 422 and code(refused) == "preset_not_found"
    assert (await db_session.scalar(select(StudyRun.id))) is None


async def test_engines_that_come_out_the_same_are_refused(api_client, db_session, lab):
    hand_picked = {**lab["exact"], "options": {"iterations": 50}}

    twice = await study(api_client, lab, [{"preset": "quick"}, hand_picked])
    await preset(api_client, lab["headers"], "same", options={"iterations": 50})
    alike = await study(api_client, lab, [{"preset": "quick"}, {"preset": "same"}], slug="alike")
    differs = await study(api_client, lab, [{"preset": "quick"}, lab["exact"]], slug="differs")

    assert twice.status_code == 422 and code(twice) == "duplicate_study_engines"
    assert alike.status_code == 422 and code(alike) == "duplicate_study_engines"
    assert differs.status_code == 201, differs.text


async def test_a_frozen_engine_can_be_saved_back_into_the_study(api_client, db_session, lab):
    assert (await study(api_client, lab, [{"preset": "quick"}])).status_code == 201
    frozen = (await run(api_client, lab))["definition"]["engines"]
    etag = (await api_client.get(f"{BASE}/studies/compare", headers=lab["headers"])).headers["ETag"]

    patched = await api_client.patch(f"{BASE}/studies/compare", headers={**lab["headers"], "If-Match": etag}, json={
        "definition": {"revision_ids": [lab["revision"]["id"]], "engines": frozen, "parameter_sets": [{}], "seeds": [1]},
    })

    assert patched.status_code == 200, patched.text
    again = await run(api_client, lab)
    assert again["definition"]["engines"] == frozen
