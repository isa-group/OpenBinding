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
from dataclasses import fields, replace
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
    NetworkEdge,
    Normalize,
    OpenTask,
    Parallel,
    Placement,
    Pool,
    PoolDemand,
    PricingRef,
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
    members, _unrecorded = module.gate(REPO_ROOT)
    return members


def test_a_package_against_itself_has_no_changes(gate: list[str]) -> None:
    """What makes an empty diff evidence rather than a shrug.

    The gate is the whole corpus now, so this runs over the placement packages too -- and
    over the one whose workflow is BPMN, which is why the compiler is passed in: that
    package is read by delegation (specification section 5.4).
    """
    from bim_core import compile_instance  # noqa: PLC0415
    from bim_core.package import InstancePackage  # noqa: PLC0415

    from openbinding_gateway.composition.read import import_bim  # noqa: PLC0415

    def compile(files: dict[str, bytes]) -> dict:
        return compile_instance(InstancePackage(files)).document

    noisy = []
    for package in gate:
        directory = Path(REPO_ROOT / package)
        files = {entry.name: entry.read_bytes() for entry in directory.iterdir() if entry.is_file()}
        model = import_bim(files, compile=compile)
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
    """Eight of the gate's 266 criteria do not clamp, and clamping is not a rendering."""
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


# ------------------------------------------------- every field reaches the change list


#: One mutation per field of ``Composition``, keyed by field name. The table is asserted
#: complete against the dataclass, so a field added to the model fails this test until
#: somebody decides how the diff reports it.
#:
#: That guard is here because its absence already cost something: ``placement`` was added
#: to the model and the diff kept its eight sections, so two compositions differing only in
#: where their candidates run compared **equal** -- and the endpoint's ``identical`` said
#: so. An empty change list is only evidence that nothing moved if every field can move it.
COMPOSITION_MUTATIONS: dict[str, dict] = {
    "composition": {"composition": "fleet-two"},
    "version": {"version": "2.0.0"},
    "properties": {"properties": {"latency": COST}},
    "tasks": {
        "tasks": {
            "pick": OpenTask(requires="service/pick"),
            "pay": OpenTask(requires="service/pay"),
            "ship": OpenTask(requires="service/ship"),
        },
    },
    "workflow": {"workflow": Sequence((TaskNode("pay"), TaskNode("pick")))},
    "title": {"title": "Fleet"},
    "description": {"description": "a description"},
    "pricing": {"pricing": PricingRef(href="https://sphere.score.us.es/faked/x.yaml")},
    "providers": {"providers": {"telco": Provider(title="Telco")}},
    "candidates": {
        "candidates": (
            Candidate(id="c_pick", provides="service/pick", properties={"cost": 11.0}),
            Candidate(id="c_pay", provides="service/pay", properties={"cost": 20.0}),
        ),
    },
    "rules": {"rules": (Rule(id="r1", assertion="cost <= 100"),)},
    "goals": {"goals": (Goal("cost", normalize=Normalize(0.0, 9999.0)),)},
    "placement": {
        "placement": Placement(
            pools=(Pool(id="edge", capacity={"cpu": 4.0}),),
            network=(NetworkEdge(source="edge", target="edge", latency=0.0),),
        ),
    },
    "studio": {"studio": {"tags": ["one"]}},
}

#: The same for the two nested records a candidate carries, which is where two of the
#: gate's packages were losing values: a provider's name and a candidate's own map.
CANDIDATE_MUTATIONS: dict[str, dict] = {
    "id": {"id": "c_other"},
    "provides": {"provides": ("service/pick", "service/pay")},
    "properties": {"properties": {"cost": 99.0}},
    "provider": {"provider": "telco"},
    "title": {"title": "A candidate"},
    "attributes": {"attributes": {"description": "an original fog node"}},
    "placement": {"placement": PoolDemand(pool="edge", resources={"cpu": 0.5})},
    "domain": {"domain": "quantum"},
}


def test_the_mutation_tables_cover_the_model() -> None:
    """The table is the test: an uncovered field is a field the diff may be blind to."""
    assert {f.name for f in fields(Composition)} == set(COMPOSITION_MUTATIONS)
    assert {f.name for f in fields(Candidate)} == set(CANDIDATE_MUTATIONS)


@pytest.mark.parametrize("field_name", sorted(COMPOSITION_MUTATIONS))
def test_every_composition_field_reaches_the_change_list(field_name: str) -> None:
    before = _base()
    after = _base(**COMPOSITION_MUTATIONS[field_name])
    assert after != before, f"the mutation for {field_name} changes nothing"
    from openbinding_gateway.composition.diff import SECTIONS  # noqa: PLC0415

    changes = diff(before, after)
    assert changes, f"a change in {field_name} is reported nowhere"
    assert all(change.section in SECTIONS for change in changes)


@pytest.mark.parametrize("field_name", sorted(CANDIDATE_MUTATIONS))
def test_every_candidate_field_reaches_the_change_list(field_name: str) -> None:
    first = _base().candidates[0]
    before = _base()
    after = _base(
        candidates=(replace(first, **CANDIDATE_MUTATIONS[field_name]), _base().candidates[1]),
    )
    assert after != before, f"the mutation for {field_name} changes nothing"
    assert diff(before, after), f"a change in a candidate's {field_name} is reported nowhere"


def test_a_provider_s_own_map_is_not_reported_as_a_title() -> None:
    """It reaches the IR, so it is a change in the problem and needs its own subject."""
    before = _base(providers={"telco": Provider(title="Telco")})
    after = _base(providers={"telco": Provider(title="Telco", properties={"tier": "edge"})})
    subjects = _subjects(diff(before, after))
    assert ("candidates", "provider telco.properties.tier", "changed") in subjects
    assert not [s for s in subjects if s[1] == "provider telco.title"], (
        "reporting it under the title would have printed None -> None"
    )


def test_a_moved_demand_is_reported_in_the_placement_section() -> None:
    """The candidate is where it is written; where it runs is a placement change."""
    pools = (Pool(id="edge", capacity={"cpu": 4.0}), Pool(id="cloud", capacity={"cpu": 64.0}))
    here = _base(
        placement=Placement(pools=pools),
        candidates=(
            replace(_base().candidates[0], placement=PoolDemand(pool="edge")),
            _base().candidates[1],
        ),
    )
    there = _base(
        placement=Placement(pools=pools),
        candidates=(
            replace(_base().candidates[0], placement=PoolDemand(pool="cloud")),
            _base().candidates[1],
        ),
    )
    subjects = _subjects(diff(here, there))
    assert ("placement", "c_pick.demand", "changed") in subjects


def test_a_reordered_network_is_one_row_and_not_the_whole_network() -> None:
    """Two things at once, and the first version of this test got the first one wrong.

    The network's order **is** in the IR digest -- measured: reversing the network of any
    placement package moves it -- so two models whose edges differ only in order are two
    different problems and the diff has to say so. This test first asserted the opposite,
    that such a pair compares equal, which would have made ``identical`` lie on the
    endpoint. The empty change list is the one verdict that must never be reachable from
    two unequal models.

    The second half is still the original point: the report is **one** row about the order,
    not one row per edge. The per-edge rows stay keyed by their endpoints, so a mirror
    appended by the symmetric completion moves nothing after it.
    """
    pools = (Pool(id="edge", capacity={"cpu": 4.0}), Pool(id="cloud", capacity={"cpu": 64.0}))
    forward = NetworkEdge(source="edge", target="cloud", latency=25.0)
    back = NetworkEdge(source="cloud", target="edge", latency=25.0)
    one = Placement(pools=pools, network=(forward, back))
    other = Placement(pools=pools, network=(back, forward))
    assert one != other, "the tuples differ, which is the point"

    changes = _subjects(diff(_base(placement=one), _base(placement=other)))
    assert ("placement", "network order", "moved") in changes
    assert len(changes) == 1, f"one row about the order, not one per edge: {changes}"
