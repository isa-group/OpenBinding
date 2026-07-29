"""What the gateway needs from a pricing service, and nothing more.

Entitlements are not decided here. They are decided by a SPACE instance, which
holds a contract per user and knows what each plan allows. This module is the
seam between the two: a narrow protocol the rest of the gateway talks to, an
adapter over SPACE's own client, and a fake the tests use so that a solve can
be refused for lack of quota without a SPACE instance existing.

The seam is the point. SPACE is early-stage software whose API will move, and
when it does ``SpacePricingGate`` changes and nothing else does.

One thing the protocol is deliberate about: **asking and spending are separate
calls**. ``evaluate`` answers whether something may happen and changes nothing;
``adjust_usage`` records what it cost. That is partly because the cost of a
solve is unknown until it is over, and partly because SPACE's own
consume-while-evaluating path loses updates when more than one limit is
involved - so the gateway keeps its own accounts. See ``space.py``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional, Protocol, runtime_checkable

#: The service name this pricing is registered under in SPACE. Feature
#: identifiers are ``<service>-<feature>``, lower-cased on the service half.
SERVICE_NAME = "openbinding"


def feature_id(feature: str) -> str:
    """The identifier SPACE knows a feature by.

    One helper, because the convention is easy to get subtly wrong and a
    mistyped identifier fails as "feature not in your plan" rather than as an
    error - which is exactly the kind of bug that reaches production.
    """
    return f"{SERVICE_NAME}-{feature}"


@dataclass(frozen=True)
class PlanCaps:
    """The static ceilings a plan imposes, as the gateway needs them.

    These are the limits that bound a single request rather than a month's
    worth: how long one solve may run, how large an instance may be. They are
    read before a solve and never decremented, which is why they are separated
    from the usage levels below.
    """

    plan: str = "FREE"
    max_timeout_s: float = 300.0
    max_iterations: int = 10_000
    max_payload_mb: int = 16
    max_binding_space_log10: float = 9.0
    job_history_days: int = 7
    features: Dict[str, bool] = field(default_factory=dict)

    def allows(self, feature: str) -> bool:
        """Whether the plan includes a feature. Unknown features are allowed.

        An unknown feature is one the pricing does not model, and refusing
        those would mean every new endpoint is denied until the pricing is
        republished. Anything meant to be gated has to be in the pricing.
        """
        return self.features.get(feature, True)


@dataclass(frozen=True)
class LimitUsage:
    """One usage limit, as an account holder should see it."""

    limit_id: str
    limit: float
    used: float
    unit: Optional[str] = None
    renews_at: Optional[str] = None

    @property
    def remaining(self) -> float:
        return max(0.0, self.limit - self.used)


@dataclass(frozen=True)
class UsageSnapshot:
    plan: str
    limits: Dict[str, LimitUsage] = field(default_factory=dict)


@dataclass(frozen=True)
class Verdict:
    """The answer to "may this happen?"."""

    allowed: bool
    #: Which limit refused, when one did.
    limit: Optional[LimitUsage] = None
    reason: Optional[str] = None

    @classmethod
    def yes(cls) -> "Verdict":
        return cls(allowed=True)

    @classmethod
    def no(cls, reason: str, limit: Optional[LimitUsage] = None) -> "Verdict":
        return cls(allowed=False, reason=reason, limit=limit)


class PricingUnavailable(RuntimeError):
    """SPACE could not be reached, and the caller has to decide what that means.

    Deliberately distinct from a refusal: "you have no quota left" and "I could
    not find out whether you have quota left" call for different answers, and
    conflating them would either hand out unmetered compute or refuse everyone
    the moment SPACE restarts.
    """


@runtime_checkable
class PricingGate(Protocol):
    """Everything the gateway asks a pricing service."""

    async def evaluate(
        self, user_id: uuid.UUID, feature: str, expected: Optional[Dict[str, float]] = None
    ) -> Verdict:
        """Whether a feature may be used. Asks; spends nothing."""

    async def revert(self, user_id: uuid.UUID, feature: str) -> None:
        """Undo an evaluation. Kept for completeness; spending is undone by adjusting."""

    async def adjust_usage(self, user_id: uuid.UUID, increments: Dict[str, float]) -> None:
        """Add to (or, negatively, release) usage levels once the real cost is known."""

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        """The static ceilings this user's plan imposes."""

    async def usage(self, user_id: uuid.UUID) -> UsageSnapshot:
        """What this user has spent, for display."""

    async def create_contract(self, user_id: uuid.UUID, plan: str, email: str) -> None:
        """Put a newly registered account on a plan."""

    async def change_plan(self, user_id: uuid.UUID, plan: str) -> None:
        """Move an account to another plan. SPACE calls this a novation."""

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        """A signed token the browser evaluates features against locally."""
