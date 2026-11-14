"""Phase F0 adds a language, and must move nothing that already exists.

The specification and the composition library are additive by design: no package is
checked in, no golden is regenerated, no corpus count changes. That intent is easy to
state and easy to break -- the obvious convenience, checking the guiding case in as a BIM
package so the fixtures are "real", would break four goldens and two CI jobs at once.

So this test pins the two things that would move first: the identity of the guiding case
in the live golden, and the corpus counts. It reads files and imports a tool; it needs
neither the compiler nor the vendored XSDs, so it runs anywhere.

A failure here is not necessarily a regression in this package. It means the corpus or
the toolchain moved, and the specification's pinned values need re-reading before anyone
trusts them again.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway import composition

#: The golden the phase F1 gate means, decided in review (specification section 11.1):
#: the live normalized one. The frozen baselines beside it record an older IR and
#: disagree with it for 64 of the 82 packages, so a compiler must reproduce THIS one --
#: implementing against a frozen baseline is the mistake that looks like a compiler bug
#: and never passes. Only its informative ``toolchain`` members are ever refreshed, and
#: ``test_bim_baseline.py`` pins the gateway's byte copy of this very file, so naming it
#: here records what the pipeline already enforces instead of adding a second target.
NORMALIZED_CORPUS = REPO_ROOT / "openbinding-gateway" / "tests" / "golden" / "bim_baseline" / "corpus.json"

#: The guiding case, version 1, as the live golden records it.
FMS_PATH = "examples/demo/13_fms"
FMS_SEMANTIC_DIGEST = "sha256-710017a5f090fdbfabf965e77a3ce683dc9ccecb846c0a7036161f36125b55a7"
FMS_APPLICATION_SECTION = "38520fbe1a031240"
FMS_BINDING_SPACE = {"candidatesPerServiceTask": [2, 2, 2, 2, 2], "cardinality": "32"}
FMS_TASKS = {"service": 5, "total": 6}
FMS_CANDIDATES = 10

#: The guard and the corpus check walk the whole repository and see 82, the packages of the
#: golden (83 while bim-core's example package lived in this repository). Every one of these
#: is asserted somewhere else too, which is exactly why adding a package is expensive.
WALKED_PACKAGES = 82
GOLDEN_PACKAGES = 82

#: The guiding case aggregates every feature's exclusive with ``weightedSum``, including
#: ``availability`` and ``reliability``, where ``docs/FEATURES.md`` -- and so the template
#: the Studio ships -- gives the routing-weighted product. ``cost`` says it with the
#: container's string shorthand, which expands to the same operator.
FMS_EXCLUSIVE = {
    "cost": "sum",
    "execution_time": "weightedSum",
    "availability": "weightedSum",
    "reliability": "weightedSum",
    "security": "weightedSum",
}
#: The two templates that therefore need an explicit override to write version 1.
OVERRIDDEN = ("availability", "reliability")

#: What the local branch of the guiding case asserts, as the live golden records it:
#: ``cost`` 2210.0 is ``220 + 500 + 300 + (0.8 * 0 + 0.2 * 1200) + 950``, four fifths of
#: that branch pinned at zero, and ``security`` 4.0 comes from another task because the
#: branch contributes the neutral 5.0, the top of its domain, and never binds the outer
#: ``min``. Specification section 4.1 reasons on these two numbers.
FMS_COST_MINIMUM = 2210.0
FMS_SECURITY = {"min": 4.0, "max": 4.0}


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


def test_the_guiding_case_keeps_its_identity(corpus: dict) -> None:
    entry = corpus["packages"][FMS_PATH]
    assert entry["semanticDigest"] == FMS_SEMANTIC_DIGEST
    assert entry["sectionDigests"]["application"] == FMS_APPLICATION_SECTION
    assert entry["tasks"] == FMS_TASKS
    assert entry["candidates"] == FMS_CANDIDATES
    for key, value in FMS_BINDING_SPACE.items():
        assert entry["bindingSpace"][key] == value


def test_the_guiding_case_still_has_one_probabilistic_choice() -> None:
    """The exclusive of the guiding case is what the language's branch rule is built on.

    Its two branch ids are the join key between the application and the routing overlay,
    and they are visible in the IR digest, so the composition written in phase F1 has to
    reproduce them exactly.
    """
    routing = json.loads((REPO_ROOT / FMS_PATH / "routing.json").read_text(encoding="utf-8"))
    entries = routing["spec"]["entries"]
    assert [entry["probability"] for entry in entries] == [0.8, 0.2]
    assert [entry["target"]["id"] for entry in entries] == [
        "node_routing_choice_branch_1",
        "node_routing_choice_branch_2",
    ]
    assert all(entry["target"]["resource"] == "application" for entry in entries)


def test_the_guiding_case_models_its_in_house_solver_as_a_local_task(corpus: dict) -> None:
    """The rule of specification section 4.1 reads this package, so the package must keep
    saying what the rule says it says.

    A local task contributes each property's neutral under every operator, not only under
    a sequence, and this one is the flow of the 0.8 branch of a weighted exclusive. So the
    package asserts that the in-house classical path is free, instantaneous and maximally
    secure, four times out of five. The two recorded numbers pinned here are the evidence
    the specification argues from; if the package stops saying it, that argument needs
    rewriting before anyone trusts it.
    """
    tasks = json.loads((REPO_ROOT / FMS_PATH / "application.json").read_text(encoding="utf-8"))["spec"]["tasks"]
    local = sorted(
        task_id
        for task_id, body in tasks.items()
        if not isinstance(body, str) and body.get("kind") == "local"
    )
    assert local == ["node_classic_routing"]
    assert len(tasks) - len(local) == FMS_TASKS["service"]

    features = corpus["packages"][FMS_PATH]["evaluation"]["summary"]["features"]
    assert features["cost"]["min"] == FMS_COST_MINIMUM
    assert features["security"] == FMS_SECURITY


def test_the_guiding_case_needs_a_template_override() -> None:
    """Version 1 cannot be written with the bare templates, and this is why.

    The mismatch is invisible in every recorded number -- the two operators agree to six
    decimals at this package's values -- so without this test it would surface in phase F1
    as a digest that does not match, with nothing pointing at the cause.
    """
    features = json.loads((REPO_ROOT / FMS_PATH / "application.json").read_text(encoding="utf-8"))["spec"]["features"]
    assert set(features) == set(FMS_EXCLUSIVE)
    for name, expected in FMS_EXCLUSIVE.items():
        aggregation = features[name]["aggregation"]
        found = aggregation if isinstance(aggregation, str) else aggregation["exclusive"]
        assert found == expected, f"{name} aggregates its exclusive with {found!r}, not {expected!r}"

    for name in OVERRIDDEN:
        _, policy = composition.TEMPLATES[name]
        assert policy.exclusive == "weightedProduct", (
            f"the {name} template no longer differs from the guiding case; specification "
            "section 3.1 explains why the override is required and would need rewriting"
        )


def test_the_corpus_counts_did_not_move(corpus: dict) -> None:
    assert corpus["packageCount"] == GOLDEN_PACKAGES
    walked = _load_tool("check_bim_corpus").package_directories(REPO_ROOT)
    assert len(walked) == WALKED_PACKAGES, (
        f"the walk found {len(walked)} packages, not {WALKED_PACKAGES}; adding one to the tree "
        "breaks the goldens and the corpus jobs"
    )
    assert _load_tool("check_bim_guard").EXPECTED_PACKAGES == WALKED_PACKAGES


def test_no_composition_source_is_a_package_entry() -> None:
    """Composition sources live outside packages, and the compiler enforces it.

    Any file inside a package directory that ``instance.json`` does not declare is
    refused with ``undeclared_resource``, and the manifest's path pattern admits only
    JSON, BPMN and XML. A ``.c2y.yaml`` dropped into a package for convenience would
    break every compile of it.
    """
    strays = sorted(
        path.relative_to(REPO_ROOT)
        for directory in _load_tool("check_bim_corpus").package_directories(REPO_ROOT)
        for path in Path(directory).rglob("*.c2y.yaml")
    )
    assert not strays, f"composition sources inside packages: {strays}"
