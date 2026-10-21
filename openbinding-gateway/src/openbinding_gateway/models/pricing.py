"""Wire contract of the read-only published-pricing endpoints."""

from __future__ import annotations

from pydantic import BaseModel


class PricingCurrentView(BaseModel):
    version: str
    digest: str
    url: str
