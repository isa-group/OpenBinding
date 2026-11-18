"""Exact money helpers and the shared month factor (``plans.domain.money``, ``pricing2yaml.units``)."""

from __future__ import annotations

import decimal
from decimal import Decimal

import pytest

from openbinding_gateway.modules.plans.application import (
    MAX_AMOUNT,
    AmountOutOfRange,
    exact,
    in_range,
    money_context,
    money_str,
    month_factor,
    quantize6,
)


def test_exact_keeps_float_noise_and_quantize_removes_it():
    noisy = 20 + 9.99
    assert exact(noisy) == Decimal("29.990000000000002")
    assert quantize6(exact(noisy)) == Decimal("29.990000")
    assert money_str(exact(noisy)) == "29.990000"


def test_point_one_plus_point_two():
    assert exact(0.1 + 0.2) == Decimal("0.30000000000000004")
    assert money_str(exact(0.1 + 0.2)) == "0.300000"


def test_negative_zero_is_written_as_zero():
    assert money_str(Decimal("-0.0000001")) == "0.000000"
    assert money_str(Decimal("-0")) == "0.000000"
    assert money_str(exact(-0.0)) == "0.000000"


def test_bounds():
    assert money_str(Decimal(10) ** 12) == "1000000000000.000000"
    assert in_range(MAX_AMOUNT)
    assert not in_range(MAX_AMOUNT + 1)
    with pytest.raises(AmountOutOfRange):
        quantize6(MAX_AMOUNT + 1)
    with pytest.raises(AmountOutOfRange):
        quantize6(exact(1e30))
    with pytest.raises(AmountOutOfRange):
        money_str(exact(1e30))


def test_non_finite_values_raise_amount_out_of_range():
    for bad in (float("nan"), float("inf"), float("-inf"), "NaN", "Infinity"):
        with pytest.raises(AmountOutOfRange):
            exact(bad)
    with pytest.raises(AmountOutOfRange):
        quantize6(Decimal("NaN"))
    with pytest.raises(AmountOutOfRange):
        exact("not a number")


def test_tiny_values_and_strings():
    assert money_str(exact(1e-9)) == "0.000000"
    assert money_str(exact(4e-7)) == "0.000000"
    assert money_str(exact(6e-7)) == "0.000001"
    assert exact("3.99") == Decimal("3.99")
    assert exact(7) == Decimal(7)


def test_ties_round_half_even():
    assert quantize6(Decimal("0.0000005")) == Decimal("0.000000")
    assert quantize6(Decimal("0.0000015")) == Decimal("0.000002")
    assert quantize6(Decimal("0.0000025")) == Decimal("0.000002")


def test_money_context_traps():
    with money_context(), pytest.raises(decimal.DivisionByZero):
        Decimal(1) / Decimal(0)
    with money_context(), pytest.raises(decimal.InvalidOperation):
        Decimal("Infinity") - Decimal("Infinity")


def test_month_factor_is_one_table():
    assert month_factor("month") == Decimal(1)
    with money_context():
        assert quantize6(Decimal(240) * month_factor("year")) == Decimal("20.000000")
        assert quantize6(Decimal(7) * month_factor("week")) == Decimal("30.333333")
    assert month_factor(None) is None
    assert month_factor("fortnight") is None
    # The generator converts it with float(): the same floats as before, so no generated golden moves.
    assert float(month_factor("month")) == 1.0
    assert float(month_factor("year")) == 1.0 / 12.0
    assert float(month_factor("week")) == 52.0 / 12.0
