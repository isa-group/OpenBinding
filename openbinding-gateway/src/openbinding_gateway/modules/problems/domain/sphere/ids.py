"""Deterministic ids of generated candidates and catalogs.

A generated candidate is ``<service>.<provider>.<plan>[.<addon>]``, each segment slugged (NFKD to ASCII, lower
case, every run of other characters to ``-``, trimmed). Its catalog is ``sphere-<service>``, which carries no
pricing version, so the key ``sphere-email/email.mailgun.foundation`` survives new pricing versions and renames.
Two plans or variants with one slug (``Pro`` and ``PRO``) are a collision, never a silent suffix, and an id over
128 characters is refused: the raw names are kept in the value origins and the binding's ``from``.
"""

from __future__ import annotations

import re
import unicodedata

#: The container's pattern for a candidate id (a map key).
CANDIDATE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$")
MAX_ID = 128
CATALOG_PREFIX = "sphere-"


def slug(text: str) -> str:
    """``Business Plus (Yearly)`` -> ``business-plus-yearly``; ``""`` when nothing is left."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")


def candidate_id(service: str, provider: str, plan: str, add_on: str | None = None) -> str:
    """The id of a plan (or a plan with one add-on) of a provider; may be empty-segmented or too long, which
    ``id_problem`` reports."""
    segments = [service, provider, slug(plan)]
    if add_on is not None:
        segments.append(slug(add_on))
    return ".".join(segments)


def id_problem(identifier: str) -> str | None:
    """Why ``identifier`` cannot be a candidate id (``too_long``, ``empty``, ``pattern``), or ``None``."""
    if len(identifier) > MAX_ID:
        return "too_long"
    if any(not segment for segment in identifier.split(".")):
        return "empty"
    if not CANDIDATE_ID.fullmatch(identifier):
        return "pattern"
    return None


def catalog_resource(service: str) -> str:
    return CATALOG_PREFIX + service


def catalog_path(service: str) -> str:
    return f"{CATALOG_PREFIX}{service}.json"


def candidate_key(resource: str, identifier: str) -> str:
    return f"{resource}/{identifier}"
