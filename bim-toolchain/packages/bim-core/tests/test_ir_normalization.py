"""The canonical order of the IR and the number model, on small inputs (``docs/qa/IR_NORMALIZATION.md``).

* ``integral_numbers``: a parsed JSON document reads every integral number as an integer, as the canonical form does.
* ``decimal_string``: the text of any integer, whatever ``sys.get_int_max_str_digits()`` says.
* ``has()``: asks for presence only (was a strict ``xfail`` for an interval slot).
* The five ways to write one package (``synthetic_packages``) give one IR, and neighbourhood and re-evaluation, which
  work by identifier, answer alike.
* Invalid inputs: shuffling the members of the JSON objects of a package that does not compile gives the same
  diagnostics (code, resource and location), the order in which they are listed aside.
"""

from __future__ import annotations

import json
import sys

import pytest
from core_support import require_corpus_path
from synthetic_packages import VARIANTS, files, write

from bim_core import (
    CompileError,
    InstancePackage,
    analyze_neighborhood,
    canonical_json,
    compile_instance,
    load_package,
    reevaluate_result,
)
from bim_core.canonical import decimal_string, integral_numbers
from bim_core.expressions import _evaluate

# --- integral_numbers -------------------------------------------------------------------------------------------------


def test_an_integral_float_is_read_as_an_integer() -> None:
    document = {"a": 6.0, "b": [1.0, {"c": -0.0}], "d": 2.5, "e": True, "f": "6.0", "g": None, "h": 1e300, "i": 12}
    result = integral_numbers(document)

    assert result is document
    assert document == {"a": 6, "b": [1, {"c": 0}], "d": 2.5, "e": True, "f": "6.0", "g": None, "h": 1e300, "i": 12}
    assert type(document["a"]) is int and type(document["b"][1]["c"]) is int
    assert type(document["d"]) is float and type(document["h"]) is float and document["e"] is True


@pytest.mark.parametrize(
    ("value", "integral"),
    [(9007199254740991.0, True), (9007199254740992.0, False), (-9007199254740991.0, True), (1e21, False), (1e-7, False)],
)
def test_only_floats_that_canonical_json_carries_as_integers_are_converted(value: float, integral: bool) -> None:
    assert type(integral_numbers({"x": value})["x"]) is (int if integral else float)


def test_a_float_read_from_canonical_json_equals_the_one_read_from_the_original() -> None:
    """The point of the conversion: the document as written and its canonical form parse to the same Python value."""
    written = json.loads('{"max": 6.0, "min": 0.50, "big": 1e3, "z": -0.0, "n": [2.0, 3]}')
    canonical = json.loads(canonical_json(written))

    # ``json.dumps`` tells 6 from 6.0, which ``==`` does not.
    assert json.dumps(integral_numbers(written), sort_keys=True) == json.dumps(integral_numbers(canonical), sort_keys=True)
    assert json.dumps(written, sort_keys=True) == '{"big": 1000, "max": 6, "min": 0.5, "n": [2, 3], "z": 0}'


def test_the_walk_is_not_limited_by_the_recursion_limit() -> None:
    node: dict = {"leaf": 2.0}
    for _ in range(sys.getrecursionlimit() * 2):
        node = {"child": [node]}
    integral_numbers(node)
    while "child" in node:
        node = node["child"][0]
    assert node == {"leaf": 2} and type(node["leaf"]) is int


def test_a_scalar_is_converted_and_other_scalars_returned() -> None:
    assert type(integral_numbers(3.0)) is int
    assert integral_numbers("3.0") == "3.0" and integral_numbers(None) is None


# --- decimal_string ---------------------------------------------------------------------------------------------------


def unlimited(value: int) -> str:
    previous = sys.get_int_max_str_digits()
    sys.set_int_max_str_digits(0)
    try:
        return str(value)
    finally:
        sys.set_int_max_str_digits(previous)


@pytest.mark.parametrize(
    "value",
    [
        # explicit ids: pytest would call str() on a 4516-digit integer to name the case, and that is what fails
        pytest.param(value, id=name)
        for name, value in {
            "0": 0, "1": 1, "9": 9, "10": 10, "999": 999, "-5": -5,
            "10**499": 10**499, "10**500-1": 10**500 - 1, "10**500": 10**500, "10**500+1": 10**500 + 1,
            "10**1000": 10**1000, "10**1000-1": 10**1000 - 1, "7**5000": 7**5000,
            "2**15000": 2**15000, "-(2**15000)": -(2**15000),
        }.items()
    ],
)  # fmt: skip
def test_decimal_string_is_the_decimal_text_of_any_integer(value: int) -> None:
    assert decimal_string(value) == unlimited(value)


def test_decimal_string_does_not_depend_on_the_interpreter_limit() -> None:
    previous = sys.get_int_max_str_digits()
    sys.set_int_max_str_digits(640)  # the smallest limit CPython accepts
    try:
        with pytest.raises(ValueError, match="digits"):
            str(10**700)
        assert decimal_string(10**700 + 1) == "1" + "0" * 699 + "1"
        assert len(decimal_string(3**20000)) == 9543
    finally:
        sys.set_int_max_str_digits(previous)


# --- has() -------------------------------------------------------------------------------------------------------------


def has(*segments: str) -> dict:
    return {"kind": "call", "name": "has", "args": [{"kind": "path", "segments": list(segments)}]}


class Unreadable(dict):
    """A mapping that has a member but refuses to give its value (the interval slot of ``_TaskFeatures``)."""

    def __getitem__(self, key):
        raise ValueError("interval")


def test_has_is_presence_only() -> None:
    context = {"a": {"b": 1, "c": None}, "s": "text"}

    assert _evaluate(has("a", "b"), context) is True
    assert _evaluate(has("a", "c"), context) is True  # present although null
    assert _evaluate(has("a", "z"), context) is False
    assert _evaluate(has("z"), context) is False
    assert _evaluate(has("s", "x"), context) is False  # a string has no members
    assert _evaluate(has("a", "b", "x"), context) is False  # a number has no members


def test_has_does_not_read_the_value_of_the_last_segment() -> None:
    context = {"features": Unreadable(latency=1)}

    assert _evaluate(has("features", "latency"), context) is True
    assert _evaluate(has("features", "missing"), context) is False


# --- one package, written five ways -------------------------------------------------------------------------------------

NAMES = sorted(VARIANTS)


@pytest.fixture(scope="module")
def problems(tmp_path_factory):
    return {name: compile_instance(load_package(write(tmp_path_factory.mktemp(name), name))) for name in NAMES}


BINDING = {"t1": {"resource": "cat-a", "id": "c2"}, "t2": {"resource": "cat-b", "id": "c1"}}


def test_neighbourhood_is_the_same_for_every_way_of_writing_the_package(problems) -> None:
    results = {name: canonical_json(analyze_neighborhood(problem, BINDING, seconds=60.0)) for name, problem in problems.items()}

    assert len(set(results.values())) == 1
    moves = analyze_neighborhood(problems["ordered"], BINDING, seconds=60.0)["moves"]
    assert [(move["task"], move["to"]["resource"], move["to"]["id"]) for move in moves] == [
        ("t1", "cat-a", "c1"), ("t1", "cat-b", "c1"), ("t1", "cat-b", "c2"),
        ("t2", "cat-a", "c1"), ("t2", "cat-a", "c2"), ("t2", "cat-b", "c2"),
    ]  # fmt: skip


def test_reevaluation_is_the_same_for_every_way_of_writing_the_package(problems) -> None:
    answer = {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": BINDING}}]}
    results = {name: canonical_json(reevaluate_result(problem, answer)) for name, problem in problems.items()}

    assert len(set(results.values())) == 1


def test_a_binding_names_its_candidates_it_does_not_count_them(problems) -> None:
    """The same binding is valid and evaluates alike whatever the position of its candidates in the IR."""
    problem = problems["unordered-catalogs"]
    outcomes = {canonical_json(problem.evaluate(binding)) for binding in [BINDING, dict(reversed(list(BINDING.items())))]}

    assert len(outcomes) == 1
    assert problem.validate_binding(BINDING) == BINDING


# --- numbers ----------------------------------------------------------------------------------------------------------


def package_with(feature_values: dict[str, object]) -> InstancePackage:
    contents = files("ordered")
    catalog = json.loads(contents["catalog-a.json"])
    catalog["spec"]["candidates"]["c1"]["features"].update(feature_values)
    contents["catalog-a.json"] = json.dumps(catalog, indent=2).encode("utf-8")
    return InstancePackage(contents)


def test_a_number_written_as_a_float_or_as_an_integer_is_one_number_in_the_ir() -> None:
    as_float, as_integer = package_with({"latency": 10.0, "cost": 5.0}), package_with({"latency": 10, "cost": 5})
    left, right = compile_instance(as_float), compile_instance(as_integer)

    assert b"10.0" in as_float.files["catalog-a.json"] and b"10.0" not in as_integer.files["catalog-a.json"]
    assert left.digest == right.digest
    features = left.document["spec"]["candidates"]["cat-a"]["candidates"]["c1"]["features"]
    assert features == {"latency": 10, "cost": 5} and all(type(value) is int for value in features.values())
    assert as_float.package_digest == as_integer.package_digest
    assert compile_instance(load_package(as_float.to_zip())).digest == left.digest


# --- invalid inputs ---------------------------------------------------------------------------------------------------


def diagnostics_of(baseline_tool, files_: dict[str, bytes]) -> object:
    """How compiling ``files_`` ends: the exception, and for a CompileError its diagnostics as a sorted list."""
    try:
        compile_instance(InstancePackage(dict(files_)))
    except CompileError as exc:
        return ("CompileError", sorted(json.dumps(baseline_tool._diagnostic(item), sort_keys=True) for item in exc.diagnostics))
    except Exception as exc:  # any other end must be the same, too
        return (type(exc).__name__, str(exc))
    return ("ok", None)


def test_shuffled_invalid_packages_give_the_diagnostics_of_the_original(baseline_tool) -> None:
    base = dict(load_package(require_corpus_path("examples/demo/01_simple_seq")).files)
    cases = baseline_tool.compile_cases(base)
    assert len(cases) >= 20
    differing = []
    outcomes = set()
    for name, (_, build) in cases.items():
        original = build()
        reference = diagnostics_of(baseline_tool, original)
        outcomes.add(reference[0])
        for seed in baseline_tool.PERMUTATION_SEEDS:
            if diagnostics_of(baseline_tool, baseline_tool.permute_members(original, seed)) != reference:
                differing.append((name, seed))
    assert differing == []
    assert {"CompileError", "ok"} <= outcomes
