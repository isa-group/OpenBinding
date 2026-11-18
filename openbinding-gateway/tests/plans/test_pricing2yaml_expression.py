"""The safe price-expression evaluator (``pricing2yaml.expression``)."""

from __future__ import annotations

import pytest

from openbinding_gateway.modules.plans.domain.pricing2yaml.expression import dependencies, evaluate


def value(source: str, **variables):
    result = evaluate(source, variables)
    assert result.error is None, result.error
    return result.value


def error(source: str, **variables) -> str:
    result = evaluate(source, variables)
    assert result.value is None and result.error is not None
    return result.error.kind


def test_precedence_and_unary_minus() -> None:
    assert value("1 + 2 * 3") == 7
    assert value("(1 + 2) * 3") == 9
    assert value("10 - -2") == 12
    assert value("7 % 4 + 10 / 4") == 5.5
    assert value("#a > 2 && #b ? 10 : 20", a=3, b=True) == 10
    assert value("!#a ? 1 : 2", a=0) == 1
    assert value("#a || 4", a=0) == 4


def test_math_and_string() -> None:
    assert value("Math.round(2.5)") == 3
    assert value("Math.round(-2.5) + 3") == 1
    assert value("Math.floor(2.7) + Math.ceil(0.2) + Math.trunc(1.9) + Math.abs(-2)") == 6
    assert value("Math.min(3, 1, 2) + Math.max(3, 1, 2)") == 4
    assert value("#m[String(5000)]", m={"5000": 7}) == 7
    assert value("#m[String(#tier)]", m={50000: 19.95, 100000: 34.95}, tier=50000) == pytest.approx(19.95)
    assert value("'a'.concat('b', 1).length") == 3
    assert value("String(#x) === '5000' ? 1 : 0", x=5000) == 1
    assert value("String(0.5) === '0.5' ? 1 : 0") == 1


def test_member_and_index_access() -> None:
    assert value("#o.a.b + #l[1]", o={"a": {"b": 2}}, l=[1, 5]) == 7
    assert value("#l.length", l=[1, 2, 3]) == 3


@pytest.mark.parametrize(
    "source",
    ["#o.constructor", "#o['__proto__']", "#o.__class__", "#o['constructor']"],
)
def test_forbidden_properties(source: str) -> None:
    assert error(source, o={"a": 1}) == "not_allowed"


@pytest.mark.parametrize("source", ["eval('1')", "foo", "Math.pow(2, 3)", "#s.toUpperCase()", "(1)(2)"])
def test_calls_and_identifiers_outside_the_whitelist(source: str) -> None:
    assert error(source, s="a") == "not_allowed"


def test_size_limits() -> None:
    assert error("1+" * 500 + "1") in {"too_long", "too_complex"}
    assert error("1" + " " * 1000) == "too_long"
    assert error("!" * 41 + "1") == "too_complex"
    assert error("[" * 41 + "1" + "]" * 41) == "too_complex"
    assert value("(" * 41 + "1" + ")" * 41) == 1  # parentheses add no node
    assert error("+".join(["1"] * 251)) == "too_complex"  # 501 tokens
    assert value("+".join(["1"] * 20)) == 20


def test_a_concat_blow_up_is_too_large() -> None:
    assert error("#s + #s + #s", s="x" * 2000) == "too_large"
    assert error("#s.concat(#s, #s)", s="x" * 2000) == "too_large"
    assert error("#s", s="x" * 5000) == "too_large"


def test_an_array_over_1000_items_is_too_large() -> None:
    assert error("#l[0]", l=list(range(1001))) == "too_large"


def test_a_result_must_be_a_finite_non_negative_number() -> None:
    assert error("-1") == "not_number"
    assert error("'a'") == "not_number"
    assert error("1 / 0") == "not_number"
    assert error("#missing") == "undefined_variable"
    assert error("1 +") == "syntax"


def test_dependencies() -> None:
    assert dependencies("#a[String(#b)] * #a.x") == ("a", "b")
