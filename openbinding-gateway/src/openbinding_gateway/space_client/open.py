"""A stateless gate for ``SPACE_ENABLED=false``: development and QacoBench only.

It grants every functional capability and keeps nothing: no plans, no
contracts, no counters. Its allowances are finite where the system has a
technical ceiling (never above it) and unbounded elsewhere. Production refuses to start without SPACE (see
``Settings.space_required_in_production``), so this can never decide a real
account's entitlements.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

from ..core.settings import get_settings
from .gate import PlanCaps, SubscriptionSnapshot

#: The per-request payload ceiling ``routes/v1.py`` and ``routes/artifacts.py``
#: pass to the policy (they hard-code it); the open gate must never grant more.
PAYLOAD_TECHNICAL_CEILING_BYTES = 512 * 1024 * 1024

#: Features the gateway or the interface evaluate. ``OpenCaps.allows`` grants any
#: identifier, but listing these keeps the usage view shaped like a real plan's.
OPEN_FEATURES = (
    "authoring",
    "solve",
    "federatedEngines",
    "apiAccess",
    "collaboration",
    "studies",
    "advancedAnalytics",
    "reproducibleExport",
    "publishing",
    "reproducibilityArchive",
    "institutionalBranding",
)

#: Allowances with no technical ceiling: unbounded, which is how a real plan
#: expresses "unlimited" too (``inf``; ``PlanCaps.limit`` reads it as ``None``).
#: Absent would not do: a missing allowance is zero (fail closed).
UNBOUNDED_LIMITS = (
    "apiKeys",
    "federatedEngines",
    "maxIterations",
    "maxInstanceComplexityLog10",
    "jobHistoryDays",
    "organizations",
    "members",
    "projects",
    "privateProjects",
    "collections",
    "studies",
    "storageBytes",
)


def open_limits() -> Dict[str, float]:
    """Every allowance the gateway reads, as open as the configured system allows.

    The allowances that ``access.policy`` checks against a technical ceiling
    (solve timeout, request payload) are granted exactly that ceiling: finite,
    and never above it, because the policy refuses a larger entitlement. The
    rest have no technical ceiling and are unbounded. ``concurrentJobs`` is
    informative (the enforced concurrency limit is
    ``MAX_CONCURRENT_JOBS_PER_USER``, independent of the plan).
    """
    settings = get_settings()
    limits: Dict[str, float] = {name: float("inf") for name in UNBOUNDED_LIMITS}
    limits["maxTimeoutSeconds"] = float(settings.engine_solve_timeout_s)
    limits["maxPayloadBytes"] = float(
        min(settings.max_request_body_bytes, PAYLOAD_TECHNICAL_CEILING_BYTES)
    )
    limits["concurrentJobs"] = float(settings.max_concurrent_jobs_per_user)
    return limits


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
