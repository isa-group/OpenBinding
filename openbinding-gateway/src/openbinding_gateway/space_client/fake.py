"""An in-memory SPACE substitute driven by an injected Pricing2Yaml catalog."""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from ..pricing_catalog import PricingCatalog, PricingCatalogError
from .gate import PlanCaps, PricingUnavailable, SubscriptionSnapshot


class FakePricingGate:
    """Exercise plan entitlements without copying the commercial catalog.

    Keeps contracts only: no consumption state of any kind.
    """

    def __init__(self, catalog: PricingCatalog | None = None):
        self.catalog = catalog
        self.default_plan = catalog.default_plan if catalog else ""
        self.plans: Dict[uuid.UUID, str] = {}
        self.contracts: Dict[uuid.UUID, str] = {}
        self.versions: Dict[uuid.UUID, str] = {}
        self.add_ons: Dict[uuid.UUID, Dict[str, int]] = {}
        self.renews_at: Dict[uuid.UUID, datetime] = {}
        self.unavailable = False

    def _check_available(self) -> PricingCatalog:
        if self.unavailable:
            raise PricingUnavailable("The fake pricing service is switched off.")
        if self.catalog is None:
            raise PricingUnavailable("No Pricing2Yaml catalog was injected into the fake pricing service.")
        return self.catalog

    def plan_of(self, user_id: uuid.UUID) -> str:
        catalog = self._check_available()
        return self.plans.get(user_id, self.default_plan)

    def _entitlements(self, user_id: uuid.UUID) -> tuple[dict[str, bool], dict[str, float]]:
        catalog = self._check_available()
        try:
            return catalog.entitlements(self.plan_of(user_id), self.add_ons.get(user_id, {}))
        except PricingCatalogError as exc:
            raise PricingUnavailable(str(exc)) from exc

    async def caps(self, user_id: uuid.UUID) -> PlanCaps:
        self._check_available()
        features, limits = self._entitlements(user_id)
        return PlanCaps(
            plan=self.plan_of(user_id),
            features=features,
            limits=limits,
        )

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: str,
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        catalog = self._check_available()
        if pricing_version is not None and pricing_version != catalog.version:
            raise PricingUnavailable(f"Pricing release {pricing_version!r} is not loaded")
        catalog.validate_selection(plan, {})
        self.contracts[user_id] = email
        self.plans[user_id] = plan
        self.versions[user_id] = catalog.version
        self.add_ons[user_id] = {}
        self.renews_at[user_id] = datetime.now(timezone.utc) + timedelta(days=30)

    async def change_plan(
        self, user_id: uuid.UUID, plan: str, pricing_version: Optional[str] = None
    ) -> None:
        await self.change_subscription(
            user_id, plan, self.add_ons.get(user_id, {}), pricing_version
        )

    async def subscription(self, user_id: uuid.UUID) -> SubscriptionSnapshot:
        catalog = self._check_available()
        return SubscriptionSnapshot(
            plan=self.plan_of(user_id),
            pricing_version=self.versions.get(user_id, catalog.version),
            add_ons=dict(self.add_ons.get(user_id, {})),
            renews_at=self.renews_at.get(user_id, datetime.now(timezone.utc)).isoformat(),
        )

    async def change_subscription(
        self,
        user_id: uuid.UUID,
        plan: str,
        add_ons: Dict[str, int],
        pricing_version: Optional[str] = None,
    ) -> SubscriptionSnapshot:
        catalog = self._check_available()
        if pricing_version is not None and pricing_version != catalog.version:
            raise PricingUnavailable(f"Pricing release {pricing_version!r} is not loaded")
        selected = catalog.validate_selection(plan, add_ons)
        self.plans[user_id] = plan
        self.add_ons[user_id] = selected
        self.versions[user_id] = catalog.version
        self.renews_at[user_id] = datetime.now(timezone.utc) + timedelta(days=30)
        return await self.subscription(user_id)

    async def migrate_due_contract(self, user_id: uuid.UUID, pricing_version: str) -> bool:
        catalog = self._check_available()
        if pricing_version != catalog.version:
            raise PricingUnavailable(f"Pricing release {pricing_version!r} is not loaded")
        if self.versions.get(user_id, catalog.version) == pricing_version:
            return False
        if self.renews_at.get(user_id, datetime.max.replace(tzinfo=timezone.utc)) > datetime.now(timezone.utc):
            return False
        await self.change_subscription(
            user_id, self.plan_of(user_id), self.add_ons.get(user_id, {}), pricing_version
        )
        return True

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        caps = await self.caps(user_id)
        service = "openbinding-"
        json_limits = {
            name: value if value != float("inf") else None
            for name, value in caps.limits.items()
        }
        exp = int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp())
        claims = {
            "sub": str(user_id),
            "exp": exp,
            "features": {
                service + name: {"eval": value}
                for name, value in caps.features.items()
            },
            "pricingContext": {
                "features": {service + name: value for name, value in caps.features.items()},
                "usageLimits": {service + name: value for name, value in json_limits.items()},
            },
        }
        payload = base64.urlsafe_b64encode(
            json.dumps(claims, allow_nan=False).encode()
        ).decode().rstrip("=")
        return f"fake.{payload}.unsigned"

    async def remove_contract(self, user_id: uuid.UUID) -> None:
        self._check_available()
        self.contracts.pop(user_id, None)
        self.plans.pop(user_id, None)
        self.versions.pop(user_id, None)
        self.add_ons.pop(user_id, None)
        self.renews_at.pop(user_id, None)
