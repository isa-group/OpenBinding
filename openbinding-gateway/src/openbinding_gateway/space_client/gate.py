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
``adjust_usage`` records what it cost, in SPACE. The gateway keeps job audit
state but no second commercial balance.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol, runtime_checkable

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
    """Entitlements resolved by SPACE for one exact Pricing2Yaml contract."""

    plan: str
    features: Dict[str, bool] = field(default_factory=dict)
    limits: Dict[str, float] = field(default_factory=dict)

    def allows(self, identifier: str) -> bool:
        """Unknown identifiers and absent token values fail closed."""
        return self.features.get(identifier, False)

    def limit(self, identifier: str) -> Optional[float]:
        """Return an allowance in the canonical iPricing unit.

        Missing token values are zero (fail closed); infinity is ``None``.
        """
        if identifier not in self.limits:
            return 0.0
        value = float(self.limits[identifier])
        return None if not math.isfinite(value) else value

    def http_view(self) -> dict[str, Any]:
        return {
            "plan": self.plan,
            "features": dict(self.features),
            "limits": dict(self.limits),
            "capabilities": {
                identifier: self.limit(identifier) for identifier in self.limits
            },
        }


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
class SubscriptionSnapshot:
    """The immutable pricing selection currently pinned to one contract."""

    plan: str
    pricing_version: str
    add_ons: Dict[str, int] = field(default_factory=dict)
    renews_at: Optional[str] = None


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

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: str,
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        """Put a newly registered account on a plan."""

    async def change_plan(
        self, user_id: uuid.UUID, plan: str, pricing_version: Optional[str] = None
    ) -> None:
        """Move an account to another plan. SPACE calls this a novation."""

    async def subscription(self, user_id: uuid.UUID) -> SubscriptionSnapshot:
        """Read the plan, add-ons and pricing version pinned to a contract."""

    async def change_subscription(
        self,
        user_id: uuid.UUID,
        plan: str,
        add_ons: Dict[str, int],
        pricing_version: Optional[str] = None,
    ) -> SubscriptionSnapshot:
        """Novate a plan/add-on selection against an explicit pricing release."""

    async def migrate_due_contract(self, user_id: uuid.UUID, pricing_version: str) -> bool:
        """Move an expired contract to ``pricing_version`` before SPACE renews it."""

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        """A signed token the browser evaluates features against locally."""

    async def remove_contract(self, user_id: uuid.UUID) -> None:
        """Remove the contract after an account deletion."""
