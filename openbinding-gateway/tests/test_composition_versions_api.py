"""Sealing composition versions with their evaluation, and checking a document as a seal would (F1 B9).

Every problem is uploaded and compiled for real, and every value and verdict comes from the in-process
toolchain. A seal stores the canonical text of the effective document (values replaced by the toolchain's,
evidence stamped) with one evaluation; a check answers the same findings and stores nothing.
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager

import pytest
from sqlalchemy import event, func, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from _b1_helpers import gate, make_account  # noqa: F401
from _composition_helpers import (
    CountingPort,
    SemanticChange,
    bim_binding,
    document_for,
    finished_run,
    first_binding,
    linked_problem,
)
from _paths import TESTS_DIR
from _repo import REPO_ROOT
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import spans, text
from openbinding_gateway.composition.diagnostics import Path
from openbinding_gateway.composition.document import Evidence, Offering, ProblemRef, Provenance, Value
from openbinding_gateway.core.settings import SphereRegistry, get_settings
from openbinding_gateway.db.models import (
    AuditEvent,
    Composition,
    CompositionEvaluation,
    CompositionVersion,
    User,
)
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.compositions.domain.analytics import analytics
from openbinding_gateway.modules.compositions.domain.refs import VersionRef, problem_ref_text, version_ref

JSON = REPO_ROOT / "examples" / "demo" / "16_json_complete"
PLACEMENT = REPO_ROOT / "examples" / "placement" / "01_small_placement"
NEGATIVE = REPO_ROOT / "examples" / "demo" / "11_multi_obj_negative"
GOLDEN = TESTS_DIR / "composition" / "golden" / "valid"

SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}
YAML = {"content-type": "application/yaml"}

DECLARED = """\
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: workflow
workflow:
  seq: [t1, t2]
binding:
  t1: {candidate: c1a}
  t2: {local: true}
values:
  trust: 0.9
  latency: {value: 30, unit: ms}
"""


# --------------------------------------------------------------------------- helpers


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


def found(diagnostics) -> list[tuple[str, str, str]]:
    return [(item["code"], item["severity"], item["path"]) for item in diagnostics]


async def owner_of(api_client, registration, db_session, gate, path=None):  # noqa: F811
    """A signed-in account, OWNER of a new organization with a problem (``path``) and a composition ``shop``."""
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    linked = await linked_problem(db_session, user, **({"path": path} if path else {}))
    await db_session.commit()
    base = f"/v1/organizations/{linked.organization.slug}/compositions"
    created = await api_client.post(base, headers=headers, json={"slug": "shop", "name": "Shop"})
    assert created.status_code == 201, created.text
    return headers, linked, f"{base}/shop"


async def seal(api_client, headers, base, source: str):
    return await api_client.post(f"{base}/versions", content=source.encode("utf-8"), headers={**headers, **YAML})


async def check(api_client, headers, base, source: str):
    return await api_client.post(
        f"{base}/versions/check", content=source.encode("utf-8"), headers={**headers, **YAML},
    )


async def rows(db_session, model) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(model)) or 0)


# --------------------------------------------------------------------------- declared versions


async def test_a_declared_version_is_sealed_once_by_meaning(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)

    first = await seal(api_client, headers, base, DECLARED)

    assert first.status_code == 201, first.text
    body = first.json()
    version = body["version"]
    assert version["ordinal"] == 1 and version["label"] == "1.0.0" and version["kind"] == "workflow"
    assert version["values_status"] == "declared" and version["verified"] is False
    assert version["syntax_version"] == "1.0"
    assert version["problem"] is None and version["evidence_run"] is None
    assert version["values"] == {"latency": {"value": 30, "unit": "ms"}, "trust": {"value": 0.9, "unit": "1"}}
    assert first.headers["ETag"] == f'"{version["content_digest"]}"'
    assert first.headers["Location"].endswith(f"/versions/{version['id']}")
    (evaluation,) = version["evaluations"]
    assert evaluation["basis"] == "declared" and evaluation["outcome"] == "declared" and evaluation["current"]
    assert evaluation["compilation"] is None and body["evaluation"]["id"] == evaluation["id"]
    assert version["current_evaluation_id"] == evaluation["id"]

    content = await api_client.get(f"{base}/versions/{version['id']}/content", headers=headers)
    stored = content.text
    assert text.serialise(text.parse(stored)) == stored
    assert "evidence:\n  evaluatedBy: declared\n" in stored
    assert version["size_bytes"] == len(stored.encode("utf-8"))

    again = await seal(api_client, headers, base, DECLARED)
    flow = (
        '{values: {latency: {unit: ms, value: 30}, trust: 0.9}, binding: {t2: {local: true}, t1: {candidate: c1a}},'
        ' workflow: {seq: [t1, t2]}, kind: workflow, version: 1.0.0, composition: shop, syntaxVersion: "1.0"}\n'
    )
    reformatted = await seal(api_client, headers, base, flow)
    assert again.status_code == reformatted.status_code == 200, reformatted.text
    assert again.json()["version"]["id"] == reformatted.json()["version"]["id"] == version["id"]
    assert "Location" not in again.headers
    assert await rows(db_session, CompositionVersion) == 1 and await rows(db_session, CompositionEvaluation) == 1

    taken = await seal(api_client, headers, base, DECLARED.replace("trust: 0.9", "trust: 0.8"))
    assert taken.status_code == 409, taken.text
    assert code(taken) == "version_label_taken"
    assert taken.json()["detail"]["version"] == {"id": version["id"], "ordinal": 1, "label": "1.0.0"}

    second = await seal(
        api_client, headers, base, DECLARED.replace("version: 1.0.0", "version: 1.1.0").replace("kind: workflow", "kind: system"),
    )
    assert second.status_code == 201, second.text
    assert second.json()["version"]["ordinal"] == 2

    composition = (await api_client.get(base, headers=headers)).json()
    assert composition["kind"] == "system" and composition["version_count"] == 2
    assert composition["latest_version"]["label"] == "1.1.0" and composition["latest_version"]["ordinal"] == 2
    listed = (await api_client.get(base.rsplit("/", 1)[0], headers=headers)).json()["compositions"]
    assert [(item["slug"], item["version_count"]) for item in listed] == [("shop", 2)]
    sealed = (await db_session.scalars(select(AuditEvent.action).where(AuditEvent.action == "composition.version_sealed"))).all()
    assert len(sealed) == 2


async def test_versions_are_listed_and_named_by_id_label_and_ordinal(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)
    first = (await seal(api_client, headers, base, DECLARED)).json()["version"]
    second = (await seal(api_client, headers, base, DECLARED.replace("version: 1.0.0", "version: 2.0.0"))).json()["version"]

    newest = (await api_client.get(f"{base}/versions", headers=headers)).json()
    oldest = (await api_client.get(f"{base}/versions?order=oldest&include=analytics", headers=headers)).json()

    assert newest["total"] == 2 and [item["ordinal"] for item in newest["versions"]] == [2, 1]
    assert all(item["analytics"] is None for item in newest["versions"])
    assert [item["ordinal"] for item in oldest["versions"]] == [1, 2]
    assert oldest["versions"][0]["analytics"] == {
        "tasks": 2, "boundTasks": 1, "localTasks": 1, "providers": 1, "upstreamPricings": 0,
        "workflow": {"depth": 1, "xor": 0, "and": 0, "loop": 0}, "hasOffering": False,
    }
    assert oldest["versions"][0]["values"] == first["values"]
    for ref in (first["id"], "1.0.0", "1"):
        got = await api_client.get(f"{base}/versions/{ref}", headers=headers)
        assert got.status_code == 200 and got.json()["id"] == first["id"]
        assert got.headers["ETag"] == f'"{first["content_digest"]}"'
    assert (await api_client.get(f"{base}/versions/2", headers=headers)).json()["id"] == second["id"]
    for missing in ("3", "9.9.9", str(uuid.uuid4()), "01", "latest"):
        assert (await api_client.get(f"{base}/versions/{missing}", headers=headers)).status_code == 404


async def test_the_content_is_served_with_its_digest(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)
    version = (await seal(api_client, headers, base, DECLARED)).json()["version"]
    url = f"{base}/versions/{version['label']}/content"

    served = await api_client.get(url, headers=headers)
    cached = await api_client.get(url, headers={**headers, "If-None-Match": served.headers["ETag"]})

    assert served.status_code == 200
    assert served.headers["content-type"] == "application/yaml; charset=utf-8"
    assert served.headers["ETag"] == f'"{version["content_digest"]}"'
    assert served.headers["Cache-Control"] == "private, immutable"
    stored = await db_session.scalar(select(CompositionVersion.content).where(CompositionVersion.id == uuid.UUID(version["id"])))
    assert served.content == stored.encode("utf-8")
    assert cached.status_code == 304 and cached.content == b""


async def test_a_slug_mismatch_is_an_info(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)

    sealed = await seal(api_client, headers, base, DECLARED.replace("composition: shop", "composition: other"))

    assert sealed.status_code == 201, sealed.text
    assert found(sealed.json()["diagnostics"]) == [(codes.SLUG_MISMATCH, "info", "composition")]


async def test_a_sealed_version_cannot_be_changed(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)
    version = (await seal(api_client, headers, base, DECLARED)).json()["version"]
    identifier = uuid.UUID(version["id"])

    with pytest.raises((IntegrityError, DBAPIError), match="composition_versions rows are sealed and immutable"):
        await db_session.execute(update(CompositionVersion).where(CompositionVersion.id == identifier).values(label="9.9.9"))
    await db_session.rollback()
    with pytest.raises((IntegrityError, DBAPIError), match="composition_evaluations rows are sealed and immutable"):
        await db_session.execute(
            update(CompositionEvaluation).where(CompositionEvaluation.version_id == identifier).values(values={})
        )
    await db_session.rollback()


# --------------------------------------------------------------------------- linked versions


async def test_a_linked_version_stores_the_toolchains_values(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    source = document_for(linked, SIMPLE_BINDING, values={"latency": Value(31, "ms")})

    sealed = await seal(api_client, headers, base, source)

    assert sealed.status_code == 201, sealed.text
    body = sealed.json()
    version = body["version"]
    expected = bim.get_bim().evaluate(linked.compilation.ir, bim_binding(linked, SIMPLE_BINDING))["features"]
    assert version["values"] == {"latency": {"value": expected["latency"], "unit": "ms"}}
    assert version["values"]["latency"]["value"] == 30.0
    assert version["values_status"] == "verified" and version["verified"] is True
    assert version["problem"] == {
        "problem": {"id": str(linked.upload.problem.id), "slug": linked.upload.problem.slug, "name": linked.upload.problem.name},
        "revision": {"id": str(linked.upload.revision.id), "revision": linked.upload.revision.revision},
        "linked_compilation": {
            "id": str(linked.compilation.id), "compilation_digest": linked.compilation.compilation_digest,
            "semantic_digest": linked.compilation.semantic_digest,
        },
    }
    evaluation = body["evaluation"]
    assert evaluation["basis"] == "bim" and evaluation["outcome"] == "verified" and evaluation["current"]
    assert evaluation["compilation"]["id"] == str(linked.compilation.id)
    assert evaluation["compilation"]["compiler_digest"] == linked.compilation.compiler_digest
    assert found(body["diagnostics"]) == [(codes.VALUE_DIFFERS, "warning", "values.latency.value")]
    assert body["diagnostics"][0]["span"] is not None

    stored = (await api_client.get(f"{base}/versions/1/content", headers=headers)).text
    document = text.read_stored(stored)
    toolchain = linked.compilation.toolchain
    assert document.evidence == Evidence(
        manual=True, evaluated_by="gateway", toolchain=f"{toolchain['name']} {toolchain['version']}"
    )
    assert document.value("latency") == Value(30.0, "ms")
    assert "value: 30.0\n" in stored
    row = await db_session.scalar(select(CompositionEvaluation))
    assert row.values == {"latency": {"value": 30.0, "unit": "ms"}}
    assert row.binding == bim_binding(linked, SIMPLE_BINDING)
    assert row.result["features"] == expected


@pytest.mark.parametrize(
    "case",
    [
        "unknown candidate", "candidate of another task", "hand-edited workflow", "from without version",
        "offering with two sources", "http offering", "unknown problem", "unknown compilation",
        "another organization's problem", "problem content",
    ],
)
async def test_a_refused_document_is_located(api_client, registration, db_session, gate, case):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    ref = linked.ref
    sources = {
        "unknown candidate": (document_for(linked, {**SIMPLE_BINDING, "t1": "nope"}), codes.CANDIDATE_UNKNOWN),
        "candidate of another task": (
            document_for(linked, {**SIMPLE_BINDING, "t1": "c2a"}), codes.CANDIDATE_NOT_ALLOWED,
        ),
        "hand-edited workflow": (
            document_for(linked, SIMPLE_BINDING).replace("  - t1\n  - t2\n", "  - t2\n  - t1\n"), codes.WORKFLOW_MISMATCH,
        ),
        "from without version": (
            document_for(linked, SIMPLE_BINDING, sources={"t1": Provenance(sphere="acme/maps", version=None, plan="pro")}),
            codes.FROM_VERSION_MISSING,
        ),
        "offering with two sources": (
            document_for(linked, SIMPLE_BINDING, offering=Offering(sphere="acme/shop", url="https://example.org/p.yaml")),
            codes.OFFERING_SOURCES,
        ),
        "http offering": (
            document_for(linked, SIMPLE_BINDING, offering=Offering(url="http://example.org/p.yaml")),
            codes.OFFERING_URL_NOT_HTTPS,
        ),
        "unknown problem": (
            document_for(linked, SIMPLE_BINDING, ref=ProblemRef(ref.organization, "nope", "1")), codes.PROBLEM_NOT_FOUND,
        ),
        "unknown compilation": (
            document_for(linked, SIMPLE_BINDING, compilation="sha256-" + "0" * 64), codes.COMPILATION_NOT_FOUND,
        ),
        "another organization's problem": (
            document_for(linked, SIMPLE_BINDING, ref=ProblemRef("elsewhere", ref.problem, ref.revision)),
            codes.PROBLEM_FOREIGN,
        ),
        "problem content": (document_for(linked, SIMPLE_BINDING) + "tasks: {}\n", codes.PROBLEM_CONTENT),
    }
    source, expected = sources[case]

    refused = await seal(api_client, headers, base, source)

    assert refused.status_code == 422, refused.text
    assert code(refused) == "composition_invalid"
    (diagnostic,) = [item for item in refused.json()["diagnostics"] if item["code"] == expected]
    assert diagnostic["severity"] == "error"
    assert diagnostic["span"]["line"] >= 1 and diagnostic["span"]["column"] >= 1
    assert await rows(db_session, CompositionVersion) == 0


@pytest.mark.parametrize("path", [JSON, PLACEMENT], ids=["hard constraint", "placement"])
async def test_a_violated_constraint_refuses_the_seal(api_client, registration, db_session, gate, path):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate, path=path)

    refused = await seal(api_client, headers, base, document_for(linked, first_binding(linked.compilation.ir)))

    assert refused.status_code == 422, refused.text
    violated = [item for item in refused.json()["diagnostics"] if item["code"] == codes.CONSTRAINT_VIOLATED]
    assert violated and all(item["span"] is not None for item in violated)
    if path == PLACEMENT:
        assert any(item["message"].startswith("constraint placement/") for item in violated)
    else:
        assert any("constraints/edge_authentication" in item["message"] for item in violated)


async def test_an_unconfigured_offering_registry_warns_and_keeps_the_binding_verified(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    source = document_for(linked, SIMPLE_BINDING, offering=Offering(sphere="acme/shop", registry="onprem"))

    sealed = await seal(api_client, headers, base, source)

    assert sealed.status_code == 201, sealed.text
    body = sealed.json()
    assert found(body["diagnostics"]) == [(codes.OFFERING_REGISTRY_UNKNOWN, "warning", "offering.registry")]
    assert body["evaluation"]["outcome"] == "verified" and body["version"]["verified"] is True
    assert body["version"]["offering"] == {"sphere": "acme/shop", "registry": "onprem"}
    assert body["version"]["analytics"]["hasOffering"] is True


# --------------------------------------------------------------------------- check


async def test_check_answers_what_a_seal_would_and_stores_nothing(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    source = document_for(linked, SIMPLE_BINDING, values={"latency": Value(31, "ms")})
    before = (await rows(db_session, CompositionVersion), await rows(db_session, CompositionEvaluation))

    checked = await check(api_client, headers, base, source)

    assert checked.status_code == 200, checked.text
    body = checked.json()
    assert body["valid"] is True and body["values_status"] == "verified"
    assert body["values"] == {"latency": {"value": 30.0, "unit": "ms"}}
    assert (await rows(db_session, CompositionVersion), await rows(db_session, CompositionEvaluation)) == before

    sealed = await seal(api_client, headers, base, source)
    stored = (await api_client.get(f"{base}/versions/1/content", headers=headers)).text
    assert sealed.json()["diagnostics"] == body["diagnostics"]
    assert body["content"] == stored


async def test_check_of_an_invalid_document_is_a_lint(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)

    refused = await check(api_client, headers, base, document_for(linked, {**SIMPLE_BINDING, "t1": "nope"}))
    unreadable = await check(api_client, headers, base, "syntaxVersion: [\n")

    assert refused.status_code == unreadable.status_code == 200
    assert refused.json()["valid"] is False and refused.json()["content"] is None and refused.json()["values"] is None
    assert refused.json()["values_status"] == "verified"
    assert found(refused.json()["diagnostics"]) == [(codes.CANDIDATE_UNKNOWN, "error", "binding.t1.candidate")]
    assert unreadable.json()["valid"] is False and unreadable.json()["values_status"] is None
    assert found(unreadable.json()["diagnostics"])[0][0] == codes.SYNTAX


async def test_check_and_seal_bound_the_document(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)
    too_long = b"#" * (text.MAX_SOURCE_BYTES + 1)

    for path in ("versions", "versions/check"):
        large = await api_client.post(f"{base}/{path}", content=too_long, headers={**headers, **YAML})
        wrong = await api_client.post(f"{base}/{path}", content=DECLARED.encode(), headers={**headers, "content-type": "text/plain"})
        assert large.status_code == 413 and large.json()["detail"]["limitBytes"] == text.MAX_SOURCE_BYTES
        assert wrong.status_code == 415


async def test_a_viewer_checks_but_does_not_seal_and_an_outsider_sees_nothing(
    api_client, registration, db_session, gate,  # noqa: F811
):
    from _b1_helpers import put_member

    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    viewer, viewer_headers = await make_account(api_client, registration, db_session, gate)
    _, outsider_headers = await make_account(api_client, registration, db_session, gate)
    added = await put_member(api_client, headers, linked.organization.slug, viewer["id"], "VIEWER")
    assert added.status_code in (200, 201), added.text

    assert (await check(api_client, viewer_headers, base, DECLARED)).status_code == 200
    forbidden = await seal(api_client, viewer_headers, base, DECLARED)
    assert forbidden.status_code == 403 and code(forbidden) == "organization_forbidden"
    for response in (
        await check(api_client, outsider_headers, base, DECLARED),
        await seal(api_client, outsider_headers, base, DECLARED),
        await api_client.get(f"{base}/versions", headers=outsider_headers),
    ):
        assert response.status_code == 404 and code(response) == "not_found"


# --------------------------------------------------------------------------- stored diagnostics


async def test_stored_diagnostics_point_into_the_stored_content(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate, path=NEGATIVE)
    canonical = document_for(
        linked, {"T1": "S1_1", "T2": "S2_1"}, values={"cost": Value(26, "eur"), "reliability": Value(0.9, "p")},
    )
    # The same document in flow style, on one line.
    flow = json.dumps(text.document(text.parse(canonical))) + "\n"

    sealed = await seal(api_client, headers, base, flow)

    assert sealed.status_code == 201, sealed.text
    submitted = {item["code"]: item for item in sealed.json()["diagnostics"]}
    assert set(submitted) == {codes.VALUE_DIFFERS, codes.VALUE_NOT_COMPUTED}
    assert submitted[codes.VALUE_DIFFERS]["span"]["line"] == 1
    stored = (await api_client.get(f"{base}/versions/1/content", headers=headers)).text
    kept = {item["code"]: item for item in sealed.json()["evaluation"]["diagnostics"]}
    where = spans.locate(stored, [Path(("values", "cost", "value"))])[Path(("values", "cost", "value"))]
    assert where.line > 1
    assert kept[codes.VALUE_DIFFERS]["span"] == {
        "line": where.line, "column": where.column, "end_line": where.end_line, "end_column": where.end_column,
    }
    assert kept[codes.VALUE_DIFFERS]["path"] == "values.cost.value"
    assert kept[codes.VALUE_NOT_COMPUTED]["span"] is None
    assert kept[codes.VALUE_NOT_COMPUTED]["path"] == "values.reliability"
    assert kept[codes.VALUE_NOT_COMPUTED]["pointer"] == "/values/reliability"
    assert "reliability" not in stored


# --------------------------------------------------------------------------- evidence


async def test_the_evidence_run_must_hold_the_binding(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    binding = bim_binding(linked, SIMPLE_BINDING)
    other = bim_binding(linked, {**SIMPLE_BINDING, "t1": "c1b"})
    matching = await finished_run(db_session, linked, [other, binding])
    elsewhere = await linked_problem(db_session, await db_session.get(User, linked.upload.problem.created_by_id),
                                     organization=linked.organization)
    foreign = await finished_run(
        db_session, linked, [binding], revision_id=elsewhere.upload.revision.id, compilation_id=elsewhere.compilation.id,
    )
    await db_session.commit()

    def with_run(run, point=None, label="1.0.0"):
        return document_for(linked, SIMPLE_BINDING, evidence=Evidence(run=str(run.id), point=point)).replace(
            "version: 1.0.0", f"version: {label}",
        )

    refusals = {
        codes.RUN_FOREIGN_REVISION: with_run(foreign),
        codes.RUN_BINDING_MISMATCH: with_run(matching, point=0),
        codes.RUN_POINT_INVALID: with_run(matching, point=5),
    }
    for expected, source in refusals.items():
        refused = await seal(api_client, headers, base, source)
        assert refused.status_code == 422, refused.text
        assert expected in {item["code"] for item in refused.json()["diagnostics"]}

    sealed = await seal(api_client, headers, base, with_run(matching, point=1))
    assert sealed.status_code == 201, sealed.text
    assert sealed.json()["version"]["evidence_run"] == {"id": str(matching.id)}
    row = await db_session.scalar(select(CompositionVersion))
    assert row.evidence_job_id == matching.id


# --------------------------------------------------------------------------- deletes


async def test_a_linked_problem_is_kept_and_a_composition_goes_with_its_versions(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    assert (await seal(api_client, headers, base, document_for(linked, SIMPLE_BINDING))).status_code == 201
    assert (await seal(api_client, headers, base, DECLARED.replace("version: 1.0.0", "version: 2.0.0"))).status_code == 201
    org = linked.organization.slug

    kept = await api_client.delete(f"/v1/organizations/{org}/problems/{linked.upload.problem.slug}", headers=headers)

    assert kept.status_code == 409 and code(kept) == "problem_has_compositions"
    deleted = await api_client.delete(base, headers=headers)
    assert deleted.status_code == 204, deleted.text
    assert await rows(db_session, CompositionVersion) == await rows(db_session, CompositionEvaluation) == 0
    assert await rows(db_session, Composition) == 0
    gone = await api_client.delete(f"/v1/organizations/{org}/problems/{linked.upload.problem.slug}", headers=headers)
    assert gone.status_code == 204, gone.text


# --------------------------------------------------------------------------- cost


async def test_a_seal_asks_the_toolchain_once_and_a_declared_one_never(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        assert (await check(api_client, headers, base, document_for(linked, SIMPLE_BINDING))).status_code == 200
        checked = dict(port.calls)
        assert (await seal(api_client, headers, base, document_for(linked, SIMPLE_BINDING))).status_code == 201
        sealed = dict(port.calls)
        assert (await seal(api_client, headers, base, DECLARED.replace("version: 1.0.0", "version: 2.0.0"))).status_code == 201

    assert checked.get("evaluate") == 1 and checked.get("compile", 0) == 0
    assert sealed.get("evaluate") == 2 and sealed.get("compile", 0) == 0
    assert port.calls["evaluate"] == 2 and port.calls["compile"] == 0


# --------------------------------------------------------------------------- reading versions for the renderer

PINNED = "t1: {candidate: c1a, from: {sphere: acme/greeter, registry: onprem, version: v1, plan: basic}}"


async def test_a_version_serves_its_document_as_it_was_sealed(api_client, registration, db_session, gate, monkeypatch):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)
    monkeypatch.setattr(get_settings(), "sphere_registries", {"onprem": SphereRegistry(url="https://sphere.onprem.example")})
    assert (await seal(api_client, headers, base, DECLARED.replace("t1: {candidate: c1a}", PINNED))).status_code == 201
    content = (await api_client.get(f"{base}/versions/1/content", headers=headers)).content

    parsed = await api_client.post("/v1/compositions/parse", content=content, headers=YAML)
    served = await api_client.get(f"{base}/versions/1", params={"include": "document"}, headers=headers)
    plain = await api_client.get(f"{base}/versions/1", headers=headers)
    monkeypatch.setattr(get_settings(), "sphere_registries", {})
    still = await api_client.get(f"{base}/versions/1.0.0", params={"include": "document,document"}, headers=headers)
    refused = await api_client.post("/v1/compositions/parse", content=content, headers=YAML)
    unknown = await api_client.get(f"{base}/versions/1", params={"include": "document,ir"}, headers=headers)

    assert parsed.status_code == 200 and served.status_code == 200, served.text
    assert served.json()["document"] == parsed.json()["document"]
    assert served.json()["document"]["binding"]["t1"]["from"]["registry"] == "onprem"
    assert plain.json()["document"] is None
    assert {key: value for key, value in served.json().items() if key != "document"} == {
        key: value for key, value in plain.json().items() if key != "document"
    }
    # The stored bytes read as they were sealed, whatever registries the deployment defines now.
    assert still.status_code == 200, still.text
    assert still.json()["document"] == parsed.json()["document"]
    assert refused.status_code == 422
    assert codes.FROM_REGISTRY_UNKNOWN in {item["code"] for item in refused.json()["diagnostics"]}
    assert unknown.status_code == 422


async def test_a_list_row_names_its_current_evaluation_and_the_evaluations_come_on_request(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    assert (await seal(api_client, headers, base, document_for(linked, SIMPLE_BINDING))).status_code == 201
    assert (await seal(api_client, headers, base, DECLARED.replace("version: 1.0.0", "version: 2.0.0"))).status_code == 201

    light = (await api_client.get(f"{base}/versions", headers=headers)).json()["versions"]
    whole = (await api_client.get(f"{base}/versions", params={"include": "evaluations,analytics"}, headers=headers)).json()
    single = [(await api_client.get(f"{base}/versions/{item['id']}", headers=headers)).json() for item in light]

    assert [item["label"] for item in light] == ["2.0.0", "1.0.0"]
    assert all(item["evaluations"] == [] and item["analytics"] is None for item in light)
    assert whole["versions"] == single
    declared_row, linked_row = light
    declared_view, linked_view = single
    (declared_evaluation,) = declared_view["evaluations"]
    (linked_evaluation,) = linked_view["evaluations"]
    assert declared_row["current_evaluation"] == {
        "id": declared_evaluation["id"], "basis": "declared", "outcome": "declared", "compilation": None,
        "created_at": declared_evaluation["created_at"],
    }
    assert declared_evaluation["binding"] is None
    assert linked_row["current_evaluation"] == {
        "id": linked_evaluation["id"], "basis": "bim", "outcome": "verified",
        "compilation": {
            key: linked_evaluation["compilation"][key] for key in ("compilation_digest", "semantic_digest", "toolchain")
        },
        "created_at": linked_evaluation["created_at"],
    }
    assert linked_evaluation["binding"] == {task: f"catalog/{candidate}" for task, candidate in SIMPLE_BINDING.items()}
    for row, view in zip(light, single, strict=True):
        assert row["current_evaluation_id"] == row["current_evaluation"]["id"]
        assert {key: value for key, value in row.items() if key not in ("evaluations", "analytics")} == {
            key: value for key, value in view.items() if key not in ("evaluations", "analytics")
        }


async def test_versions_are_paged_by_the_date_they_were_sealed(api_client, registration, db_session, gate):  # noqa: F811
    headers, _, base = await owner_of(api_client, registration, db_session, gate)
    sealed = []
    for label in ("1.0.0", "2.0.0", "3.0.0"):
        answer = await seal(api_client, headers, base, DECLARED.replace("version: 1.0.0", f"version: {label}"))
        assert answer.status_code == 201, answer.text
        sealed.append(answer.json()["version"])
    instants = [item["created_at"] for item in sealed]

    async def labels(**params: str) -> list[str]:
        answer = await api_client.get(f"{base}/versions", params={"order": "oldest", **params}, headers=headers)
        assert answer.status_code == 200, answer.text
        assert answer.json()["total"] == len(answer.json()["versions"])
        return [item["label"] for item in answer.json()["versions"]]

    assert await labels(created_after=instants[1]) == ["2.0.0", "3.0.0"]
    assert await labels(created_before=instants[1]) == ["1.0.0"]
    assert await labels(created_after=instants[1], created_before=instants[2]) == ["2.0.0"]
    assert await labels(created_after=instants[1], created_before=instants[1]) == []
    assert await labels(created_after="2000-01-01T00:00:00") == ["1.0.0", "2.0.0", "3.0.0"]
    assert await labels(created_before="2000-01-01T00:00:00+02:00") == []
    backwards = await api_client.get(
        f"{base}/versions", params={"created_after": instants[2], "created_before": instants[0]}, headers=headers,
    )
    assert backwards.status_code == 422 and code(backwards) == "invalid_request"
    assert (await api_client.get(f"{base}/versions", params={"created_after": "yesterday"}, headers=headers)).status_code == 422


async def test_compositions_are_listed_by_name_or_the_latest_updated_first(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    listing = f"/v1/organizations/{linked.organization.slug}/compositions"
    for slug, name in (("b-two", "Alpha"), ("a-one", "Beta")):
        assert (await api_client.post(listing, headers=headers, json={"slug": slug, "name": name})).status_code == 201
    assert (await api_client.patch(f"{listing}/shop", headers=headers, json={"description": "touched"})).status_code == 200

    by_name = (await api_client.get(listing, headers=headers)).json()["compositions"]
    by_update = (await api_client.get(listing, params={"sort": "updated"}, headers=headers)).json()["compositions"]

    assert [item["slug"] for item in by_name] == ["b-two", "a-one", "shop"]
    assert [item["slug"] for item in by_update] == ["shop", "a-one", "b-two"]
    assert [item["updated_at"] for item in by_update] == sorted((item["updated_at"] for item in by_update), reverse=True)
    assert (await api_client.get(listing, params={"sort": "created"}, headers=headers)).status_code == 422


async def test_the_list_names_the_status_of_each_latest_versions_values(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    listing = base.rsplit("/", 1)[0]
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    for slug in ("stale", "menu", "draft"):
        assert (await api_client.post(listing, headers=headers, json={"slug": slug, "name": slug.title()})).status_code == 201
    for target in (base, f"{listing}/stale"):
        derived = await api_client.post(f"{target}/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})
        assert derived.status_code == 201, derived.text
    assert (await seal(api_client, headers, f"{listing}/menu", DECLARED.replace("composition: shop", "composition: menu"))).status_code == 201
    # A toolchain release that reads the problem differently evaluates stale's version again: still linked, its current
    # evaluation no longer verifies it. Shop has no evaluation by that release, so its current one stays verified.
    with bim.bim_override(SemanticChange(bim.get_bim())):
        assert (await api_client.post(f"{listing}/stale/versions/1/evaluations", headers=headers)).status_code == 201
        listed = await api_client.get(listing, headers=headers)
        own = {slug: (await api_client.get(f"{listing}/{slug}", headers=headers)).json() for slug in ("shop", "stale")}
        version = {slug: (await api_client.get(f"{listing}/{slug}/versions/1", headers=headers)).json() for slug in own}

    assert listed.status_code == 200, listed.text
    latest = {item["slug"]: item["latest_version"] for item in listed.json()["compositions"]}
    assert {slug: (item["values_status"], item["verified"]) for slug, item in latest.items() if item} == {
        "shop": ("verified", True), "stale": ("verified", False), "menu": ("declared", False),
    }
    assert latest["draft"] is None
    assert set(latest["shop"]) == {"id", "ordinal", "label", "values_status", "verified", "created_at"}
    # The composition's own view says the same as the list, and as its latest version's view.
    for slug in own:
        assert own[slug]["latest_version"] == latest[slug]
        assert version[slug]["verified"] is latest[slug]["verified"]


@contextmanager
def statements(db_session):
    """How many SQL statements the database runs inside the block."""
    counted = [0]

    def count(*_arguments) -> None:
        counted[0] += 1

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield counted
    finally:
        event.remove(engine, "before_cursor_execute", count)


async def test_reading_versions_costs_the_same_queries_whatever_their_number(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    derived = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})
    assert derived.status_code == 201, derived.text
    reads = (f"{base}/versions", f"{base}/versions?include=evaluations,analytics")

    async def cost() -> list[int]:
        found = []
        for path in reads:
            with statements(db_session) as counted:
                assert (await api_client.get(path, headers=headers)).status_code == 200
            found.append(counted[0])
        return found

    await cost()
    one = await cost()
    assert (await seal(api_client, headers, base, document_for(linked, {**SIMPLE_BINDING, "t1": "c1b"}).replace(
        "version: 1.0.0", "version: 2.0.0",
    ))).status_code == 201
    assert (await seal(api_client, headers, base, DECLARED.replace("version: 1.0.0", "version: 3.0.0"))).status_code == 201
    three = await cost()

    assert all(found > 0 for found in one) and one == three


async def test_listing_compositions_costs_the_same_queries_whatever_their_number(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await owner_of(api_client, registration, db_session, gate)
    listing = base.rsplit("/", 1)[0]
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])

    async def add(slug: str, *, derived: bool) -> None:
        if slug != "shop":
            assert (await api_client.post(listing, headers=headers, json={"slug": slug, "name": slug.title()})).status_code == 201
        target = f"{listing}/{slug}"
        if derived:
            answer = await api_client.post(f"{target}/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})
        else:
            answer = await seal(api_client, headers, target, DECLARED.replace("composition: shop", f"composition: {slug}"))
        assert answer.status_code == 201, answer.text

    async def cost() -> int:
        with statements(db_session) as counted:
            answer = await api_client.get(listing, headers=headers)
        assert answer.status_code == 200, answer.text
        return counted[0]

    await add("shop", derived=True)
    await cost()
    one = await cost()
    await add("menu", derived=False)
    await add("stale", derived=True)
    await add("draft", derived=False)
    four = await cost()

    assert one > 0 and one == four


# --------------------------------------------------------------------------- the domain


def test_a_version_is_named_by_id_then_label_then_ordinal():
    identifier = uuid.uuid4()
    assert version_ref(str(identifier)) == VersionRef("id", identifier)
    assert version_ref("1.2.3") == VersionRef("label", "1.2.3")
    assert version_ref("1.0.0-rc.1+build.5") == VersionRef("label", "1.0.0-rc.1+build.5")
    assert version_ref("12") == VersionRef("ordinal", 12)
    for nothing in ("0", "012", "1.2", "latest", "", "9" * 20, "١٢"):
        assert version_ref(nothing) == VersionRef("none")
    assert problem_ref_text("acme", "shop", 3) == "acme/problems/shop@3"


@pytest.mark.parametrize(
    ("golden", "expected"),
    [
        ("02_tomatometer", {
            "tasks": 4, "boundTasks": 3, "localTasks": 1, "providers": 3, "upstreamPricings": 1,
            "workflow": {"depth": 2, "xor": 0, "and": 1, "loop": 0}, "hasOffering": True,
        }),
        ("12_loop_count", {
            "tasks": 3, "boundTasks": 2, "localTasks": 1, "providers": 2, "upstreamPricings": 0,
            "workflow": {"depth": 3, "xor": 0, "and": 0, "loop": 1}, "hasOffering": False,
        }),
    ],
)
def test_the_analytics_of_a_golden(golden, expected):
    document = text.read_stored((GOLDEN / f"{golden}.canonical.yaml").read_text(encoding="utf-8"))
    assert analytics(document) == expected


def test_the_analytics_of_every_valid_golden_hold_together():
    for path in sorted(GOLDEN.glob("*.canonical.yaml")):
        document = text.read_stored(path.read_text(encoding="utf-8"))
        summary = analytics(document)
        assert summary["boundTasks"] + summary["localTasks"] == summary["tasks"], path.name
        assert summary["providers"] <= summary["boundTasks"], path.name
        assert summary["hasOffering"] is (document.offering is not None), path.name
