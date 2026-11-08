"""Neutral values, computed exactly as the container computes them.

Every feature has a finite neutral: the value a step contributes when it does not
participate. Local tasks and empty workflow leaves contribute it, and so does a candidate
for a property that does not apply to it.

The neutral is **computed, not tabulated**. There is no neutral column in
``docs/FEATURES.md`` and there is no table to copy: the only normative source is the
container's feature normalization, which keys off the ``sequence`` operator and the
declared domain and nothing else. This module reproduces that rule, and
``tests/composition/test_neutral_matches_compiler.py`` asserts the reproduction against
the compiled IR of every package in the corpus, so the two cannot drift apart silently.

Writing the neutral explicitly is therefore digest-neutral: the IR carries a neutral on
every feature either way, and the value written here equals the value the container would
have inferred.

There is a second, different neutral in the container that must never be used here: the
evaluator's operator identity, which is 1.0 for product-like operators and 0.0 for
everything else, and which applies only when an operator receives an empty list of
values. Writing that identity in place of the feature-level neutral would be wrong for
every ``min`` and ``max`` property -- in the guiding case it would give the ``security``
property 0.0 instead of 5.0, and move every binding digest of that package.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
from typing import Any

#: The operators a shorthand may name, and the per-block policy each expands to. The
#: container accepts a shorthand string or a block policy; both lower to the same IR, so
#: the choice of source form is digest-neutral.
SHORTHANDS = ("sum", "product", "min", "max")

#: The block policy a block-form aggregation starts from before the author's overrides.
BLOCK_DEFAULTS: Mapping[str, str] = {
    "sequence": "sum",
    "parallel": "sum",
    "exclusive": "weightedSum",
    "repeat": "scale",
    "selection": "sum",
}

#: Which operators each block admits. An operator outside its set is the container's
#: business to diagnose, not this module's; the corpus test proves agreement in practice.
ALLOWED: Mapping[str, frozenset[str]] = {
    "sequence": frozenset(SHORTHANDS),
    "parallel": frozenset(SHORTHANDS),
    "exclusive": frozenset({"weightedSum", "weightedProduct", "min", "max"}),
    "repeat": frozenset({"scale", "power", "identity"}),
    "selection": frozenset(SHORTHANDS),
}


#: The neutral each sequence operator implies: a constant, or the name of the domain bound
#: that does not constrain it. ``sum`` contributes nothing and ``product`` does not degrade;
#: ``min`` is not lowered by the domain's maximum and ``max`` is not raised by its minimum.
SEQUENCE_NEUTRALS: Mapping[str, float | str] = {
    "sum": 0.0,
    "product": 1.0,
    "min": "maximum",
    "max": "minimum",
}

#: What a ``ratio`` domain gives the two bound-reading operators, whatever bounds it states:
#: the container reads the ratio's own [0, 1], not the author's narrower range.
RATIO_NEUTRALS: Mapping[str, float] = {"min": 1.0, "max": 0.0}


class NeutralSource(str, Enum):
    """Where a feature's neutral came from, recorded in provenance."""

    DECLARED = "declared"
    INFERRED = "inferred"


class Unbounded(Exception):
    """The sequence operator and the domain do not determine a neutral.

    Raised for a ``min`` property with no upper bound, or a ``max`` property with no
    lower bound. The container diagnoses this as ``feature_neutral`` and then proceeds
    with 0.0, which is a value no one chose; the Studio refuses the document instead and
    names the property.
    """

    def __init__(self, operator: str, bound: str) -> None:
        self.operator = operator
        self.bound = bound
        super().__init__(f"aggregation {operator!r} needs a domain {bound} to have a neutral")


def normalize_domain(domain: Any) -> dict[str, Any]:
    """Return the domain as the container sees it, with ratio bounds materialized.

    A bare string is the kind. A ``ratio`` domain is bounded to [0, 1], which the
    container fills in before reading a neutral from it, so the same must happen here or
    a ratio ``min`` property would look unbounded.
    """
    if domain is None:
        domain = "real"
    normalized = {"kind": domain} if isinstance(domain, str) else dict(domain)
    if normalized.get("kind") == "ratio":
        normalized.setdefault("minimum", 0.0)
        normalized.setdefault("maximum", 1.0)
    return normalized


def expand_aggregation(aggregation: Any) -> dict[str, str]:
    """Expand a shorthand or block aggregation into the full per-block policy.

    Mirrors the container: a missing aggregation means ``sum``; a shorthand sets every
    block, mapping ``sum`` and ``product`` onto their routing-weighted and repetition
    counterparts; a block policy overrides the defaults one block at a time.
    """
    if aggregation is None:
        aggregation = "sum"
    if isinstance(aggregation, str):
        operator = aggregation if aggregation in SHORTHANDS else "sum"
        weighted = {"sum": "weightedSum", "product": "weightedProduct"}.get(operator, operator)
        repeat = {"sum": "scale", "product": "power"}.get(operator, "identity")
        return {
            "sequence": operator,
            "parallel": operator,
            "exclusive": weighted,
            "repeat": repeat,
            "selection": operator,
        }
    policy = dict(BLOCK_DEFAULTS)
    if not isinstance(aggregation, Mapping):
        return policy
    for block, operator in aggregation.items():
        if block in policy and isinstance(operator, str) and operator in ALLOWED[block]:
            policy[block] = operator
    return policy


def infer_neutral(aggregation: Any, domain: Any) -> float:
    """The neutral the container would infer, from the sequence operator and the domain.

    ``sum`` contributes nothing, ``product`` does not degrade, ``min`` does not constrain
    a minimum (so the domain's upper bound) and ``max`` does not raise a maximum (so its
    lower bound). A ratio domain is bounded to [0, 1], so its ``min`` neutral is 1.0 and
    its ``max`` neutral is 0.0.

    Raises:
        Unbounded: when the operator needs a bound the domain does not declare.
    """
    policy = expand_aggregation(aggregation)
    bounds = normalize_domain(domain)
    operator = policy["sequence"]
    rule = SEQUENCE_NEUTRALS[operator]
    if not isinstance(rule, str):
        return rule
    if bounds.get("kind") == "ratio":
        return RATIO_NEUTRALS[operator]
    value = bounds.get(rule)
    if value is None:
        raise Unbounded(operator=operator, bound=rule)
    return float(value)


class OutsideDomain(ValueError):
    """The neutral -- declared or inferred -- lies outside the domain the container checks.

    A ``ValueError``, as the refusal always was, so a caller that caught that still does;
    its own class so that a caller can tell it from a ``float()`` that failed.
    """

    def __init__(self, value: float, minimum: float | None, maximum: float | None) -> None:
        self.value = value
        self.minimum = minimum
        self.maximum = maximum
        super().__init__(f"neutral {value} is outside the domain [{minimum}, {maximum}]")


def resolve_neutral(
    *, aggregation: Any, domain: Any, declared: float | int | None = None
) -> tuple[float, NeutralSource]:
    """The neutral to write, and where it came from, checked as the container checks it.

    A declared neutral is honoured; otherwise it is inferred. Either way the value must lie
    inside the domain, which is the container's rule exactly: it range-checks the neutral
    after inferring it, not only when it was declared, and it checks a ``ratio`` against
    the ratio's own [0, 1] rather than any narrower bounds the author gave. Checking less
    let an inferred neutral outside its domain through to a compile that refused it with
    ``feature_neutral_domain``; checking a ratio against the author's bounds refused a
    package the container accepts.

    Raises:
        Unbounded: when nothing determines the neutral.
        OutsideDomain: when the neutral lies outside the domain.
    """
    if declared is None:
        value, source = infer_neutral(aggregation, domain), NeutralSource.INFERRED
    else:
        value, source = float(declared), NeutralSource.DECLARED
    bounds = normalize_domain(domain)
    if bounds.get("kind") == "ratio":
        minimum, maximum = 0.0, 1.0
    else:
        minimum, maximum = bounds.get("minimum"), bounds.get("maximum")
    if (minimum is not None and value < float(minimum)) or (
        maximum is not None and value > float(maximum)
    ):
        raise OutsideDomain(value, minimum, maximum)
    return value, source
