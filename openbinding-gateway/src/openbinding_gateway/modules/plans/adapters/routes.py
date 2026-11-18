"""The plans routes under ``/v1/organizations/{org}``: connections, SPHERE discovery and pricing snapshots.

Connections are an organization ADMIN's: the key is written, validated by SPHERE and never read back.
A MEMBER searches SPHERE, lists a family's versions and reads one version (``/sphere/pricings/...``) through the
gateway, never from the browser; every unreadable pricing is the same 404. Snapshots are read by whoever may
read the organization (a visitor of an organization that publishes a composition included), a private one only
by members of its organization.
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import Response as RawResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....access.dependencies import get_current_user, get_reader, session_dependency
from ....access.work_limits import charge_anonymous_read, limit_work
from ....collaboration import effective_role, organization_by_ref, require_role
from ....core import revision as etags
from ....core.public_errors import PUBLISHED_PRICING_UNAVAILABLE, pricing_unavailable_error
from ....core.settings import Settings, get_settings
from ....db.models import Composition, CompositionVersion, Organization, OrganizationRole, PricingSnapshot, User
from ....models.errors import NOT_FOUND_RESPONSE, ErrorResponse, api_error
from ..application import connections, discovery
from ..application.own_pricing import OwnPricingUnavailable, own_pricing
from ..application.pricing_source import (
    PricingNotFound,
    PricingSourceBusy,
    PricingSourceUnavailable,
    get_pricing_source,
)
from ..application.snapshots import read_snapshot, snapshot_bytes
from ..domain.errors import PricingInvalid
from ..domain.sources import MAX_PAGE, SearchQuery, SearchRow, SphereEndpoint, is_sphere_id
from .schemas import (
    PlansPricingView,
    ConnectionList,
    ConnectionScope,
    ConnectionView,
    Facets,
    PricingSnapshotView,
    SphereAnalytics,
    SphereCollection,
    SphereConnectionUpdate,
    SphereLatestVersion,
    SphereManifestView,
    SphereOwner,
    SpherePricingRow,
    SpherePricingSearch,
    SphereVersionEntry,
    SphereVersionView,
)

router = APIRouter(prefix="/v1/organizations/{org}", tags=["Organizations"])
#: OpenBinding's own plans, public.
public_router = APIRouter(prefix="/v1/plans", tags=["Pricing"])

FORBIDDEN_RESPONSE = {"model": ErrorResponse, "description": "The caller is not an ADMIN of the organization."}


async def _organization(session: AsyncSession, org: str, user: User, minimum: OrganizationRole) -> Organization:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")
    await require_role(session, organization, user, minimum)
    return organization


def _connection(row) -> ConnectionView:
    shown = connections.view(row)
    return ConnectionView(
        kind=shown.kind,  # type: ignore[arg-type]
        status=shown.status,  # type: ignore[arg-type]
        username=shown.username,
        scopes=[ConnectionScope(organization_id=s["organizationId"], scope=s["scope"]) for s in shown.scopes]
        if shown.scopes is not None else None,
        key_hint=shown.key_hint,
        validated_at=etags.normalise(shown.validated_at) if shown.validated_at else None,
        expires_at=shown.expires_at,
    )


@router.get(
    "/connections",
    operation_id="listOrganizationConnections",
    summary="The organization's connections (never their secrets)",
    response_model=ConnectionList,
    responses={403: FORBIDDEN_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def list_connections(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ConnectionList:
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    rows = await connections.list_connections(session, organization.id)
    return ConnectionList(connections=[_connection(row) for row in rows])


@router.put(
    "/connections/sphere",
    operation_id="putOrganizationSphereConnection",
    summary="Connect the organization to SPHERE with an API key (write-only)",
    response_model=ConnectionView,
    dependencies=[Depends(limit_work)],
    responses={
        **etags.EDIT_RESPONSES,
        403: FORBIDDEN_RESPONSE,
        404: NOT_FOUND_RESPONSE,
        422: {
            "model": ErrorResponse,
            "description": "The key is malformed (`sphere_key_malformed`) or SPHERE refused it (`sphere_key_rejected`).",
        },
        503: {
            "model": ErrorResponse,
            "description": "No secrets can be kept (`secrets_unavailable`), or SPHERE is busy or unreachable "
            "(`sphere_busy`, `sphere_unavailable`).",
        },
    },
)
async def put_sphere_connection(
    org: str,
    body: SphereConnectionUpdate,
    response: Response,
    if_match: str | None = etags.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ConnectionView:
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    row = await connections.put_sphere_key(session, organization.id, body.api_key, user, if_match)
    etags.set_etag(response, row)
    return _connection(row)


@router.delete(
    "/connections/sphere",
    operation_id="deleteOrganizationSphereConnection",
    summary="Remove the organization's SPHERE connection and its key",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={403: FORBIDDEN_RESPONSE, 404: NOT_FOUND_RESPONSE},
)
async def delete_sphere_connection(
    org: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> Response:
    organization = await _organization(session, org, user, OrganizationRole.ADMIN)
    if not await connections.delete_connection(session, organization.id, user):
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "The organization has no SPHERE connection.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# -- SPHERE discovery ----------------------------------------------------------------------------------------------

PRICING_NOT_FOUND = "sphere_pricing_not_found"
SNAPSHOT_NOT_FOUND = "pricing_snapshot_not_found"
SPHERE_RESPONSES = {
    403: {"model": ErrorResponse, "description": "The caller is not a MEMBER of the organization."},
    404: {"model": ErrorResponse, "description": "No such SPHERE pricing, or none this organization may read (`sphere_pricing_not_found`)."},
    422: {"model": ErrorResponse, "description": "An unknown registry (`sphere_registry_unknown`), or a version the "
          "gateway does not read (`sphere_syntax_unsupported`, `sphere_pricing_invalid`)."},
    503: {"model": ErrorResponse, "description": "SPHERE is busy (`sphere_busy`, with `Retry-After`) or unavailable "
          "(`sphere_unavailable`)."},
}


def _not_found(code: str = PRICING_NOT_FOUND):
    return api_error(status.HTTP_404_NOT_FOUND, code, "No such pricing, or none this organization may read.")


def _sphere_error(exc: Exception):
    if isinstance(exc, PricingNotFound):
        return _not_found()
    if isinstance(exc, PricingSourceBusy):
        return api_error(503, "sphere_busy", "SPHERE is busy; try again later.", headers={"Retry-After": str(exc.retry_after)})
    if isinstance(exc, PricingSourceUnavailable):
        if exc.reason == "registry_unknown":
            return api_error(422, "sphere_registry_unknown", "No SPHERE registry is configured with that alias.")
        return api_error(503, "sphere_unavailable", "SPHERE cannot be read right now.", reason=exc.reason)
    if isinstance(exc, PricingInvalid):
        return api_error(422, exc.code if exc.code.startswith("sphere_") else "sphere_pricing_invalid", exc.message,
                         diagnostics=[d.as_dict() for d in exc.diagnostics])
    return None


def _endpoint(registry: str | None) -> SphereEndpoint:
    if registry is None:
        return SphereEndpoint()
    if registry not in get_pricing_source().registries():
        raise api_error(422, "sphere_registry_unknown", "No SPHERE registry is configured with that alias.")
    return SphereEndpoint(registry)


async def _credential(session: AsyncSession, organization: Organization, where: SphereEndpoint):
    if where.registry is not None:
        return None
    return await connections.credential_for(session, organization.id)


def _row(row: SearchRow) -> SpherePricingRow:
    analytics = row.analytics
    return SpherePricingRow(
        pricing_id=row.pricing_id,
        name=row.name,
        slug=row.slug,
        owner=SphereOwner(name=row.organization.name, display_name=row.organization.display_name)
        if row.organization else None,
        collection=SphereCollection(id=str(row.collection["id"]), name=row.collection.get("name"),
                                    slug=row.collection.get("slug")) if row.collection else None,
        latest_version=SphereLatestVersion(id=row.version_id, label=row.version_label, created_at=row.created_at),
        currency=row.currency,
        private=row.private,
        analytics=SphereAnalytics(
            plans=analytics.get("numberOfPlans"), add_ons=analytics.get("numberOfAddOns"),
            features=analytics.get("numberOfFeatures"), configuration_space_size=analytics.get("configurationSpaceSize"),
            min_price=analytics.get("minSubscriptionPrice"), max_price=analytics.get("maxSubscriptionPrice"),
        ),
    )


@router.get(
    "/sphere/pricings",
    operation_id="searchSpherePricings",
    summary="Search SPHERE's pricings (and, with a connection, a connected organization's private ones)",
    tags=["Pricing"],
    response_model=SpherePricingSearch,
    dependencies=[Depends(limit_work)],
    responses=SPHERE_RESPONSES,
)
async def search_sphere_pricings(
    org: str,
    q: str | None = Query(default=None, max_length=120, description="Words of the pricing's name."),
    collection: str | None = Query(default=None, max_length=160, description="A SPHERE collection slug."),
    organization: str | None = Query(
        default=None, pattern=r"^[0-9a-f]{24}$",
        description="A SPHERE organization of the connection's scopes: its private pricings are listed too.",
    ),
    registry: str | None = Query(default=None, max_length=32, description="A configured SPHERE registry alias."),
    min_price: float | None = Query(
        default=None, alias="minPrice", ge=0, description="Only pricings whose cheapest plan costs at least this.",
    ),
    sort: Literal["name", "minPrice"] | None = Query(default=None),
    order: Literal["asc", "desc"] = Query(default="asc"),
    limit: int = Query(default=MAX_PAGE, ge=1, le=MAX_PAGE),
    offset: int = Query(default=0, ge=0, le=10_000),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SpherePricingSearch:
    found = await _organization(session, org, user, OrganizationRole.MEMBER)
    where = _endpoint(registry)
    credential = await _credential(session, found, where)
    connected = credential is not None
    if session.in_transaction():
        await session.commit()
    query = SearchQuery(name=q or None, collection=collection or None, sort_by=sort, sort=order if sort else None,
                        min_price=min_price, limit=limit, offset=offset)
    try:
        result = await discovery.search(where, query, credential, private_organization=organization)
    except Exception as exc:  # noqa: BLE001 - mapped below or re-raised
        mapped = _sphere_error(exc)
        if mapped is None:
            raise
        raise mapped from exc
    facets = result.facets
    return SpherePricingSearch(
        pricings=[_row(row) for row in result.rows],
        total=result.total,
        facets=Facets(min_price=facets.get("minPrice"), max_price=facets.get("maxPrice"),
                      configuration_space_size=facets.get("configurationSpaceSize")),
        connected=connected,
        registries=list(get_pricing_source().registries()),
    )


@router.get(
    "/sphere/pricings/{pricing_id}",
    operation_id="getSpherePricing",
    summary="A SPHERE pricing's versions, newest first by date",
    tags=["Pricing"],
    response_model=SphereManifestView,
    dependencies=[Depends(limit_work)],
    responses=SPHERE_RESPONSES,
)
async def get_sphere_pricing(
    org: str,
    pricing_id: str,
    registry: str | None = Query(default=None, max_length=32),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SphereManifestView:
    found = await _organization(session, org, user, OrganizationRole.MEMBER)
    if not is_sphere_id(pricing_id):
        raise _not_found()
    where = _endpoint(registry)
    credential = await _credential(session, found, where)
    if session.in_transaction():
        await session.commit()
    try:
        manifest = await discovery.manifest(where, pricing_id, credential)
    except Exception as exc:  # noqa: BLE001
        mapped = _sphere_error(exc)
        if mapped is None:
            raise
        raise mapped from exc
    return SphereManifestView(
        pricing_id=manifest.pricing_id,
        name=manifest.name,
        permanent_url=get_pricing_source().permanent_url(where, manifest.pricing_id),
        latest_version_id=manifest.latest_version_id,
        versions=[
            SphereVersionEntry(version_id=v.version_id, label=v.label, created_at=v.created_at or None, private=v.private)
            for v in manifest.newest_first()
        ],
    )


def snapshot_view(org: str, row: PricingSnapshot) -> PricingSnapshotView:
    permanent = None
    if row.pricing_id:
        where = SphereEndpoint(row.registry) if row.registry else SphereEndpoint()
        try:
            permanent = get_pricing_source().permanent_url(where, row.pricing_id, row.version_id)
        except RuntimeError:
            permanent = None
    return PricingSnapshotView(
        id=str(row.id),
        source=row.source_kind,  # type: ignore[arg-type]
        registry=row.registry,
        pricing_id=row.pricing_id,
        version_id=row.version_id,
        version_label=row.version_label,
        version_created_at=row.version_created_at,
        owner=row.owner,
        slug=row.slug,
        title=row.title,
        collection=row.collection_slug,
        url=row.url,
        currency=row.currency,
        syntax_version=row.syntax_version,
        valid=row.valid,
        fetched_at=etags.normalise(row.fetched_at),
        renamed=row.renamed_from_id is not None,
        permanent_url=permanent,
        yaml_href=f"/v1/organizations/{org}/pricing-snapshots/{row.id}/yaml",
    )


@router.get(
    "/sphere/pricings/{pricing_id}/versions/{version_id}",
    operation_id="getSpherePricingVersion",
    summary="One SPHERE version, kept as a snapshot, with its plans, add-ons, features and limits",
    tags=["Pricing"],
    response_model=SphereVersionView,
    dependencies=[Depends(limit_work)],
    responses=SPHERE_RESPONSES,
)
async def get_sphere_pricing_version(
    org: str,
    pricing_id: str,
    version_id: str,
    registry: str | None = Query(default=None, max_length=32),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> SphereVersionView:
    found = await _organization(session, org, user, OrganizationRole.MEMBER)
    if not is_sphere_id(pricing_id) or not is_sphere_id(version_id):
        raise _not_found()
    where = _endpoint(registry)
    credential = await _credential(session, found, where)
    try:
        view = await discovery.version_view(session, found.id, where, pricing_id, version_id, credential, actor_id=user.id)
    except Exception as exc:  # noqa: BLE001
        mapped = _sphere_error(exc)
        if mapped is None:
            raise
        raise mapped from exc
    return SphereVersionView(snapshot=snapshot_view(org, view.taken.snapshot), summary=view.summary,
                             diagnostics=view.diagnostics)


# -- Pricing snapshots ---------------------------------------------------------------------------------------------


async def _readable_snapshot(
    session: AsyncSession, org: str, snapshot: str, user: User | None
) -> PricingSnapshot:
    organization = await organization_by_ref(session, org)
    if organization is None:
        raise _not_found(SNAPSHOT_NOT_FOUND)
    role = await effective_role(session, organization.id, user) if user is not None else None
    if role is None and not await _publishes(session, organization.id):
        raise _not_found(SNAPSHOT_NOT_FOUND)
    try:
        return await read_snapshot(session, organization.id, snapshot, member=role is not None, signed_in=user is not None)
    except PricingNotFound as exc:
        raise _not_found(SNAPSHOT_NOT_FOUND) from exc


async def _publishes(session: AsyncSession, organization_id: uuid.UUID) -> bool:
    """Whether the organization publishes a composition (then anybody reads it, and its public snapshots)."""
    versioned = select(CompositionVersion.id).where(CompositionVersion.composition_id == Composition.id).exists()
    return await session.scalar(
        select(Composition.id).where(
            Composition.organization_id == organization_id, Composition.visibility == "public",
            Composition.archived.is_(False), versioned,
        ).limit(1)
    ) is not None


SNAPSHOT_RESPONSES = {404: {"model": ErrorResponse, "description": "No such snapshot, or none this caller may read "
                            "(`pricing_snapshot_not_found`)."}}


@router.get(
    "/pricing-snapshots/{snapshot}",
    operation_id="getPricingSnapshot",
    summary="A stored upstream pricing version",
    tags=["Pricing"],
    response_model=PricingSnapshotView,
    dependencies=[Depends(charge_anonymous_read)],
    responses=SNAPSHOT_RESPONSES,
)
async def get_pricing_snapshot(
    org: str,
    snapshot: str,
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PricingSnapshotView:
    row = await _readable_snapshot(session, org, snapshot, user)
    return snapshot_view(org, row)


@router.get(
    "/pricing-snapshots/{snapshot}/yaml",
    operation_id="getPricingSnapshotYaml",
    summary="The bytes of a stored upstream pricing version",
    tags=["Pricing"],
    response_class=RawResponse,
    dependencies=[Depends(charge_anonymous_read)],
    responses={
        200: {"content": {"application/yaml": {"schema": {"type": "string"}}},
              "headers": {"ETag": etags.ETAG_HEADER}},
        304: {"description": "The caller's copy (`If-None-Match`) is current."},
        **SNAPSHOT_RESPONSES,
    },
)
async def get_pricing_snapshot_yaml(
    org: str,
    snapshot: str,
    request: Request,
    user: User | None = Depends(get_reader),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> RawResponse:
    row = await _readable_snapshot(session, org, snapshot, user)
    tag = f'"{row.sha256}"'
    headers = {
        "ETag": tag,
        "Cache-Control": "private, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": f'attachment; filename="pricing-{row.id}.yaml"',
    }
    if tag in [part.strip() for part in request.headers.get("if-none-match", "").split(",")]:
        return RawResponse(status_code=304, headers=headers)
    try:
        content = snapshot_bytes(row)
    except PricingSourceUnavailable as exc:
        raise api_error(409, "content_integrity", "The stored pricing does not match its digest.") from exc
    return RawResponse(content=content, media_type="application/yaml", headers=headers)


# -- OpenBinding's own pricing ---------------------------------------------------------------------------------


@public_router.get(
    "/pricing",
    operation_id="getPlansPricing",
    summary="OpenBinding's published pricing (the version SPACE_PRICING_VERSION names), read from SPHERE",
    response_model=PlansPricingView,
    responses={
        200: {"headers": {"ETag": {"description": "The SHA-256 of the YAML.", "schema": {"type": "string"}}}},
        304: {"description": "The caller's copy (`If-None-Match`) is current."},
        503: {"model": ErrorResponse, "description": "The published pricing cannot be read (`pricing_unavailable`)."},
    },
)
async def get_plans_pricing(
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(session_dependency, scope="function"),
):
    """The published pricing: the YAML for pricing-renderer and the parsed document (``.inf`` as ``null``)."""
    try:
        value = await own_pricing(session, settings)
    except OwnPricingUnavailable as exc:
        raise pricing_unavailable_error(exc, where="published pricing", problem=PUBLISHED_PRICING_UNAVAILABLE) from exc
    tag = f'"{value.sha256}"'
    cache = "public, max-age=300"
    if tag in [part.strip() for part in request.headers.get("if-none-match", "").split(",")]:
        return RawResponse(status_code=304, headers={"ETag": tag, "Cache-Control": cache})
    response.headers["ETag"] = tag
    response.headers["Cache-Control"] = cache
    return PlansPricingView(
        pricing_id=value.pricing_id, name=value.name, version=value.version, version_id=value.version_id,
        created_at=value.created_at, permanent_url=value.permanent_url, yaml=value.yaml, document=value.document,
    )
