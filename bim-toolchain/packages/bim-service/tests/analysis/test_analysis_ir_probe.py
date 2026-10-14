"""M4 / IR (``docs/qa/analysis/BIM_B5_B8_M4_IR.md``, ``docs/qa/IR_NORMALIZATION.md``): a directory and its canonical ZIP.

``docs/qa/BIM_EQUIVALENCE.md`` measured that 64 of the 82 packages compiled to another IR from ``to_zip()`` than from the
directory, because the compiler listed eligibility, constraints and placement in the order the JSON members were written
and the canonical form sorts them.  This module began as the measurement of *what kind* of change that was, list by list,
and what the evaluator and a seeded draw did with it (strict ``xfail`` for the defect).  The compiler now lists those sets
in one canonical order, and the same corpus shows the defect closed:

* the IR of the directory and of its canonical ZIP are the same document, for all 82 packages;
* ``normalized`` below, the *reference* of the order (sort the lists derived from JSON object members by their identifier),
  leaves the IR of every package as it is: the compiler's order is that one;
* the same bindings evaluate to the same evaluations, order and text of the violations included (492 evaluations);
* a seeded draw from the eligibility lists, as the engines make, picks the same binding from either form.

The corpus is the repository's (``BIM_CORPUS_ROOT``, default the parent of ``bim-toolchain``).  Like the other corpus
tests it is skipped, with a reason, when it is absent, and fails instead when ``BIM_REQUIRE_CORPUS=1``.  The comparison
with the previous toolchain, by identifier, is in ``packages/bim-core/tests/test_ir_previous_baseline.py``.
"""

from __future__ import annotations

import os
import random
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

import pytest
from service_support import TOOLS_DIR  # noqa: F401  (puts ``tools/`` on sys.path)

import baseline_core as tool
from bim_core import BindingProblem, compile_instance, load_package
from bim_core.canonical import canonical_json

SEED = 20261012
BINDINGS_PER_PACKAGE = 6


@dataclass
class Record:
    name: str
    direct: dict[str, Any]
    canonical: dict[str, Any]
    direct_digest: str
    canonical_digest: str


@pytest.fixture(scope="module")
def corpus() -> list[Record]:
    root = tool.default_corpus_root()
    if not tool.corpus_available(root):
        message = f"no BIM corpus under {root} (set BIM_CORPUS_ROOT)"
        if os.environ.get("BIM_REQUIRE_CORPUS") == "1":
            pytest.fail(message)
        pytest.skip(message)
    records = []
    for directory in tool.package_directories(root):
        package = load_package(directory)
        direct = compile_instance(package)
        portable = compile_instance(load_package(package.to_zip()))
        records.append(
            Record(directory.relative_to(root).as_posix(), direct.document, portable.document, direct.digest, portable.digest)
        )
    return records


def key_ref(ref: dict[str, str]) -> tuple[str, str]:
    return ref["resource"], ref["id"]


def dumps(value: Any) -> bytes:
    return canonical_json(value)


def normalized(document: dict[str, Any], *, keep_source_map: bool = False) -> dict[str, Any]:
    """Reference order: sort the lists derived from JSON object members by their identifier.

    ``eligibility[task]`` by candidate, ``constraints`` by ``ref``, ``placement`` by ``resource`` and, inside a model,
    ``demands`` by candidate and ``transitions`` by ``ref``.  Arrays the author writes as arrays (``network``,
    ``capacityRules``, ``routing``...) keep their order, as canonicalisation already keeps them.
    """
    out = deepcopy(document)
    spec = out["spec"]
    if not keep_source_map:
        spec.pop("sourceMap", None)
    spec["eligibility"] = {task: sorted(items, key=key_ref) for task, items in spec["eligibility"].items()}
    spec["constraints"] = sorted(spec["constraints"], key=lambda item: key_ref(item["ref"]))
    models = []
    for model in spec["placement"]:
        model = dict(model)
        model["demands"] = sorted(model["demands"], key=lambda item: key_ref(item["candidate"]))
        model["transitions"] = sorted(model["transitions"], key=lambda item: key_ref(item["ref"]))
        models.append(model)
    spec["placement"] = sorted(models, key=lambda item: item["resource"])
    return out


def sample_bindings(document: dict[str, Any]) -> list[dict[str, dict[str, str]]]:
    """Bindings chosen from the eligibility lists sorted by identifier, so the same ones are evaluated on both sides."""
    eligibility = document["spec"]["eligibility"]
    tasks = sorted(eligibility)
    ordered = {task: sorted(eligibility[task], key=key_ref) for task in tasks}
    return [
        {task: dict(ordered[task][(k * 7 + i) % len(ordered[task])]) for i, task in enumerate(tasks)}
        for k in range(BINDINGS_PER_PACKAGE)
    ]


def evaluate_all(document: dict[str, Any], bindings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    problem = BindingProblem.from_document(document)
    outcomes = []
    for binding in bindings:
        try:
            outcomes.append(problem.evaluate(binding))
        except (ValueError, ArithmeticError) as exc:
            outcomes.append({"error": f"{type(exc).__name__}: {exc}"})
    return outcomes


# --- the defect, closed ----------------------------------------------------------------------------------


def test_a_directory_and_its_canonical_zip_compile_to_the_same_ir(corpus) -> None:
    """Was a strict ``xfail`` (``OpenDefect``): 64 of 82 packages compiled to another IR from their canonical ZIP."""
    assert len(corpus) == 82
    assert [r.name for r in corpus if r.direct_digest != r.canonical_digest] == []
    assert [r.name for r in corpus if dumps(r.direct) != dumps(r.canonical)] == []


def test_the_ir_of_every_package_is_in_the_reference_order(corpus) -> None:
    """The documented order (the reference above) is the one the compiler produces: sorting changes nothing."""
    assert [r.name for r in corpus if dumps(normalized(r.direct, keep_source_map=True)) != dumps(r.direct)] == []
    assert [r.name for r in corpus if dumps(normalized(r.canonical, keep_source_map=True)) != dumps(r.canonical)] == []


# --- what the order does to results ------------------------------------------------------------------------


def test_evaluations_of_the_same_binding_are_identical_in_both_forms(corpus) -> None:
    """492 evaluations (6 bindings of each of the 82 packages): the same values, the same violations in the same order,
    the same text. Before the normalisation 313 were identical, 164 differed in the order of the violations, 9 in the text
    of a message (``6.0`` against ``6``) and 6 in both."""
    exact = 0
    for record in corpus:
        bindings = sample_bindings(record.direct)
        for left, right in zip(evaluate_all(record.direct, bindings), evaluate_all(record.canonical, bindings), strict=True):
            assert dumps(left) == dumps(right), record.name
            exact += 1
    assert exact == 82 * BINDINGS_PER_PACKAGE == 492


def test_a_seeded_draw_from_the_eligibility_lists_picks_the_same_binding_from_both_forms(corpus) -> None:
    """What a seeded engine does (``eligible.get(random.nextInt(n))``) simulated with Python's generator. Before the
    normalisation the draw differed for the 46 packages whose eligibility lists changed with the form."""

    def draw(document: dict[str, Any]) -> dict[str, tuple[str, str]]:
        rng = random.Random(SEED)
        eligibility = document["spec"]["eligibility"]
        return {task: key_ref(eligibility[task][rng.randrange(len(eligibility[task]))]) for task in sorted(eligibility)}

    assert [r.name for r in corpus if draw(r.direct) != draw(r.canonical)] == []
