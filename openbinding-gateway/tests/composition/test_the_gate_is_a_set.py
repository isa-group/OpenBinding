"""The phase F1 gate is a named set of packages, and this test is where it is named.

Specification section 11.2 settles what "the demo examples" could not: the gate is the live
normalized golden's own package set, minus the packages that declare a Placement resource.
Everything here recomputes that set from the repository rather than restating a number, so
the test fails when the tree moves rather than when somebody edits a constant.

Two further things it pins, both of which the gate forced into the language:

* a goal may override the criterion range, because 14 packages scale a property onto a
  range that is not its domain and seven of those are inside the gate;
* a property may declare ``scope``, which the model has typed from the first commit while
  section 12 claimed it was inexpressible.

A failure here is a decision, not a regression. A new package in the tree means somebody
has to put it in the gate or in the exclusion list, and say which in the specification.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway import composition

#: Section 11.2's gate, as arithmetic rather than as a number: these two must add up to the
#: golden's own ``packageCount``, so no row of this file can drift on its own.
GATE_SIZE = 75
EXCLUDED = (
    "engines/minizinc-csp/tests/fixtures/placement",
    "examples/demo/15_bpmn_complete",
    "examples/demo/16_json_complete",
    "examples/placement/01_small_placement",
    "examples/placement/02_stock_market_sample",
    "examples/placement/03_cloud_only",
    "examples/placement/04_edge_heavy",
)

#: The one package the walk finds and the golden does not hold. It is the compiler's own
#: fixture, it is not a composition, and section 11.2 puts it out of scope by name.
NOT_A_TARGET = "bim-toolchain/packages/bim-core/tests/fixtures/example-package"

NORMALIZED_CORPUS = REPO_ROOT / "bim-toolchain" / "golden" / "bim_normalized" / "corpus.json"

#: Packages whose criterion range is not the domain of the property it reads, measured over
#: the whole walk. Seven declare a Placement resource and leave by that door; the other
#: seven are why ``Goal.normalize`` exists.
RANGE_OVERRIDE_PACKAGES = 14
RANGE_OVERRIDE_INSIDE_THE_GATE = 7
#: The gate if a goal could only ever normalize over the domain, and if ``scope`` stayed
#: unwritten: section 11.2 records the 68 -> 74 -> 75 chain.
GATE_WITHOUT_RANGE_OVERRIDE = 68


@pytest.fixture(scope="module")
def corpus() -> dict:
    if not NORMALIZED_CORPUS.is_file():
        pytest.skip(f"{NORMALIZED_CORPUS} is not mounted in this environment")
    return json.loads(NORMALIZED_CORPUS.read_text(encoding="utf-8"))


def _load_tool(name: str):
    path = REPO_ROOT / "tools" / f"{name}.py"
    if not path.is_file():
        pytest.skip(f"tools/{name}.py is not mounted in this environment")
    spec = importlib.util.spec_from_file_location(f"_{name}", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"_{name}"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(f"_{name}", None)
    return module


def _resources(package: str) -> dict:
    manifest = json.loads((REPO_ROOT / package / "instance.json").read_text(encoding="utf-8"))
    return manifest["spec"]["resources"]


def _declares_placement(package: str) -> bool:
    return any("placement" in members for members in _resources(package).values())


def _criteria_and_features(package: str) -> tuple[list, dict]:
    resources = _resources(package)
    application = (resources.get("application") or {}).get("application")
    optimization = next(iter((resources.get("optimization") or {}).values()), None)
    if not application or not optimization:
        return [], {}
    app = json.loads((REPO_ROOT / package / application).read_text(encoding="utf-8"))
    opt = json.loads((REPO_ROOT / package / optimization).read_text(encoding="utf-8"))
    features = {
        name: body
        for name, body in (app["spec"].get("features") or {}).items()
        if isinstance(body, dict)
    }
    return list(opt["spec"].get("criteria") or []), features


def _range_is_the_domain(criterion: dict, features: dict) -> bool:
    feature = criterion.get("feature")
    name = feature if isinstance(feature, str) else (feature or {}).get("id")
    normalize = criterion.get("normalize")
    normalize = normalize if isinstance(normalize, dict) else {}
    domain = (features.get(name) or {}).get("domain")
    domain = domain if isinstance(domain, dict) else {}
    if "min" not in normalize or "max" not in normalize:
        return True
    return normalize["min"] == domain.get("minimum") and normalize["max"] == domain.get("maximum")


def test_the_gate_is_the_golden_minus_placement(corpus: dict) -> None:
    """The exclusion list is recomputed, so it cannot quietly stop matching the tree."""
    packages = sorted(corpus["packages"])
    excluded = sorted(name for name in packages if _declares_placement(name))
    assert excluded == sorted(EXCLUDED), (
        "the packages declaring a Placement resource are no longer the ones section 11.2 "
        "names; the gate's exclusion list has to be re-decided, not re-sorted"
    )
    assert len(packages) - len(excluded) == GATE_SIZE
    assert GATE_SIZE + len(EXCLUDED) == corpus["packageCount"], (
        "the gate and its exclusions no longer add up to the golden's own count"
    )


def test_the_walk_and_the_golden_agree_on_one_name(corpus: dict) -> None:
    """Membership is the golden file; the walk's job is finding packages.

    The existing baseline test asserts the same equality for the toolchain's own walk,
    which excludes ``bim-toolchain`` wholesale. This one closes that hole: a second package
    added under ``bim-toolchain`` passes there and fails here.
    """
    walked = {
        Path(directory).relative_to(REPO_ROOT).as_posix()
        for directory in _load_tool("check_bim_corpus").package_directories(REPO_ROOT)
    }
    assert walked - set(corpus["packages"]) == {NOT_A_TARGET}
    assert not set(corpus["packages"]) - walked


def test_a_goal_can_override_the_criterion_range(corpus: dict) -> None:
    """Seven packages inside the gate need this field, and these are they."""
    offenders = []
    for package in sorted(corpus["packages"]):
        criteria, features = _criteria_and_features(package)
        if any(not _range_is_the_domain(item, features) for item in criteria if isinstance(item, dict)):
            offenders.append(package)
    assert len(offenders) == RANGE_OVERRIDE_PACKAGES
    inside = [name for name in offenders if name not in EXCLUDED]
    assert len(inside) == RANGE_OVERRIDE_INSIDE_THE_GATE, f"inside the gate: {inside}"
    assert GATE_SIZE - len(inside) == GATE_WITHOUT_RANGE_OVERRIDE

    goal = composition.Goal("security", normalize=composition.Normalize(1.0, 4.0))
    assert (goal.normalize.minimum, goal.normalize.maximum) == (1.0, 4.0)
    assert composition.Goal("cost").normalize is None


def test_the_digest_neutral_defaults_are_not_blockers() -> None:
    """Four container defaults a reader can mistake for a limit, counted over the walk.

    They are what the gate's "they share one reason" argument rests on: count the one
    unitless feature as a blocker and the exclusion list grows an eighth member that has
    nothing to do with Placement. The compiler supplies each of these, and none of them
    reaches the IR as a difference, so the emitter may write them explicitly or not.
    """
    walked = [Path(d) for d in _load_tool("check_bim_corpus").package_directories(REPO_ROOT)]
    counts = dict.fromkeys(("annotations", "direction", "unit", "open_domain"), 0)
    for directory in sorted(walked):
        manifest = json.loads((directory / "instance.json").read_text(encoding="utf-8"))
        counts["annotations"] += bool((manifest.get("metadata") or {}).get("annotations"))
        application = (manifest["spec"]["resources"].get("application") or {}).get("application")
        if not application:
            continue
        app = json.loads((directory / application).read_text(encoding="utf-8"))
        features = [
            body for body in (app["spec"].get("features") or {}).values() if isinstance(body, dict)
        ]
        counts["direction"] += any("direction" not in body for body in features)
        counts["unit"] += any("unit" not in body for body in features)
        counts["open_domain"] += any(
            (body.get("domain") if isinstance(body.get("domain"), dict) else {}).get(end) is None
            for body in features
            for end in ("minimum", "maximum")
        )
    assert counts == {"annotations": 78, "direction": 3, "unit": 1, "open_domain": 6}, (
        f"section 11.2's digest-neutral counts moved: {counts}"
    )


def test_a_criterion_never_names_anything_but_its_feature(corpus: dict) -> None:
    """Section 8 derives the criterion id from the property, and the corpus allows it.

    The id is required and visible in the IR, so this is the one derivation the emitter
    could not be left to guess.
    """
    named = 0
    for package in sorted(corpus["packages"]):
        criteria, _ = _criteria_and_features(package)
        for item in criteria:
            if not isinstance(item, dict):
                continue
            feature = item.get("feature")
            name = feature if isinstance(feature, str) else (feature or {}).get("id")
            named += item.get("id") != name
    assert named == 0, "a criterion names something other than its feature; section 8 needs rewriting"


def test_a_property_can_declare_its_scope() -> None:
    """Section 12 claimed this was inexpressible while the model had always typed it."""
    assert composition.Property(
        unit="USD/month",
        direction="minimize",
        aggregation=composition.TEMPLATES["cost"][1],
        domain=composition.Domain("real", 0.0, 100.0),
        scope="selectedCandidate",
    ).scope == "selectedCandidate"
    assert composition.Property(
        unit="ms",
        direction="minimize",
        aggregation=composition.TEMPLATES["latency"][1],
        domain=composition.Domain("real", 0.0, 1000.0),
    ).scope == "invocation"
