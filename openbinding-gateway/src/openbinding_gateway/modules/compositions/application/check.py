"""Checking an environment against its sources now: a manual, read-only report (plan §10 F4 "Comprobar ahora").

``check_environment`` judges the version in effect and compares what it pins with what its sources publish now:

* ``binding``: the stored content assessed on the installed toolchain, as ``versions/check`` assesses a document
  (``valid``, ``invalid``, or ``declared`` for a version without a problem);
* ``upstream``: one row per bound task whose ``from`` has a stored snapshot (the ones the upstream view resolves),
  its pinned version against the manifest's ``latestVersionId`` (``current`` or ``newer``; "latest" is SPHERE's,
  never the highest label); a task without a snapshot is ``not_snapshotted``, one whose source cannot be read now
  ``unavailable``;
* ``offering``: the offering version the adoption's pinned evaluation read, against the latest one (a URL
  offering: its bytes now against the pinned snapshot's digest, in memory).

It writes nothing: no snapshot, row, audit, event or notification, and the feed and its ETag stay as they were. It
reads manifests through the pricing port (its cache and back-off), at most ``MAX_MANIFEST_READS`` of them, outside
any transaction and within ``DEADLINE_S``; every port error is ``unavailable``, never a 5xx. Classification, watches,
events and badges are F6's poller, which reuses these reads.
"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....composition import text
from ....db.models import (
    Composition,
    CompositionAdoption,
    CompositionEnvironment,
    CompositionEvaluation,
    CompositionVersion,
    Organization,
    PricingSnapshot,
    User,
)
from ....models.errors import api_error
from ...plans.application import (
    NotModified,
    SphereEndpoint,
    credential_for,
    get_pricing_source,
    sphere_manifest,
)
from . import seal, upstream, versions
from .language import diagnostic_view

#: Manifests one check may read.
MAX_MANIFEST_READS = 8
#: The longest the reads of one check may take together.
DEADLINE_S = 10.0


def _named(version_id: str | None, name: str | None, created_at: str | None) -> dict[str, Any] | None:
    if version_id is None and name is None:
        return None
    return {"versionId": version_id, "name": name, "createdAt": created_at}


class _Reads:
    """The manifest reads of one check: bounded, shared by rows naming the same pricing, never raising."""

    def __init__(self, session: AsyncSession, organization: Organization) -> None:
        self.session = session
        self.organization = organization
        self.left = MAX_MANIFEST_READS
        self.found: dict[tuple[str | None, str], Any] = {}
        self.credential: Any = None
        self.credential_read = False

    async def latest(self, registry: str | None, pricing_id: str) -> dict[str, Any] | None:
        """The manifest's latest version, or ``None`` when it cannot be read now (or the budget is spent)."""
        key = (registry, pricing_id)
        if key not in self.found:
            if self.left <= 0:
                return None
            self.left -= 1
            try:
                if registry is None and not self.credential_read:
                    self.credential_read = True
                    self.credential = await credential_for(self.session, self.organization.id)
                manifest = await sphere_manifest(
                    SphereEndpoint(registry), pricing_id, self.credential if registry is None else None,
                )
                latest = manifest.version(manifest.latest_version_id)
                self.found[key] = {
                    "versionId": manifest.latest_version_id,
                    "name": latest.label if latest is not None else None,
                    "createdAt": latest.created_at if latest is not None else None,
                }
            except Exception:  # noqa: BLE001 - busy, down, private without a connection: unavailable
                self.found[key] = None
        return self.found[key]


async def _binding(
    session: AsyncSession, organization: Organization, composition: Composition, version: CompositionVersion,
    caller: User,
) -> dict[str, Any]:
    checked = await seal.judge(session, organization, composition.slug, version.content.encode("utf-8"), caller)
    declared = checked.assessment is not None and checked.assessment.document.problem is None
    state = "invalid" if not checked.valid else ("declared" if declared else "valid")
    return {
        "status": state,
        "toolchain": None if declared else versions.installed_basis(),
        "diagnostics": [diagnostic_view(item) for item in checked.diagnostics],
    }


async def _upstream(
    session: AsyncSession, organization: Organization, version: CompositionVersion, reads: _Reads,
) -> list[dict[str, Any]]:
    reading = text.read(version.content)
    if reading.document is None:
        return []
    view = await upstream.upstream(session, organization, version, reading.document, member=True)
    rows = []
    for entry in view["entries"]:
        source = entry.get("from")
        if not source:
            continue
        row: dict[str, Any] = {
            "task": entry["task"], "sphere": source.get("sphere"), "plan": source.get("plan"),
            "pinned": None, "latest": None, "status": "not_snapshotted",
        }
        snapshot = entry.get("snapshot")
        if entry["status"] == "registry_unknown":
            row["status"] = "unavailable"
        elif snapshot is not None and snapshot.get("pricingId"):
            row["pinned"] = _named(snapshot["versionId"], snapshot["versionName"], snapshot["createdAt"])
            latest = await reads.latest(snapshot.get("registry"), snapshot["pricingId"])
            if latest is None:
                row["status"] = "unavailable"
            else:
                row["latest"] = latest
                row["status"] = "current" if latest["versionId"] == snapshot["versionId"] else "newer"
        rows.append(row)
    return rows


async def _offering(
    session: AsyncSession, version: CompositionVersion, evaluation: CompositionEvaluation | None, reads: _Reads,
) -> dict[str, Any]:
    source = dict(version.offering) if version.offering else None
    if source is None:
        return {"source": None, "pinned": None, "latest": None, "status": "none"}
    snapshot = None
    if evaluation is not None and evaluation.offering_snapshot_id is not None:
        snapshot = await session.get(PricingSnapshot, evaluation.offering_snapshot_id)
    pinned = None if snapshot is None else {"versionName": snapshot.version_label, "createdAt": snapshot.version_created_at}
    answer: dict[str, Any] = {"source": source, "pinned": pinned, "latest": None, "status": "unavailable"}
    if snapshot is None:
        return answer
    if source.get("url"):
        try:
            fetched = await get_pricing_source().url_yaml(source["url"], if_none_match=snapshot.etag)
        except Exception:  # noqa: BLE001 - unreadable now
            return answer
        if isinstance(fetched, NotModified):
            same = True
        else:
            same = hashlib.sha256(fetched.body).hexdigest() == snapshot.sha256
        answer["latest"] = pinned if same else {"versionName": None, "createdAt": None}
        answer["status"] = "current" if same else "newer"
        return answer
    if snapshot.pricing_id is None:
        return answer
    latest = await reads.latest(snapshot.registry, snapshot.pricing_id)
    if latest is None:
        return answer
    answer["latest"] = {"versionName": latest["name"], "createdAt": latest["createdAt"]}
    answer["status"] = "current" if latest["versionId"] == snapshot.version_id else "newer"
    return answer


async def check_environment(
    session: AsyncSession,
    organization: Organization,
    composition: Composition,
    environment: CompositionEnvironment,
    caller: User,
) -> dict[str, Any]:
    """The report of ``environment`` now (see the module docstring); 409 ``nothing_adopted`` before an adoption."""
    if environment.adopted_version_id is None:
        raise api_error(status.HTTP_409_CONFLICT, "nothing_adopted", "Nothing is adopted in this environment yet.")
    version = await session.get(CompositionVersion, environment.adopted_version_id)
    adoption = await session.scalar(select(CompositionAdoption).where(
        CompositionAdoption.environment_id == environment.id,
        CompositionAdoption.ordinal == environment.adoption_ordinal,
    ))
    evaluation = await session.get(CompositionEvaluation, adoption.evaluation_id) if adoption is not None else None
    binding = await _binding(session, organization, composition, version, caller)
    # Nothing read from here on is held across the network reads, and nothing is written.
    await session.commit()
    reads = _Reads(session, organization)

    async def remote() -> tuple[list[dict[str, Any]], dict[str, Any]]:
        return await _upstream(session, organization, version, reads), await _offering(session, version, evaluation, reads)

    try:
        rows, offering = await asyncio.wait_for(remote(), DEADLINE_S)
    except asyncio.TimeoutError:
        rows = await _upstream_unread(session, organization, version)
        offering = {"source": dict(version.offering) if version.offering else None, "pinned": None, "latest": None,
                    "status": "unavailable" if version.offering else "none"}
    return {
        "checkedAt": datetime.now(timezone.utc),
        "version": {"id": version.id, "label": version.label},
        "binding": binding,
        "upstream": rows,
        "offering": offering,
    }


async def _upstream_unread(
    session: AsyncSession, organization: Organization, version: CompositionVersion,
) -> list[dict[str, Any]]:
    """The upstream rows when the deadline passed: what is pinned, and nothing known of what is latest."""
    reads = _Reads(session, organization)
    reads.left = 0
    rows = await _upstream(session, organization, version, reads)
    return rows
