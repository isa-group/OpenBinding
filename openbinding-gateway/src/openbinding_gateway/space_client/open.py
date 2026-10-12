"""A stateless gate for ``SPACE_ENABLED=false``: development and QacoBench only.

It grants every functional capability and keeps nothing: no plans, no
contracts, no counters. Production refuses to start without SPACE (see
``Settings.space_required_in_production``), so this can never decide a real
account's entitlements.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from typing import Dict, Optional

from .gate import PlanCaps, SubscriptionSnapshot


@dataclass(frozen=True)
class OpenCaps(PlanCaps):
    """Entitlements of the open gate: every feature allowed, every allowance unbounded."""

    plan: str = ""

    def allows(self, identifier: str) -> bool:
        return True

    def limit(self, identifier: str) -> Optional[float]:
        return None

    def http_view(self) -> dict:
        return {"plan": self.plan, "features": {}, "limits": {}, "capabilities": {}}


class OpenGate:
    """A ``PricingGate`` that remembers nothing and refuses nothing."""

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        return OpenCaps()

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: Optional[str],
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        return None

    async def change_plan(
        self, user_id: uuid.UUID, plan: str, pricing_version: Optional[str] = None
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
