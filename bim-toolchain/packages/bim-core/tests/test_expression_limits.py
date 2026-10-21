"""Integer results of expressions are bounded: a huge power is a controlled error, never a hang.

``Limits.max_integer_bits`` (default 1_000_000) caps the size of every integer an expression produces
through ``pow``, ``mul``, ``product``, ``weightedSum`` and ``weightedProduct``.  Expressions with
reasonable results behave exactly as before.
"""

from __future__ import annotations

import json
import time

import pytest

from bim_core import (
    CompileError,
    EvaluationError,
    ExpressionError,
    Limits,
    compile_instance,
    configure,
    default_limits,
)
from bim_core.evaluator import evaluate_violations
from bim_core.expressions import compile_expression

from _language import BINDING, base_package

LIMIT_CODE = "integer_limit"
#: Far above the default limit (1_000_000 bits) yet cheap to compute: it shows the rule without a hang.
OVER = 5_000_000
#: Time budget for refusing even the genuinely hostile inputs.
BUDGET_SECONDS = 5.0
#: About 634 000 bits: accepted alone, refused once multiplied by itself a few times.
BIG = 3**400_000


@pytest.fixture
def restore_default_limits():
    previous = default_limits()
    yield
    configure(previous)


def _evaluate(source, context=None):
    return compile_expression(source).evaluate(context or {})


def _assert_limit(source, context=None) -> None:
    started = time.monotonic()
    with pytest.raises(ExpressionError) as caught:
        _evaluate(source, context)
    assert caught.value.code == LIMIT_CODE
    assert time.monotonic() - started < BUDGET_SECONDS


def test_the_default_limit_is_one_million_bits() -> None:
    assert Limits().max_integer_bits == 1_000_000
    assert Limits.from_env({"BIM_MAX_INTEGER_BITS": "64"}).max_integer_bits == 64


@pytest.mark.parametrize("source", [f"3 ** {OVER}", f"(0 - 3) ** {OVER}", f"3 ** {OVER} + 1", f"- (3 ** {OVER})"])
def test_a_power_above_the_limit_is_refused_when_evaluated(source: str) -> None:
    _assert_limit(source)


def test_the_json_form_is_bounded_like_the_cel_form() -> None:
    for op in ("pow", "power"):
        expression = compile_expression({"op": op, "left": 3, "right": OVER}, expected_type="number")
        with pytest.raises(ExpressionError) as caught:
            expression.evaluate({})
        assert caught.value.code == LIMIT_CODE


@pytest.mark.parametrize(
    "source",
    ["10 ** (10 ** 10)", "10 ** 10 ** 10", "7 ** (2 ** 62)", "(10 ** 10) ** (10 ** 10)", "(3 ** 400000) ** 400000"],
)
def test_the_hostile_powers_are_refused_in_bounded_time(source: str) -> None:
    _assert_limit(source)


def test_weighted_product_with_a_huge_integer_weight_is_refused() -> None:
    _assert_limit("weightedProduct(values, weights)", {"values": [3], "weights": [OVER]})
    _assert_limit("weightedProduct(values, weights)", {"values": [10, 10], "weights": [10**10, 1]})


def test_weighted_product_products_that_grow_past_the_limit_are_refused() -> None:
    _assert_limit("weightedProduct(values, weights)", {"values": [BIG] * 6, "weights": [1] * 6})


def test_product_and_multiplication_are_bounded() -> None:
    assert _evaluate("product(values)", {"values": [BIG]}) == BIG
    _assert_limit("product(values)", {"values": [BIG] * 6})
    _assert_limit("count * count", {"count": BIG * BIG})
    assert _evaluate("count * 2", {"count": BIG}) == BIG * 2


def test_weighted_sum_products_are_bounded() -> None:
    _assert_limit("weightedSum(values, weights)", {"values": [BIG * BIG], "weights": [BIG * BIG]})


def test_there_is_no_shift_operator_to_reach_the_limit_with() -> None:
    for source in (f"1 << {OVER}", "1 << (10 ** 10)", f"2 >> {OVER}", f"1 | {OVER}"):
        with pytest.raises(ExpressionError, match="unsupported construct"):
            compile_expression(source)


def test_the_limit_is_exact_for_powers_of_two() -> None:
    assert _evaluate("2 ** 999999") == 1 << 999_999  # exactly 1_000_000 bits
    _assert_limit("2 ** 1000000")  # 1_000_001 bits


def test_a_configured_limit_applies(restore_default_limits) -> None:
    configure(Limits(max_integer_bits=64))
    assert _evaluate("2 ** 63") == 2**63
    _assert_limit("2 ** 64")
    assert _evaluate("1 ** 1000000000") == 1


@pytest.mark.parametrize(
    ("source", "context", "expected"),
    [
        ("2 ** 10", {}, 1024),
        ("10 ** 20", {}, 10**20),
        ("3 ** 1000", {}, 3**1000),
        ("2 ** 62 * 2 ** 62", {}, 2**124),
        ("(0 - 1) ** 1000000001", {}, -1),
        ("1 ** 10000000000", {}, 1),
        ("0 ** 10000000000", {}, 0),
        ("2 ** (0 - 5000000)", {}, 0.0),
        ("2.5 ** 3", {}, 15.625),
        ("2 ** 0.5", {}, 2**0.5),
        ("7 / 2", {}, 3.5),
        ("product(values)", {"values": [1, 2, 3, 4]}, 24),
        ("weightedProduct(values, weights)", {"values": [2, 3, 4], "weights": [1, 2, 1]}, 72),
        ("weightedSum(values, weights)", {"values": [2, 3, 4], "weights": [1, 2, 1]}, 12),
    ],
)
def test_reasonable_expressions_are_unchanged(source: str, context: dict, expected) -> None:
    result = _evaluate(source, context)
    assert result == expected
    assert type(result) is type(expected)


def test_float_overflow_in_calls_is_a_controlled_error() -> None:
    with pytest.raises(ExpressionError):
        _evaluate("weightedProduct(values, weights)", {"values": [10.0], "weights": [1e10]})
    with pytest.raises(ExpressionError):
        _evaluate("product(values)", {"values": [1e308, 1e308]})


def _package_with_penalty(penalty, assertion="tasks.t1.provider.resource == 'never'"):
    value = base_package()
    soft = json.loads(value.files["soft.json"])
    constraint = soft["spec"]["constraints"]["limit"]
    constraint["penalty"] = penalty
    constraint["assert"] = assertion
    value.files["soft.json"] = json.dumps(soft).encode()
    return value


@pytest.mark.parametrize(
    "penalty",
    [
        f"3 ** {OVER}",
        "10 ** (10 ** 10)",
        {"op": "pow", "left": 10, "right": {"literal": 10**10}},
    ],
)
def test_a_constant_soft_penalty_above_the_limit_is_a_compile_diagnostic(penalty) -> None:
    started = time.monotonic()
    with pytest.raises(CompileError) as caught:
        compile_instance(_package_with_penalty(penalty))
    assert time.monotonic() - started < BUDGET_SECONDS
    penalty = [item for item in caught.value.diagnostics if item.code == "soft_penalty"]
    assert len(penalty) == 1
    assert "integer result exceeds the limit" in penalty[0].message


def test_a_reasonable_constant_soft_penalty_still_compiles() -> None:
    problem = compile_instance(_package_with_penalty("2 ** 10"))
    assert problem.evaluate(BINDING)["objectives"]["penalty"] == 1024


def test_a_huge_assertion_fails_evaluation_with_an_evaluation_error() -> None:
    problem = compile_instance(_package_with_penalty(2, assertion=f"3 ** {OVER} > 1"))
    with pytest.raises(EvaluationError) as caught:
        evaluate_violations(problem, BINDING)
    assert caught.value.code == "evaluation_failed"
