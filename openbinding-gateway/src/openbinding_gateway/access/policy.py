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

from pydantic import BaseModel

from ..space_client import PlanCaps

#: The BIM v1 engine protocol has one public duration option. Keeping the
#: vocabulary singular prevents account policy from accidentally accepting an
#: option that no current Engine mode declares.
TIME_BUDGET_OPTIONS = ("time_budget_ms",)

#: BIM v1's sampling engines count iterations, while its genetic modes count
#: evaluations. Population size is deliberately absent: that is a shape
#: parameter bounded by the mode's ``optionsSchema``/``maxPopulation``, not a
#: search-effort budget.
EFFORT_OPTIONS = ("iterations", "max_evaluations")

#: Warning code attached when an option was brought down to the plan's ceiling.
OPTION_CLAMPED = "OPTION_CLAMPED"


class AnalyzeWarning(BaseModel):
    """A non-fatal account-policy adjustment."""

    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


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
    timeout = caps.limit("maxTimeoutSeconds")
    iterations = caps.limit("maxIterations")
    warnings = _clamp(
        clamped, TIME_BUDGET_OPTIONS,
        float("inf") if timeout is None else timeout * 1000,
        "milliseconds",
    )
    warnings += _clamp(
        clamped, EFFORT_OPTIONS,
        float("inf") if iterations is None else iterations,
        "iterations",
    )
    return ClampedOptions(options=clamped, warnings=warnings)


def plan_aware_defaults(defaults: Dict[str, Any], caps: PlanCaps) -> Dict[str, Any]:
    """An engine's defaults, brought within a plan.

    Mode defaults may evolve independently of account plans, so the defaults an
    account is shown have to be the ones it can actually run. Otherwise the
    Playground could offer a request that is reduced the moment it is sent.
    """
    return clamp_options(defaults, caps).options


def solve_timeout_s(caps: PlanCaps, gateway_ceiling: float) -> float:
    """How long to wait for the engine on this caller's behalf.

    Never longer than the gateway's own ceiling, and never longer than the plan
    permits. A little grace beyond the plan's budget, because the engine has to
    receive the instance, solve, and answer - and only the middle part is what
    the budget describes.
    """
    timeout = caps.limit("maxTimeoutSeconds")
    if timeout is None or timeout > gateway_ceiling:
        raise ValueError("SPACE entitlement exceeds the configured technical timeout")
    return timeout


def payload_ceiling_bytes(caps: PlanCaps, gateway_ceiling: int) -> int:
    """The largest request body this caller may send."""
    payload = caps.limit("maxPayloadBytes")
    if payload is None or payload > gateway_ceiling:
        raise ValueError("SPACE entitlement exceeds the configured technical payload ceiling")
    return int(payload)


def instance_complexity_too_large(log10_cardinality: Optional[float], caps: PlanCaps) -> bool:
    """Whether this instance is beyond what the plan will solve.

    Refused rather than clamped: instance complexity is a fact about the
    submitted resources, and there is no smaller version to run instead.
    """
    if log10_cardinality is None:
        return False
    ceiling = caps.limit("maxInstanceComplexityLog10")
    return ceiling is not None and log10_cardinality > ceiling
