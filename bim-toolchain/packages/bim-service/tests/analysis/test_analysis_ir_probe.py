"""M4 / IR (analysis, ``docs/qa/analysis/BIM_B5_B8_M4_IR.md``): which order changes between a directory and its canonical ZIP.

``docs/qa/BIM_EQUIVALENCE.md`` measured that 64 of the 82 packages compile to another IR from ``to_zip()`` than from the
directory.  This module measures, on the same corpus, *what kind* of change that is, list by list, and what the
evaluator and a seeded draw do with it.  Nothing here changes ``bim-core`` or a golden.

The corpus is the repository's (``BIM_CORPUS_ROOT``, default the parent of ``bim-toolchain``).  Like the other corpus
tests it is skipped, with a reason, when it is absent, and fails instead when ``BIM_REQUIRE_CORPUS=1``.

``normalized`` below is the *reference* of the order proposed in the analysis: it sorts only the lists whose order
comes from the order of the members of a JSON object, by the identifier they carry.  It is not part of ``bim-core``.
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
from bim_core.compiler import ir_digest

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
    """Bindings chosen from the *sorted* eligibility, so the same ones are evaluated on both sides."""
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


def without_order(evaluation: dict[str, Any]) -> dict[str, Any]:
    out = dict(evaluation)
    if "violations" in out:
        out["violations"] = sorted(out["violations"], key=dumps)
    return out


def without_messages(evaluation: dict[str, Any]) -> dict[str, Any]:
    out = dict(evaluation)
    if "violations" in out:
        out["violations"] = [{k: v for k, v in item.items() if k != "message"} for item in out["violations"]]
    return out


# --- what changes ----------------------------------------------------------------------------------------


def test_64_of_the_82_packages_compile_to_another_ir_from_the_canonical_zip(corpus) -> None:
    assert len(corpus) == 82
    assert sum(record.direct_digest != record.canonical_digest for record in corpus) == 64


def test_the_changes_are_in_three_lists_and_the_source_map_only(corpus) -> None:
    sections: set[str] = set()
    counts = dict.fromkeys(("eligibility", "constraints", "placement", "demands", "transitions", "network", "capacityRules"), 0)
    for record in corpus:
        a, b = record.direct["spec"], record.canonical["spec"]
        sections |= {key for key in a if key != "sourceMap" and dumps(a[key]) != dumps(b.get(key))}
        counts["eligibility"] += a["eligibility"] != b["eligibility"]
        counts["constraints"] += a["constraints"] != b["constraints"]
        counts["placement"] += a["placement"] != b["placement"]
        for left, right in zip(a["placement"], b["placement"], strict=True):
            for name in ("demands", "transitions", "network", "capacityRules"):
                counts[name] += left.get(name) != right.get(name)
    assert sections == {"eligibility", "constraints", "placement"}
    assert counts == {
        "eligibility": 46, "constraints": 59, "placement": 7, "demands": 2, "transitions": 7, "network": 0, "capacityRules": 0,
    }


def test_every_changed_list_holds_the_same_items_in_another_order(corpus) -> None:
    for record in corpus:
        a, b = record.direct["spec"], record.canonical["spec"]
        assert {t: sorted(map(dumps, v)) for t, v in a["eligibility"].items()} == {
            t: sorted(map(dumps, v)) for t, v in b["eligibility"].items()
        }, record.name
        assert sorted(map(dumps, a["constraints"])) == sorted(map(dumps, b["constraints"])), record.name
        assert sorted(map(dumps, a["placement"])) == sorted(map(dumps, b["placement"])) or all(
            sorted(map(dumps, left["demands"])) == sorted(map(dumps, right["demands"]))
            and sorted(map(dumps, left["transitions"])) == sorted(map(dumps, right["transitions"]))
            and left["network"] == right["network"]
            for left, right in zip(a["placement"], b["placement"], strict=True)
        ), record.name


def test_sorting_the_object_derived_lists_gives_one_ir_for_both_forms(corpus) -> None:
    """The proposed order makes the two forms identical (source map apart) for all 82 packages."""
    assert [r.name for r in corpus if dumps(normalized(r.direct)) != dumps(normalized(r.canonical))] == []


def test_the_proposed_order_would_move_the_semantic_digest_of_exactly_these_packages(corpus) -> None:
    moved = [r.name for r in corpus if ir_digest(normalized(r.direct, keep_source_map=True)) != r.direct_digest]
    assert len(moved) == 64
    assert {r.name for r in corpus if r.direct_digest != r.canonical_digest} == set(moved)


class OpenDefect(AssertionError):
    """The one failure the ``xfail`` below accepts: any other error in a test is a broken test, not the defect."""


@pytest.mark.xfail(
    raises=OpenDefect,
    strict=True,
    reason=(
        "M4: the members of JSON objects are sorted by the canonical form and the compiler builds eligibility, "
        "constraints and placement by iterating them, so the directory and its canonical ZIP are two IRs for 64 of 82 "
        "packages. Closing it moves the semantic digest of those 64: a MAJOR change (docs/DIGESTS.md)."
    ),
)
def test_a_directory_and_its_canonical_zip_compile_to_the_same_ir(corpus) -> None:
    different = [r.name for r in corpus if r.direct_digest != r.canonical_digest]
    if different:
        raise OpenDefect(f"{len(different)} of {len(corpus)} packages compile to another IR from their canonical ZIP")


# --- what the order does to results ----------------------------------------------------------------------


def test_evaluations_of_the_same_binding_differ_only_in_violation_order_and_message_text(corpus) -> None:
    counts = dict.fromkeys(("exact", "order_only", "message_only", "order_and_message", "other"), 0)
    for record in corpus:
        bindings = sample_bindings(record.direct)
        for left, right in zip(evaluate_all(record.direct, bindings), evaluate_all(record.canonical, bindings), strict=True):
            if dumps(left) == dumps(right):
                counts["exact"] += 1
            elif dumps(without_order(left)) == dumps(without_order(right)):
                counts["order_only"] += 1
            elif dumps(without_messages(left)) == dumps(without_messages(right)):
                counts["message_only"] += 1
            elif dumps(without_messages(without_order(left))) == dumps(without_messages(without_order(right))):
                counts["order_and_message"] += 1
            else:
                counts["other"] += 1
    assert counts == {"exact": 313, "order_only": 164, "message_only": 9, "order_and_message": 6, "other": 0}, counts


def test_sorting_the_lists_never_changes_an_evaluation_beyond_violation_order(corpus) -> None:
    exact = order_only = 0
    for record in corpus:
        bindings = sample_bindings(record.direct)
        before = evaluate_all(record.direct, bindings)
        after = evaluate_all(normalized(record.direct, keep_source_map=True), bindings)
        for left, right in zip(before, after, strict=True):
            if dumps(left) == dumps(right):
                exact += 1
            else:
                assert dumps(without_order(left)) == dumps(without_order(right)), record.name
                order_only += 1
    assert (exact, order_only) == (322, 170)


def test_a_seeded_draw_from_the_eligibility_lists_depends_on_their_order(corpus) -> None:
    """What a seeded engine does (``eligible.get(random.nextInt(n))``) simulated with Python's generator."""

    def draw(document: dict[str, Any]) -> dict[str, tuple[str, str]]:
        rng = random.Random(SEED)
        eligibility = document["spec"]["eligibility"]
        return {task: key_ref(eligibility[task][rng.randrange(len(eligibility[task]))]) for task in sorted(eligibility)}

    changed_lists = [r for r in corpus if r.direct["spec"]["eligibility"] != r.canonical["spec"]["eligibility"]]
    other_draw = [r.name for r in changed_lists if draw(r.direct) != draw(r.canonical)]
    same_draw_after_sorting = [r.name for r in corpus if draw(normalized(r.direct)) != draw(normalized(r.canonical))]
    assert same_draw_after_sorting == []
    assert (len(changed_lists), len(other_draw)) == (46, 46), other_draw
