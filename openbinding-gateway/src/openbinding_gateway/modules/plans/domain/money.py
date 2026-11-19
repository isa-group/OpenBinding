"""Exact money: a stored float turned into a ``Decimal``, six places, a bound, and one arithmetic context.

Pure. The toolchain and the normaliser hand prices and costs over as floats (``29.990000000000002`` for
``20 + 9.99``); money is computed from them only through ``exact`` (the float's shortest repr, the digits a person
reads), kept in ``Decimal`` inside ``money_context()`` and quantized stepwise to six places with ``ROUND_HALF_EVEN``,
so displayed amounts always subtract exactly.

**Bounds.** A price may be any finite non-negative float (the normaliser sets no maximum) and a 28-digit context
cannot quantize beyond 22 integer digits, so ``MAX_AMOUNT`` (10^12) bounds every amount before it is used: a value
above it, ``NaN`` or an infinity raises ``AmountOutOfRange``, never ``decimal.InvalidOperation``.
"""

from __future__ import annotations

import decimal
import math
from contextlib import contextmanager
from decimal import Decimal
from collections.abc import Iterator

QUANTUM = Decimal("0.000001")
MAX_AMOUNT = Decimal(10) ** 12
_ZERO = Decimal(0)


class AmountOutOfRange(ValueError):
    """An amount that is not finite or whose magnitude exceeds ``MAX_AMOUNT``."""


@contextmanager
def money_context() -> Iterator[decimal.Context]:
    """34 digits, with ``InvalidOperation``, ``Overflow`` and ``DivisionByZero`` trapped."""
    with decimal.localcontext() as ctx:
        ctx.prec = 34
        ctx.rounding = decimal.ROUND_HALF_EVEN
        ctx.traps[decimal.InvalidOperation] = True
        ctx.traps[decimal.Overflow] = True
        ctx.traps[decimal.DivisionByZero] = True
        yield ctx


def exact(x: float | int | str | Decimal) -> Decimal:
    """The decimal a person reads for ``x``: ``Decimal(repr(x))`` for a float; strings and ints pass through."""
    if isinstance(x, Decimal):
        value = x
    elif isinstance(x, bool):
        raise TypeError("a boolean is not an amount")
    elif isinstance(x, float):
        if not math.isfinite(x):
            raise AmountOutOfRange(f"{x!r} is not a finite amount")
        value = Decimal(repr(x))
    elif isinstance(x, int):
        value = Decimal(x)
    elif isinstance(x, str):
        try:
            value = Decimal(x.strip())
        except decimal.InvalidOperation as exc:
            raise AmountOutOfRange(f"{x!r} is not an amount") from exc
    else:
        raise TypeError(f"{type(x).__name__} is not an amount")
    if not value.is_finite():
        raise AmountOutOfRange(f"{x!r} is not a finite amount")
    return value


def in_range(d: Decimal) -> bool:
    """Finite and at most ``MAX_AMOUNT`` in magnitude."""
    return d.is_finite() and abs(d) <= MAX_AMOUNT


def quantize6(d: Decimal) -> Decimal:
    """Six places, ``ROUND_HALF_EVEN``; ``AmountOutOfRange`` beyond ``MAX_AMOUNT`` or for a non-finite value."""
    if not in_range(d):
        raise AmountOutOfRange(f"{d} is beyond {MAX_AMOUNT}")
    with money_context():
        q = d.quantize(QUANTUM, rounding=decimal.ROUND_HALF_EVEN)
    return _ZERO.quantize(QUANTUM) if q.is_zero() else q


def money_str(d: Decimal) -> str:
    """A fixed six-place string with no exponent; ``-0.000000`` is written ``0.000000``."""
    q = quantize6(d)
    return format(q, "f")
