"""A SPACE substitute for the tests, driven by the synthetic ``fixtures/pricing_test.yml``.

Production code holds no pricing and evaluates no plan: SPACE does. The tests
still need plans with different limits to exercise how the gateway reacts to
them, so this module reads the synthetic fixture and answers the way SPACE
would. Nothing here is imported by ``src``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import yaml

from openbinding_gateway.space_client import (
    PlanCaps,
    PricingUnavailable,
    SubscriptionRejected,
    SubscriptionSnapshot,
)

IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,127}$")


class PricingCatalogError(ValueError):
    """The fixture or a requested selection is invalid."""


def _mapping(value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise PricingCatalogError(f"{path} must be an object with string keys")
    return value


def _identifier(value: object, path: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise PricingCatalogError(f"{path} is not a valid identifier")
    return value


def _number(value: object, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PricingCatalogError(f"{path} must be numeric")
    result = float(value)
    if result < 0 or math.isnan(result):
        raise PricingCatalogError(f"{path} must be non-negative")
    return result


def _configured_values(declarations: dict[str, Any], overrides: object, path: str) -> dict[str, Any]:
    result = {
        name: _mapping(declaration, f"{path}.{name}").get("defaultValue")
        for name, declaration in declarations.items()
    }
    for name, raw in _mapping(overrides or {}, path).items():
        if name not in declarations:
            raise PricingCatalogError(f"{path}.{name} is not declared")
        item = _mapping(raw, f"{path}.{name}")
        if "value" not in item:
            raise PricingCatalogError(f"{path}.{name}.value is required")
        result[name] = item["value"]
    return result


@dataclass(frozen=True)
class PlanDefinition:
    name: str
    price: Any
    features: dict[str, bool]
    limits: dict[str, float]


@dataclass(frozen=True)
class AddOnDefinition:
    name: str
    available_for: frozenset[str]
    minimum: int
    maximum: int
    step: int
    limit_extensions: dict[str, float]


@dataclass(frozen=True)
class PricingCatalog:
    """The parts of a Pricing2Yaml document the fake needs to resolve entitlements."""

    version: str
    digest: str
    plans: dict[str, PlanDefinition]
    add_ons: dict[str, AddOnDefinition]
    document: dict[str, Any]

    @classmethod
    def parse(cls, content: bytes) -> "PricingCatalog":
        root = _mapping(yaml.safe_load(content), "pricing")
        version = root.get("version")
        if not isinstance(version, str) or not version:
            raise PricingCatalogError("pricing.version is required")
        feature_declarations = _mapping(root.get("features"), "features")
        limit_declarations = _mapping(root.get("usageLimits"), "usageLimits")
        for name in feature_declarations:
            _identifier(name, f"features.{name}")
        for name, raw in limit_declarations.items():
            _identifier(name, f"usageLimits.{name}")
            _number(_mapping(raw, f"usageLimits.{name}").get("defaultValue"), f"usageLimits.{name}")

        plans: dict[str, PlanDefinition] = {}
        for name, raw in _mapping(root.get("plans"), "plans").items():
            _identifier(name, f"plans.{name}")
            declaration = _mapping(raw, f"plans.{name}")
            features = _configured_values(
                feature_declarations, declaration.get("features"), f"plans.{name}.features"
            )
            limits = _configured_values(
                limit_declarations, declaration.get("usageLimits"), f"plans.{name}.usageLimits"
            )
            plans[name] = PlanDefinition(
                name=name,
                price=declaration.get("price"),
                features={key: bool(value) for key, value in features.items()},
                limits={key: _number(value, f"plans.{name}.usageLimits.{key}") for key, value in limits.items()},
            )
        if not plans:
            raise PricingCatalogError("pricing.plans must not be empty")

        add_ons: dict[str, AddOnDefinition] = {}
        for name, raw in _mapping(root.get("addOns") or {}, "addOns").items():
            declaration = _mapping(raw, f"addOns.{name}")
            constraints = _mapping(declaration.get("subscriptionConstraints") or {}, f"addOns.{name}")
            minimum = constraints.get("minQuantity", 1)
            add_ons[name] = AddOnDefinition(
                name=name,
                available_for=frozenset(declaration.get("availableFor", [])),
                minimum=minimum,
                maximum=constraints.get("maxQuantity", minimum),
                step=constraints.get("quantityStep", 1),
                limit_extensions={
                    key: _number(_mapping(item, f"addOns.{name}.{key}").get("value"), f"addOns.{name}.{key}")
                    for key, item in _mapping(
                        declaration.get("usageLimitsExtensions") or {}, f"addOns.{name}"
                    ).items()
                },
            )
        return cls(
            version=version,
            digest=f"sha256-{hashlib.sha256(content).hexdigest()}",
            plans=plans,
            add_ons=add_ons,
            document=dict(root),
        )

    @property
    def default_plan(self) -> str:
        """The one non-RESEARCH zero-price plan of the fixture."""
        free = [
            name
            for name, plan in self.plans.items()
            if name != "RESEARCH"
            and isinstance(plan.price, (int, float))
            and not isinstance(plan.price, bool)
            and float(plan.price) == 0
        ]
        if len(free) != 1:
            raise PricingCatalogError("The fixture must declare exactly one non-RESEARCH zero-price plan")
        return free[0]

    def validate_selection(self, plan: str, add_ons: dict[str, int]) -> dict[str, int]:
        if plan not in self.plans:
            raise PricingCatalogError(f"Unknown plan {plan!r} in pricing {self.version}")
        selected = {name: quantity for name, quantity in add_ons.items() if quantity}
        for name, quantity in selected.items():
            if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 0:
                raise PricingCatalogError(f"{name} quantity must be a non-negative integer")
            add_on = self.add_ons.get(name)
            if add_on is None:
                raise PricingCatalogError(f"Unknown add-on {name!r} in pricing {self.version}")
            if plan not in add_on.available_for:
                raise PricingCatalogError(f"{name} is not available for {plan}")
            if quantity < add_on.minimum or quantity > add_on.maximum or (quantity - add_on.minimum) % add_on.step:
                raise PricingCatalogError(
                    f"{name} quantity must be {add_on.minimum}..{add_on.maximum} in steps of {add_on.step}"
                )
        return selected

    def entitlements(
        self, plan: str, add_ons: dict[str, int] | None = None
    ) -> tuple[dict[str, bool], dict[str, float]]:
        selected = self.validate_selection(plan, dict(add_ons or {}))
        definition = self.plans[plan]
        features = dict(definition.features)
        limits = dict(definition.limits)
        for name, quantity in selected.items():
            for limit_name, increment in self.add_ons[name].limit_extensions.items():
                limits[limit_name] = limits.get(limit_name, 0) + increment * quantity
        return features, limits


class FakePricingGate:
    """Exercise plan entitlements without a SPACE instance.

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
        self._check_available()
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
        return PlanCaps(plan=self.plan_of(user_id), features=features, limits=limits)

    async def create_contract(
        self,
        user_id: uuid.UUID,
        plan: Optional[str],
        email: str,
        pricing_version: Optional[str] = None,
    ) -> None:
        catalog = self._check_available()
        if pricing_version is not None and pricing_version != catalog.version:
            raise PricingUnavailable(f"Pricing release {pricing_version!r} is not loaded")
        plan = plan or catalog.default_plan
        try:
            catalog.validate_selection(plan, {})
        except PricingCatalogError as exc:
            raise SubscriptionRejected(str(exc)) from exc
        self.contracts[user_id] = email
        self.plans[user_id] = plan
        self.versions[user_id] = catalog.version
        self.add_ons[user_id] = {}
        self.renews_at[user_id] = datetime.now(timezone.utc) + timedelta(days=30)

    async def change_plan(
        self, user_id: uuid.UUID, plan: str, pricing_version: Optional[str] = None
    ) -> None:
        await self.change_subscription(user_id, plan, self.add_ons.get(user_id, {}), pricing_version)

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
        try:
            selected = catalog.validate_selection(plan, add_ons)
        except PricingCatalogError as exc:
            raise SubscriptionRejected(str(exc)) from exc
        self.plans[user_id] = plan
        self.add_ons[user_id] = selected
        self.versions[user_id] = catalog.version
        self.renews_at[user_id] = datetime.now(timezone.utc) + timedelta(days=30)
        return await self.subscription(user_id)

    async def pricing_token(self, user_id: uuid.UUID) -> str:
        caps = await self.caps(user_id)
        service = "openbinding-"
        json_limits = {
            name: value if value != float("inf") else None for name, value in caps.limits.items()
        }
        exp = int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp())
        claims = {
            "sub": str(user_id),
            "exp": exp,
            "features": {service + name: {"eval": value} for name, value in caps.features.items()},
            "pricingContext": {
                "features": {service + name: value for name, value in caps.features.items()},
                "usageLimits": {service + name: value for name, value in json_limits.items()},
            },
        }
        payload = base64.urlsafe_b64encode(json.dumps(claims, allow_nan=False).encode()).decode().rstrip("=")
        return f"fake.{payload}.unsigned"

    async def remove_contract(self, user_id: uuid.UUID) -> None:
        self._check_available()
        self.contracts.pop(user_id, None)
        self.plans.pop(user_id, None)
        self.versions.pop(user_id, None)
        self.add_ons.pop(user_id, None)
        self.renews_at.pop(user_id, None)
