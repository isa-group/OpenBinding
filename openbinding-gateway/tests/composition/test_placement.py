"""Placement in the language, and the three measurements that lifted the gate to the corpus.

Section 11.2's gate held 75 of the normalized golden's 82 packages. Seven were out, and the
specification said they shared one reason -- a Placement resource with no home in the model.
That was wrong by three packages, and finding out why is what this file pins:

``examples/demo/15_bpmn_complete`` was kept out by its **BPMN workflow**, not by its
placement. It is read by delegation now, and the reduction is exact rather than approximate:
it and ``examples/demo/16_json_complete`` are the same composition in the two notations and
compile to one IR digest, so the JSON workflow emitted back is the document the BPMN one
already was. That twin pair is the oracle, and the first test here runs it.

``examples/demo/16_json_complete`` was kept out by a **provider's name** and a provider's
own **properties map** -- two fields, since each moves its digest on its own. All four
names the container knows reach the IR, measured: a task's, a feature's, a candidate's and
a provider's each move the digest. What decides whether this translation writes one is the
corpus: 18 of the 82 packages carry a task name and 2 carry a provider name, while none
carries a feature name or a candidate name.

``examples/placement/02_stock_market_sample`` was kept out by a candidate's **own properties
map**, which is not the numeric map this surface calls properties -- that one is the
container's ``features``. All 44 of its candidates carry one.

The placement itself is proved over the whole gate by ``test_the_roundtrip_gate.py``. What
is proved here is what the round trip cannot see: that the conveniences a placement document
may use -- a defaults block, a group, a symmetric network -- are expanded rather than
guessed at, and that what this version cannot express is refused by name.
"""

from __future__ import annotations

import json

import pytest
import yaml
from jsonschema import Draft202012Validator

from _repo import REPO_ROOT
from openbinding_gateway.composition.read import ImportError_, import_bim
from openbinding_gateway.composition.text import parse, serialise

BPMN = "examples/demo/15_bpmn_complete"
JSON_TWIN = "examples/demo/16_json_complete"
STOCK = "examples/placement/02_stock_market_sample"
SMALL = "examples/placement/01_small_placement"


def _files(package: str) -> dict[str, bytes]:
    directory = REPO_ROOT / package
    if not (directory / "instance.json").is_file():
        pytest.skip(f"{directory} is not mounted in this environment")
    return {entry.name: entry.read_bytes() for entry in directory.iterdir() if entry.is_file()}


@pytest.fixture(scope="module")
def compile_():
    try:
        from bim_core import compile_instance  # noqa: PLC0415
        from bim_core.package import InstancePackage  # noqa: PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")

    def compile(files: dict[str, bytes]) -> dict:
        return compile_instance(InstancePackage(files)).document

    return compile


@pytest.fixture(scope="module")
def ir():
    try:
        from bim_core import ir_digest  # noqa: PLC0415
    except ImportError:
        pytest.skip("bim_core is not importable in this environment")
    return ir_digest


# --------------------------------------------------------------- BPMN by delegation


def test_the_twin_packages_compile_to_one_ir_digest(compile_, ir) -> None:
    """The oracle that licenses reading a BPMN workflow and writing JSON back.

    Without this, emitting a JSON workflow for a package that declared a BPMN one would be
    a claim about the two notations rather than a measurement of them.
    """
    try:
        bpmn = compile_(_files(BPMN))
    except FileNotFoundError as exc:  # the vendored OMG BPMN XSDs
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    assert ir(bpmn) == ir(compile_(_files(JSON_TWIN)))


def test_a_bpmn_workflow_without_a_compiler_is_refused_by_name() -> None:
    """The alternative is a composition whose workflow is silently empty."""
    with pytest.raises(ImportError_) as raised:
        import_bim(_files(BPMN))
    message = str(raised.value)
    assert "BPMN" in message
    assert "compile=" in message, "the refusal has to name what the caller must pass"


def test_the_bpmn_resource_is_not_reported_as_inexpressible(compile_) -> None:
    """It has no destination in the model and the workflow it reduces to does.

    The importer used to refuse the package for holding a resource it could not express.
    The bytes still have no home; the reduced workflow does, so the resource the reference
    names is discounted rather than counted against the package.
    """
    try:
        composition = import_bim(_files(BPMN), compile=compile_)
    except FileNotFoundError as exc:
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    assert composition.workflow is not None
    assert composition.placement is not None


# ------------------------------------------------------------ the two lost fields


def test_a_provider_s_name_and_properties_survive_the_trip(compile_) -> None:
    """Both are in the IR, which is why the package moved without them."""
    composition = import_bim(_files(JSON_TWIN), compile=compile_)
    named = {name: p.title for name, p in composition.providers.items() if p.title}
    assert named, "the json twin names its providers"
    assert composition == parse(serialise(composition))


def test_every_candidate_of_the_stock_sample_keeps_its_own_map(compile_) -> None:
    """The container's ``properties`` on a candidate, not the numeric ``features``.

    These candidates carry a demand **and** a map, which is the pair that caught the bug:
    attaching the demand rebuilt each candidate field by field and dropped the map. The
    importer uses ``replace`` now, so a field added to ``Candidate`` next cannot be lost
    the same way -- and the loss would have shown up only as one moved digest.
    """
    composition = import_bim(_files(STOCK), compile=compile_)
    assert len(composition.candidates) == 44
    assert all(candidate.attributes for candidate in composition.candidates)
    assert all(candidate.placement is not None for candidate in composition.candidates)
    assert all("description" in candidate.attributes for candidate in composition.candidates)


# ------------------------------------------------- the conveniences, expanded not guessed


def test_a_group_and_the_defaults_become_one_demand_per_candidate(compile_) -> None:
    """Both are erased by the lowering, so the model holds what they expand to."""
    try:
        composition = import_bim(_files(BPMN), compile=compile_)
    except FileNotFoundError as exc:
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    demands = {c.id: c.placement for c in composition.candidates if c.placement is not None}
    # The package declares no demands at all: three groups and a defaults block.
    assert demands, "the groups expand to demands"
    edge = demands["cache-edge"]
    assert edge.pool == "edge"
    assert edge.resources == {"cpu": 0.75, "memory": 1.5}


def test_the_defaults_fill_only_what_the_group_leaves_out(compile_) -> None:
    """The merge, on a fixture the corpus cannot supply.

    Both packages that use ``groups`` give every group its own value for every key the
    defaults block has, so the assertion above holds whether the defaults are merged in or
    thrown away: it pins the precedence and not the merge. This removes one key from one
    group so that the defaults have something left to supply.
    """
    files = _files(BPMN)
    document = json.loads(files["placement.json"])
    defaults = document["spec"]["defaults"]
    assert set(defaults) == {"cpu", "memory"}, f"the fixture assumes these: {sorted(defaults)}"
    group = document["spec"]["groups"]["edge-runtime"]
    assert group["resources"] == {"cpu": 0.75, "memory": 1.5}
    del group["resources"]["memory"]
    files["placement.json"] = json.dumps(document).encode("utf-8")

    try:
        composition = import_bim(files, compile=compile_)
    except FileNotFoundError as exc:
        pytest.skip(f"the vendored OMG BPMN XSDs are not in place: {exc}")
    demand = next(c.placement for c in composition.candidates if c.id == "cache-edge")
    # cpu from the group, memory from the defaults: a merge, not a replacement either way.
    assert demand.resources == {"cpu": 0.75, "memory": defaults["memory"]}


def test_an_explicit_demand_wins_over_a_group(compile_) -> None:
    """The container's precedence, measured rather than assumed.

    With one candidate named by both a ``demands`` entry and a ``groups`` entry, the
    compiled IR digest is the one the demand alone produces. The importer read them the
    other way round at first, which round-tripped such a package to a different problem
    with nothing to show for it -- no corpus package writes both, so the gate was silent.
    """
    files = _files(SMALL)
    document = json.loads(files["placement.json"])
    demand = document["spec"]["demands"][0]
    candidate = demand["candidate"]["id"]
    demand_pool = demand["pool"]["id"]
    other_pool = next(name for name in document["spec"]["pools"] if name != demand_pool)
    document["spec"]["groups"] = {
        "g": {
            "pool": {"resource": "placement", "id": other_pool},
            "candidates": [{"resource": "catalog", "id": candidate}],
            "resources": dict(demand.get("resources") or {}),
        },
    }
    files["placement.json"] = json.dumps(document).encode("utf-8")
    composition = import_bim(files, compile=compile_)
    placed = next(c.placement for c in composition.candidates if c.id == candidate)
    assert placed.pool == demand_pool, "the explicit demand is the one the container follows"


def test_a_symmetric_network_comes_back_complete(compile_) -> None:
    """The mode is a saving in typing, and the lowering erases it.

    So the model holds the completed directed list and re-emitting writes both directions.
    Re-deriving the mode from a list of edges would be a guess about the author's intent,
    and the digest is the measurement that says the completion is right.
    """
    composition = import_bim(_files(SMALL), compile=compile_)
    assert composition.placement is not None
    edges = {(edge.source, edge.target): edge.latency for edge in composition.placement.network}
    off_diagonal = [pair for pair in edges if pair[0] != pair[1]]
    assert off_diagonal, "the small placement has a network between its pools"
    for source, target in off_diagonal:
        assert (target, source) in edges, f"the mirror of {source}->{target} is missing"
        assert edges[(target, source)] == edges[(source, target)]


def test_the_ordered_lists_keep_their_order(compile_) -> None:
    """A capacity rule's position is data, and an event's latency list is ordered.

    On the package as it ships this test could not fail: it has one capacity rule and one
    event, so reversing either list is the identity, and the first version of the
    projection dropped ``scope`` as well, so flipping every rule's scope passed too. The
    fixture therefore grows a second rule and a second event before the loop, which is the
    only way the two list orders are under test at all.
    """
    files = _files(SMALL)
    document = json.loads(files["placement.json"])
    rules = document["spec"]["capacityRules"]
    second_rule = dict(rules[0])
    second_rule["scope"] = (
        "invocation" if rules[0].get("scope") != "invocation" else "selectedCandidate"
    )
    document["spec"]["capacityRules"] = [rules[0], second_rule]
    events = document["spec"]["events"]
    name, body = next(iter(events.items()))
    events[f"{name}_twin"] = json.loads(json.dumps(body))
    files["placement.json"] = json.dumps(document).encode("utf-8")

    composition = import_bim(files, compile=compile_)
    placement = composition.placement
    assert placement is not None
    assert len(placement.capacity_rules) == 2, "the fixture is what makes the order testable"
    assert len(placement.events) == 2
    assert len({rule.scope for rule in placement.capacity_rules}) == 2

    through_text = parse(serialise(composition)).placement
    assert through_text is not None
    # The scope is in the projection: without it a flipped scope passed as unchanged.
    assert [
        (tuple(sorted(rule.resources)), rule.scope) for rule in through_text.capacity_rules
    ] == [(tuple(sorted(rule.resources)), rule.scope) for rule in placement.capacity_rules]
    assert [event.id for event in through_text.events] == [e.id for e in placement.events]
    assert [
        [(row.pool, row.latency) for row in event.latency] for event in through_text.events
    ] == [[(row.pool, row.latency) for row in event.latency] for event in placement.events]


def test_a_transition_may_end_at_an_event_or_at_a_task(compile_) -> None:
    """Two shapes on the surface, and the text layer has to tell them apart.

    An event and a task can share a name, so writing a bare id for both would make the
    document ambiguous in exactly the case where it matters.
    """
    composition = import_bim(_files(SMALL), compile=compile_)
    placement = composition.placement
    assert placement is not None
    assert placement.transitions, "the small placement constrains its transitions"
    kinds = {(t.source.event, t.target.event) for t in placement.transitions}
    assert (True, False) in kinds, "one transition runs from an event to a task"
    assert parse(serialise(composition)) == composition


# ----------------------------------------------------------------- what is refused


def test_a_soft_transition_is_refused_rather_than_silently_hardened() -> None:
    """It needs a penalty row in the Optimization keyed by a placement reference.

    This version writes none, so reading one and emitting it back would turn a preference
    into a requirement -- a change in the problem, not in its notation.
    """
    files = _files(SMALL)
    placement = json.loads(files["placement.json"])
    name, body = next(iter(placement["spec"]["transitions"].items()))
    body["enforcement"] = "soft"
    files["placement.json"] = json.dumps(placement).encode("utf-8")
    with pytest.raises(ImportError_) as raised:
        import_bim(files)
    assert name in str(raised.value)
    assert "penalty" in str(raised.value)


def test_a_group_naming_a_capability_is_refused() -> None:
    """One demand per candidate is what the model holds, so a capability has no expansion.

    The container lets a group name a capability and place everything that provides it.
    Expanding that here would mean deciding what the catalog holds at import time and
    writing a demand the author never wrote.
    """
    files = _files(SMALL)
    placement = json.loads(files["placement.json"])
    # ``capability`` and the pool's own resource keys, because the container's group schema
    # has no ``provides`` and the pool declares only the dimensions it declares: a fixture
    # the container would refuse as malformed proves nothing about this refusal.
    pool = next(iter(placement["spec"]["pools"]))
    placement["spec"]["groups"] = {
        "by-capability": {
            "pool": {"resource": "placement", "id": pool},
            "capability": "service/anything",
            "resources": dict(placement["spec"]["pools"][pool]["capacity"]),
        },
    }
    files["placement.json"] = json.dumps(placement).encode("utf-8")
    with pytest.raises(ImportError_) as raised:
        import_bim(files)
    assert "capability" in str(raised.value)


def test_the_placement_block_validates_against_the_schema(compile_) -> None:
    """The surface is schema-checked, and ``additionalProperties`` is false throughout.

    A key the schema does not know is a key the author misspelled, so the block has to be
    described there and not only implemented here.
    """
    path = (
        REPO_ROOT
        / "openbinding-gateway"
        / "src"
        / "openbinding_gateway"
        / "composition"
        / "resources"
        / "composition2yaml"
        / "v1"
        / "composition.schema.json"
    )
    if not path.is_file():
        pytest.skip(f"{path} is not mounted in this environment")
    schema = json.loads(path.read_text(encoding="utf-8"))
    assert "placement" in schema["properties"]
    validator = Draft202012Validator(schema)

    composition = import_bim(_files(SMALL), compile=compile_)
    document = yaml.safe_load(serialise(composition))
    errors = sorted(validator.iter_errors(document), key=lambda e: list(e.path))
    assert not errors, "; ".join(f"{e.json_path}: {e.message}" for e in errors[:3])

    # A positive document alone does not test strictness: it passes against a schema that
    # describes nothing. One mistake per structural object of the block, each expected to
    # be refused.
    mistakes = {
        "an unknown key on the block": lambda d: d["placement"].update(netwrok=[]),
        "an unknown key on a pool": lambda d: d["placement"]["pools"][0].update(capcity={}),
        "a pool with no capacity": lambda d: d["placement"]["pools"][0].pop("capacity"),
        "an unknown key on an edge": lambda d: d["placement"]["network"][0].update(ltency=1),
        "a negative latency": lambda d: d["placement"]["network"][0].update(latency=-1),
        "an unknown key on a transition": lambda d: d["placement"]["transitions"][0].update(mx=1),
        "a transition with no max": lambda d: d["placement"]["transitions"][0].pop("max"),
        "an unknown capacity scope": lambda d: d["placement"]["capacityRules"][0].update(
            scope="whatever",
        ),
        "an unknown key on the global latency": lambda d: d["placement"].update(
            globalLatency={"parallell": "max"},
        ),
        "a demand naming no pool": lambda d: d["candidates"]["rows"][0]["placement"].pop("pool"),
    }
    accepted = []
    for label, break_it in mistakes.items():
        broken = yaml.safe_load(serialise(composition))
        break_it(broken)
        if not list(validator.iter_errors(broken)):
            accepted.append(label)
    assert not accepted, f"the schema accepts: {accepted}"


# --------------------------------------- which lists are ordered, where the corpus is silent


def test_the_demand_order_is_not_in_the_digest(compile_, ir) -> None:
    """Which is why the emitter may sort the demands by candidate id.

    Every other list in a Placement document is written back exactly as it was read. This
    one is sorted, and that is a canonicalization rather than a liberty only because the
    container does not look at the order. The 44 demands of the stock sample happen to be
    written sorted already, so the gate would pass either way: this is the measurement the
    gate cannot make.
    """
    files = _files(STOCK)
    document = json.loads(files["placement.json"])
    before = ir(compile_(files))
    document["spec"]["demands"] = list(reversed(document["spec"]["demands"]))
    files["placement.json"] = json.dumps(document).encode("utf-8")
    assert ir(compile_(files)) == before


def test_a_capacity_rule_s_position_is_in_the_digest(compile_, ir) -> None:
    """So the model keeps the rules as a tuple, and the surface never sorts them.

    No package in the corpus has two capacity rules, so this adds the second one. Without
    it the claim that a rule's position is data would be an assertion about the container
    that nothing in the tree checks.
    """
    files = _files(SMALL)
    document = json.loads(files["placement.json"])
    rules = document["spec"]["capacityRules"]
    assert len(rules) == 1, "the corpus has one; this test is what covers two"
    second = dict(rules[0])
    second["scope"] = "invocation" if rules[0].get("scope") != "invocation" else "selectedCandidate"

    def digest(order: list) -> str:
        document["spec"]["capacityRules"] = order
        return ir(compile_(dict(files, **{"placement.json": json.dumps(document).encode("utf-8")})))

    assert digest([rules[0], second]) != digest([second, rules[0]])


def test_an_event_s_latency_rows_are_ordered(compile_, ir) -> None:
    """Measured on the small placement.

    Every one of the seven placement packages carries exactly one event, and every one of
    those events has between 2 and 12 latency rows, so any of them would serve. What the
    corpus does not supply is a second event or a second capacity rule, which is why the
    tests above build those.
    """
    files = _files(SMALL)
    document = json.loads(files["placement.json"])
    name = next(iter(document["spec"]["events"]))
    rows = document["spec"]["events"][name]["latency"]
    assert len(rows) > 1, "the measurement needs at least two rows to reverse"
    before = ir(compile_(files))
    document["spec"]["events"][name]["latency"] = list(reversed(rows))
    files["placement.json"] = json.dumps(document).encode("utf-8")
    assert ir(compile_(files)) != before
