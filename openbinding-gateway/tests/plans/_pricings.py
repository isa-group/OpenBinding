"""Recorded pricings by role, normalised (shared by the plans tests)."""

from __future__ import annotations

import json
from functools import lru_cache

from openbinding_gateway.modules.plans.domain.pricing2yaml import NormalisedPricing, normalise_text
from sphere_recorded import SFX

TOMATOMETER = "6ab0a323697330667ccce8cd"
SET_B = {
    "sendgrid": "6adf1a6240e55445692b6f14",
    "mailgun": "6ade364540e55445692b0eda",
    "brevo": "6ade2d4440e55445692b07f1",
    "resend": "6ade2d2540e55445692b07c6",
    "postmark": "6ade2f3b40e55445692b09aa",
}
SET_A = {
    "sendgrid": "6ae0772d40e55445692c0143",
    "mailgun": "6ae077ac40e55445692c01ce",
    "brevo": "6ae0768440e55445692c0081",
    "resend": "6ae076f340e55445692c0101",
    "postmark": "6ae0776f40e55445692c018c",
}
DROPBOX = "6ab0a323697330667ccce9c1"
DROPBOX_2021 = "687e4b68102baa50f3a5c7b7"
DROPBOX_2023 = "687e4b68102baa50f3a5c7b5"
DROPBOX_2024 = "687e4b68102baa50f3a5c7b6"
DROPBOX_25 = "6ab0a323697330667ccce93d"
OPENBINDING = "6ab0a323697330667ccce891"
OPENBINDING_020 = "6ada6dbd4b2b5b01c587d17f"
RESEND_SPHERE = "6ab0a323697330667cccea11"


def latest(pricing_id: str) -> str:
    return json.loads((SFX / pricing_id / "manifest.json").read_text())["latestVersionId"]


def raw(pricing_id: str, version_id: str | None = None) -> bytes:
    return (SFX / pricing_id / f"{version_id or latest(pricing_id)}.yml").read_bytes()


@lru_cache(maxsize=64)
def pricing(pricing_id: str, version_id: str | None = None) -> NormalisedPricing:
    return normalise_text(raw(pricing_id, version_id))
