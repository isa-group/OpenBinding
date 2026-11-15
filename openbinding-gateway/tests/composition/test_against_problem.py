"""A Composition2Yaml document judged against a compiled problem.

The problems are compiled here by the gateway's in-process port, and every evaluation comes
from the same port, so the library is tested against the toolchain's real outputs while it
imports nothing of the toolchain itself. The test needs the pinned wheels and no kit, and never
skips.

Each finding is checked by code, severity and exact path. The parity test pins override 4: every
pending case -- a binding the lookup only explains -- is refused by the toolchain itself, so the
lookup is never stricter than ``validate_binding``.
"""

from __future__ import annotations

import copy
from functools import cache
from typing import Any

import pytest
from bim_core import EvaluationError

from _repo import REPO_ROOT
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition import text
from openbinding_gateway.composition.document import Document, Value
from openbinding_gateway.composition.problem import (
    CandidateRef,
    ProblemFacts,
    ProblemFactsError,
    against,
    computed_values,
    document_binding,
    value_findings,
    violation_findings,
)
from openbinding_gateway.integrations import bim, packages

SIMPLE = REPO_ROOT / "examples" / "demo" / "01_simple_seq"
FMS = REPO_ROOT / "examples" / "demo" / "13_fms"
JSON = REPO_ROOT / "examples" / "demo" / "16_json_complete"
PLACEMENT = REPO_ROOT / "examples" / "placement" / "01_small_placement"

HEAD = (
    'syntaxVersion: "1.0"\ncomposition: shop\nversion: 1.0.0\nkind: application\n'
    "problem: {ref: isa/problems/shop@1, compilation: sha256-" + "0" * 64 + "}\n"
)


@cache
def _port():
    return bim.build_bim()


@cache
def _ir(directory) -> dict[str, Any]:
    return _port().compile(packages.zip_directory(directory))["ir"]


def _facts(directory) -> ProblemFacts:
    return ProblemFacts.from_ir(_ir(directory))


def _first(directory) -> dict[str, dict[str, str]]:
    """The first eligible candidate of every service task."""
    spec = _ir(directory)["spec"]
    return {
        task: dict(spec["eligibility"][task][0])
        for task, body in spec["application"]["tasks"].items()
        if body["kind"] == "service"
    }


def _evaluate(directory, binding: dict[str, dict[str, str]]) -> dict[str, Any]:
    return _port().evaluate(_ir(directory), binding)


def _document(workflow: str, binding: dict[str, str], values: str = "{}") -> Document:
    """A document: ``binding`` maps each task to ``candidate: <ref>`` or to ``local``."""
    entries = ", ".join(
        f"{task}: {{local: true}}" if ref == "local" else f"{task}: {{candidate: {ref}}}"
        for task, ref in binding.items()
    )
    return text.parse(f"{HEAD}workflow: {workflow}\nbinding: {{{entries}}}\nvalues: {values}\n")


def _found(items) -> list[tuple[str, str, str]]:
    return [(item.code, item.severity, item.path) for item in items]


# --------------------------------------------------------------------------- the simple sequence

SIMPLE_WORKFLOW = "{seq: [t1, t2, t3]}"
SIMPLE_BINDING = {"t1": "c1a", "t2": "c2a", "t3": "c3a"}


def test_the_demo_binding_resolves_and_its_value_is_the_evaluators() -> None:
    facts = _facts(SIMPLE)
    resolution = against(_document(SIMPLE_WORKFLOW, SIMPLE_BINDING), facts)
    assert resolution.blocking == () and resolution.pending == ()
    assert resolution.bim_binding == {
        "t1": {"resource": "catalog", "id": "c1a"},
        "t2": {"resource": "catalog", "id": "c2a"},
        "t3": {"resource": "catalog", "id": "c3a"},
    }
    features = _evaluate(SIMPLE, resolution.bim_binding)["features"]
    values = computed_values(features, facts)
    assert values == (("latency", Value(30.0, "ms")),)
    assert values[0][1].value == features["latency"]


def test_the_facts_of_a_compiled_problem() -> None:
    facts = _facts(SIMPLE)
    assert facts.service_tasks == {"t1", "t2", "t3"} and facts.local_tasks == frozenset()
    assert facts.eligibility["t1"] == (CandidateRef("catalog", "c1a"), CandidateRef("catalog", "c1b"))
    assert CandidateRef("catalog", "c3a") in facts.candidates
    assert facts.units == {"latency": "ms"} and facts.features == {"latency"} and facts.reported == {"latency"}


def test_an_ir_without_the_members_every_compilation_has_is_a_bug() -> None:
    broken = copy.deepcopy(_ir(SIMPLE))
    del broken["spec"]["eligibility"]
    with pytest.raises(ProblemFactsError):
        ProblemFacts.from_ir(broken)
    strange = copy.deepcopy(_ir(SIMPLE))
    strange["spec"]["application"]["workflow"] = {"kind": "teleport"}
    with pytest.raises(ProblemFactsError):
        ProblemFacts.from_ir(strange)


# Each case: the binding, then (blocking, pending) as (code, path).
CANDIDATES = [
    (
        "unknown",
        {**SIMPLE_BINDING, "t1": "nope"},
        [(codes.CANDIDATE_UNKNOWN, "binding.t1.candidate")],
        [],
    ),
    (
        "not allowed",
        {**SIMPLE_BINDING, "t1": "c2a"},
        [],
        [(codes.CANDIDATE_NOT_ALLOWED, "binding.t1.candidate")],
    ),
    (
        "qualified, outside the eligibility",
        {**SIMPLE_BINDING, "t1": "catalog/c2a"},
        [],
        [(codes.CANDIDATE_NOT_ALLOWED, "binding.t1.candidate")],
    ),
    (
        "qualified, no such catalog",
        {**SIMPLE_BINDING, "t1": "elsewhere/c1a"},
        [(codes.CANDIDATE_UNKNOWN, "binding.t1.candidate")],
        [],
    ),
    (
        "qualified, eligible",
        {**SIMPLE_BINDING, "t1": "catalog/c1b"},
        [],
        [],
    ),
]


@pytest.mark.parametrize(("case", "binding", "blocking", "pending"), CANDIDATES, ids=[case[0] for case in CANDIDATES])
def test_each_candidate_case_has_its_code_at_its_path(case, binding, blocking, pending) -> None:
    resolution = against(_document(SIMPLE_WORKFLOW, binding), _facts(SIMPLE))
    assert [(item.code, item.path) for item in resolution.blocking] == blocking
    assert [(item.code, item.path) for item in resolution.pending] == pending
    assert all(item.severity == "error" for item in (*resolution.blocking, *resolution.pending))
    if blocking:
        assert resolution.bim_binding is None
    else:
        assert set(resolution.bim_binding) == {"t1", "t2", "t3"}


def test_a_not_allowed_candidate_is_still_translated_for_the_toolchain() -> None:
    resolution = against(_document(SIMPLE_WORKFLOW, {**SIMPLE_BINDING, "t1": "c2a"}), _facts(SIMPLE))
    assert resolution.bim_binding["t1"] == {"resource": "catalog", "id": "c2a"}


def _two_catalogs() -> ProblemFacts:
    """The simple sequence with a second catalog that also holds a ``c1a``, eligible for ``t1``."""
    ir = copy.deepcopy(_ir(SIMPLE))
    spec = ir["spec"]
    spec["candidates"]["other"] = copy.deepcopy(spec["candidates"]["catalog"])
    spec["eligibility"]["t1"].append({"resource": "other", "id": "c1a"})
    return ProblemFacts.from_ir(ir)


def test_an_id_two_catalogs_give_a_task_is_ambiguous_and_the_qualified_form_resolves() -> None:
    facts = _two_catalogs()
    ambiguous = against(_document(SIMPLE_WORKFLOW, SIMPLE_BINDING), facts)
    assert _found(ambiguous.blocking) == [(codes.CANDIDATE_AMBIGUOUS, "error", "binding.t1.candidate")]
    assert "'catalog/c1a'" in ambiguous.blocking[0].message and "'other/c1a'" in ambiguous.blocking[0].message
    assert ambiguous.bim_binding is None
    qualified = against(_document(SIMPLE_WORKFLOW, {**SIMPLE_BINDING, "t1": "other/c1a"}), facts)
    assert qualified.blocking == () and qualified.pending == ()
    assert qualified.bim_binding["t1"] == {"resource": "other", "id": "c1a"}
    # Eligible for no task but held by two catalogs: still nothing to send.
    across = against(_document(SIMPLE_WORKFLOW, {**SIMPLE_BINDING, "t1": "catalog/c1a", "t2": "c1b"}), facts)
    assert _found(across.blocking) == [(codes.CANDIDATE_AMBIGUOUS, "error", "binding.t2.candidate")]
    # The inverse writes the qualified form only where the id is ambiguous.
    assert document_binding(qualified.bim_binding, facts)[0][1].candidate == "other/c1a"
    assert document_binding(qualified.bim_binding, facts)[1][1].candidate == "c2a"


def test_a_missing_service_task_is_refused_by_the_language() -> None:
    reading = text.read(f"{HEAD}workflow: {SIMPLE_WORKFLOW}\nbinding: {{t1: {{candidate: c1a}}, t2: {{candidate: c2a}}}}\nvalues: {{}}\n")
    assert _found(reading.diagnostics) == [(codes.TASK_UNBOUND, "error", "workflow.seq[2]")]


# --------------------------------------------------------------------------- local tasks

FMS_WORKFLOW = "{seq: [T1, T2, T3, {xor: [{probability: 0.8, flow: node_classic_routing}, {probability: 0.2, flow: T5}]}, T6]}"
FMS_BINDING = {
    "T1": "cand_t1_aws",
    "T2": "cand_t2_radius_iot_network",
    "T3": "cand_t3_distance_matrix_api",
    "node_classic_routing": "local",
    "T5": "cand_t5_amazon_braket",
    "T6": "cand_t6_paypal",
}


def test_a_local_task_is_bound_local_and_left_out_of_the_bim_binding() -> None:
    resolution = against(_document(FMS_WORKFLOW, FMS_BINDING), _facts(FMS))
    assert resolution.blocking == () and resolution.pending == ()
    assert set(resolution.bim_binding) == {"T1", "T2", "T3", "T5", "T6"}
    _evaluate(FMS, resolution.bim_binding)


LOCAL = [
    ("a candidate on a local task", {**FMS_BINDING, "node_classic_routing": "cand_t1_aws"}, "binding.node_classic_routing"),
    ("local on a service task", {**FMS_BINDING, "T5": "local"}, "binding.T5"),
]


@pytest.mark.parametrize(("case", "binding", "path"), LOCAL, ids=[case[0] for case in LOCAL])
def test_local_task_misuse_is_pending_and_the_binding_is_still_built(case, binding, path) -> None:
    resolution = against(_document(FMS_WORKFLOW, binding), _facts(FMS))
    assert resolution.blocking == ()
    assert _found(resolution.pending) == [(codes.TASK_LOCAL_MISMATCH, "error", path)]
    assert resolution.bim_binding is not None


# --------------------------------------------------------------------------- the toolchain's verdict

PENDING = [
    ("not allowed", SIMPLE, SIMPLE_WORKFLOW, {**SIMPLE_BINDING, "t1": "c2a"}),
    ("qualified outside the eligibility", SIMPLE, SIMPLE_WORKFLOW, {**SIMPLE_BINDING, "t1": "catalog/c2a"}),
    ("a candidate on a local task", FMS, FMS_WORKFLOW, LOCAL[0][1]),
    ("local on a service task", FMS, FMS_WORKFLOW, LOCAL[1][1]),
]


@pytest.mark.parametrize(("case", "directory", "workflow", "binding"), PENDING, ids=[case[0] for case in PENDING])
def test_every_pending_case_is_refused_by_the_toolchain(case, directory, workflow, binding) -> None:
    resolution = against(_document(workflow, binding), _facts(directory))
    assert resolution.pending and not resolution.blocking
    with pytest.raises(EvaluationError) as refused:
        _evaluate(directory, resolution.bim_binding)
    assert refused.value.code == "binding_invalid"


# --------------------------------------------------------------------------- values and units


VALUES = [
    ("a property the problem lacks", "{latency: {value: 30, unit: ms}, cost: 3}", [(codes.PROPERTY_UNKNOWN, "values.cost")]),
    ("a wrong unit", "{latency: {value: 30, unit: s}}", [(codes.UNIT_MISMATCH, "values.latency.unit")]),
    ("a bare number for ms", "{latency: 30}", [(codes.UNIT_MISSING, "values.latency")]),
    ("the right unit", "{latency: {value: 30, unit: ms}}", []),
]


@pytest.mark.parametrize(("case", "values", "expected"), VALUES, ids=[case[0] for case in VALUES])
def test_each_value_case_has_its_code_at_its_path(case, values, expected) -> None:
    resolution = against(_document(SIMPLE_WORKFLOW, SIMPLE_BINDING, values), _facts(SIMPLE))
    assert [(item.code, item.path) for item in resolution.blocking] == expected
    assert resolution.pending == ()
    assert (resolution.bim_binding is None) == bool(expected)


def test_a_unit_on_a_dimensionless_property_is_a_mismatch() -> None:
    document = _json_document(values="{trust: {value: 0.95, unit: percent}}")
    assert _found(against(document, _facts(JSON)).blocking) == [(codes.UNIT_MISMATCH, "error", "values.trust.unit")]


# --------------------------------------------------------------------------- 16_json_complete

JSON_WORKFLOW = (
    "{seq: [authenticate, {and: [{seq: [enrich, {xor: [{probability: 0.65, flow: cache}, "
    "{probability: 0.35, flow: fetch}]}, {loop: score, count: 2}]}, audit]}, publish]}"
)
JSON_TASKS = ("authenticate", "enrich", "cache", "fetch", "score", "audit", "publish")


def _json_document(workflow: str = JSON_WORKFLOW, values: str = "{}", tasks=JSON_TASKS) -> Document:
    first = _first(JSON)
    return _document(workflow, {task: first[task]["id"] for task in tasks}, values)


def test_the_first_eligible_binding_violates_edge_authentication_and_has_the_evaluators_values() -> None:
    facts = _facts(JSON)
    resolution = against(_json_document(), facts)
    assert resolution.blocking == () and resolution.pending == ()
    result = _evaluate(JSON, resolution.bim_binding)
    violated = violation_findings(result["violations"], facts)
    assert _found(violated) == [(codes.CONSTRAINT_VIOLATED, "error", "binding")]
    assert "constraints/edge_authentication" in violated[0].message
    assert "constraints.json at /spec/constraints/edge_authentication" in violated[0].message
    assert computed_values(result["features"], facts) == (
        ("carbon", Value(22.5, "gCO2e/run")),
        ("cost", Value(16.0, "EUR/run")),
        ("latency", Value(51.650000000000006, "ms")),
        ("trust", Value(0.95, "1")),
    )


@pytest.mark.parametrize(("latency", "differs"), [("51.65", False), ("51.650000000000006", False), ("52", True)])
def test_a_declared_value_differs_only_beyond_representation_noise(latency: str, differs: bool) -> None:
    facts = _facts(JSON)
    document = _json_document(values=f"{{latency: {{value: {latency}, unit: ms}}}}")
    resolution = against(document, facts)
    assert resolution.blocking == ()
    computed = computed_values(_evaluate(JSON, resolution.bim_binding)["features"], facts)
    found = value_findings(document, computed)
    if differs:
        assert _found(found) == [(codes.VALUE_DIFFERS, "warning", "values.latency.value")]
        assert "51.650000000000006" in found[0].message
    else:
        assert found == ()


def test_a_declared_value_the_toolchain_does_not_compute_is_a_warning() -> None:
    document = _json_document(values="{latency: {value: 51.65, unit: ms}, trust: 0.95}")
    computed = (("latency", Value(51.650000000000006, "ms")),)
    assert _found(value_findings(document, computed)) == [(codes.VALUE_NOT_COMPUTED, "warning", "values.trust")]


def test_a_soft_violation_is_a_warning_with_its_penalty() -> None:
    found = violation_findings(
        [{"constraint": {"resource": "constraints", "id": "run_budget"}, "enforcement": "soft", "penalty": 2.5}],
        _facts(JSON),
    )
    assert _found(found) == [(codes.CONSTRAINT_SOFT, "warning", "binding")]
    assert "2.5" in found[0].message and "constraints.json at /spec/constraints/run_budget" in found[0].message


WORKFLOWS = [
    (
        "a branch removed",
        JSON_WORKFLOW.replace("{xor: [{probability: 0.65, flow: cache}, {probability: 0.35, flow: fetch}]}", "{xor: [cache]}"),
        tuple(task for task in JSON_TASKS if task != "fetch"),
        "workflow.seq[1].and[0].seq[1]",
        "only in the problem: 'fetch'",
    ),
    (
        "a probability changed",
        JSON_WORKFLOW.replace("0.65", "0.6").replace("0.35", "0.4"),
        JSON_TASKS,
        "workflow.seq[1].and[0].seq[1].xor[0].probability",
        "probability 0.65",
    ),
    (
        "a count changed",
        JSON_WORKFLOW.replace("count: 2", "count: 3"),
        JSON_TASKS,
        "workflow.seq[1].and[0].seq[2].count",
        "count 2",
    ),
    (
        "an expected count where the problem has a count",
        JSON_WORKFLOW.replace("count: 2", "expected: 2"),
        JSON_TASKS,
        "workflow.seq[1].and[0].seq[2].expected",
        "count 2",
    ),
]


@pytest.mark.parametrize(("case", "workflow", "tasks", "path", "said"), WORKFLOWS, ids=[case[0] for case in WORKFLOWS])
def test_a_hand_edited_workflow_is_one_mismatch_at_its_node(case, workflow, tasks, path, said) -> None:
    resolution = against(_json_document(workflow, tasks=tasks), _facts(JSON))
    assert _found(resolution.blocking) == [(codes.WORKFLOW_MISMATCH, "error", path)]
    assert said in resolution.blocking[0].message
    assert "derive again or copy it from the problem" in resolution.blocking[0].message
    assert resolution.bim_binding is None


def test_a_mismatch_is_underlined_where_the_text_has_it() -> None:
    source = (
        f"{HEAD}workflow: {JSON_WORKFLOW.replace('count: 2', 'count: 3')}\n"
        "binding: {" + ", ".join(f"{task}: {{candidate: {_first(JSON)[task]['id']}}}" for task in JSON_TASKS) + "}\nvalues: {}\n"
    )
    document = text.parse(source)
    (finding,) = against(document, _facts(JSON)).blocking
    assert finding.pointer == "/workflow/seq/1/and/0/seq/2/count"


# --------------------------------------------------------------------------- placement

PLACEMENT_TASKS = ("t_login", "t_process", "t_check", "t_rules", "t_render")


def _placement_document(xor: str, values: str = "{}") -> Document:
    workflow = f"{{seq: [t_login, {{and: [{{seq: [t_process, {xor}]}}, t_render]}}]}}"
    first = _first(PLACEMENT)
    return _document(workflow, {task: first[task]["id"] for task in PLACEMENT_TASKS}, values)


@pytest.mark.parametrize(
    "xor",
    ["{xor: [t_check, t_rules], uniform: true}", "{xor: [{probability: 0.5, flow: t_check}, {probability: 0.5, flow: t_rules}]}", "{xor: [t_check, t_rules]}"],
)
def test_a_uniform_choice_matches_written_uniform_with_its_probabilities_or_bare(xor: str) -> None:
    assert against(_placement_document(xor), _facts(PLACEMENT)).blocking == ()


def test_the_placement_violation_says_its_own_message_and_the_ratio_feature_needs_its_unit() -> None:
    facts = _facts(PLACEMENT)
    bare = against(_placement_document("{xor: [t_check, t_rules], uniform: true}", "{security: 1.0}"), facts)
    assert _found(bare.blocking) == [(codes.UNIT_MISSING, "error", "values.security")]
    assert "'score'" in bare.blocking[0].message
    resolution = against(_placement_document("{xor: [t_check, t_rules], uniform: true}", "{security: {value: 1.0, unit: score}}"), facts)
    assert resolution.blocking == ()
    result = _evaluate(PLACEMENT, resolution.bim_binding)
    (violated,) = violation_findings(result["violations"], facts)
    assert (violated.code, violated.path) == (codes.CONSTRAINT_VIOLATED, "binding")
    assert violated.message == "constraint placement/tr_event_login: " + result["violations"][0]["message"]
