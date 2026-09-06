"""Wire contracts for the SPHERE/SPACE pricing control room."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class PricingYamlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    yaml: str = Field(..., min_length=1, max_length=2 * 1024 * 1024)
    changelog: str = Field(default="", max_length=4000)
    migration_manifest: dict[str, Any] = Field(default_factory=dict)


class PricingPublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_version: str
    version: str
    changelog: str = Field(..., min_length=1, max_length=4000)
    migration_manifest: dict[str, Any] = Field(default_factory=dict)


class PricingForkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str
    changelog: str = Field(default="", max_length=4000)


class PricingConfirmation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation: str


class PricingArchiveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fallback: dict[str, Any] = Field(default_factory=dict)


class PricingValidationView(BaseModel):
    valid: bool
    version: str | None = None
    digest: str | None = None
    syntax_version: str | None = None
    plans: list[str] = Field(default_factory=list)
    add_ons: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class PricingReleaseView(BaseModel):
    id: uuid.UUID
    version: str
    digest: str
    sphere_organization: Literal["OpenBinding"]
    sphere_organization_id: str
    sphere_slug: Literal["openbinding"]
    sphere_state: Literal["PRIVATE_DRAFT", "PUBLIC_RELEASE"]
    space_state: Literal["NOT_DEPLOYED", "ACTIVE", "DRAINING", "ARCHIVED"]
    is_live: bool
    public_url: str | None = None
    changelog: str
    migration_manifest: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class PricingCurrentView(BaseModel):
    version: str
    digest: str
    url: str


class PricingActionResult(BaseModel):
    release: PricingReleaseView
    message: str

