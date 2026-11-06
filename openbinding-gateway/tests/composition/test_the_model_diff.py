"""What the diff says, including the three things the compare screen says nothing about.

Phase F1 step 6. The repository's existing diff is computed over the compiled package and
reports "changed" when two rendered cells differ. Measured against it, three classes of
real change come out wrong: a goal whose normalization range moves prints the *same*
string, a property's aggregation has no row at all, and a rename is reported as a removal
plus an addition. This diff works over the model and names the kind of each change, and the
tests below are mostly about those three.

The first test is the one that makes an empty diff mean something: a package compared with
itself produces nothing, over the whole gate. Without it, "no changes" is as likely to mean
the comparison is shallow as to mean nothing moved.
"""

from __future__ import annotations

import importlib.util
import sys
from decimal import Decimal
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway.composition.diff import diff
from openbinding_gateway.composition.model import (
    Aggregation,
    Branch,
    Candidate,
    Composition,
    Domain,
    Exclusive,
    FixedTask,
    Goal,
    Normalize,
    OpenTask,
    Parallel,
    Property,
    Provider,
    Rule,
    Sequence,
    TaskNode,
)

COST = Property(
    unit="USD/month",
    direction="minimize",
    aggregation=Aggregation("sum", "sum", "weightedSum", "scale", "sum"),
    domain=Domain("real", 0.0, 10000.0),
)


def _base(**overrides) -> Composition:
    base = {
        "composition": "fleet",
        "version": "1.0.0",
        "properties": {"cost": COST},
        "tasks": {
            "pick": OpenTask(requires="service/pick"),
            "pay": OpenTask(requires="service/pay"),
        },
        "workflow": Sequence((TaskNode("pick"), TaskNode("pay"))),
        "candidates": (
            Candidate(id="c_pick", provides="service/pick", properties={"cost": 10.0}),
            Candidate(id="c_pay", provides="service/pay", properties={"cost": 20.0}),
        ),
        "goals": (Goal("cost", normalize=Normalize(0.0, 10000.0)),),
    }
    base.update(overrides)
    return Composition(**base)


def _subjects(changes) -> list[tuple[str, str, str]]:
    return [(c.section, c.subject, c.kind) for c in changes]


@pytest.fixture(scope="module")
def gate() -> list[str]:
    path = REPO_ROOT / "tools" / "check_composition_roundtrip.py"
    if not path.is_file():
        pytest.skip(f"{path} is not mounted in this environment")
    try:
        import bim_core  # noqa: F401, PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    spec = importlib.util.spec_from_file_location("_gate_for_diff", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_gate_for_diff"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_gate_for_diff", None)
    members, _excluded, _unrecorded = module.gate(REPO_ROOT)
    return members


def test_a_package_against_itself_has_no_changes(gate: list[str]) -> None:
    """What makes an empty diff evidence rather than a shrug."""
    from openbinding_gateway.composition.read import import_bim

    noisy = []
    for package in gate:
        directory = Path(REPO_ROOT / package)
        model = import_bim(
            {entry.name: entry.read_bytes() for entry in directory.iterdir() if entry.is_file()},
        )
        changes = diff(model, model)
        if changes:
            noisy.append(f"{package}: {[c.subject for c in changes][:5]}")
    assert not noisy, "\n".join(noisy)


def test_a_moved_normalization_range_is_reported() -> None:
    """The compare screen renders this as the same string, measured. It is not the same."""
    after = _base(goals=(Goal("cost", normalize=Normalize(0.0, 25000.0)),))
    changes = diff(_base(), after)
    assert _subjects(changes) == [("goals", "cost.normalize", "changed")]
    assert changes[0].was == {"min": 0.0, "max": 10000.0, "clamp": True}
    assert changes[0].now == {"min": 0.0, "max": 25000.0, "clamp": True}


def test_clamp_alone_is_a_change() -> None:
    """Five of the gate's 243 criteria do not clamp, and clamping is not a rendering."""
    after = _base(goals=(Goal("cost", normalize=Normalize(0.0, 10000.0, clamp=False)),))
    changes = diff(_base(), after)
    assert _subjects(changes) == [("goals", "cost.normalize", "changed")]
    assert changes[0].now["clamp"] is False


def test_an_aggregation_operator_is_named_one_by_one() -> None:
    """"The aggregation changed" is not a finding anybody can act on."""
    moved = Property(
        unit=COST.unit,
        direction=COST.direction,
        aggregation=Aggregation("sum", "max", "weightedProduct", "scale", "sum"),
        domain=COST.domain,
    )
    changes = diff(_base(), _base(properties={"cost": moved}))
    assert _subjects(changes) == [
        ("properties", "cost.aggregation.exclusive", "changed"),
        ("properties", "cost.aggregation.parallel", "changed"),
    ]
    assert (changes[0].was, changes[0].now) == ("weightedSum", "weightedProduct")


def test_a_renamed_task_is_one_change_and_not_two() -> None:
    """The verdict that turns a rename census back into a sentence."""
    changes = diff(
        _base(),
        _base(
            tasks={"collect": OpenTask(requires="service/pick"), "pay": OpenTask(requires="service/pay")},
            workflow=Sequence((TaskNode("collect"), TaskNode("pay"))),
        ),
    )
    assert _subjects(changes) == [("tasks", "pick", "renamed")]
    assert (changes[0].was, changes[0].now) == ("pick", "collect")


def test_a_rename_is_refused_when_the_evidence_is_weak() -> None:
    """Two open tasks buying the same thing must not be paired by accident."""
    twins = {
        "pick": OpenTask(requires="service/pick"),
        "pick_again": OpenTask(requires="service/pick"),
    }
    after = {
        "collect": OpenTask(requires="service/pick"),
        "pick_again": OpenTask(requires="service/pick"),
    }
    changes = diff(
        _base(tasks=twins, workflow=Sequence((TaskNode("pick"), TaskNode("pick_again")))),
        _base(tasks=after, workflow=Sequence((TaskNode("collect"), TaskNode("pick_again")))),
    )
    kinds = {kind for _section, _subject, kind in _subjects(changes)}
    assert "renamed" not in kinds
    assert ("tasks", "pick", "removed") in _subjects(changes)
    assert ("tasks", "collect", "added") in _subjects(changes)


def test_a_task_that_only_changed_position_is_moved() -> None:
    changes = diff(_base(), _base(workflow=Sequence((TaskNode("pay"), TaskNode("pick")))))
    assert ("workflow", "pick", "moved") in _subjects(changes)
    assert ("workflow", "pay", "moved") in _subjects(changes)
    moved = next(c for c in changes if c.subject == "pick")
    assert (moved.was, moved.now) == (["/sequence[0]"], ["/sequence[1]"])


def test_a_task_invoked_twice_is_not_a_move() -> None:
    """One task placed twice is what shared candidates means; it is a different change."""
    changes = diff(
        _base(),
        _base(workflow=Sequence((TaskNode("pick"), TaskNode("pay"), TaskNode("pick")))),
    )
    pick = next(c for c in changes if c.section == "workflow" and c.subject == "pick")
    assert pick.kind == "changed"
    assert len(pick.now) == 2


def test_the_block_structure_is_reported_even_when_every_task_was_renamed() -> None:
    """"The same plan with new names" is a different finding from "everything changed"."""
    same_shape = diff(
        _base(),
        _base(
            tasks={"collect": OpenTask(requires="service/pick"), "pay": OpenTask(requires="service/pay")},
            workflow=Sequence((TaskNode("collect"), TaskNode("pay"))),
        ),
    )
    assert not [c for c in same_shape if c.subject == "structure"]

    reshaped = diff(_base(), _base(workflow=Parallel((TaskNode("pick"), TaskNode("pay")))))
    structure = next(c for c in reshaped if c.subject == "structure")
    assert structure.was == "sequence(task,task)"
    assert structure.now == "parallel(task,task)"


def test_a_probability_is_compared_exactly() -> None:
    """A rounded probability would report two distributions as equal that the compiler does not."""
    def with_probability(value: str) -> Composition:
        return _base(
            workflow=Sequence((
                TaskNode("pick"),
                Exclusive(
                    id="choice",
                    branches=(
                        Branch(flow=TaskNode("pay"), probability=Decimal(value)),
                        Branch(flow=TaskNode("pick"), probability=Decimal("0.2")),
                    ),
                ),
            )),
        )
    changes = diff(with_probability("0.8"), with_probability("0.80000000001"))
    subject = "choice.branch[1].probability"
    moved = next(c for c in changes if c.subject == subject)
    assert (moved.was, moved.now) == ("0.8", "0.80000000001")


def test_the_studio_side_fields_are_reported() -> None:
    """Three things a diff over the compiled package cannot see, because emission drops them."""
    quantum = Property(
        unit=COST.unit, direction=COST.direction, aggregation=COST.aggregation,
        domain=COST.domain, applies_to="quantum",
    )
    changes = diff(
        _base(),
        _base(
            properties={"cost": quantum},
            candidates=(
                Candidate(id="c_pick", provides="service/pick", properties={"cost": 10.0},
                          domain="classical"),
                Candidate(id="c_pay", provides="service/pay", properties={"cost": 20.0}),
            ),
            studio={"tags": ["jisbd-2026"]},
        ),
    )
    assert ("properties", "cost.applies_to", "changed") in _subjects(changes)
    assert ("candidates", "c_pick.domain", "changed") in _subjects(changes)
    assert ("studio", "tags", "added") in _subjects(changes)


def test_a_rule_s_penalty_and_its_weight_are_separate_changes() -> None:
    """Two independent numbers: the gate has soft rules weighed 1, 0.3 and not at all."""
    soft = Rule(id="budget", assertion="features.cost <= 50", enforcement="soft", penalty=1.0, weight=1.0)
    reweighed = Rule(id="budget", assertion="features.cost <= 50", enforcement="soft", penalty=1.0, weight=0.3)
    changes = diff(_base(rules=(soft,)), _base(rules=(reweighed,)))
    assert _subjects(changes) == [("rules", "budget.weight", "changed")]
    assert (changes[0].was, changes[0].now) == (1.0, 0.3)


def test_reordering_the_penalties_is_a_change() -> None:
    """That list is ordered in the IR while the constraint map is not."""
    one = Rule(id="a", assertion="features.cost <= 50", enforcement="soft", penalty=1.0)
    two = Rule(id="b", assertion="features.cost <= 60", enforcement="soft", penalty=1.0)
    changes = diff(_base(rules=(one, two)), _base(rules=(two, one)))
    assert _subjects(changes) == [("rules", "penalty order", "moved")]


def test_a_candidate_keeps_its_identity_through_a_rename() -> None:
    changes = diff(
        _base(),
        _base(
            candidates=(
                Candidate(id="pick_eu", provides="service/pick", properties={"cost": 10.0}),
                Candidate(id="c_pay", provides="service/pay", properties={"cost": 20.0}),
            ),
        ),
    )
    assert _subjects(changes) == [("candidates", "c_pick", "renamed")]


def test_a_provider_and_a_fixed_task_are_reported() -> None:
    changes = diff(
        _base(),
        _base(
            providers={"inhouse": Provider(title="In house")},
            tasks={
                "pick": OpenTask(requires="service/pick"),
                "pay": FixedTask(properties={"cost": 0.0}, provider="inhouse"),
            },
        ),
    )
    assert ("candidates", "provider inhouse", "added") in _subjects(changes)
    assert ("tasks", "pay.kind", "changed") in _subjects(changes)


def test_the_sections_come_out_in_reading_order() -> None:
    from openbinding_gateway.composition.diff import SECTIONS

    changes = diff(
        _base(),
        _base(
            version="2.0.0",
            properties={"cost": COST, "latency": COST},
            goals=(Goal("cost", normalize=Normalize(0.0, 1.0)),),
        ),
    )
    seen = [change.section for change in changes]
    assert seen == sorted(seen, key=SECTIONS.index)
    assert seen[0] == "identity"


def test_a_choice_that_gained_a_branch_says_so() -> None:
    """Comparing only the branches both sides have would hide the one that appeared."""
    def choice(*branches) -> Composition:
        return _base(
            workflow=Sequence((TaskNode("pick"), Exclusive(id="choice", branches=branches))),
        )
    two = choice(
        Branch(flow=TaskNode("pay"), probability=Decimal("0.8")),
        Branch(flow=TaskNode("pick"), probability=Decimal("0.2")),
    )
    three = choice(
        Branch(flow=TaskNode("pay"), probability=Decimal("0.5")),
        Branch(flow=TaskNode("pick"), probability=Decimal("0.3")),
        Branch(flow=TaskNode("pay"), probability=Decimal("0.2")),
    )
    subjects = _subjects(diff(two, three))
    assert ("workflow", "choice.branches", "changed") in subjects
    assert ("workflow", "choice.branch[1].probability", "changed") in subjects
