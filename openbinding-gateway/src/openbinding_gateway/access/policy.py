"""Bringing a request inside what the caller's plan allows.

Solver budgets used to be whatever the client asked for. Nothing stopped a
request from claiming half an hour of an engine and ten million iterations,
because there was no caller to attribute it to and therefore no basis on which
to say no.

There are two ways to bring a request within a plan, and which applies is a
property of the thing being limited rather than a preference:

* **Clamp** what the caller merely asked for. A time budget or an iteration
  count is a request for effort, and asking for more effort than the plan
  allows is best answered by doing the allowed amount - especially since
  engine defaults exceed the free plan's ceiling, so refusing would make the
  default request fail for every new account.
* **Refuse** what the caller cannot change. The size of an instance's binding
  space is a fact about the instance; there is no smaller version of it to run
  instead, so the only honest answer is no.

Every clamp is reported. A solve that quietly did a tenth of the work asked for
would produce a worse answer with no explanation, which is exactly the kind of
result that gets published.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from ..models.api import AnalyzeWarning
from ..space_client import PlanCaps

#: Options naming a duration in milliseconds, bounded by the plan's per-task
#: ceiling. Collected by name because that is how engines spell them; a new
#: engine reusing either name is covered without further work.
TIME_BUDGET_OPTIONS = ("time_limit_ms", "time_budget_ms")

#: Options naming an amount of search effort, bounded by the iteration ceiling.
EFFORT_OPTIONS = ("iterations_count", "max_evaluations")

#: Warning code attached when an option was brought down to the plan's ceiling.
OPTION_CLAMPED = "OPTION_CLAMPED"


@dataclass(frozen=True)
class ClampedOptions:
    """The options a solve will actually run with, and what changed."""

    options: Dict[str, Any]
    warnings: List[AnalyzeWarning]

    @property
    def anything_changed(self) -> bool:
        return bool(self.warnings)


def _clamp(
    options: Dict[str, Any],
    names: Tuple[str, ...],
    ceiling: float,
    unit: str,
) -> List[AnalyzeWarning]:
    warnings: List[AnalyzeWarning] = []
    for name in names:
        requested = options.get(name)
        if requested is None or isinstance(requested, bool):
            continue
        if not isinstance(requested, (int, float)):
            # Not a number, so not ours to clamp; validation reports it.
            continue
        if requested <= ceiling:
            continue

        applied = type(requested)(ceiling) if isinstance(requested, int) else ceiling
        options[name] = applied
        warnings.append(
            AnalyzeWarning(
                code=OPTION_CLAMPED,
                message=(
                    f"'{name}' was reduced from {requested} to {applied} {unit}, "
                    f"which is what this plan allows."
                ),
                details={
                    "option": name,
                    "requested": requested,
                    "applied": applied,
                    "unit": unit,
                },
            )
        )
    return warnings


def clamp_options(options: Optional[Dict[str, Any]], caps: PlanCaps) -> ClampedOptions:
    """Bring solver options within the plan's ceilings, saying what moved.

    Only what the caller sent is touched. An option they left out is filled in
    by the engine's own defaults later, and those are clamped separately at
    ``plan_aware_defaults`` - so a caller who sends nothing still gets a
    request their plan can honour.
    """
    clamped = dict(options or {})
    warnings = _clamp(clamped, TIME_BUDGET_OPTIONS, caps.max_timeout_s * 1000, "milliseconds")
    warnings += _clamp(clamped, EFFORT_OPTIONS, caps.max_iterations, "iterations")
    return ClampedOptions(options=clamped, warnings=warnings)


def plan_aware_defaults(defaults: Dict[str, Any], caps: PlanCaps) -> Dict[str, Any]:
    """An engine's defaults, brought within a plan.

    MiniZinc defaults to a fifteen-minute budget and the free plan allows five,
    so the defaults an account is shown have to be the ones it can actually
    run. Otherwise the Playground offers a request that is silently reduced the
    moment it is sent.
    """
    return clamp_options(defaults, caps).options


def solve_timeout_s(caps: PlanCaps, gateway_ceiling: float) -> float:
    """How long to wait for the engine on this caller's behalf.

    Never longer than the gateway's own ceiling, and never longer than the plan
    permits. A little grace beyond the plan's budget, because the engine has to
    receive the instance, solve, and answer - and only the middle part is what
    the budget describes.
    """
    return min(gateway_ceiling, caps.max_timeout_s + 30.0)


def payload_ceiling_bytes(caps: PlanCaps, gateway_ceiling: int) -> int:
    """The largest request body this caller may send."""
    return min(gateway_ceiling, caps.max_payload_mb * 1024 * 1024)


def binding_space_too_large(log10_cardinality: Optional[float], caps: PlanCaps) -> bool:
    """Whether this instance is beyond what the plan will solve.

    Refused rather than clamped: an instance's binding space is a fact about
    the instance, and there is no smaller version of it to run instead.
    """
    if log10_cardinality is None:
        return False
    return log10_cardinality > caps.max_binding_space_log10
