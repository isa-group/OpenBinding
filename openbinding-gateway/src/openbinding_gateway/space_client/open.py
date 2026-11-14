"""A stateless gate for ``SPACE_ENABLED=false``: development and QacoBench only.

It grants every functional capability and keeps nothing: no plans, no
contracts, no counters. Its features and limits are generated from the
entitlement map (``modules/plans/domain/entitlement_map.py``): every required
feature is granted and every required limit is unbounded (``inf``), so only the
deployment's technical ceilings apply. Production refuses to start without SPACE
(see ``Settings.space_required_in_production``), so this can never decide a
real account's entitlements.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass, field
from importlib import resources
from typing import Dict, Optional

from ..modules.plans.application import entitlement_map
from .gate import PlanCaps, SubscriptionSnapshot

#: The pricing version the package copy holds (``modules/plans/pricing``).
PACKAGE_PRICING_VERSION = "0.2.0"

#: Features the gateway reads: every one granted (``OpenCaps.allows`` grants any
#: identifier too; listing them keeps the usage view shaped like a real plan's).
OPEN_FEATURES = entitlement_map.REQUIRED_FEATURES

#: Limits the gateway reads, all unbounded: ``inf`` is how a real plan says
#: "unlimited" too (``PlanCaps.limit`` reads it as ``None``). Absent would not
#: do: a missing allowance is zero (fail closed).
UNBOUNDED_LIMITS = entitlement_map.REQUIRED_LIMITS


def open_limits() -> Dict[str, float]:
    """Every limit the gateway reads, unbounded; the technical ceilings of the deployment still apply."""
    return {name: float("inf") for name in UNBOUNDED_LIMITS}


def package_pricing_document() -> str:
    """The Pricing2Yaml text shipped with the gateway (a byte copy of ``docs/pricing/openbinding-0.2.0.yml``)."""
    source = resources.files("openbinding_gateway.modules.plans") / "pricing" / f"openbinding-{PACKAGE_PRICING_VERSION}.yml"
    return source.read_text(encoding="utf-8")


@dataclass(frozen=True)
class OpenCaps(PlanCaps):
    """Entitlements of the open gate: every feature allowed, every allowance as open as it can be.

    A regular ``PlanCaps`` (same fields, same ``limit``/``http_view``); the only
    difference is that any feature identifier is allowed, declared or not.
    """

    plan: str = ""
    features: Dict[str, bool] = field(
        default_factory=lambda: {name: True for name in OPEN_FEATURES}
    )
    limits: Dict[str, float] = field(default_factory=open_limits)

    def allows(self, identifier: str) -> bool:
        return True


class OpenGate:
    """A ``PricingGate`` that remembers nothing and refuses nothing."""

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        return OpenCaps()

    async def pricing_document(self) -> str:
        """The package copy of the published pricing: there is no SPACE to ask."""
        return package_pricing_document()

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: Optional[str],
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        return None

    async def change_plan(
        self,
        user_id: uuid.UUID,
        plan: str,
        pricing_version: Optional[str] = None,
        expected_contract_version: Optional[str] = None,
    ) -> None:
        return None

    async def subscription(self, user_id: uuid.UUID) -> SubscriptionSnapshot:
        return SubscriptionSnapshot(plan="", pricing_version="")

    async def change_subscription(
        self,
        user_id: uuid.UUID,
        plan: str,
        add_ons: Dict[str, int],
        pricing_version: Optional[str] = None,
        expected_contract_version: Optional[str] = None,
    ) -> SubscriptionSnapshot:
        return SubscriptionSnapshot(
            plan="", pricing_version=pricing_version or "", add_ons=dict(add_ons)
        )

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        """An unsigned token that says nothing is restricted."""
        claims = {"sub": str(user_id), "features": {}, "pricingContext": {"features": {}, "usageLimits": {}}}
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        return f"open.{payload}.unsigned"

    async def remove_contract(self, user_id: uuid.UUID) -> None:
        return None
