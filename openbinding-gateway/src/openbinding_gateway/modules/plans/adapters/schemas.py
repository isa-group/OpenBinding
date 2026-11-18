"""What the plans routes read and answer: organization connections, SPHERE discovery, snapshots, the own pricing."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class SphereConnectionUpdate(_Camel):
    """The key of a SPHERE connection: ``sk-`` and 64 hexadecimal characters. It is written, never read back."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")
    api_key: str = Field(min_length=1, max_length=200, description="The SPHERE API key (write-only).")


class ConnectionScope(_Camel):
    organization_id: str = Field(description="A SPHERE organization the key may act in.")
    scope: str = Field(description="The key's scope there (`VIEW`, `MANAGEMENT`, `ALL`).")


class ConnectionView(_Camel):
    """An organization's connection. The secret is never returned; `keyHint` is its last four characters."""

    kind: Literal["sphere", "space"]
    status: Literal["active", "invalid"] = Field(description="`invalid` once SPHERE refused the key.")
    username: Optional[str] = Field(default=None, description="The SPHERE user the key belongs to.")
    scopes: Optional[list[ConnectionScope]] = Field(
        default=None,
        description="The SPHERE organizations the key may act in, as SPHERE reported them (null when it did not).",
    )
    key_hint: str
    validated_at: Optional[datetime] = None
    expires_at: Optional[str] = None


class ConnectionList(_Camel):
    connections: list[ConnectionView]


class Facets(_Camel):
    """SPHERE's histograms over the whole result (never computed from one page)."""

    min_price: Optional[dict[str, Any]] = None
    max_price: Optional[dict[str, Any]] = None
    configuration_space_size: Optional[dict[str, Any]] = None


class SphereOwner(_Camel):
    name: str
    display_name: Optional[str] = None


class SphereLatestVersion(_Camel):
    id: str
    label: str
    created_at: Optional[str] = None


class SphereAnalytics(_Camel):
    plans: Optional[int] = None
    add_ons: Optional[int] = None
    features: Optional[int] = None
    configuration_space_size: Optional[int] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None


class SphereCollection(_Camel):
    id: str
    name: Optional[str] = None
    slug: Optional[str] = None


class SpherePricingRow(_Camel):
    pricing_id: str
    name: str
    slug: str
    owner: Optional[SphereOwner] = None
    collection: Optional[SphereCollection] = None
    latest_version: SphereLatestVersion
    currency: Optional[str] = None
    private: bool = False
    analytics: SphereAnalytics


class SpherePricingSearch(_Camel):
    pricings: list[SpherePricingRow]
    total: int
    facets: Facets
    connected: bool = Field(description="Whether the organization has an active SPHERE connection.")
    registries: list[str] = Field(description="The SPHERE registries this deployment can read, by alias.")


class SphereVersionEntry(_Camel):
    version_id: str
    label: str
    created_at: Optional[str] = None
    private: bool = False


class SphereManifestView(_Camel):
    pricing_id: str
    name: str
    permanent_url: str
    latest_version_id: str
    versions: list[SphereVersionEntry] = Field(description="Newest first by date (SPHERE's latest is by date).")


class PricingSnapshotView(_Camel):
    """A stored upstream pricing version: where it came from and what it is, by name (no digests)."""

    id: str
    source: Literal["sphere", "registry", "url"]
    registry: Optional[str] = None
    pricing_id: Optional[str] = None
    version_id: Optional[str] = None
    version_label: Optional[str] = None
    version_created_at: Optional[str] = None
    owner: Optional[str] = None
    slug: Optional[str] = None
    title: str
    collection: Optional[str] = None
    url: Optional[str] = None
    currency: Optional[str] = None
    syntax_version: Optional[str] = None
    valid: bool
    fetched_at: datetime
    renamed: bool = Field(description="Whether an earlier snapshot of the same source had the same content.")
    permanent_url: Optional[str] = None
    yaml_href: str


class SphereVersionView(_Camel):
    snapshot: PricingSnapshotView
    summary: dict[str, Any] = Field(description="The normalised pricing: plans, add-ons (metered apart), features, limits.")
    diagnostics: list[dict[str, Any]]


class PlansPricingView(_Camel):
    """OpenBinding's own published pricing, read through the pricing source."""

    pricing_id: str
    name: str
    version: str
    version_id: str
    created_at: Optional[str] = None
    permanent_url: str
    yaml: str = Field(description="The Pricing2Yaml text, for pricing-renderer.")
    document: dict[str, Any] = Field(description="The parsed document as JSON (`.inf` is null).")
