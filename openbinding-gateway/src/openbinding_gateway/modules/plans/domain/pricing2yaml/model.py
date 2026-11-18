"""The normalised reading of a Pricing2Yaml 3.x document (``normalise``) and its values.

Semantics followed from pricing4ts 0.12.1 (``pricing-parser.js``, ``pricing-validators.js``,
``version-manager.js``; MIT, Copyright (c) 2024 Alejandro García Fernández; no code copied) and
pricing-renderer v0.2.0 (``src/core/normalize.ts``, ``compare-values.ts``, ``breakdown.ts``; MIT,
Copyright (c) 2026 Francisco Javier Cavero), choosing pricing-renderer where they differ.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..errors import PricingDiagnostic

FEATURE_TYPES = frozenset(
    {"INFORMATION", "INTEGRATION", "DOMAIN", "AUTOMATION", "MANAGEMENT", "GUARANTEE", "SUPPORT", "PAYMENT"}
)
#: pricing4ts's sentinel for "unlimited" in a NUMERIC value (``unlimitedValue``).
UNLIMITED_SENTINEL = 1e8
UNLIMITED_TEXT = frozenset({".inf", "Infinity", "unlimited"})


@dataclass(frozen=True)
class Unlimited:
    """An unlimited value; ``raw`` is what the document wrote (``.inf``, ``null``, ``100000000``)."""

    raw: Any = None


#: A feature or limit value; a PAYMENT feature may hold a list (plain JSON data).
Value = float | bool | str | Unlimited | list | dict | None


@dataclass(frozen=True)
class Fixed:
    amount: float
    kind: str = "fixed"


@dataclass(frozen=True)
class Expression:
    source: str
    value: float | None
    error: str | None = None
    dependencies: tuple[str, ...] = ()
    kind: str = "expression"


@dataclass(frozen=True)
class Label:
    text: str
    kind: str = "label"


Price = Fixed | Expression | Label


@dataclass(frozen=True)
class Billing:
    id: str
    multiplier: float
    synthesized: bool = False


@dataclass(frozen=True)
class FeatureDef:
    name: str
    display_name: str
    type: str | None
    value_type: str | None
    default: Value
    doc_url: str | None = None
    description: str | None = None


@dataclass(frozen=True)
class LimitDef:
    name: str
    display_name: str
    value_type: str | None
    default: Value
    unit: str | None
    type: str | None
    period: Any
    linked_features: tuple[str, ...] = ()
    description: str | None = None


@dataclass(frozen=True)
class Plan:
    name: str
    display_name: str
    price: Price
    unit: str | None
    private: bool
    #: Every global feature and usage limit: the plan's own value over the default.
    features: Mapping[str, Value]
    limits: Mapping[str, Value]
    description: str | None = None


@dataclass(frozen=True)
class AddOn:
    name: str
    display_name: str
    price: Price
    unit: str | None
    available_for: tuple[str, ...]
    depends_on: tuple[str, ...]
    excludes: tuple[str, ...]
    private: bool
    #: Only what the add-on overrides or extends.
    features: Mapping[str, Value]
    limits: Mapping[str, Value]
    extensions: Mapping[str, float]
    metered: bool
    metered_quantity: float | None
    min_quantity: float = 1
    max_quantity: float | None = None
    quantity_step: float = 1
    description: str | None = None


@dataclass(frozen=True)
class NormalisedPricing:
    syntax_version: str
    title: str
    version: str | None
    created_at: str | None
    currency: str
    billing: tuple[Billing, ...]
    variables: Mapping[str, Any]
    features: Mapping[str, FeatureDef]
    usage_limits: Mapping[str, LimitDef]
    plans: Mapping[str, Plan]
    add_ons: Mapping[str, AddOn]
    diagnostics: tuple[PricingDiagnostic, ...] = field(default_factory=tuple)

    @property
    def valid(self) -> bool:
        return not any(d.severity == "error" for d in self.diagnostics)

    def default_billing(self) -> Billing:
        """The period pricing-renderer selects first: multiplier 1, else the first one."""
        return next((b for b in self.billing if b.multiplier == 1), self.billing[0])
