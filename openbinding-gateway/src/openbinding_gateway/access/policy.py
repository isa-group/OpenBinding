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
  instead, so the only honest answer is no (``domain.binding_space``, against
  the deployment's ``MAX_BINDING_SPACE_LOG10``).

The time budget comes from the plan (``maxRunMinutes``); the effort budget
(``MAX_ITERATIONS``) and the package size (``MAX_PACKAGE_BYTES``) are settings of
the deployment, which pricing 0.2.0 does not declare.

Every clamp is reported. A solve that quietly did a tenth of the work asked for
would produce a worse answer with no explanation, which is exactly the kind of
result that gets published.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from pydantic import BaseModel

from ..core.settings import get_settings
from ..models.errors import api_error
from ..modules.plans.application import entitlement_map as ids
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

#: Problem code (503) for a plan whose entitlement exceeds a technical ceiling.
PRICING_MISCONFIGURED = "pricing_misconfigured"


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
    allowed_by: str = "this plan",
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
                    f"which is what {allowed_by} allows."
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
    settings = get_settings()
    minutes = caps.limit(ids.MAX_RUN_MINUTES)
    technical_ms = settings.engine_solve_timeout_s * 1000
    plan_ms = float("inf") if minutes is None else ids.run_minutes_to_ms(minutes)
    warnings = _clamp(
        clamped, TIME_BUDGET_OPTIONS, min(plan_ms, technical_ms), "milliseconds",
        "this plan" if plan_ms <= technical_ms else "this deployment",
    )
    warnings += _clamp(clamped, EFFORT_OPTIONS, float(settings.max_iterations), "iterations", "this deployment")
    return ClampedOptions(options=clamped, warnings=warnings)


def plan_aware_defaults(defaults: Dict[str, Any], caps: PlanCaps) -> Dict[str, Any]:
    """An engine's defaults, brought within a plan.

    Mode defaults may evolve independently of account plans, so the defaults an
    account is shown have to be the ones it can actually run. Otherwise the
    Playground could offer a request that is reduced the moment it is sent.
    """
    return clamp_options(defaults, caps).options


def pricing_misconfigured(message: str) -> HTTPException:
    """The refusal for an entitlement the gateway cannot read.

    A plan that does not declare a limit the gateway needs is a pricing
    configuration error, not something to guess: the request is denied, with a
    stable 503 problem rather than an unhandled exception.
    """
    return api_error(503, PRICING_MISCONFIGURED, message)


def solve_timeout_s(caps: PlanCaps, gateway_ceiling: float) -> float:
    """How long to wait for the engine on this caller's behalf, in seconds.

    The lower of the plan's ``maxRunMinutes`` and the gateway's own ceiling
    (``ENGINE_SOLVE_TIMEOUT_S``), like the other limits a deployment also
    bounds: a plan that grants more (LAB grants a day) runs as long as this
    deployment waits, and ``clamp_options`` brings the time budget to the same
    figure, saying so. An unlimited plan (``inf``, as the open gate grants)
    waits the ceiling. This is a wall-clock budget (time the engine may take,
    as the gateway waits for it), not CPU time: nothing in the gateway
    measures CPU.

    Raises the 503 ``pricing_misconfigured`` problem when the plan declares no
    ``maxRunMinutes`` at all: an unknown limit is not "no limit", and
    ``PlanCaps.limit`` would read it as zero.
    """
    if ids.MAX_RUN_MINUTES not in caps.limits:
        raise pricing_misconfigured("SPACE entitlement does not declare maxRunMinutes")
    minutes = caps.limit(ids.MAX_RUN_MINUTES)
    if minutes is None:
        return gateway_ceiling
    return min(ids.run_minutes_to_seconds(minutes), gateway_ceiling)


def payload_ceiling_bytes(gateway_ceiling: int) -> int:
    """The largest package one request may carry: ``MAX_PACKAGE_BYTES``, never above ``gateway_ceiling``."""
    return min(get_settings().max_package_bytes, gateway_ceiling)
