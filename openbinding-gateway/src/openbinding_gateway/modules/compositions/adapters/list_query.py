"""The query parameters every composition list takes: owners, kinds, sorting and the bounds of its numbers."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Query

from ....db.models import CompositionKind
from ....models.errors import api_error
from ..application import listing
from .schemas import CompositionFacets


@dataclass(frozen=True)
class ListQuery:
    owners: set[str] | None
    kinds: set[CompositionKind] | None
    sort: listing.Sort
    order: listing.Order | None
    bounds: listing.Bounds


def list_query(default_sort: listing.Sort):
    """A dependency reading the list parameters, with ``default_sort`` when the request names none."""

    def read(
        owners: str | None = Query(
            default=None, max_length=2000, description="Only these organizations (comma-separated slugs).",
        ),
        kinds: str | None = Query(
            default=None, max_length=200, description="Only these kinds (comma-separated: application, workflow, "
            "pipeline, system).",
        ),
        sort: listing.Sort = Query(
            default=default_sort, description="By `name`, the most recently `updated`, the number of `tasks` of the "
            "latest version, or its `cost` value.",
        ),
        order: listing.Order | None = Query(
            default=None, description="`asc` or `desc`; by default `updated` is newest first, the others ascending. "
            "A composition without the number sorts last either way.",
        ),
        min_tasks: float | None = Query(default=None, ge=0),
        max_tasks: float | None = Query(default=None, ge=0),
        min_providers: float | None = Query(default=None, ge=0),
        max_providers: float | None = Query(default=None, ge=0),
        min_cost: float | None = Query(default=None),
        max_cost: float | None = Query(default=None),
    ) -> ListQuery:
        chosen = listing.split(kinds)
        try:
            parsed = {CompositionKind(kind) for kind in chosen} if chosen else None
        except ValueError:
            raise api_error(422, "invalid_kind", "Each kind is application, workflow, pipeline or system.") from None
        return ListQuery(
            owners=listing.split(owners), kinds=parsed, sort=sort, order=order,
            bounds=listing.Bounds(
                {"tasks": min_tasks, "providers": min_providers, "cost": min_cost},
                {"tasks": max_tasks, "providers": max_providers, "cost": max_cost},
            ),
        )

    return read


def facets_view(facets: dict) -> CompositionFacets:
    return CompositionFacets.model_validate(facets)
