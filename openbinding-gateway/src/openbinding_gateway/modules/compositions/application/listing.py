"""Filtering, sorting, paging and faceting a list of compositions, as SPHERE's pricing lists.

Adapted from SPHERE (SCORELabUS/SPHERE, MIT licence, revision 73779a8a),
``api/src/main/repositories/mongoose/aggregators/pricings/filters-data-generator.ts``: each numeric facet is its
minimum, its maximum and a histogram of ten buckets (nine equal ones up to the 80th percentile and one for the
rest). Two of SPHERE's defects are not copied: the facets are computed over the whole filtered set, never one
page, and a value equal to the percentile is counted (in the last bucket) instead of falling between two.

Every number comes from what a version stored when it was sealed: ``tasks`` and ``providers`` from the latest
version's ``analytics``, ``cost`` from the ``cost`` value of its latest evaluation. A composition without a
version (or without a cost) has none, sorts last, and is left out by any bound on that number. Each facet ignores
its own filter, so the owners facet still offers the organizations not chosen, and a range its full extent.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Literal, Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....db.models import Composition, CompositionEvaluation, Organization
from . import versions

Sort = Literal["name", "updated", "tasks", "cost"]
Order = Literal["asc", "desc"]
#: The numbers a list is bounded and faceted by.
RANGES = ("tasks", "providers", "cost")
#: How many buckets a range's histogram has, and the percentile the equal ones stop at (SPHERE's).
BUCKETS = 9
PERCENTILE = 0.8


@dataclass
class Entry:
    """One composition of a list, with its organization and the numbers it is filtered and sorted by."""

    composition: Composition
    organization: Organization
    summary: versions.Summary
    numbers: dict[str, float | None] = field(default_factory=dict)


@dataclass(frozen=True)
class Bounds:
    """The ``min_*``/``max_*`` of a request, by range name."""

    minimum: Mapping[str, float | None]
    maximum: Mapping[str, float | None]

    def admits(self, entry: Entry, *, skip: str | None = None) -> bool:
        for name in RANGES:
            if name == skip:
                continue
            low, high = self.minimum.get(name), self.maximum.get(name)
            if low is None and high is None:
                continue
            value = entry.numbers.get(name)
            if value is None or (low is not None and value < low) or (high is not None and value > high):
                return False
        return True


@dataclass(frozen=True)
class Listed:
    """One page of a list, how many match in all, and the facets of everything that matched."""

    entries: list[Entry]
    total: int
    facets: dict


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


async def gather(session: AsyncSession, rows: Sequence[tuple[Composition, Organization]]) -> list[Entry]:
    """The entries of ``rows``, with their latest version and its numbers, in four queries whatever their number."""
    found = await versions.summaries(session, [composition.id for composition, _ in rows])
    latest = {summary.latest.id: summary.latest for summary in found.values() if summary.latest is not None}
    costs: dict[uuid.UUID, float | None] = {}
    if latest:
        for version_id, values in (await session.execute(
            select(CompositionEvaluation.version_id, CompositionEvaluation.values)
            .where(CompositionEvaluation.version_id.in_(list(latest)))
            .order_by(CompositionEvaluation.created_at, CompositionEvaluation.id)
        )).all():
            cost = (values or {}).get("cost")
            costs[version_id] = _number(cost.get("value") if isinstance(cost, dict) else cost)
    entries = []
    for composition, organization in rows:
        summary = found[composition.id]
        version = summary.latest
        analytics = (version.analytics or {}) if version is not None else {}
        entries.append(Entry(composition, organization, summary, {
            "tasks": _number(analytics.get("tasks")) if version is not None else None,
            "providers": _number(analytics.get("providers")) if version is not None else None,
            "cost": costs.get(version.id) if version is not None else None,
        }))
    return entries


def _rounded(value: float) -> str:
    text = f"{round(value, 2):.2f}".rstrip("0").rstrip(".")
    return text or "0"


def histogram(values: Sequence[float]) -> dict:
    """``{min, max, data}`` of ``values``: SPHERE's ten buckets, ``[{value: "a-b", count}]`` and ``"p+"``."""
    data = sorted(values)
    if not data:
        return {"min": None, "max": None, "data": []}
    percentile = data[min(len(data) - 1, math.floor(len(data) * PERCENTILE))]
    width = percentile / BUCKETS
    buckets = []
    for index in range(BUCKETS):
        low, high = index * width, (index + 1) * width
        buckets.append({
            "value": f"{_rounded(low)}-{_rounded(high)}",
            "count": sum(1 for value in data if low <= value < high) if width > 0 else 0,
        })
    buckets.append({"value": f"{_rounded(percentile)}+", "count": sum(1 for value in data if value >= percentile)})
    return {"min": data[0], "max": data[-1], "data": buckets}


def facets(entries: Sequence[Entry], owners: set[str] | None, bounds: Bounds) -> dict:
    """The owners and ranges of every entry that matches the other filters."""
    counted: dict[str, dict] = {}
    for entry in entries:
        if not bounds.admits(entry):
            continue
        slot = counted.setdefault(entry.organization.slug, {
            "slug": entry.organization.slug, "name": entry.organization.name, "count": 0,
        })
        slot["count"] += 1
    ranges = {}
    for name in RANGES:
        values = [
            entry.numbers[name] for entry in entries
            if entry.numbers.get(name) is not None
            and (not owners or entry.organization.slug in owners)
            and bounds.admits(entry, skip=name)
        ]
        ranges[name] = histogram(values)
    return {
        "owners": sorted(counted.values(), key=lambda owner: (-owner["count"], owner["name"].casefold(), owner["slug"])),
        "ranges": ranges,
    }


def _key(sort: Sort):
    if sort == "name":
        return lambda entry: (entry.composition.name.casefold(), entry.composition.slug)
    if sort == "updated":
        return lambda entry: entry.composition.updated_at.timestamp()
    return lambda entry: entry.numbers.get(sort)


def arrange(
    entries: Sequence[Entry],
    *,
    owners: set[str] | None,
    bounds: Bounds,
    sort: Sort,
    order: Order | None,
    limit: int,
    offset: int,
) -> Listed:
    """Filter ``entries`` by owners and bounds, sort them (an entry without the number sorts last either way), and
    page them; the facets are those of every match. ``updated`` sorts the newest first unless ``order`` says."""
    matched = [
        entry for entry in entries
        if (not owners or entry.organization.slug in owners) and bounds.admits(entry)
    ]
    descending = order == "desc" if order is not None else sort == "updated"
    key = _key(sort)
    present = [entry for entry in matched if sort in ("name", "updated") or key(entry) is not None]
    absent = [entry for entry in matched if entry not in present]
    tie = {id(entry): (entry.composition.slug, str(entry.composition.id)) for entry in matched}
    present.sort(key=lambda entry: tie[id(entry)])
    present.sort(key=key, reverse=descending)
    absent.sort(key=lambda entry: tie[id(entry)])
    ordered = present + absent
    return Listed(ordered[offset:offset + limit], len(ordered), facets(entries, owners, bounds))


def split(value: str | None) -> set[str] | None:
    """A comma-separated query parameter as a set, ``None`` when absent or empty."""
    parts = {part.strip() for part in (value or "").split(",") if part.strip()}
    return parts or None
