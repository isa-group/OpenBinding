"""Deriving a composition version from a run's solution or from a binding of a revision (F1 B12).

Plan §4 "Derivación": problem + binding -> composition, through the one evaluation path, byte-idempotent (the
same compilation and binding give the same bytes) and stored with an immutable derivation edge. Every value
is the in-process toolchain's own float, compared exactly; a ``CountingPort`` pins one ``evaluate`` and no
``compile`` per derivation when the compilation exists.
"""

from __future__ import annotations

import itertools
import json
import uuid
from pathlib import Path
from typing import Any, Mapping

import yaml
from bim_core.canonical import digest
from sqlalchemy import func, select

from _b1_helpers import gate, make_account  # noqa: F401
from _composition_helpers import (
    CountingPort,
    Linked,
    OtherToolchain,
    SemanticChange,
    bim_binding,
    finished_run,
    first_binding,
)
from _paths import TESTS_DIR
from _problem_helpers import EXAMPLE, problem_for
from _repo import REPO_ROOT
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.db.models import (
    AuditEvent,
    CompositionDerivation,
    CompositionVersion,
    JobState,
    Organization,
    User,
)
from openbinding_gateway.integrations import bim

GOLDEN = TESTS_DIR / "composition" / "golden" / "derived"
DEMO = REPO_ROOT / "examples" / "demo"
SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}


def code(response) -> str:
    body = response.json()
    return body["detail"]["code"] if isinstance(body.get("detail"), dict) else body["code"]


def diagnostics(response) -> list[dict[str, Any]]:
    body = response.json()
    detail = body["detail"] if isinstance(body.get("detail"), dict) else body
    return detail["diagnostics"]


def found(response) -> list[tuple[str, str]]:
    return [(item["code"], item["pointer"]) for item in diagnostics(response)]


async def composition_of(api_client, registration, db_session, gate, path: Path = EXAMPLE, slug: str = "simple-seq"):  # noqa: F811
    """An OWNER of an organization with the problem at ``path`` (slug ``slug``) and an empty composition ``shop``."""
    account, headers = await make_account(api_client, registration, db_session, gate)
    user = await db_session.get(User, uuid.UUID(account["id"]))
    upload = await problem_for(db_session, user, path=path, slug=slug)
    linked = Linked(await db_session.get(Organization, upload.problem.organization_id), upload)
    await db_session.commit()
    base = f"/v1/organizations/{linked.organization.slug}/compositions"
    created = await api_client.post(base, headers=headers, json={"slug": "shop", "name": "Shop"})
    assert created.status_code == 201, created.text
    return headers, linked, f"{base}/shop"


async def count(db_session, model) -> int:
    return int(await db_session.scalar(select(func.count()).select_from(model)) or 0)


async def content_of(api_client, headers, base, version: str) -> str:
    response = await api_client.get(f"{base}/versions/{version}/content", headers=headers)
    assert response.status_code == 200, response.text
    return response.text


def toolchain_of(linked: Linked) -> str:
    toolchain = linked.compilation.toolchain
    return f"{toolchain['name']} {toolchain['version']}"


def golden(name: str, **fields: str) -> str:
    written = (GOLDEN / name).read_text(encoding="utf-8")
    for key, value in fields.items():
        written = written.replace("{" + key + "}", value)
    return written


def body_of(document: str) -> dict[str, Any]:
    loaded = yaml.safe_load(document)
    return {key: loaded[key] for key in ("workflow", "binding", "values")}


def without_evidence(document: str) -> dict[str, Any]:
    loaded = yaml.safe_load(document)
    loaded.pop("evidence")
    return loaded


def evaluated(linked: Linked) -> tuple[tuple[dict, dict] | None, tuple[dict, dict] | None]:
    """The first binding of the whole eligibility product with no hard violation, and the first with one.

    Each as ``(bim binding, the toolchain's evaluation)``, walked in-process in natural order.
    """
    facts = linked.facts
    ir = linked.compilation.ir
    port = bim.get_bim()
    service = sorted(facts.service_tasks)
    feasible = violating = None
    for choice in itertools.product(*(facts.eligibility[task] for task in service)):
        binding = {task: reference.as_bim() for task, reference in zip(service, choice, strict=True)}
        result = port.evaluate(ir, binding)
        hard = any(item.get("enforcement") == "hard" for item in result.get("violations") or ())
        if hard and violating is None:
            violating = (binding, result)
        if not hard and feasible is None:
            feasible = (binding, result)
        if feasible is not None and violating is not None:
            break
    return feasible, violating


def by_id(binding: Mapping[str, Mapping[str, str]]) -> dict[str, str]:
    return {task: reference["id"] for task, reference in binding.items()}


# --------------------------------------------------------------------------- from a run


async def test_a_run_solution_derives_to_its_golden_bytes_with_its_edge(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    binding = bim_binding(linked, SIMPLE_BINDING)
    run = await finished_run(db_session, linked, [binding])
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        derived = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})

    assert derived.status_code == 201, derived.text
    assert port.calls["evaluate"] == 1 and port.calls["compile"] == 0
    body = derived.json()
    version = body["version"]
    assert version["values_status"] == "verified" and version["verified"] is True
    assert version["evidence_run"] == {"id": str(run.id)}
    assert derived.headers["Location"].endswith(f"/versions/{version['id']}")
    assert derived.headers["ETag"] == f'"{version["content_digest"]}"'
    content = await content_of(api_client, headers, base, "1.0.0")
    assert content == golden(
        "01_simple_seq.run.yaml",
        slug="shop", label="1.0.0", org=linked.organization.slug, run=str(run.id),
        compilation=linked.compilation.compilation_digest, toolchain=toolchain_of(linked),
    )
    # The body is the binding's, as B5 derives it.
    b5 = golden("01_simple_seq.yaml", compilation="x", toolchain="x")
    assert body_of(content) == body_of(b5)
    derivation = body["derivation"]
    assert derivation["source"] == "run" and derivation["job_id"] == str(run.id) and derivation["point"] == 0
    assert derivation["binding"] == binding and derivation["binding_digest"] == digest(binding)
    assert derivation["compilation_id"] == str(linked.compilation.id)
    assert derivation["provenance"]["evaluatedCompilationId"] == str(linked.compilation.id)
    assert derivation["provenance"]["semanticDigest"] == linked.compilation.semantic_digest
    edge = await db_session.scalar(select(CompositionDerivation))
    assert (edge.job_id, edge.point, edge.binding_digest) == (run.id, 0, digest(binding))
    assert str(edge.version_id) == version["id"]
    assert await db_session.scalar(select(AuditEvent.id).where(AuditEvent.action == "composition.derived")) is not None


async def test_the_same_derivation_gives_the_same_bytes_and_one_version(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    request = {"run": str(run.id), "version": "1.0.0"}

    first = await api_client.post(f"{base}/derive", headers=headers, json=request)
    again = await api_client.post(f"{base}/derive", headers=headers, json=request)
    draft = await api_client.post(f"{base}/derive", headers=headers, json={**request, "seal": False})
    other = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "simple-seq@1", "binding": SIMPLE_BINDING, "version": "1.0.0", "seal": False},
    )

    assert first.status_code == 201, first.text
    assert again.status_code == 200, again.text
    assert again.json()["version"]["id"] == first.json()["version"]["id"]
    assert again.json()["derivation"]["id"] == first.json()["derivation"]["id"]
    assert await count(db_session, CompositionVersion) == 1 and await count(db_session, CompositionDerivation) == 1
    stored = await content_of(api_client, headers, base, "1")
    assert draft.status_code == 200, draft.text
    assert set(draft.json()) == {"content", "document", "values", "diagnostics"}
    assert draft.json()["content"] == stored
    assert draft.json()["document"] == yaml.safe_load(stored)
    assert draft.json()["values"] == first.json()["version"]["values"]
    # A revision and a binding derive the same document but its evidence.
    assert other.status_code == 200, other.text
    assert other.json()["content"] != stored
    assert without_evidence(other.json()["content"]) == without_evidence(stored)
    assert yaml.safe_load(other.json()["content"])["evidence"] == {
        "manual": True, "evaluatedBy": "gateway", "toolchain": toolchain_of(linked),
    }
    assert await count(db_session, CompositionVersion) == 1


async def test_a_point_derives_that_solution_of_the_run(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    second = {**SIMPLE_BINDING, "t1": "c1b"}
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING), bim_binding(linked, second)])

    derived = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(run.id), "point": 1, "version": "1.0.0"})
    past = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(run.id), "point": 2, "version": "2.0.0"})

    assert derived.status_code == 201, derived.text
    loaded = yaml.safe_load(await content_of(api_client, headers, base, "1.0.0"))
    assert loaded["binding"]["t1"] == {"candidate": "c1b"}
    assert loaded["evidence"]["point"] == 1
    assert derived.json()["derivation"]["point"] == 1
    assert past.status_code == 422, past.text
    assert code(past) == "derivation_invalid"
    assert found(past) == [(codes.RUN_POINT_INVALID, "/point")]


async def test_a_run_that_cannot_be_derived_is_refused(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    failed = await finished_run(db_session, linked, [], state=JobState.FAILED, termination="UNKNOWN")
    not_binding = await finished_run(db_session, linked, [None])
    _, outsider, _ = await composition_of(api_client, registration, db_session, gate)
    foreign = await finished_run(db_session, outsider, [bim_binding(outsider, SIMPLE_BINDING)])
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        from_failed = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(failed.id), "version": "1.0.0"})
        from_assignment = await api_client.post(
            f"{base}/derive", headers=headers, json={"run": str(not_binding.id), "version": "1.0.0"},
        )
        from_foreign = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(foreign.id), "version": "1.0.0"})
        from_nothing = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(uuid.uuid4()), "version": "1.0.0"})

    assert from_failed.status_code == 422 and found(from_failed) == [(codes.RUN_POINT_INVALID, "/point")]
    assert from_assignment.status_code == 422 and found(from_assignment) == [(codes.RUN_POINT_INVALID, "/point")]
    assert from_foreign.status_code == 404 and code(from_foreign) == "not_found"
    assert from_nothing.status_code == 404
    assert port.calls["evaluate"] == 0
    assert await count(db_session, CompositionVersion) == 0


async def test_a_solution_with_a_hard_violation_is_not_derivable(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await composition_of(
        api_client, registration, db_session, gate, path=DEMO / "16_json_complete", slug="json-complete",
    )
    _, violating = evaluated(linked)
    assert violating is not None
    run = await finished_run(db_session, linked, [violating[0]])

    refused = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})

    assert refused.status_code == 422, refused.text
    assert code(refused) == "derivation_invalid"
    assert (codes.CONSTRAINT_VIOLATED, "/binding") in found(refused)
    assert await count(db_session, CompositionVersion) == 0


# --------------------------------------------------------------------------- from a binding


async def test_a_binding_of_a_revision_derives_with_the_toolchains_values(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await composition_of(
        api_client, registration, db_session, gate, path=DEMO / "16_json_complete", slug="json-complete",
    )
    feasible, _ = evaluated(linked)
    assert feasible is not None, "the whole eligibility product has no binding without a hard violation"
    binding, result = feasible
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        derived = await api_client.post(
            f"{base}/derive", headers=headers,
            json={"revision": f"json-complete@{linked.upload.revision.revision}", "binding": by_id(binding), "version": "1.0.0"},
        )

    assert derived.status_code == 201, derived.text
    assert port.calls["evaluate"] == 1 and port.calls["compile"] == 0
    body = derived.json()
    assert {name: value["value"] for name, value in body["version"]["values"].items()} == result["features"]
    assert body["derivation"]["source"] == "binding" and body["derivation"]["job_id"] is None
    assert body["derivation"]["point"] is None and body["derivation"]["binding"] == binding
    content = await content_of(api_client, headers, base, "1.0.0")
    assert "probability: 0.65\n" in content and "probability: 0.35\n" in content
    loaded = yaml.safe_load(content)
    assert loaded["evidence"] == {"manual": True, "evaluatedBy": "gateway", "toolchain": toolchain_of(linked)}
    assert loaded["problem"] == {
        "ref": f"{linked.organization.slug}/problems/json-complete@1",
        "compilation": linked.compilation.compilation_digest,
    }


async def test_a_local_task_derives_as_local(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await composition_of(api_client, registration, db_session, gate, path=DEMO / "13_fms", slug="fms")
    binding = {task: candidate for task, candidate in first_binding(linked.compilation.ir).items() if candidate != "local"}
    assert linked.facts.local_tasks

    derived = await api_client.post(
        f"{base}/derive", headers=headers, json={"revision": "fms@1", "binding": binding, "version": "1.0.0"},
    )

    assert derived.status_code == 201, derived.text
    loaded = yaml.safe_load(await content_of(api_client, headers, base, "1.0.0"))
    for task in linked.facts.local_tasks:
        assert loaded["binding"][task] == {"local": True}


def _three_way(directory: Path) -> Path:
    """``16_json_complete`` with a third, empty branch on its exclusive choice and uniform routing."""
    source = DEMO / "16_json_complete"
    for path in sorted(source.rglob("*")):
        if path.is_file():
            target = directory / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
    application = json.loads((directory / "application.json").read_text())
    workflow = application["spec"]["workflow"]
    exclusive = workflow["sequence"][1]["sequence"][0]["parallel"][0]["sequence"][1]["sequence"][0]["exclusive"]
    exclusive.append({"id": "Flow_Skip", "flow": {"empty": True}})
    (directory / "application.json").write_text(json.dumps(application))
    routing = json.loads((directory / "routing.json").read_text())
    routing["spec"] = {"uniform": True}
    (directory / "routing.json").write_text(json.dumps(routing))
    return directory


async def test_a_three_way_uniform_choice_derives_uniform_and_seals(
    api_client, registration, db_session, gate, tmp_path,  # noqa: F811
):
    headers, linked, base = await composition_of(
        api_client, registration, db_session, gate, path=_three_way(tmp_path / "three-way"), slug="three-way",
    )
    feasible, _ = evaluated(linked)
    assert feasible is not None

    derived = await api_client.post(
        f"{base}/derive", headers=headers, json={"revision": "three-way@1", "binding": by_id(feasible[0]), "version": "1.0.0"},
    )

    assert derived.status_code == 201, derived.text
    content = await content_of(api_client, headers, base, "1.0.0")
    assert "uniform: true" in content and "probability" not in content


async def test_a_binding_that_does_not_fit_is_refused_in_the_request(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    port = CountingPort(bim.get_bim())

    def request(binding: dict[str, str], **extra: Any) -> dict[str, Any]:
        return {"revision": "simple-seq@1", "binding": binding, "version": "1.0.0", **extra}

    with bim.bim_override(port):
        unknown = await api_client.post(f"{base}/derive", headers=headers, json=request({**SIMPLE_BINDING, "t1": "nope"}))
        shaped = await api_client.post(
            f"{base}/derive", headers=headers, json=request({"t1": "a b", "t2": "c2a", "zz": "c1a"}),
        )
        untranslated = port.calls["evaluate"]
        not_allowed = await api_client.post(f"{base}/derive", headers=headers, json=request({**SIMPLE_BINDING, "t1": "c2a"}))
        missing = await api_client.post(f"{base}/derive", headers=headers, json={**request(SIMPLE_BINDING), "revision": "simple-seq@9"})

    assert unknown.status_code == 422 and code(unknown) == "derivation_invalid"
    assert found(unknown) == [(codes.CANDIDATE_UNKNOWN, "/binding/t1")]
    assert shaped.status_code == 422
    assert sorted(found(shaped)) == [
        (codes.BINDING_UNKNOWN_TASK, "/binding/zz"),
        (codes.CANDIDATE_REF_INVALID, "/binding/t1"),
        (codes.TASK_UNBOUND, "/binding/t3"),
    ]
    assert untranslated == 0
    assert not_allowed.status_code == 422
    assert sorted(found(not_allowed)) == [
        (codes.BINDING_INVALID, "/binding"), (codes.CANDIDATE_NOT_ALLOWED, "/binding/t1"),
    ]
    assert port.calls["evaluate"] == 1
    assert missing.status_code == 404 and code(missing) == "not_found"
    assert await count(db_session, CompositionVersion) == 0


async def test_a_taken_label_is_a_conflict(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    first = await api_client.post(
        f"{base}/derive", headers=headers, json={"revision": "simple-seq@1", "binding": SIMPLE_BINDING, "version": "1.0.0"},
    )
    taken = await api_client.post(
        f"{base}/derive", headers=headers,
        json={"revision": "simple-seq@1", "binding": {**SIMPLE_BINDING, "t1": "c1b"}, "version": "1.0.0"},
    )

    assert first.status_code == 201, first.text
    assert taken.status_code == 409 and code(taken) == "version_label_taken"
    assert await count(db_session, CompositionDerivation) == 1


async def test_the_request_names_exactly_one_source(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])

    for payload in (
        {"version": "1.0.0"},
        {"run": str(run.id), "revision": "simple-seq@1", "binding": SIMPLE_BINDING, "version": "1.0.0"},
        {"run": str(run.id), "binding": SIMPLE_BINDING, "version": "1.0.0"},
        {"revision": "simple-seq@1", "version": "1.0.0"},
        {"revision": "simple-seq@1", "binding": SIMPLE_BINDING, "point": 0, "version": "1.0.0"},
        {"run": str(run.id)},
        {"run": str(run.id), "version": "1.0"},
        {"run": str(run.id), "version": "1.0.0", "presentation": {}},
    ):
        response = await api_client.post(f"{base}/derive", headers=headers, json=payload)
        assert response.status_code == 422, (payload, response.text)
    assert await count(db_session, CompositionVersion) == 0


# --------------------------------------------------------------------------- offering, kind, access


async def test_the_offering_is_written_only_when_given(api_client, registration, db_session, gate):  # noqa: F811
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    request = {"run": str(run.id), "version": "1.0.0", "seal": False}

    plain = await api_client.post(f"{base}/derive", headers=headers, json=request)
    offered = await api_client.post(
        f"{base}/derive", headers=headers, json={**request, "offering": {"sphere": "acme/shop"}, "kind": "workflow"},
    )
    insecure = await api_client.post(f"{base}/derive", headers=headers, json={**request, "offering": {"url": "http://x.org/p.yaml"}})
    port = CountingPort(bim.get_bim())
    with bim.bim_override(port):
        shaped = await api_client.post(f"{base}/derive", headers=headers, json={**request, "offering": {"version": "1"}})

    assert plain.status_code == 200, plain.text
    assert "offering" not in plain.json()["document"]
    assert offered.status_code == 200, offered.text
    assert offered.json()["document"]["offering"] == {"sphere": "acme/shop"}
    assert offered.json()["document"]["kind"] == "workflow"
    assert "offering:\n  sphere: acme/shop\n" in offered.json()["content"]
    assert insecure.status_code == 422 and code(insecure) == "derivation_invalid"
    assert found(insecure) == [(codes.OFFERING_URL_NOT_HTTPS, "/offering/url")]
    assert shaped.status_code == 422 and found(shaped) == [(codes.OFFERING_SHAPE, "/offering/version")]
    assert port.calls["evaluate"] == 0


async def test_a_non_member_cannot_derive(api_client, registration, db_session, gate):  # noqa: F811
    _, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])
    _, stranger = await make_account(api_client, registration, db_session, gate)

    response = await api_client.post(f"{base}/derive", headers=stranger, json={"run": str(run.id), "version": "1.0.0"})

    assert response.status_code == 404 and code(response) == "not_found"


# --------------------------------------------------------------------------- toolchain releases


async def test_a_run_of_an_earlier_release_derives_while_it_reads_the_problem_alike(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        derived = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})

    assert derived.status_code == 201, derived.text
    body = derived.json()
    assert [(item["code"], item["severity"]) for item in body["diagnostics"]] == [
        (codes.COMPILATION_SUPERSEDED, "info"),
    ]
    assert body["diagnostics"][0]["span"] is not None
    # The document links the compilation the run solved; the toolchain evaluated the installed one's.
    loaded = yaml.safe_load(await content_of(api_client, headers, base, "1.0.0"))
    assert loaded["problem"]["compilation"] == linked.compilation.compilation_digest
    assert body["derivation"]["compilation_id"] == str(linked.compilation.id)
    assert body["derivation"]["provenance"]["evaluatedCompilationId"] != str(linked.compilation.id)
    assert body["derivation"]["provenance"]["semanticDigest"] == linked.compilation.semantic_digest


async def test_a_run_of_a_release_that_reads_the_problem_differently_is_refused(
    api_client, registration, db_session, gate,  # noqa: F811
):
    headers, linked, base = await composition_of(api_client, registration, db_session, gate)
    run = await finished_run(db_session, linked, [bim_binding(linked, SIMPLE_BINDING)])

    with bim.bim_override(SemanticChange(bim.get_bim())):
        refused = await api_client.post(f"{base}/derive", headers=headers, json={"run": str(run.id), "version": "1.0.0"})

    assert refused.status_code == 422, refused.text
    assert code(refused) == "derivation_invalid"
    assert found(refused) == [(codes.COMPILATION_SEMANTICS_CHANGED, "/problem/compilation")]
    assert "run the problem again" in diagnostics(refused)[0]["message"]

