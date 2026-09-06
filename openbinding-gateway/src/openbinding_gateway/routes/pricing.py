"""Pricing metadata, proxy and administrator control room.

No YAML body is persisted by OpenBinding.  SPHERE owns immutable drafts and
releases; SPACE owns deployments and contracts; this module stores only the
join metadata and the LIVE pointer.
"""

from __future__ import annotations

import hashlib
import re
from datetime import date
from typing import Any

import yaml
from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import require_admin, session_dependency
from ..core.settings import Settings, get_settings
from ..db.models import (
    AuditEvent,
    PricingRelease,
    PricingSpaceState,
    PricingSphereState,
    User,
)
from ..models.errors import api_error
from ..models.pricing import (
    PricingActionResult,
    PricingArchiveRequest,
    PricingConfirmation,
    PricingCurrentView,
    PricingForkRequest,
    PricingPublishRequest,
    PricingReleaseView,
    PricingValidationView,
    PricingYamlRequest,
)
from ..space_client import PricingUnavailable
from ..pricing_catalog import PricingCatalog, PricingCatalogError, live_catalog
from ..space_client.deployments import SpaceDeploymentClient
from ..sphere_client import SphereClient, SphereError

public_router = APIRouter(prefix="/v1/pricing", tags=["Pricing"])
admin_router = APIRouter(
    prefix="/v1/admin/pricing",
    tags=["Pricing Administration"],
    dependencies=[Depends(require_admin)],
)

STABLE_VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
DRAFT_VERSION = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-draft\.([1-9]\d*)$"
)


def _digest(content: bytes) -> str:
    return f"sha256-{hashlib.sha256(content).hexdigest()}"


def _sensitive_paths(value: Any, prefix: str = "$") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{prefix}.{key}"
            normalized = re.sub(r"[^a-z]", "", str(key).casefold())
            if normalized in {"password", "secret", "token", "apikey", "credential", "credentials"} or normalized.endswith(("password", "secret", "token")):
                paths.append(child_path)
            paths.extend(_sensitive_paths(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(_sensitive_paths(child, f"{prefix}[{index}]"))
    return paths


def validate_pricing(
    content: bytes,
    expected_version: str | None = None,
    settings: Settings | None = None,
) -> tuple[dict[str, Any] | None, PricingValidationView]:
    errors: list[str] = []
    warnings: list[str] = []
    settings = settings or get_settings()
    if len(content) > settings.pricing_document_max_bytes:
        return None, PricingValidationView(
            valid=False,
            errors=[f"Pricing YAML exceeds the technical {settings.pricing_document_max_bytes}-byte ceiling."],
        )
    try:
        value = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        return None, PricingValidationView(valid=False, errors=[f"Invalid YAML: {exc}"])
    if not isinstance(value, dict):
        return None, PricingValidationView(valid=False, errors=["The YAML root must be an object."])
    syntax_version = str(value.get("syntaxVersion", ""))
    if syntax_version != "3.1":
        errors.append("syntaxVersion must be 3.1.")
    if str(value.get("saasName", "")).casefold() != "openbinding":
        errors.append("saasName must be openbinding.")
    version = str(value.get("version", ""))
    if not (STABLE_VERSION.fullmatch(version) or DRAFT_VERSION.fullmatch(version)):
        errors.append("version must be SemVer X.Y.Z or X.Y.Z-draft.N.")
    if expected_version is not None and version != expected_version:
        errors.append(f"The YAML version must be {expected_version}.")
    plans = value.get("plans")
    if not isinstance(plans, dict) or not plans:
        errors.append("At least one plan is required.")
        plan_names: list[str] = []
    else:
        plan_names = sorted(str(name) for name in plans)
    features = value.get("features")
    limits = value.get("usageLimits")
    if not isinstance(features, dict) or not features:
        errors.append("features must be a non-empty object.")
    if not isinstance(limits, dict) or not limits:
        errors.append("usageLimits must be a non-empty object.")
    sensitive = _sensitive_paths(value)
    if sensitive:
        errors.append("Pricing documents may not contain secret-shaped fields: " + ", ".join(sensitive[:10]))
    add_ons = value.get("addOns") or {}
    if not isinstance(add_ons, dict):
        errors.append("addOns must be an object when present.")
        add_on_names: list[str] = []
    else:
        add_on_names = sorted(str(name) for name in add_ons)
    try:
        catalog = PricingCatalog.parse(content)
        errors.extend(catalog.technical_errors(settings))
    except PricingCatalogError as exc:
        errors.append(str(exc))
    return value, PricingValidationView(
        valid=not errors,
        version=version or None,
        digest=_digest(content),
        syntax_version=syntax_version or None,
        plans=plan_names,
        add_ons=add_on_names,
        errors=errors,
        warnings=warnings,
    )


def _release_view(value: PricingRelease) -> PricingReleaseView:
    return PricingReleaseView(
        id=value.id,
        version=value.version,
        digest=value.digest,
        sphere_organization="OpenBinding",
        sphere_organization_id=value.sphere_organization_id,
        sphere_slug="openbinding",
        sphere_state=value.sphere_state.value,
        space_state=value.space_state.value,
        is_live=value.is_live,
        public_url=value.public_url if value.sphere_state is PricingSphereState.PUBLIC_RELEASE else None,
        changelog=value.changelog,
        migration_manifest=value.migration_manifest,
        created_at=value.created_at,
        updated_at=value.updated_at,
    )


def _remote_error(exc: Exception) -> None:
    raise api_error(status.HTTP_502_BAD_GATEWAY, "pricing_control_plane_error", str(exc)) from exc


def _audit(session: AsyncSession, actor: User, action: str, release: PricingRelease, **detail) -> None:
    session.add(
        AuditEvent(
            actor_id=actor.id,
            action=action,
            target_type="PricingRelease",
            target_id=release.id,
            detail={"version": release.version, **detail},
        )
    )


async def _release(session: AsyncSession, version: str) -> PricingRelease:
    value = await session.scalar(select(PricingRelease).where(PricingRelease.version == version))
    if value is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Pricing version not found.")
    return value


async def _sphere(settings: Settings) -> SphereClient:
    if not settings.sphere_enabled:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "sphere_disabled", "SPHERE is not enabled.")
    try:
        return SphereClient(settings)
    except SphereError as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "sphere_unavailable", str(exc)) from exc


async def _space(settings: Settings) -> SpaceDeploymentClient:
    if not settings.space_enabled:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "space_disabled", "SPACE is not enabled.")
    try:
        return SpaceDeploymentClient(settings)
    except PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "space_unavailable", str(exc)) from exc


@public_router.get("/current", response_model=PricingCurrentView, operation_id="getCurrentPricing")
async def current_pricing(
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PricingCurrentView:
    value = await session.scalar(select(PricingRelease).where(PricingRelease.is_live.is_(True)))
    if value is None or value.sphere_state is not PricingSphereState.PUBLIC_RELEASE or not value.public_url:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No public pricing release is live.")
    return PricingCurrentView(version=value.version, digest=value.digest, url=value.public_url)


@public_router.get(
    "",
    deprecated=True,
    operation_id="getPricingDocument",
    response_class=Response,
    responses={200: {"content": {"application/yaml": {"schema": {"type": "string"}}}}},
)
async def proxy_current_pricing(
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    value = await session.scalar(select(PricingRelease).where(PricingRelease.is_live.is_(True)))
    if value is None or value.sphere_state is not PricingSphereState.PUBLIC_RELEASE:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No public pricing release is live.")
    client = await _sphere(settings)
    try:
        body = await client.content(value.version)
    except SphereError as exc:
        _remote_error(exc)
    finally:
        await client.aclose()
    if _digest(body) != value.digest:
        raise api_error(status.HTTP_502_BAD_GATEWAY, "pricing_digest_mismatch", "SPHERE content no longer matches the immutable release digest.")
    return Response(
        body,
        media_type="application/yaml",
        headers={"ETag": f'"{value.digest}"', "Cache-Control": "public, max-age=300"},
    )


@public_router.get("/catalog", operation_id="getPricingCatalog")
async def pricing_catalog(
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Return the active, digest-verified Pricing2Yaml catalog unchanged."""
    try:
        return (await live_catalog(session, settings)).public_view()
    except PricingCatalogError as exc:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)
        ) from exc


@admin_router.post("/validate", response_model=PricingValidationView, operation_id="validatePricingDraft")
async def validate_pricing_draft(payload: PricingYamlRequest) -> PricingValidationView:
    _, result = validate_pricing(payload.yaml.encode())
    return result


@admin_router.get("/templates", operation_id="listPricingTemplates")
async def pricing_templates() -> dict[str, list[dict[str, Any]]]:
    """Return linter-aware Pricing2Yaml blocks without commercial defaults."""

    return {
        "templates": [
            {
                "id": "feature",
                "name": "Boolean feature",
                "description": "A capability that plans can enable or disable.",
                "section": "features",
                "body": """featureName:
  description: What this feature unlocks.
  type: DOMAIN
  valueType: BOOLEAN
  defaultValue: false
  expression: pricingContext['features']['featureName']""",
            },
            {
                "id": "integration-feature",
                "name": "Integration feature",
                "description": "An API-backed integration capability.",
                "section": "features",
                "body": """integrationName:
  description: What this integration connects to.
  type: INTEGRATION
  integrationType: API
  valueType: BOOLEAN
  defaultValue: false
  expression: pricingContext['features']['integrationName']""",
            },
            {
                "id": "renewable-limit",
                "name": "Renewable usage limit",
                "description": "A metered allowance that resets on a declared period.",
                "section": "usageLimits",
                "body": """itemsPerMonth:
  description: Items consumed per month.
  type: RENEWABLE
  period: { value: 1, unit: MONTH }
  valueType: NUMERIC
  defaultValue: 10
  unit: item/month
  linkedFeatures: [featureName]""",
            },
            {
                "id": "non-renewable-limit",
                "name": "Structural usage limit",
                "description": "A capacity or per-operation ceiling that does not renew.",
                "section": "usageLimits",
                "body": """maximumItems:
  description: Maximum number of items.
  type: NON_RENEWABLE
  trackable: true
  valueType: NUMERIC
  defaultValue: 1
  unit: item
  linkedFeatures: [featureName]""",
            },
            {
                "id": "plan",
                "name": "Plan",
                "description": "A plan overriding only the selected feature and limit.",
                "section": "plans",
                "body": """PLAN_NAME:
  description: Who this plan is for.
  price: 0.0
  unit: user/month
  features:
    featureName: { value: true }
  usageLimits:
    itemsPerMonth: { value: 10 }""",
            },
            {
                "id": "scalable-addon",
                "name": "Scalable add-on",
                "description": "An optional quantity that extends a usage limit.",
                "section": "addOns",
                "body": """extraItems:
  description: Extra metered items.
  price: Contact us / Institutional agreement
  unit: item/month
  availableFor: [PLAN_NAME]
  usageLimitsExtensions:
    itemsPerMonth: { value: 10 }
  subscriptionConstraints:
    minQuantity: 1
    maxQuantity: 10
    quantityStep: 1""",
            },
        ]
    }


@admin_router.get("/control-room", operation_id="getPricingControlRoom")
async def control_room(
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    local = (
        await session.execute(select(PricingRelease).order_by(PricingRelease.created_at.desc()))
    ).scalars().all()
    sphere_health: dict[str, Any] = {"enabled": settings.sphere_enabled, "reachable": False}
    space_health: dict[str, Any] = {"enabled": settings.space_enabled, "reachable": False}
    remote_versions: list[dict[str, Any]] = []
    space_versions: dict[str, list[dict[str, Any]]] = {"active": [], "archived": []}
    if settings.sphere_enabled:
        client = await _sphere(settings)
        try:
            versions = await client.list_versions()
            organization_id = await client.organization_id()
            sphere_health.update(reachable=True, organization="OpenBinding", organizationId=organization_id, slug="openbinding")
            remote_versions = [{"version": item.version, "private": item.private} for item in versions]
        except SphereError as exc:
            sphere_health["error"] = str(exc)
        finally:
            await client.aclose()
    if settings.space_enabled:
        try:
            client_space = await _space(settings)
            health = await client_space.health()
            space_health.update(health)
            space_versions = await client_space.versions()
        except PricingUnavailable as exc:
            space_health["error"] = str(exc)
    local_versions = {item.version for item in local}
    sphere_versions = {item["version"] for item in remote_versions}
    return {
        "identity": {"organization": "OpenBinding", "slug": "openbinding"},
        "sphere": sphere_health,
        "space": space_health,
        "live": next((item.version for item in local if item.is_live), None),
        "releases": [_release_view(item) for item in local],
        "remoteVersions": remote_versions,
        "spaceVersions": space_versions,
        "divergence": {
            "onlyInSphere": sorted(sphere_versions - local_versions),
            "onlyLocal": sorted(local_versions - sphere_versions),
        },
    }


@admin_router.post("/sync", operation_id="syncPricingMetadata")
async def sync_pricing_metadata(
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> dict[str, int]:
    client = await _sphere(settings)
    created = 0
    try:
        organization_id = await client.organization_id()
        for remote in await client.list_versions():
            existing = await session.scalar(select(PricingRelease).where(PricingRelease.version == remote.version))
            if existing is not None:
                if existing.sphere_organization_id != organization_id:
                    raise SphereError("A local release points at another SPHERE organization.")
                continue
            content = await client.content(remote.version)
            _, result = validate_pricing(content, remote.version)
            if not result.valid or not result.digest:
                raise SphereError(f"SPHERE version {remote.version!r} is not a valid OpenBinding pricing.")
            value = PricingRelease(
                version=remote.version,
                digest=result.digest,
                sphere_organization_id=organization_id,
                sphere_state=(PricingSphereState.PRIVATE_DRAFT if remote.private else PricingSphereState.PUBLIC_RELEASE),
                public_url=None if remote.private else remote.yaml_url,
                created_by_id=actor.id,
            )
            session.add(value)
            await session.flush()
            _audit(session, actor, "pricing.metadata.synced", value)
            created += 1
    except SphereError as exc:
        _remote_error(exc)
    finally:
        await client.aclose()
    return {"created": created}


@admin_router.post("/drafts", response_model=PricingActionResult, status_code=201, operation_id="createPricingDraft")
async def create_draft(
    payload: PricingYamlRequest,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> PricingActionResult:
    content = payload.yaml.encode()
    _, validation = validate_pricing(content)
    if not validation.valid or not validation.version or not validation.digest:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_pricing", "Pricing validation failed.", diagnostics=[{"message": error} for error in validation.errors])
    if not DRAFT_VERSION.fullmatch(validation.version):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "draft_version_required", "Draft versions must use X.Y.Z-draft.N.")
    if await session.scalar(select(PricingRelease.id).where(PricingRelease.version == validation.version)):
        raise api_error(status.HTTP_409_CONFLICT, "immutable_version_exists", "That pricing version already exists.")
    client = await _sphere(settings)
    try:
        uploaded = await client.upload(content, validation.version, private=True)
    except SphereError as exc:
        _remote_error(exc)
    finally:
        await client.aclose()
    value = PricingRelease(
        version=validation.version,
        digest=validation.digest,
        sphere_organization_id=uploaded.organization_id,
        sphere_state=PricingSphereState.PRIVATE_DRAFT,
        changelog=payload.changelog,
        migration_manifest=payload.migration_manifest,
        created_by_id=actor.id,
    )
    session.add(value)
    await session.flush()
    _audit(session, actor, "pricing.draft.created", value)
    return PricingActionResult(release=_release_view(value), message="Private immutable draft created in SPHERE.")


@admin_router.post("/drafts/{source}/fork", response_model=PricingActionResult, status_code=201, operation_id="forkPricingDraft")
async def fork_draft(
    source: str,
    payload: PricingForkRequest,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> PricingActionResult:
    if not DRAFT_VERSION.fullmatch(payload.version):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "draft_version_required", "Forks must use X.Y.Z-draft.N.")
    await _release(session, source)
    client = await _sphere(settings)
    try:
        document = yaml.safe_load(await client.content(source))
        if not isinstance(document, dict):
            raise SphereError("Source pricing is malformed.")
        document["version"] = payload.version
        document["createdAt"] = date.today().isoformat()
        content = yaml.safe_dump(document, sort_keys=False, allow_unicode=True).encode()
        _, validation = validate_pricing(content, payload.version)
        if not validation.valid or not validation.digest:
            raise SphereError("Forked pricing is invalid: " + "; ".join(validation.errors))
        uploaded = await client.upload(content, payload.version, private=True)
    except (SphereError, yaml.YAMLError) as exc:
        _remote_error(exc)
    finally:
        await client.aclose()
    value = PricingRelease(
        version=payload.version,
        digest=validation.digest,
        sphere_organization_id=uploaded.organization_id,
        sphere_state=PricingSphereState.PRIVATE_DRAFT,
        changelog=payload.changelog,
        migration_manifest={"forkedFrom": source},
        created_by_id=actor.id,
    )
    session.add(value)
    await session.flush()
    _audit(session, actor, "pricing.draft.forked", value, source=source)
    return PricingActionResult(release=_release_view(value), message=f"Draft forked from {source}.")


@admin_router.post("/publish", response_model=PricingActionResult, status_code=201, operation_id="publishPricingRelease")
async def publish_release(
    payload: PricingPublishRequest,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> PricingActionResult:
    if not STABLE_VERSION.fullmatch(payload.version):
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "stable_version_required", "Published releases require X.Y.Z.")
    draft = await _release(session, payload.draft_version)
    if draft.sphere_state is not PricingSphereState.PRIVATE_DRAFT:
        raise api_error(status.HTTP_409_CONFLICT, "not_a_draft", "Only a private draft can be published.")
    stable_count = await session.scalar(
        select(PricingRelease.id).where(PricingRelease.sphere_state == PricingSphereState.PUBLIC_RELEASE).limit(1)
    )
    if stable_count is None and payload.version != "0.1.0":
        raise api_error(status.HTTP_409_CONFLICT, "first_release_version", "The first stable release must be exactly 0.1.0.")
    client = await _sphere(settings)
    try:
        document = yaml.safe_load(await client.content(draft.version))
        if not isinstance(document, dict):
            raise SphereError("Draft pricing is malformed.")
        document["version"] = payload.version
        document["createdAt"] = date.today().isoformat()
        content = yaml.safe_dump(document, sort_keys=False, allow_unicode=True).encode()
        _, validation = validate_pricing(content, payload.version)
        if not validation.valid or not validation.digest:
            raise SphereError("Published pricing is invalid: " + "; ".join(validation.errors))
        uploaded = await client.upload(content, payload.version, private=False)
    except (SphereError, yaml.YAMLError) as exc:
        _remote_error(exc)
    finally:
        await client.aclose()
    value = PricingRelease(
        version=payload.version,
        digest=validation.digest,
        sphere_organization_id=uploaded.organization_id,
        sphere_state=PricingSphereState.PUBLIC_RELEASE,
        public_url=uploaded.yaml_url,
        changelog=payload.changelog,
        migration_manifest=payload.migration_manifest,
        created_by_id=actor.id,
    )
    session.add(value)
    await session.flush()
    _audit(session, actor, "pricing.release.published", value, source=draft.version)
    return PricingActionResult(release=_release_view(value), message="Public immutable release published in SPHERE.")


@admin_router.get("/versions/{version}/preview", operation_id="previewPricingVersion", response_class=Response, responses={200: {"content": {"application/yaml": {"schema": {"type": "string"}}}}})
async def preview_version(
    version: str,
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    value = await _release(session, version)
    client = await _sphere(settings)
    try:
        body = await client.content(value.version)
    except SphereError as exc:
        _remote_error(exc)
    finally:
        await client.aclose()
    if _digest(body) != value.digest:
        raise api_error(status.HTTP_502_BAD_GATEWAY, "pricing_digest_mismatch", "Remote draft differs from its immutable digest.")
    return Response(body, media_type="application/yaml", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


async def _deploy_remote(value: PricingRelease, settings: Settings) -> None:
    sphere = await _sphere(settings)
    try:
        metadata = await sphere.exact_version(value.version)
        space = await _space(settings)
        await space.deploy(metadata.yaml_url)
    except (SphereError, PricingUnavailable) as exc:
        _remote_error(exc)
    finally:
        await sphere.aclose()


@admin_router.post("/versions/{version}/deploy", response_model=PricingActionResult, operation_id="deployPricingVersion")
async def deploy_version(
    version: str,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> PricingActionResult:
    value = await _release(session, version)
    if value.space_state not in {PricingSpaceState.NOT_DEPLOYED, PricingSpaceState.ARCHIVED}:
        raise api_error(status.HTTP_409_CONFLICT, "already_deployed", "That pricing is already deployed or draining.")
    await _deploy_remote(value, settings)
    value.space_state = PricingSpaceState.ACTIVE
    _audit(session, actor, "pricing.space.deployed", value, preview=value.sphere_state is PricingSphereState.PRIVATE_DRAFT)
    await session.flush()
    return PricingActionResult(release=_release_view(value), message="Pricing deployed to SPACE.")


@admin_router.post("/versions/{version}/activate", response_model=PricingActionResult, operation_id="activatePricingRelease")
async def activate_release(
    version: str,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> PricingActionResult:
    value = await _release(session, version)
    if value.sphere_state is not PricingSphereState.PUBLIC_RELEASE:
        raise api_error(status.HTTP_409_CONFLICT, "draft_cannot_be_live", "Only a public SPHERE release can become LIVE.")
    if value.space_state is PricingSpaceState.NOT_DEPLOYED:
        await _deploy_remote(value, settings)
    elif value.space_state in {PricingSpaceState.ARCHIVED, PricingSpaceState.DRAINING}:
        try:
            await (await _space(settings)).set_availability(value.version, "active")
        except PricingUnavailable as exc:
            _remote_error(exc)
    previous = (
        await session.execute(select(PricingRelease).where(PricingRelease.is_live.is_(True), PricingRelease.id != value.id))
    ).scalars().all()
    for old in previous:
        old.is_live = False
        if old.space_state is PricingSpaceState.ACTIVE:
            old.space_state = PricingSpaceState.DRAINING
    await session.execute(update(PricingRelease).where(PricingRelease.id == value.id).values(is_live=True))
    value.is_live = True
    value.space_state = PricingSpaceState.ACTIVE
    _audit(session, actor, "pricing.live.activated", value, previous=[item.version for item in previous])
    await session.flush()
    return PricingActionResult(release=_release_view(value), message="LIVE now points to this public release; existing contracts keep their pinned version until renewal.")


@admin_router.post("/versions/{version}/drain", response_model=PricingActionResult, operation_id="drainPricingVersion")
async def drain_version(
    version: str,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> PricingActionResult:
    value = await _release(session, version)
    if value.is_live:
        raise api_error(status.HTTP_409_CONFLICT, "live_cannot_drain", "Move LIVE before draining this version.")
    if value.space_state is not PricingSpaceState.ACTIVE:
        raise api_error(status.HTTP_409_CONFLICT, "not_active", "Only an active SPACE version can start draining.")
    value.space_state = PricingSpaceState.DRAINING
    _audit(session, actor, "pricing.space.draining", value)
    await session.flush()
    return PricingActionResult(release=_release_view(value), message="No new contracts will target this version; pinned contracts remain valid.")


@admin_router.post("/versions/{version}/archive", response_model=PricingActionResult, operation_id="archivePricingVersion")
async def archive_version(
    version: str,
    payload: PricingArchiveRequest,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> PricingActionResult:
    value = await _release(session, version)
    if value.is_live:
        raise api_error(status.HTTP_409_CONFLICT, "live_cannot_archive", "Move LIVE before archiving this version.")
    if value.space_state not in {PricingSpaceState.ACTIVE, PricingSpaceState.DRAINING}:
        raise api_error(status.HTTP_409_CONFLICT, "not_active", "Only an active or draining version can be archived.")
    try:
        space = await _space(settings)
        contracts = await space.contract_count(value.version)
        if contracts:
            raise api_error(
                status.HTTP_409_CONFLICT,
                "pricing_has_contracts",
                f"{contracts} contract(s) are still pinned to this pricing version.",
            )
        await space.set_availability(value.version, "archived", payload.fallback)
    except PricingUnavailable as exc:
        _remote_error(exc)
    value.space_state = PricingSpaceState.ARCHIVED
    _audit(session, actor, "pricing.space.archived", value)
    await session.flush()
    return PricingActionResult(release=_release_view(value), message="Pricing archived in SPACE.")


@admin_router.delete("/drafts/{version}", status_code=204, operation_id="deletePricingDraft")
async def delete_draft(
    version: str,
    payload: PricingConfirmation,
    actor: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    value = await _release(session, version)
    if payload.confirmation != version:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "confirmation_mismatch", "Type the exact version to confirm deletion.")
    if value.sphere_state is not PricingSphereState.PRIVATE_DRAFT or value.is_live:
        raise api_error(status.HTTP_409_CONFLICT, "immutable_public_release", "Only non-LIVE private drafts may be deleted.")
    if value.space_state in {PricingSpaceState.ACTIVE, PricingSpaceState.DRAINING}:
        raise api_error(status.HTTP_409_CONFLICT, "deployed_draft", "Archive the SPACE preview before deleting this draft.")
    if value.space_state is PricingSpaceState.ARCHIVED:
        try:
            await (await _space(settings)).delete_archived(value.version)
        except PricingUnavailable as exc:
            _remote_error(exc)
    client = await _sphere(settings)
    try:
        await client.delete_private_version(value.version)
    except SphereError as exc:
        _remote_error(exc)
    finally:
        await client.aclose()
    _audit(session, actor, "pricing.draft.deleted", value)
    await session.flush()
    await session.delete(value)
    return Response(status_code=204)
