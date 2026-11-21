"""Rows for the F6 upstream tests, written without HTTP (SQLite and PostgreSQL alike).

Not a test module. ``watch`` writes a ``pricing_watches`` row (public by default, or scoped to an organization),
``ref`` a ``pricing_watch_refs`` row of a version, ``attempt`` a ``pricing_ref_attempts`` row and ``event`` a
``composition_upstream_events`` row, each with the smallest valid values; ``world`` is ``_environment_rows.world``.
"""

from __future__ import annotations

import uuid

from _environment_rows import World, world  # noqa: F401 - re-exported for the tests
from openbinding_gateway.db.models import (
    CompositionUpstreamEvent,
    PricingRefAttempt,
    PricingWatch,
    PricingWatchRef,
)

BREVO = "6ade2d4440e55445692b07f1"
BREVO_2026_10 = "6ade2d444b2b5b01c587d80d"
BREVO_2026_11 = "6fff00000000000000000001"


async def watch(session, *, pricing_id: str | None = None, organization_id: uuid.UUID | None = None, **values) -> uuid.UUID:
    pricing_id = pricing_id or uuid.uuid4().hex[:24]
    scope = str(organization_id) if organization_id else "public"
    fields = {"source_kind": "sphere", "pricing_id": pricing_id, "scope_key": scope, "organization_id": organization_id,
              "watch_key": f"sphere|{pricing_id}|{scope}"} | values
    row = PricingWatch(**fields)
    session.add(row)
    await session.flush()
    return row.id


async def ref(session, w: World, watch_id: uuid.UUID | None, *, version_index: int = 0, pinned: str = BREVO_2026_10,
              subject: str = "binding", **values) -> uuid.UUID:
    version_id = w.versions[version_index]
    key = f"{watch_id or 'unresolved:' + values.get('sphere_ref', 'x/y')}|{subject}|{pinned or '-'}"
    fields = {
        "organization_id": w.organization_id, "composition_id": w.composition_id, "version_id": version_id,
        "watch_id": watch_id, "subject": subject, "via": "offering" if subject == "offering" else "from",
        "pinned_version_id": pinned, "ref_key": key,
        "selection": {} if subject == "offering" else {"dailySummary": {"plan": "PROFESSIONAL", "addOns": []}},
    } | values
    row = PricingWatchRef(**fields)
    session.add(row)
    await session.flush()
    return row.id


async def attempt(session, organization_id: uuid.UUID, sphere_ref: str = "nobody/nothing", pinned: str | None = None) -> uuid.UUID:
    row = PricingRefAttempt(
        organization_id=organization_id, sphere_ref=sphere_ref, pinned_version_id=pinned,
        attempt_key=f"{organization_id}|{sphere_ref}|{pinned or '-'}",
    )
    session.add(row)
    await session.flush()
    return row.id


async def event(session, w: World, watch_id: uuid.UUID, *, version_index: int = 0, subject: str = "binding",
                category: str = "values_changed", old: str = BREVO_2026_10, new: str = BREVO_2026_11,
                **values) -> uuid.UUID:
    row = CompositionUpstreamEvent(
        organization_id=w.organization_id, composition_id=w.composition_id, version_id=w.versions[version_index],
        watch_id=watch_id, subject=subject, category="offering_changed" if subject == "offering" else category,
        notify=True, old_ref=old, new_ref=new, old_version_id=old, new_version_id=new, diff={"schema": "x"},
        classifier="1", **values,
    )
    session.add(row)
    await session.flush()
    return row.id
