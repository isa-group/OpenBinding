"""The F1 walk at the API: problem, run, composition, version, evaluation, preset and run again.

The path F1 adds, against SQLite, the in-process toolchain and a fake engine (the worker's runner awaited
inline, as in ``test_f0b_walk.py``):

1. the demo package ``01_simple_seq`` is uploaded and run; a composition ``simple-seq`` derives its version
   1.0.0 from the run's solution;
2. its content, hand-edited into 1.1.0 with a wrong latency, is checked (a ``c2y_value_differs`` warning, the
   toolchain's value in the content a seal would store) and sealed; the diff of 1.0.0 and 1.1.0 is empty,
   since only the label changed and a diff does not report labels;
3. another toolchain release that reads the problem alike re-evaluates 1.0.0 (superseded, still verified),
   and 1.1.0 is forked into another organization as ``simple-seq-b``, without its problem;
4. the stateless ``parse`` and ``serialise`` of the stored content give back the same bytes;
5. another binding is evaluated, the neighbourhood of ``t1`` explored, and a run started from a run preset;
6. a declared composition written from scratch, with an offering on a registry the deployment does not
   define, is sealed with that warning.

No IR is stored outside ``problem_compilations``, and every version has exactly one evaluation by the
installed toolchain, or exactly one declared evaluation.
"""

from __future__ import annotations

import pytest
import yaml
from sqlalchemy import select

from _b1_helpers import gate, make_account  # noqa: F401
from _composition_helpers import OtherToolchain
from _problem_helpers import ZIP, make_org
from analysis_b3_b4_b6._helpers import persisted_anywhere
from test_f0b_walk import DESCRIPTORS, OPTIMIZATION, TEMPLATE, worker  # noqa: F401
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.db.models import (
    CompositionEvaluation,
    CompositionVersion,
    EvaluationBasis,
    ProblemCompilation,
    ValuesStatus,
)
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.compositions.application.versions import installed_basis

pytestmark = pytest.mark.asyncio

YAML = {"content-type": "application/yaml"}

SKETCH = """\
syntaxVersion: "1.0"
composition: sketch
version: 0.1.0
kind: workflow
workflow:
  seq: [login, {and: [dailySummary, export]}, quotes]
binding:
  login: {local: true}
  dailySummary: {candidate: email.brevo.professional, from: {sphere: danruilop1/brevo, version: 6ade2d444b2b5b01c587d80d, plan: PROFESSIONAL}}
  export: {candidate: storage.dropbox.plus}
  quotes: {candidate: quotes.zenquotes.free}
values:
  availability: 0.9985
  subscription: {value: 508.99, unit: USD/month}
offering: {sphere: sphere/tomatometer, registry: onprem}
"""


def codes_of(diagnostics) -> list[tuple[str, str]]:
    return [(item["code"], item["severity"]) for item in diagnostics]


async def test_problem_run_composition_version_evaluation_preset_and_run(
    api_client, db_session, registration, gate, worker,  # noqa: F811
):
    queued, settle = worker
    _, headers = await make_account(api_client, registration, db_session, gate)
    org = await make_org(api_client, headers)
    compositions = f"/v1/organizations/{org}/compositions"

    # 1. Upload, run, and derive 1.0.0 from the run's solution.
    archive = (await api_client.get(f"/v1/bim/templates/{TEMPLATE}")).content
    uploaded = await api_client.post(
        f"/v1/organizations/{org}/problems", params={"slug": "simple-seq"}, content=archive, headers={**headers, **ZIP},
    )
    assert uploaded.status_code == 201, uploaded.text
    revision = uploaded.json()["revision"]["id"]
    created = await api_client.post(
        f"/v1/organizations/{org}/runs", headers=headers,
        json={"revision": revision, "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert created.status_code == 202, created.text
    run = created.json()["id"]
    assert await settle(db_session) == [run]
    assert (await api_client.get(f"/v1/organizations/{org}/runs/{run}", headers=headers)).json()["status"] == "completed"

    made = await api_client.post(compositions, headers=headers, json={"slug": "simple-seq", "name": "Simple sequence"})
    assert made.status_code == 201, made.text
    base = f"{compositions}/simple-seq"
    derived = await api_client.post(f"{base}/derive", headers=headers, json={"run": run, "version": "1.0.0"})
    assert derived.status_code == 201, derived.text
    first = derived.json()["version"]
    assert first["values_status"] == "verified" and first["evidence_run"] == {"id": run}
    assert derived.json()["derivation"]["source"] == "run"

    # 2. A hand-edited 1.1.0: checked (the toolchain's value wins, with a warning), sealed, compared.
    content = (await api_client.get(f"{base}/versions/1.0.0/content", headers=headers)).text
    assert "    value: 30.0\n" in content
    edited = content.replace("version: 1.0.0", "version: 1.1.0").replace("    value: 30.0\n", "    value: 31\n")
    checked = await api_client.post(f"{base}/versions/check", content=edited.encode(), headers={**headers, **YAML})
    assert checked.status_code == 200, checked.text
    assert checked.json()["valid"] is True
    assert codes_of(checked.json()["diagnostics"]) == [(codes.VALUE_DIFFERS, "warning")]
    assert checked.json()["content"] == content.replace("version: 1.0.0", "version: 1.1.0")
    sealed = await api_client.post(f"{base}/versions", content=edited.encode(), headers={**headers, **YAML})
    assert sealed.status_code == 201, sealed.text
    second = sealed.json()["version"]
    assert second["ordinal"] == 2 and second["values"] == first["values"]
    diffed = await api_client.get(f"{base}/diff", params={"from": "1.0.0", "to": "1.1.0"}, headers=headers)
    assert diffed.status_code == 200, diffed.text
    assert diffed.json()["isEmpty"] is True and diffed.json()["general"] == []
    assert diffed.json()["comparison"]["comparable"] is True

    # 3. A release that reads the problem alike re-evaluates 1.0.0; 1.1.0 is forked into another organization.
    with bim.bim_override(OtherToolchain(bim.get_bim())):
        again = await api_client.post(f"{base}/versions/1.0.0/evaluations", headers=headers)
    assert again.status_code == 201, again.text
    assert again.json()["outcome"] == "verified" and again.json()["values"] == first["values"]
    assert codes_of(again.json()["diagnostics"]) == [(codes.COMPILATION_SUPERSEDED, "info")]
    other = await make_org(api_client, headers)
    forked = await api_client.post(
        f"{base}/fork", headers=headers,
        json={"version": "1.1.0", "targetOrganization": other, "slug": "simple-seq-b", "dropProblem": True},
    )
    assert forked.status_code == 201, forked.text
    copy = forked.json()["version"]
    assert forked.json()["droppedProblem"] is True and copy["values_status"] == "declared"
    assert copy["values"] == second["values"]
    assert copy["forked_from"]["slug"] == "simple-seq" and copy["forked_from"]["label"] == "1.1.0"

    # 4. The stateless services give the stored bytes back.
    stored = (await api_client.get(f"{base}/versions/1.1.0/content", headers=headers)).text
    parsed = await api_client.post("/v1/compositions/parse", content=stored.encode(), headers={**headers, **YAML})
    assert parsed.status_code == 200, parsed.text
    assert parsed.json()["diagnostics"] == []
    written = await api_client.post("/v1/compositions/serialise", json=parsed.json()["document"], headers=headers)
    assert written.status_code == 200, written.text
    assert written.text == stored

    # 5. Another binding, the neighbourhood of t1, and a run from a preset.
    evaluated = await api_client.post(f"{base}/evaluate", headers=headers, json={"binding": {"t1": "c1b"}})
    assert evaluated.status_code == 200, evaluated.text
    assert evaluated.json()["valid"] is True and evaluated.json()["version"]["label"] == "1.1.0"
    assert evaluated.json()["values"] != second["values"]
    around = await api_client.get(f"{base}/neighborhood", params={"task": "t1"}, headers=headers)
    assert around.status_code == 200, around.text
    assert [move["candidate"] for move in around.json()["moves"]] == ["c1b"]
    preset = await api_client.post(
        f"/v1/organizations/{org}/presets", headers=headers,
        json={"slug": "quick", "name": "Quick", "engine": "random-search", "mode": "seeded", "optimization": OPTIMIZATION},
    )
    assert preset.status_code == 201, preset.text
    from_preset = await api_client.post(
        f"/v1/organizations/{org}/runs", headers=headers, json={"revision": revision, "preset": "quick"},
    )
    assert from_preset.status_code == 202, from_preset.text
    rerun = from_preset.json()["id"]
    assert queued == [rerun] and await settle(db_session) == [rerun]
    finished = (await api_client.get(f"/v1/organizations/{org}/runs/{rerun}", headers=headers)).json()
    assert finished["status"] == "completed", finished

    # 6. A declared composition from scratch, its offering on a registry the deployment does not define.
    made = await api_client.post(
        compositions, headers=headers, json={"slug": "sketch", "name": "TomatoMeter sketch", "kind": "workflow"},
    )
    assert made.status_code == 201, made.text
    declared = await api_client.post(
        f"{compositions}/sketch/versions", content=SKETCH.encode(), headers={**headers, **YAML},
    )
    assert declared.status_code == 201, declared.text
    assert declared.json()["version"]["values_status"] == "declared"
    assert codes_of(declared.json()["diagnostics"]) == [(codes.OFFERING_REGISTRY_UNKNOWN, "warning")]
    sketch = yaml.safe_load((await api_client.get(f"{compositions}/sketch/versions/1/content", headers=headers)).text)
    assert sketch["offering"] == {"sphere": "sphere/tomatometer", "registry": "onprem"}
    assert sketch["evidence"] == {"evaluatedBy": "declared"}

    # Every version has exactly one evaluation by the installed toolchain, or exactly one declared one.
    installed = installed_basis()
    versions = (await db_session.scalars(select(CompositionVersion))).all()
    assert len(versions) == 4
    for version in versions:
        evaluations = (await db_session.scalars(
            select(CompositionEvaluation).where(CompositionEvaluation.version_id == version.id)
        )).all()
        if version.values_status is ValuesStatus.DECLARED:
            assert [item.basis for item in evaluations] == [EvaluationBasis.DECLARED], version.label
        else:
            assert [item.basis_key for item in evaluations].count(installed) == 1, version.label
    # The IR lives in problem_compilations only: one row per toolchain that compiled the revision.
    compilations = (await db_session.scalars(select(ProblemCompilation))).all()
    assert {str(row.revision_id) for row in compilations} == {revision} and len(compilations) == 2
    for compilation in compilations:
        spec = compilation.ir.get("spec", {})
        parts = {key: value for key, value in spec.items() if key not in DESCRIPTORS and len(repr(value)) > 40}
        assert {"instance", "application", "candidates"} <= set(parts), sorted(spec)
        for key, part in parts.items():
            assert not await persisted_anywhere(db_session, repr(part), exclude={"problem_compilations"}), key
