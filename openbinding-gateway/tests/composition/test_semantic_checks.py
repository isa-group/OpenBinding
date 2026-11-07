"""What a composition says that does not hold together, refused where the author is looking.

These are the checks the ``c2y_*`` codes were declared for in F0 and that nothing made. The
document is well-formed, the schema accepts it, every reader reads it, and it still says
something that cannot be true: a workflow step naming a task nobody declared, a goal over a
property that does not exist, probabilities that do not add up.

The container catches every one of them -- against a resource and a JSON pointer, one
compile later. Moving them here does not make the container's checks redundant; it makes
them late.

**The first test is the one that licenses the rest.** A check that refused a package in the
corpus would be a claim about the language contradicted by the language's own examples, so
every check is measured against section 11.2's 82 packages before being enforced, and that
measurement is a test rather than a note.

**Two kinds, and the split was measured.** Enforcing all eight in ``parse`` refused two
documents elsewhere in the suite that are *drafts* -- an open task whose market is not
written yet -- and the diff compares drafts while the editor loads one at every keystroke.
So ``checks.coherence`` (one element contradicting itself) is refused by ``parse``, and
``checks.completeness`` (references across sections, an empty market) is refused when a
version is sealed, because a sealed version is citable and has to compile.

**One declared code is deliberately absent, and the last test pins why.** Section 14 named
``c2y_exclusive_condition`` for "a branch carries both a probability and a condition", while
section 5.2 says the opposite in as many words -- and the guiding case does carry both.
"""

from __future__ import annotations

import importlib.util
import sys
from decimal import Decimal
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition import diagnostics as codes
from openbinding_gateway.composition.checks import completeness, semantic
from openbinding_gateway.composition.diagnostics import CompositionError
from openbinding_gateway.composition.text import parse

SOURCE = """\
composition: fleet
version: "1.0.0"
properties:
  cost:
    unit: USD/month
    direction: minimize
    domain: {min: 0, max: 100}
    aggregate:
      sequence: sum
      parallel: sum
      exclusive: weightedSum
      repeat: scale
      selection: sum
tasks:
  pick: {open: true, requires: service/pick}
workflow:
  sequence: [{task: pick}]
candidates:
  rows:
    - {id: c_pick, provides: service/pick, properties: {cost: 10}}
goals:
  - property: cost
"""


def _codes(text: str) -> list[str]:
    with pytest.raises(CompositionError) as raised:
        parse(text)
    return [item.code for item in raised.value.diagnostics]


def _codes_or_none(text: str) -> list[str]:
    try:
        parse(text)
        return []
    except CompositionError as error:
        return [item.code for item in error.diagnostics]


def _located(text: str, code: str):
    with pytest.raises(CompositionError) as raised:
        parse(text)
    return next(item for item in raised.value.diagnostics if item.code == code)


# ------------------------------------------------- the measurement that licenses the rest


@pytest.fixture(scope="module")
def gate() -> list[str]:
    path = REPO_ROOT / "tools" / "check_composition_roundtrip.py"
    if not path.is_file():
        pytest.skip(f"{path} is not mounted in this environment")
    try:
        import bim_core  # noqa: F401, PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    spec = importlib.util.spec_from_file_location("_gate_for_checks", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_gate_for_checks"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_gate_for_checks", None)
    members, _unrecorded = module.gate(REPO_ROOT)
    return members


def test_no_check_refuses_a_package_of_the_gate(gate: list[str]) -> None:
    """The licence for enforcing any of this at authoring time.

    A check that rejected a corpus package would be a claim about the language contradicted
    by the language's own examples. Run over all 82, through the importer rather than the
    text layer, because a package is where the examples live.
    """
    from bim_core import compile_instance  # noqa: PLC0415
    from bim_core.package import InstancePackage  # noqa: PLC0415

    from openbinding_gateway.composition.read import import_bim  # noqa: PLC0415

    def compile(files: dict[str, bytes]) -> dict:
        return compile_instance(InstancePackage(files)).document

    refused: list[str] = []
    for package in gate:
        directory = REPO_ROOT / package
        files = {e.name: e.read_bytes() for e in directory.iterdir() if e.is_file()}
        found = semantic(import_bim(files, compile=compile))
        if found:
            refused.append(f"{package}: {[item.code for item in found]}")
    assert not refused, "\n".join(refused)


# ----------------------------------------------------------------------- the checks


def test_the_valid_document_still_parses() -> None:
    assert parse(SOURCE).composition == "fleet"


def _incomplete(text: str) -> list[str]:
    """The completeness codes a draft reports, after ``parse`` has accepted it."""
    return [item.code for item in completeness(parse(text))]


def test_a_draft_with_an_empty_market_still_parses() -> None:
    """The case that split the checks in two.

    An open task whose candidates are not written yet is a normal state while authoring.
    Refusing it in ``parse`` made two documents elsewhere in the suite unreadable -- one of
    them the diff route's own fixture -- and would make the editor unable to load a draft.
    """
    draft = SOURCE.replace("provides: service/pick", "provides: service/other")
    assert parse(draft).composition == "fleet"
    assert codes.CANDIDATE_UNMATCHED in _incomplete(draft)


def test_the_workflow_cannot_run_a_task_nobody_declared() -> None:
    draft = SOURCE.replace("[{task: pick}]", "[{task: pick}, {task: ghost}]")
    found = next(item for item in completeness(parse(draft)) if item.code == codes.TASK_UNKNOWN)
    assert "ghost" in found.message
    assert found.path == "workflow"


def test_a_declared_task_that_runs_nowhere_is_reported() -> None:
    """Addressed to the task, which is the line the author would edit."""
    draft = SOURCE.replace(
        "  pick: {open: true, requires: service/pick}",
        "  pick: {open: true, requires: service/pick}\n"
        "  idle: {open: true, requires: service/pick}",
    )
    found = next(item for item in completeness(parse(draft)) if item.code == codes.TASK_UNREACHED)
    assert found.path == "tasks.idle"


def test_a_goal_over_a_property_that_does_not_exist_is_reported() -> None:
    draft = SOURCE.replace("  - property: cost", "  - property: latency")
    found = next(item for item in completeness(parse(draft)) if item.code == codes.GOAL_UNKNOWN)
    assert found.path == "goals[0].property"


def test_a_fixed_task_needs_no_candidate_row() -> None:
    """Its candidate is minted by the emitter, so requiring a row would refuse every one."""
    text = SOURCE.replace(
        "  pick: {open: true, requires: service/pick}",
        "  pick: {open: true, requires: service/pick}\n"
        "  pay:\n"
        "    fixed:\n"
        "      provider: inhouse\n"
        "      properties: {cost: 5}",
    ).replace("sequence: [{task: pick}]", "sequence: [{task: pick}, {task: pay}]")
    assert codes.CANDIDATE_UNMATCHED not in _incomplete(text)


def test_everything_missing_is_reported_at_once() -> None:
    """An editor wants a marker per problem, and a person wants to fix a document once."""
    draft = (
        SOURCE.replace("  - property: cost", "  - property: latency")
        .replace("provides: service/pick", "provides: service/other")
    )
    found = set(_incomplete(draft))
    assert {codes.GOAL_UNKNOWN, codes.CANDIDATE_UNMATCHED} <= found


@pytest.mark.parametrize(
    ("branches", "expected"),
    [
        ("[{probability: 0.7, flow: {task: pick}}, {probability: 0.2, flow: {task: pick}}]",
         codes.EXCLUSIVE_PROBABILITIES),
        ("[{probability: 0.8, flow: {task: pick}}, {flow: {task: pick}}]",
         codes.EXCLUSIVE_PROBABILITIES),
    ],
)
def test_probabilities_are_all_or_none_and_sum_to_one(branches: str, expected: str) -> None:
    """Compared without an epsilon, because the container compares without one.

    The probabilities are read as ``Decimal`` from the source and never recomputed, so
    ``0.7 + 0.2`` is the author's to see here rather than the compiler's to report two
    layers away.
    """
    text = SOURCE.replace(
        "sequence: [{task: pick}]",
        f"sequence: [{{exclusive: {{id: choice, branches: {branches}}}}}]",
    )
    assert expected in _codes(text)


def test_a_distribution_and_inline_probabilities_say_one_thing_twice() -> None:
    text = SOURCE.replace(
        "sequence: [{task: pick}]",
        "sequence: [{exclusive: {id: choice, distribution: uniform, branches: "
        "[{probability: 0.5, flow: {task: pick}}, {probability: 0.5, flow: {task: pick}}]}}]",
    )
    assert codes.EXCLUSIVE_DISTRIBUTION in _codes(text)


def test_a_repeat_states_exactly_one_of_count_and_expected() -> None:
    both = SOURCE.replace(
        "sequence: [{task: pick}]",
        "sequence: [{repeat: {count: 3, expected: 2.5, body: {task: pick}}}]",
    )
    assert codes.REPEAT_COUNT in _codes(both)


# ---------------------------------------------- the code that is declared and not made


def test_a_branch_may_carry_both_a_probability_and_a_condition() -> None:
    """Section 14 named a code for refusing this; section 5.2 and the guiding case allow it.

    ``c2y_exclusive_condition`` is deliberately not implemented and its row left section 14,
    because implementing it would have refused ``fleet-management-v2`` -- whose
    ``solver_choice`` carries 0.8/0.2 *and* a documented reason on each branch. A condition
    is prose, Studio-side and never compiled, so it conflicts with nothing.
    """
    text = SOURCE.replace(
        "sequence: [{task: pick}]",
        "sequence: [{exclusive: {id: choice, branches: ["
        "{probability: 0.8, condition: the instance is small, flow: {task: pick}}, "
        "{probability: 0.2, condition: the instance is large, flow: {task: pick}}]}}]",
    )
    composition = parse(text)
    choice = composition.workflow.children[0]
    assert [branch.probability for branch in choice.branches] == [Decimal("0.8"), Decimal("0.2")]
    assert all(branch.condition for branch in choice.branches)


def test_the_guiding_case_carries_both_and_still_parses() -> None:
    """Measured on the fixture itself, so the claim above is not about a document I wrote."""
    path = Path(REPO_ROOT) / "openbinding-gateway" / "tests" / "composition" / "fixtures" / (
        "fleet-management-v2.c2y.yaml"
    )
    if not path.is_file():
        pytest.skip(f"{path} is not mounted in this environment")
    composition = parse(path.read_text(encoding="utf-8"))
    choices = [
        node for node in composition.workflow.children
        if getattr(node, "branches", None) is not None
    ]
    assert choices, "version 2 chooses between the classical and the quantum solver"
    assert all(branch.condition for branch in choices[0].branches)
    assert all(branch.probability is not None for branch in choices[0].branches)
