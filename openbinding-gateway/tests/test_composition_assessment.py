"""Assessing a composition against the problem it links: the one evaluation path (B8).

Every problem is uploaded and compiled for real, and every value and verdict comes from the toolchain
itself (the in-process port), so the use case is tested against what ``BimPort.evaluate`` answers. A
``CountingPort`` pins how often the toolchain is asked: once per assessment, never when the lookup leaves
nothing to send, and never to compile a revision whose compilation is stored.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import AsyncExitStack

import pytest
from bim_core import EvaluationError
from bim_core.canonical import digest_bytes
from fastapi import HTTPException

from _composition_helpers import (
    OTHER_COMPILER,
    CountingPort,
    Lenient,
    OtherToolchain,
    SemanticChange,
    a_user,
    bim_binding,
    document_for,
    finished_run,
    first_binding,
    linked_problem,
)
from _repo import REPO_ROOT
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import text
from openbinding_gateway.composition.document import Evidence, ProblemRef, Provenance, Value
from openbinding_gateway.core.settings import get_settings
from openbinding_gateway.db.models import JobState
from openbinding_gateway.integrations import bim
from openbinding_gateway.modules.compositions.application import STRICTER_THAN_TOOLCHAIN, assess, evaluation_slot
from openbinding_gateway.modules.compositions.application import assess as assess_module

pytestmark = pytest.mark.asyncio

FMS = REPO_ROOT / "examples" / "demo" / "13_fms"
JSON = REPO_ROOT / "examples" / "demo" / "16_json_complete"
PLACEMENT = REPO_ROOT / "examples" / "placement" / "01_small_placement"

SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}
FMS_BINDING = {
    "T1": "cand_t1_aws",
    "T2": "cand_t2_radius_iot_network",
    "T3": "cand_t3_distance_matrix_api",
    "node_classic_routing": "local",
    "T5": "cand_t5_amazon_braket",
    "T6": "cand_t6_paypal",
}


async def _assess(db, user, linked, source: str, *, context: text.Context | None = None, **kwargs):
    """``source`` read as a submission is, then assessed in the linked problem's organization."""
    reading = text.read(source, context=context or text.Context())
    assert reading.document is not None, reading.diagnostics
    return await assess(
        db, linked.organization, reading.document, caller=user, source=source, language=reading.diagnostics, **kwargs
    )


def _found(assessment) -> list[tuple[str, str, str]]:
    return [(item.code, item.severity, item.path) for item in assessment.diagnostics]


def _codes(assessment) -> set[str]:
    return {item.code for item in assessment.diagnostics}


# --------------------------------------------------------------------------- the values are the toolchain's


async def test_the_demo_binding_is_verified_with_the_toolchains_values_in_one_call(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    source = document_for(linked, SIMPLE_BINDING, values={"latency": Value(31, "ms")})
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        assessment = await _assess(db_session, user, linked, source)

    assert assessment.valid, assessment.diagnostics
    expected = bim.get_bim().evaluate(linked.compilation.ir, bim_binding(linked, SIMPLE_BINDING))["features"]
    assert assessment.effective.values == (("latency", Value(30.0, "ms")),)
    assert assessment.effective.values[0][1].value == expected["latency"]
    assert port.calls["evaluate"] == 1 and port.calls["compile"] == 0
    assert _found(assessment) == [(codes.VALUE_DIFFERS, "warning", "values.latency.value")]
    assert assessment.diagnostics[0].span is not None
    toolchain = linked.compilation.toolchain
    assert assessment.effective.evidence == Evidence(
        manual=True, evaluated_by="gateway", toolchain=f"{toolchain['name']} {toolchain['version']}"
    )
    assert assessment.content == text.serialise(assessment.effective)
    assert assessment.content_digest == digest_bytes(assessment.content.encode("utf-8"))
    assert text.read(assessment.content).valid
    draft = assessment.evaluation
    assert (draft.basis, draft.outcome, draft.basis_key) == ("bim", "verified", linked.compilation.compiler_digest)
    assert draft.compilation_id == linked.compilation.id and draft.revision_id == linked.upload.revision.id
    assert draft.values == {"latency": {"value": 30.0, "unit": "ms"}}
    assert draft.binding == bim_binding(linked, SIMPLE_BINDING)
    assert draft.result["features"] == expected
    assert draft.diagnostics == assessment.diagnostics
    assert assessment.problem.linked.id == assessment.problem.installed.id == linked.compilation.id


async def test_an_unknown_candidate_is_refused_without_asking_the_toolchain(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    source = document_for(linked, {**SIMPLE_BINDING, "t1": "nope"})
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        assessment = await _assess(db_session, user, linked, source)

    assert not assessment.valid and assessment.effective is None and assessment.content is None
    assert _found(assessment) == [(codes.CANDIDATE_UNKNOWN, "error", "binding.t1.candidate")]
    assert port.calls["evaluate"] == 0
    assert assessment.evaluation is None


PENDING = [
    ("not allowed", None, {**SIMPLE_BINDING, "t1": "c2a"}, codes.CANDIDATE_NOT_ALLOWED, "binding.t1.candidate"),
    (
        "a candidate on a local task", FMS, {**FMS_BINDING, "node_classic_routing": "cand_t1_aws"},
        codes.TASK_LOCAL_MISMATCH, "binding.node_classic_routing",
    ),
    ("local on a service task", FMS, {**FMS_BINDING, "T5": "local"}, codes.TASK_LOCAL_MISMATCH, "binding.T5"),
]


@pytest.mark.parametrize(("case", "path", "binding", "code", "where"), PENDING, ids=[case[0] for case in PENDING])
async def test_the_toolchain_refuses_what_the_lookup_explains(db_session, case, path, binding, code, where):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user, **({"path": path} if path else {}))
    source = document_for(linked, binding)
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        assessment = await _assess(db_session, user, linked, source)

    assert port.calls["evaluate"] == 1
    assert not assessment.valid
    assert _found(assessment) == [(codes.BINDING_INVALID, "error", "binding"), (code, "error", where)]
    refusal, explanation = assessment.diagnostics
    sent = assessment.evaluation.binding
    with pytest.raises(EvaluationError) as raised:
        bim.get_bim().evaluate(linked.compilation.ir, sent)
    assert refusal.message == codes.clipped(raised.value.message)
    assert explanation.span is not None
    assert assessment.evaluation.outcome == "binding_invalid"


async def test_a_toolchain_that_accepts_an_explained_binding_has_the_last_word(db_session, caplog):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    source = document_for(linked, {**SIMPLE_BINDING, "t1": "c2a"})
    port = Lenient(bim.get_bim(), bim_binding(linked, SIMPLE_BINDING))

    with bim.bim_override(port), caplog.at_level(logging.WARNING, logger=assess_module.__name__):
        assessment = await _assess(db_session, user, linked, source)

    assert port.refused == 1
    assert assessment.valid and assessment.diagnostics == ()
    assert assessment.effective.values == (("latency", Value(30.0, "ms")),)
    assert STRICTER_THAN_TOOLCHAIN in caplog.text


# --------------------------------------------------------------------------- violations


async def test_a_hard_constraint_violation_refuses_the_binding(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user, path=JSON)
    source = document_for(linked, first_binding(linked.compilation.ir))

    assessment = await _assess(db_session, user, linked, source)

    assert not assessment.valid
    violated = [item for item in assessment.diagnostics if item.code == codes.CONSTRAINT_VIOLATED]
    assert violated and {item.path for item in violated} == {"binding"}
    assert any("constraints/edge_authentication" in item.message for item in violated)
    assert assessment.evaluation.outcome == "binding_invalid"
    assert assessment.evaluation.values == {
        "carbon": {"value": 22.5, "unit": "gCO2e/run"},
        "cost": {"value": 16.0, "unit": "EUR/run"},
        "latency": {"value": 51.650000000000006, "unit": "ms"},
        "trust": {"value": 0.95, "unit": "1"},
    }


async def test_a_placement_violation_says_its_own_message(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user, path=PLACEMENT)
    binding = first_binding(linked.compilation.ir)
    source = document_for(linked, binding)

    assessment = await _assess(db_session, user, linked, source)

    result = bim.get_bim().evaluate(linked.compilation.ir, bim_binding(linked, binding))
    (violated,) = [item for item in assessment.diagnostics if item.code == codes.CONSTRAINT_VIOLATED]
    assert violated.message.startswith("constraint placement/tr_event_login: ")
    assert result["violations"][0]["message"][:100] in violated.message
    assert not assessment.valid


# --------------------------------------------------------------------------- the link across toolchains


async def test_another_toolchain_that_reads_the_problem_alike_keeps_the_link(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    source = document_for(linked, SIMPLE_BINDING)

    with bim.bim_override(OtherToolchain(bim.get_bim())):
        assessment = await _assess(db_session, user, linked, source)

    assert assessment.valid, assessment.diagnostics
    assert _found(assessment) == [(codes.COMPILATION_SUPERSEDED, "info", "problem.compilation")]
    assert assessment.effective.values == (("latency", Value(30.0, "ms")),)
    assert assessment.effective.problem.compilation == linked.compilation.compilation_digest
    installed = assessment.problem.installed
    assert installed.id != linked.compilation.id and installed.compiler_digest == OTHER_COMPILER
    assert assessment.evaluation.basis_key == OTHER_COMPILER and assessment.evaluation.compilation_id == installed.id


async def test_a_toolchain_that_reads_the_problem_differently_breaks_the_link(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    source = document_for(linked, SIMPLE_BINDING)
    port = CountingPort(SemanticChange(bim.get_bim()))

    with bim.bim_override(port):
        assessment = await _assess(db_session, user, linked, source)

    assert not assessment.valid
    assert _found(assessment) == [(codes.COMPILATION_SEMANTICS_CHANGED, "error", "problem.compilation")]
    assert port.calls["compile"] == 1 and port.calls["evaluate"] == 0
    assert assessment.evaluation.outcome == "semantics_changed"
    assert assessment.problem.facts is None


# --------------------------------------------------------------------------- finding the problem


async def test_a_problem_of_another_organization_is_foreign(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    other = await linked_problem(db_session, user)
    source = document_for(linked, SIMPLE_BINDING, ref=other.ref, compilation=other.compilation.compilation_digest)

    assessment = await _assess(db_session, user, linked, source)

    assert _found(assessment) == [(codes.PROBLEM_FOREIGN, "error", "problem.ref")]
    assert assessment.problem is None and assessment.evaluation is None


async def test_the_organization_may_be_named_by_its_id(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    ref = ProblemRef(str(linked.organization.id), linked.ref.problem, linked.ref.revision)

    assessment = await assess(
        db_session, linked.organization, text.parse(document_for(linked, SIMPLE_BINDING, ref=ref)), caller=user
    )

    assert assessment.valid, assessment.diagnostics


@pytest.mark.parametrize(
    ("problem", "revision", "compilation", "code", "path"),
    [
        ("nope", None, None, codes.PROBLEM_NOT_FOUND, "problem.ref"),
        (None, "9", None, codes.PROBLEM_NOT_FOUND, "problem.ref"),
        (None, None, "sha256-" + "0" * 64, codes.COMPILATION_NOT_FOUND, "problem.compilation"),
    ],
    ids=["problem", "revision", "compilation"],
)
async def test_what_the_organization_does_not_hold_is_not_found(db_session, problem, revision, compilation, code, path):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    ref = ProblemRef(linked.ref.organization, problem or linked.ref.problem, revision or linked.ref.revision)
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        assessment = await _assess(db_session, user, linked, document_for(linked, SIMPLE_BINDING, ref=ref, compilation=compilation))

    assert _found(assessment) == [(code, "error", path)]
    assert assessment.diagnostics[0].span is not None
    assert port.calls["evaluate"] == 0 and port.calls["compile"] == 0


# --------------------------------------------------------------------------- the run the evidence names


async def test_the_run_that_found_the_binding_is_the_evidence(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    wanted = bim_binding(linked, SIMPLE_BINDING)
    other = bim_binding(linked, {**SIMPLE_BINDING, "t1": "c1b"})
    run = await finished_run(db_session, linked, [other, None, wanted])

    anywhere = await _assess(db_session, user, linked, document_for(linked, SIMPLE_BINDING, evidence=Evidence(run=str(run.id))))
    at_point = await _assess(
        db_session, user, linked, document_for(linked, SIMPLE_BINDING, evidence=Evidence(run=str(run.id), point=2))
    )

    for assessment in (anywhere, at_point):
        assert assessment.valid, assessment.diagnostics
        assert assessment.evidence_run == run.id
        assert assessment.effective.evidence.run == str(run.id)
        assert assessment.effective.evidence.manual is False
        assert assessment.effective.evidence.evaluated_by == "gateway"
    assert at_point.effective.evidence.point == 2


async def test_a_run_the_caller_cannot_cite_is_refused(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    wanted = bim_binding(linked, SIMPLE_BINDING)
    elsewhere = await linked_problem(db_session, user)
    foreign = await finished_run(db_session, elsewhere, [wanted])
    sibling = await linked_problem(db_session, user, organization=linked.organization)
    another_revision = await finished_run(db_session, sibling, [wanted])
    mismatch = await finished_run(db_session, linked, [bim_binding(linked, {**SIMPLE_BINDING, "t1": "c1b"})])
    one = await finished_run(db_session, linked, [wanted])
    not_a_binding = await finished_run(db_session, linked, [None])
    failed = await finished_run(db_session, linked, [wanted], state=JobState.FAILED)

    cases = [
        (Evidence(run=str(uuid.uuid4())), codes.RUN_NOT_FOUND, "evidence.run"),
        (Evidence(run=str(foreign.id)), codes.RUN_NOT_FOUND, "evidence.run"),
        (Evidence(run=str(another_revision.id)), codes.RUN_FOREIGN_REVISION, "evidence.run"),
        (Evidence(run=str(mismatch.id)), codes.RUN_BINDING_MISMATCH, "binding"),
        (Evidence(run=str(one.id), point=3), codes.RUN_POINT_INVALID, "evidence.point"),
        (Evidence(run=str(not_a_binding.id), point=0), codes.RUN_POINT_INVALID, "evidence.point"),
        (Evidence(run=str(failed.id)), codes.RUN_POINT_INVALID, "evidence.run"),
    ]
    for evidence, code, path in cases:
        assessment = await _assess(db_session, user, linked, document_for(linked, SIMPLE_BINDING, evidence=evidence))
        assert _found(assessment) == [(code, "error", path)], evidence
        assert assessment.evidence_run is None and assessment.content is None
    mismatched = await _assess(
        db_session, user, linked, document_for(linked, SIMPLE_BINDING, evidence=Evidence(run=str(mismatch.id)))
    )
    assert "'t1'" in mismatched.diagnostics[0].message


async def test_the_run_is_not_looked_up_when_the_caller_says_so(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    source = document_for(linked, SIMPLE_BINDING, evidence=Evidence(run=str(uuid.uuid4())))

    assessment = await _assess(db_session, user, linked, source, run_evidence=False)

    assert assessment.valid and assessment.evidence_run is None


# --------------------------------------------------------------------------- bounds and the declared path


async def test_a_held_evaluation_pool_is_429_busy(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    source = document_for(linked, SIMPLE_BINDING)

    async with AsyncExitStack() as stack:
        for _ in range(get_settings().composition_evaluation_slots):
            await stack.enter_async_context(evaluation_slot())
        with pytest.raises(HTTPException) as raised:
            await _assess(db_session, user, linked, source)

    assert raised.value.status_code == 429
    assert raised.value.detail["code"] == "composition_busy"
    assert raised.value.headers["Retry-After"] == "1"


DECLARED = (
    'syntaxVersion: "1.0"\ncomposition: shop\nversion: 1.0.0\nkind: application\n'
    "workflow: {seq: [pick, ship]}\n"
    "binding: {pick: {candidate: c_pick}, ship: {candidate: c_ship}}\n"
    "values: {cost: {value: 3, unit: EUR}, trust: 0.9}\n"
)


async def test_a_declared_document_keeps_its_values_and_never_asks_the_toolchain(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    port = CountingPort(bim.get_bim())

    with bim.bim_override(port):
        assessment = await _assess(db_session, user, linked, DECLARED)

    assert assessment.valid and assessment.diagnostics == ()
    assert sum(port.calls.values()) == 0
    assert assessment.problem is None
    assert assessment.effective.values == assessment.document.values
    assert assessment.effective.evidence == Evidence(evaluated_by="declared")
    assert "evaluatedBy: declared" in assessment.content
    draft = assessment.evaluation
    assert (draft.basis, draft.basis_key, draft.outcome) == ("declared", "declared", "declared")
    assert draft.values == {"cost": {"value": 3, "unit": "EUR"}, "trust": {"value": 0.9, "unit": "1"}}
    assert draft.compilation_id is None and draft.result is None


async def test_a_stored_version_assesses_after_its_registry_left_the_settings(db_session):
    user = await a_user(db_session)
    linked = await linked_problem(db_session, user)
    sources = {"t1": Provenance(sphere="acme/picking", registry="lab", version="v7", plan="Pro")}
    source = document_for(linked, SIMPLE_BINDING, sources=sources)
    sealed = await _assess(db_session, user, linked, source, context=text.Context(registries=frozenset({"lab"})))
    assert sealed.valid, sealed.diagnostics
    assert codes.FROM_REGISTRY_UNKNOWN in {item.code for item in text.read(sealed.content).diagnostics}

    stored = text.read_stored(sealed.content)
    again = await assess(db_session, linked.organization, stored, caller=user)

    assert again.valid, again.diagnostics
    assert again.content == sealed.content
    assert again.effective.entry("t1").source == sources["t1"]
