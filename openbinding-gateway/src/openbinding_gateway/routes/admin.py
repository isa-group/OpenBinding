"""What an administrator can do to somebody else's account.

Deliberately a short list. An administrator can see accounts, deactivate one,
change its role, move it between plans, and take back a key. They cannot change
a password or an email address: those are the two ways to sign in, so an
administrator able to change them could take an account over without its owner
noticing, and nothing here needs that.

There is no payment gateway: changing any plan or add-on selection is an
administrator performing an audited novation on the SPACE contract.

Every one of these is an endpoint rather than a database chore, because the
administration screen is a client of this API like any other.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..access import metering
from ..access.contracts import sweep_contract_renewals
from ..access.dependencies import require_admin, session_dependency
from ..collaboration import (
    descendant_ids,
    effective_role,
    enforce_sponsor_usage,
    organization_usage,
    sponsor_organization_ids,
)
from ..core.settings import Settings, get_settings
from ..db.models import (
    ApiErrorEvent,
    ApiKey,
    Blob,
    AuditEvent,
    AuthIdentity,
    BindingCase,
    BindingCaseRevision,
    Collection,
    DialectRevision,
    EngineRegistrationRevision,
    EngineRevision,
    Job,
    JobState,
    Organization,
    OrganizationMembership,
    PricingRelease,
    Project,
    ProjectResource,
    ProjectResourceRevision,
    Study,
    StudyCell,
    StudyRun,
    Notification,
    User,
    UserRole,
    utcnow,
)
from ..models.accounts import (
    AdminUserPage,
    AdminUserView,
    ChangePlanRequest,
    ChangeSubscriptionRequest,
    ContractSubscriptionView,
    AdminSubscriptionView,
    UpdateUserRequest,
    UsageResyncResult,
    UsageView,
)
from ..models.errors import (
    FORBIDDEN_RESPONSE,
    NOT_FOUND_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
from ..models.platform import OrganizationView
from ..space_client import PricingUnavailable, get_gate
from ..pricing_catalog import PricingCatalogError, live_catalog
from ..mailer import send_mail
from .users import usage_view_for

router = APIRouter(
    prefix="/v1/admin",
    tags=["Administration"],
    dependencies=[Depends(require_admin)],
    responses={401: UNAUTHORIZED_RESPONSE, 403: FORBIDDEN_RESPONSE},
)


class MaintenancePurgeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation: Literal["PURGE EXPIRED"]
    terminal_job_retention_days: int = Field(default=365, ge=7, le=3650)
    error_retention_days: Optional[int] = Field(default=90, ge=1, le=3650)


def _aware(value):
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


async def _maintenance_preview(session: AsyncSession, retention_days: int) -> dict:
    now = utcnow()
    cutoff = now - timedelta(days=retention_days)
    from ..db.models import ArtifactVersion
    expired_artifacts = int(await session.scalar(
        select(func.count(Blob.id)).where(Blob.expires_at.is_not(None), Blob.expires_at <= now, ~Blob.id.in_(select(ArtifactVersion.blob_id)))
    ) or 0)
    expired_keys = int(await session.scalar(
        select(func.count(ApiKey.id)).where(
            ApiKey.expires_at.is_not(None), ApiKey.expires_at <= now, ApiKey.revoked_at.is_(None)
        )
    ) or 0)
    study_job_ids = select(StudyCell.job_id).where(StudyCell.job_id.is_not(None))
    terminal_jobs = int(await session.scalar(
        select(func.count(Job.id)).where(
            Job.state.in_([JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED]),
            Job.finished_at.is_not(None),
            Job.finished_at <= cutoff,
            Job.id.not_in(study_job_ids),
        )
    ) or 0)
    abandoned = 0
    in_flight = (await session.execute(select(Job).where(
        Job.metered.is_(False), Job.state.in_([JobState.QUEUED, JobState.RUNNING])
    ))).scalars().all()
    for job in in_flight:
        deadline = _aware(job.created_at) + timedelta(
            seconds=float(job.requested_budget_s or 0) + metering.SETTLEMENT_GRACE_S
        )
        if now >= deadline:
            abandoned += 1
    return {
        "expiredArtifacts": expired_artifacts,
        "expiredApiKeys": expired_keys,
        "terminalJobs": terminal_jobs,
        "abandonedJobs": abandoned,
        "terminalJobCutoff": cutoff.isoformat(),
    }


async def _user_or_404(session: AsyncSession, user_id: uuid.UUID) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No such account.")
    return user


@router.get(
    "/users",
    response_model=AdminUserPage,
    operation_id="adminListUsers",
    summary="Accounts on this gateway",
    responses={503: UNAVAILABLE_RESPONSE},
)
async def list_users(
    session: AsyncSession = Depends(session_dependency, scope="function"),
    search: Optional[str] = Query(default=None, description="Match on username or email."),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
) -> AdminUserPage:
    """A page of accounts, with what each one costs.

    The plan shown is the cached one rather than the contract, so that
    rendering a page of fifty does not mean fifty calls to the pricing
    service. ``GET /v1/admin/users/{id}/usage`` reads the contract itself when
    an exact answer is wanted.
    """
    conditions = []
    if search:
        pattern = f"%{search.strip().lower()}%"
        conditions.append(
            func.lower(User.username).like(pattern) | func.lower(User.email).like(pattern)
        )

    total = await session.scalar(select(func.count()).select_from(User).where(*conditions))
    rows = await session.execute(
        select(User).where(*conditions).order_by(User.created_at).offset(offset).limit(limit)
    )
    users = list(rows.scalars().all())

    key_counts = dict(
        (
            await session.execute(
                select(ApiKey.user_id, func.count())
                .where(ApiKey.revoked_at.is_(None), ApiKey.user_id.in_([u.id for u in users] or [None]))
                .group_by(ApiKey.user_id)
            )
        ).all()
    )
    views = []
    for user in users:
        try:
            plan = user.plan_cache if user.contract_pending else (await get_gate().subscription(user.id)).plan
        except PricingUnavailable as error:
            raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(error)) from error
        views.append(
            AdminUserView(
                id=user.id,
                username=user.username,
                email=user.email,
                role=user.role.value,
                is_active=user.is_active,
                plan=plan,
                created_at=user.created_at,
                contract_pending=user.contract_pending,
                api_key_count=key_counts.get(user.id, 0),
            )
        )
    return AdminUserPage(
        users=views,
        total=total or 0,
        offset=offset,
        limit=limit,
    )


@router.patch(
    "/users/{user_id}",
    response_model=AdminUserView,
    operation_id="adminUpdateUser",
    summary="Deactivate an account, or change its role",
    responses={404: NOT_FOUND_RESPONSE, 409: {"description": "The change is not allowed."}},
)
async def update_user(
    user_id: uuid.UUID,
    request: UpdateUserRequest,
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> AdminUserView:
    """Change what an administrator is allowed to change.

    An administrator cannot deactivate or demote themselves. Not because it
    would be catastrophic, but because it is always a mistake: the intent is
    invariably to do it to somebody else, and a gateway whose last
    administrator locked themselves out needs database access to recover.
    """
    user = await _user_or_404(session, user_id)

    if user.id == administrator.id and (request.is_active is False or request.role == "user"):
        raise api_error(
            status.HTTP_409_CONFLICT,
            "cannot_demote_self",
            "An administrator cannot deactivate or demote their own account.",
        )

    if request.is_active is not None:
        user.is_active = request.is_active
    if request.role is not None:
        user.role = UserRole(request.role.value)

    await session.flush()
    try:
        plan = user.plan_cache if user.contract_pending else (await get_gate().subscription(user.id)).plan
    except PricingUnavailable as error:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(error)) from error
    return AdminUserView(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role.value,
        is_active=user.is_active,
        plan=plan,
        created_at=user.created_at,
        contract_pending=user.contract_pending,
        api_key_count=0,
    )


@router.post(
    "/users/{user_id}/plan",
    response_model=AdminUserView,
    operation_id="adminChangePlan",
    summary="Move an account onto another plan",
    responses={404: NOT_FOUND_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def change_plan(
    user_id: uuid.UUID,
    request: ChangePlanRequest,
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> AdminUserView:
    """Perform the novation, then update what the interface displays.

    In that order, and it matters: the contract is what decides what a request
    may do, and the column here only decides what a list looks like. If the
    novation fails, nothing should claim it succeeded.
    """
    user = await _user_or_404(session, user_id)
    try:
        current = await get_gate().subscription(user.id)
    except PricingUnavailable as error:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(error)) from error
    result = await _apply_subscription(
        user,
        request.plan,
        current.add_ons,
        "administrative_decision",
        None,
        administrator,
        session,
        get_settings(),
    )
    return result.user


def _admin_user_view(user: User, plan: str) -> AdminUserView:
    return AdminUserView(
        id=user.id, username=user.username, email=user.email, role=user.role.value,
        is_active=user.is_active, plan=plan, created_at=user.created_at,
        contract_pending=user.contract_pending, api_key_count=0,
    )


async def _assert_research_identity(session: AsyncSession, user: User, plan: str) -> None:
    if plan != "RESEARCH":
        return
    verified = await session.scalar(select(func.count(AuthIdentity.id)).where(
        AuthIdentity.user_id == user.id, AuthIdentity.provider == "us-cas"
    ))
    if not verified:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "research_requires_us_cas",
            "RESEARCH requires a verified Universidad de Sevilla CAS identity.",
        )


async def _apply_subscription(
    user: User,
    plan: str,
    add_ons: dict[str, int],
    reason: str,
    detail: str | None,
    administrator: User,
    session: AsyncSession,
    settings: Settings,
) -> AdminSubscriptionView:
    await _assert_research_identity(session, user, plan)
    gate = get_gate()
    try:
        catalog = await live_catalog(session, settings)
        before = await gate.subscription(user.id)
        target_version = catalog.version
        configuration_changed = before.plan != plan or before.add_ons != add_ons
        version_changed = before.pricing_version != target_version
        after = (
            await gate.change_subscription(user.id, plan, add_ons, target_version)
            if configuration_changed or version_changed
            else before
        )
    except PricingCatalogError as error:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "invalid_subscription",
            str(error),
        ) from error
    except PricingUnavailable as error:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            f"The subscription cannot be changed right now: {error}",
        ) from error

    user.plan_cache = plan
    user.contract_pending = False
    if configuration_changed:
        subject = "Your OpenBinding agreement changed"
        body = (
            f"Plan: {before.plan} → {after.plan}. "
            f"Add-ons: {before.add_ons} → {after.add_ons}. Reason: {reason}."
        )
        if detail:
            body += f" {detail}"
        payload = {
            "reason": reason,
            "detail": detail,
            "previous": {"plan": before.plan, "addOns": before.add_ons},
            "current": {"plan": after.plan, "addOns": after.add_ons},
            "pricingVersion": after.pricing_version,
        }
        session.add(Notification(
            user_id=user.id, kind="contract.changed", subject=subject, body=body, payload=payload
        ))
        session.add(AuditEvent(
            actor_id=administrator.id,
            action="contract.subscription.changed",
            target_type="User",
            target_id=user.id,
            detail=payload,
        ))
        if (user.preferences or {}).get("email_contract_changes", True):
            await send_mail(settings, user.email, subject, body)
    await session.flush()
    return AdminSubscriptionView(
        user=_admin_user_view(user, after.plan),
        subscription=ContractSubscriptionView(
            plan=after.plan,
            add_ons=after.add_ons,
            pricing_version=after.pricing_version,
            renews_at=after.renews_at,
        ),
        changed=configuration_changed,
    )


@router.get(
    "/users/{user_id}/subscription",
    response_model=AdminSubscriptionView,
    operation_id="adminGetSubscription",
)
async def get_subscription(
    user_id: uuid.UUID,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> AdminSubscriptionView:
    user = await _user_or_404(session, user_id)
    try:
        current = await get_gate().subscription(user.id)
    except PricingUnavailable as error:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(error)) from error
    return AdminSubscriptionView(
        user=_admin_user_view(user, current.plan),
        subscription=ContractSubscriptionView(
            plan=current.plan,
            add_ons=current.add_ons,
            pricing_version=current.pricing_version,
            renews_at=current.renews_at,
        ),
        changed=False,
    )


@router.post(
    "/users/{user_id}/subscription",
    response_model=AdminSubscriptionView,
    operation_id="adminChangeSubscription",
)
async def change_subscription(
    user_id: uuid.UUID,
    request: ChangeSubscriptionRequest,
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> AdminSubscriptionView:
    user = await _user_or_404(session, user_id)
    return await _apply_subscription(
        user,
        request.plan,
        request.add_ons,
        request.reason,
        request.detail,
        administrator,
        session,
        settings,
    )


@router.get(
    "/users/{user_id}/usage",
    response_model=UsageView,
    operation_id="adminGetUserUsage",
    summary="What an account has spent",
    responses={404: NOT_FOUND_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def user_usage(
    user_id: uuid.UUID,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UsageView:
    """The same view the account holder sees, read from the contract."""
    user = await _user_or_404(session, user_id)
    return await usage_view_for(user)


@router.delete(
    "/users/{user_id}/api-keys/{key_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="adminRevokeApiKey",
    summary="Revoke somebody's API key",
    responses={404: NOT_FOUND_RESPONSE},
)
async def revoke_api_key(
    user_id: uuid.UUID,
    key_id: uuid.UUID,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Take back a key, for when one has leaked and its owner is unreachable."""
    api_key = await session.get(ApiKey, key_id)
    if api_key is None or api_key.user_id != user_id or not api_key.is_active:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No such API key.")

    api_key.revoked_at = utcnow()
    await session.flush()
    return None


@router.post(
    "/users/{user_id}/usage/resync",
    response_model=UsageResyncResult,
    operation_id="adminResyncUsage",
    summary="Correct a drifted concurrency count",
    responses={404: NOT_FOUND_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def resync_usage(
    user_id: uuid.UUID,
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UsageResyncResult:
    """Reconcile the recorded concurrency against the jobs actually in flight.

    Concurrency is counted optimistically - checking and claiming are two
    calls - and the reconciler settles what it can see. This is the escape
    hatch for what it cannot: a slot recorded against an account that has
    nothing running. Counting the jobs is the authoritative answer, because
    they are rows in this database rather than a number somebody incremented.
    """
    user = await _user_or_404(session, user_id)
    gate = get_gate()

    in_flight = await session.scalar(
        select(func.count())
        .select_from(Job)
        .where(
            Job.owner_id == user.id,
            Job.metered.is_(False),
            Job.state.in_([JobState.QUEUED, JobState.RUNNING]),
        )
    )
    in_flight = int(in_flight or 0)

    try:
        snapshot = await gate.usage(user.id)
        limit_id = "concurrentJobs"
        recorded = snapshot.limits[limit_id].used if limit_id in snapshot.limits else 0.0
        drift = in_flight - recorded
        if drift:
            await gate.adjust_usage(user.id, {"concurrentJobs": drift})
    except PricingUnavailable as error:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            f"Usage cannot be resynchronised right now: {error}",
        ) from error

    return UsageResyncResult(
        plan=snapshot.plan,
        slots_in_flight=in_flight,
        slots_recorded=recorded,
        corrected_by=drift,
    )


@router.post(
    "/maintenance/reconcile-contracts",
    operation_id="adminReconcileContractRenewals",
    summary="Move expired contracts to the LIVE pricing release",
)
async def reconcile_contracts(
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict[str, int]:
    return {"migrated": await sweep_contract_renewals(session)}


@router.get("/overview", operation_id="adminPlatformOverview")
async def platform_overview(
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    """A bounded dashboard snapshot; no direct database console is required."""

    models = {
        "users": User,
        "identities": AuthIdentity,
        "organizations": Organization,
        "memberships": OrganizationMembership,
        "projects": Project,
        "cases": BindingCase,
        "caseRevisions": BindingCaseRevision,
        "projectResources": ProjectResource,
        "projectResourceRevisions": ProjectResourceRevision,
        "collections": Collection,
        "studies": Study,
        "studyRuns": StudyRun,
        "artifacts": Blob,
        "apiKeys": ApiKey,
        "pricingReleases": PricingRelease,
    }
    counts = {
        name: int(await session.scalar(select(func.count()).select_from(model)) or 0)
        for name, model in models.items()
    }
    queue = dict((await session.execute(
        select(Job.state, func.count(Job.id)).group_by(Job.state)
    )).all())
    plans = dict((await session.execute(
        select(User.plan_cache, func.count(User.id)).group_by(User.plan_cache)
    )).all())
    latest_audit = (await session.execute(
        select(AuditEvent)
        .where(AuditEvent.organization_id.is_(None))
        .order_by(AuditEvent.created_at.desc())
        .limit(8)
    )).scalars().all()
    return {
        "counts": counts,
        "jobs": {state.value: int(queue.get(state, 0)) for state in JobState},
        "contracts": {str(plan): int(count) for plan, count in plans.items()},
        "recentAudit": [
            {
                "id": str(item.id),
                "action": item.action,
                "targetType": item.target_type,
                "targetId": str(item.target_id) if item.target_id else None,
                "actorId": str(item.actor_id) if item.actor_id else None,
                "createdAt": item.created_at.isoformat(),
            }
            for item in latest_audit
        ],
    }


@router.get("/audit", operation_id="adminListAuditEvents")
async def list_audit_events(
    action: str | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    conditions = [AuditEvent.organization_id.is_(None)]
    if action:
        conditions.append(AuditEvent.action == action)
    total = int(await session.scalar(
        select(func.count(AuditEvent.id)).where(*conditions)
    ) or 0)
    rows = (await session.execute(
        select(AuditEvent)
        .where(*conditions)
        .order_by(AuditEvent.created_at.desc())
        .offset(offset)
        .limit(limit)
    )).scalars().all()
    return {
        "events": [
            {
                "id": str(item.id),
                "organizationId": None,
                "actorId": str(item.actor_id) if item.actor_id else None,
                "action": item.action,
                "targetType": item.target_type,
                "targetId": str(item.target_id) if item.target_id else None,
                "detail": item.detail,
                "createdAt": item.created_at.isoformat(),
            }
            for item in rows
        ],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


class AdminSponsorTransferRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    billing_sponsor_user_id: uuid.UUID


@router.post(
    "/organizations/{organization_id}/sponsor",
    response_model=OrganizationView,
    operation_id="adminTransferOrganizationSponsor",
    summary="Transfer billing sponsorship of an organization and its subtree",
    responses={
        404: NOT_FOUND_RESPONSE,
        422: {"description": "The sponsor account is not acceptable."},
        503: UNAVAILABLE_RESPONSE,
    },
)
async def admin_transfer_organization_sponsor(
    organization_id: uuid.UUID,
    payload: AdminSponsorTransferRequest,
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> OrganizationView:
    organization = await session.get(Organization, organization_id)
    if organization is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "Organization not found.")

    sponsor = await session.get(User, payload.billing_sponsor_user_id)
    if sponsor is None or not sponsor.is_active:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_sponsor", "Sponsor must be active.")

    await session.execute(select(User.id).where(User.id == sponsor.id).with_for_update())
    subtree = set(await descendant_ids(session, organization.id))
    sponsored = set(await sponsor_organization_ids(session, sponsor.id))
    hypothetical = await organization_usage(session, subtree | sponsored)
    await enforce_sponsor_usage(session, sponsor, hypothetical)

    previous_sponsor_id = organization.billing_sponsor_user_id
    await session.execute(
        update(Organization)
        .where(Organization.id.in_(subtree))
        .values(billing_sponsor_user_id=sponsor.id)
    )
    organization.billing_sponsor_user_id = sponsor.id

    session.add(
        AuditEvent(
            organization_id=organization.id,
            actor_id=administrator.id,
            action="organization.sponsor_transferred",
            target_type="Organization",
            target_id=organization.id,
            detail={
                "previous_sponsor_user_id": str(previous_sponsor_id),
                "new_sponsor_user_id": str(sponsor.id),
            },
        )
    )
    await session.flush()
    role = await effective_role(session, organization.id, administrator)
    return OrganizationView(
        id=organization.id,
        slug=organization.slug,
        name=organization.name,
        parent_id=organization.parent_id,
        billing_sponsor_user_id=organization.billing_sponsor_user_id,
        effective_role=role.value if role else None,
        created_at=organization.created_at,
    )


@router.get("/queues", operation_id="adminQueueStatus")
async def queue_status(
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    counts = dict((await session.execute(
        select(Job.state, func.count(Job.id)).group_by(Job.state)
    )).all())
    oldest = (await session.execute(
        select(Job)
        .where(Job.state.in_([JobState.QUEUED, JobState.RUNNING]))
        .order_by(Job.created_at)
        .limit(20)
    )).scalars().all()
    return {
        "counts": {state.value: int(counts.get(state, 0)) for state in JobState},
        "oldestInFlight": [
            {
                "id": str(job.id),
                "ownerId": str(job.owner_id) if job.owner_id else None,
                "engine": job.engine_id,
                "state": job.state.value,
                "createdAt": job.created_at.isoformat(),
                "budgetSeconds": job.requested_budget_s,
            }
            for job in oldest
        ],
    }


@router.get("/moderation", operation_id="adminModerationOverview")
async def moderation_overview(
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    async def statuses(model, column) -> dict[str, int]:
        rows = (await session.execute(select(column, func.count()).select_from(model).group_by(column))).all()
        return {str(value): int(count) for value, count in rows}

    return {
        "engines": await statuses(EngineRevision, EngineRevision.publication_status),
        "dialects": await statuses(DialectRevision, DialectRevision.publication_status),
        "registrations": await statuses(
            EngineRegistrationRevision, EngineRegistrationRevision.publication_status
        ),
    }


@router.get("/maintenance/preview", operation_id="adminPreviewMaintenance")
async def preview_maintenance(
    terminal_job_retention_days: int = Query(default=365, ge=7, le=3650),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    return await _maintenance_preview(session, terminal_job_retention_days)


@router.post("/maintenance/reconcile-jobs", operation_id="adminReconcileAbandonedJobs")
async def reconcile_abandoned_jobs(
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    settled = await metering.sweep_abandoned(get_gate(), session)
    session.add(AuditEvent(
        actor_id=administrator.id,
        action="maintenance.jobs.reconciled",
        target_type="JobQueue",
        detail={"settled": settled},
    ))
    return {"settled": settled}


@router.post("/maintenance/purge", operation_id="adminPurgeExpiredData")
async def purge_expired_data(
    request: MaintenancePurgeRequest,
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    settings: Settings = Depends(get_settings),
) -> dict:
    preview = await _maintenance_preview(session, request.terminal_job_retention_days)
    now = utcnow()
    from ..db.models import ArtifactVersion
    expired = (await session.execute(select(Blob).where(
        Blob.expires_at.is_not(None), Blob.expires_at <= now, ~Blob.id.in_(select(ArtifactVersion.blob_id))
    ))).scalars().all()
    root = Path(settings.artifact_root).resolve()
    removed_files = 0
    for artifact in expired:
        path = Path(artifact.storage_uri).resolve()
        await session.delete(artifact)
        await session.flush()
        retained = await session.scalar(select(Blob.id).where(Blob.storage_uri == artifact.storage_uri).limit(1))
        if not retained and path.is_relative_to(root) and path.is_file():
            path.unlink()
            removed_files += 1

    await session.execute(
        ApiKey.__table__.update()
        .where(ApiKey.expires_at.is_not(None), ApiKey.expires_at <= now, ApiKey.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    cutoff = now - timedelta(days=request.terminal_job_retention_days)
    study_job_ids = select(StudyCell.job_id).where(StudyCell.job_id.is_not(None))
    deleted_jobs = await session.execute(delete(Job).where(
        Job.state.in_([JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED]),
        Job.finished_at.is_not(None),
        Job.finished_at <= cutoff,
        Job.id.not_in(study_job_ids),
    ))
    cutoff_errors = now - timedelta(days=request.error_retention_days or 90)
    deleted_errors = await session.execute(delete(ApiErrorEvent).where(
        ApiErrorEvent.created_at <= cutoff_errors
    ))
    session.add(AuditEvent(
        actor_id=administrator.id,
        action="maintenance.expired.purged",
        target_type="Platform",
        detail={**preview, "artifactFilesRemoved": removed_files},
    ))
    res = {
        "artifacts": len(expired),
        "artifactFiles": removed_files,
        "apiKeys": preview["expiredApiKeys"],
        "jobs": deleted_jobs.rowcount or 0,
    }
    if "error_retention_days" in request.model_fields_set:
        res["errorEvents"] = deleted_errors.rowcount or 0
    return res


@router.get("/errors/overview", operation_id="adminErrorOverview")
async def get_error_overview(
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    now = utcnow()
    since = now - timedelta(hours=24)

    total_errors = int(await session.scalar(
        select(func.count(ApiErrorEvent.id)).where(ApiErrorEvent.created_at >= since)
    ) or 0)

    cat_rows = (await session.execute(
        select(ApiErrorEvent.category, func.count(ApiErrorEvent.id))
        .where(ApiErrorEvent.created_at >= since)
        .group_by(ApiErrorEvent.category)
    )).all()
    by_category = {str(cat): int(count) for cat, count in cat_rows}

    status_rows = (await session.execute(
        select(ApiErrorEvent.status_code, func.count(ApiErrorEvent.id))
        .where(ApiErrorEvent.created_at >= since)
        .group_by(ApiErrorEvent.status_code)
    )).all()
    by_status_code = {str(status): int(count) for status, count in status_rows}

    top_users_query = (
        select(
            ApiErrorEvent.user_id,
            func.count(ApiErrorEvent.id).label("cnt"),
            func.max(ApiErrorEvent.created_at).label("last_seen"),
        )
        .where(
            ApiErrorEvent.created_at >= since,
            ApiErrorEvent.category.in_(["pricing_quota", "concurrency"]),
            ApiErrorEvent.user_id.is_not(None),
        )
        .group_by(ApiErrorEvent.user_id)
        .order_by(func.count(ApiErrorEvent.id).desc())
        .limit(10)
    )
    top_users_rows = (await session.execute(top_users_query)).all()
    user_ids = [row.user_id for row in top_users_rows if row.user_id]
    user_map = {}
    if user_ids:
        users = (await session.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        user_map = {u.id: u.email for u in users}

    top_users_quota = []
    for row in top_users_rows:
        top_users_quota.append({
            "userId": str(row.user_id),
            "email": user_map.get(row.user_id),
            "errorCount": int(row.cnt),
            "lastSeen": row.last_seen.isoformat() if row.last_seen else None,
        })

    solver_query = (
        select(
            ApiErrorEvent.endpoint,
            func.count(ApiErrorEvent.id).label("cnt"),
            func.max(ApiErrorEvent.created_at).label("last_seen"),
        )
        .where(
            ApiErrorEvent.created_at >= since,
            ApiErrorEvent.category == "solver_failure",
        )
        .group_by(ApiErrorEvent.endpoint)
        .order_by(func.count(ApiErrorEvent.id).desc())
        .limit(10)
    )
    solver_rows = (await session.execute(solver_query)).all()
    top_solvers_failed = []
    for row in solver_rows:
        top_solvers_failed.append({
            "engine": row.endpoint,
            "failureCount": int(row.cnt),
            "lastSeen": row.last_seen.isoformat() if row.last_seen else None,
        })

    events_timeline = (await session.execute(
        select(ApiErrorEvent.category, ApiErrorEvent.created_at)
        .where(ApiErrorEvent.created_at >= since)
        .order_by(ApiErrorEvent.created_at.asc())
    )).all()

    buckets: dict[str, dict[str, Any]] = {}
    for i in range(24):
        slot_time = (since + timedelta(hours=i)).replace(minute=0, second=0, microsecond=0)
        key = slot_time.isoformat()
        buckets[key] = {
            "timestamp": key,
            "quota": 0,
            "concurrency": 0,
            "solver": 0,
            "system": 0,
            "validation": 0,
        }

    for cat, ts in events_timeline:
        if ts is not None:
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            slot_key = ts.replace(minute=0, second=0, microsecond=0).isoformat()
            if slot_key in buckets:
                if cat == "pricing_quota":
                    buckets[slot_key]["quota"] += 1
                elif cat == "concurrency":
                    buckets[slot_key]["concurrency"] += 1
                elif cat == "solver_failure":
                    buckets[slot_key]["solver"] += 1
                elif cat == "system_bug":
                    buckets[slot_key]["system"] += 1
                elif cat == "validation":
                    buckets[slot_key]["validation"] += 1

    return {
        "total_errors_24h": total_errors,
        "by_category_24h": by_category,
        "by_status_code_24h": by_status_code,
        "top_users_quota": top_users_quota,
        "top_solvers_failed": top_solvers_failed,
        "timeline": list(buckets.values()),
    }


@router.get("/errors", operation_id="adminListErrors")
async def list_error_events(
    category: Optional[str] = None,
    user_id: Optional[uuid.UUID] = None,
    status_code: Optional[int] = None,
    search: Optional[str] = None,
    from_date: Optional[datetime] = None,
    to_date: Optional[datetime] = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    administrator: User = Depends(require_admin),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> dict:
    stmt = select(ApiErrorEvent)
    count_stmt = select(func.count(ApiErrorEvent.id))

    filters = []
    if category:
        filters.append(ApiErrorEvent.category == category)
    if user_id:
        filters.append(ApiErrorEvent.user_id == user_id)
    if status_code:
        filters.append(ApiErrorEvent.status_code == status_code)
    if from_date:
        filters.append(ApiErrorEvent.created_at >= from_date)
    if to_date:
        filters.append(ApiErrorEvent.created_at <= to_date)
    if search:
        search_pattern = f"%{search}%"
        filters.append(
            ApiErrorEvent.error_code.ilike(search_pattern)
            | ApiErrorEvent.endpoint.ilike(search_pattern)
        )

    if filters:
        stmt = stmt.where(*filters)
        count_stmt = count_stmt.where(*filters)

    total = int(await session.scalar(count_stmt) or 0)
    events = (
        await session.execute(
            stmt.order_by(ApiErrorEvent.created_at.desc()).offset(offset).limit(limit)
        )
    ).scalars().all()

    user_ids = {e.user_id for e in events if e.user_id}
    user_map = {}
    if user_ids:
        users = (await session.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        user_map = {u.id: (u.email, u.username) for u in users}

    items = []
    for e in events:
        user_info = user_map.get(e.user_id) if e.user_id else None
        items.append({
            "id": str(e.id),
            "user_id": str(e.user_id) if e.user_id else None,
            "userId": str(e.user_id) if e.user_id else None,
            "user_email": user_info[0] if user_info else None,
            "userEmail": user_info[0] if user_info else None,
            "organization_id": str(e.organization_id) if e.organization_id else None,
            "organizationId": str(e.organization_id) if e.organization_id else None,
            "status_code": e.status_code,
            "statusCode": e.status_code,
            "category": e.category,
            "error_code": e.error_code,
            "errorCode": e.error_code,
            "endpoint": e.endpoint,
            "http_method": e.http_method,
            "httpMethod": e.http_method,
            "detail": e.detail,
            "created_at": e.created_at.isoformat() if e.created_at else None,
            "createdAt": e.created_at.isoformat() if e.created_at else None,
        })

    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


class EngineRoutingMetricsResponse(BaseModel):
    summary: dict[str, Any]
    engines: dict[str, Any]


class AdaptationObservationItem(BaseModel):
    id: str
    jobId: Optional[str] = None
    adaptationLoopId: str
    engineSelected: str
    workloadFeatures: dict[str, Any]
    candidateEvaluations: list[dict[str, Any]]
    predictedMetrics: dict[str, Any]
    actualMetrics: Optional[dict[str, Any]] = None
    residuals: Optional[dict[str, Any]] = None
    outcome: str
    engineHealthSnapshot: Optional[dict[str, Any]] = None
    createdAt: Optional[str] = None


class EngineRoutingObservationsResponse(BaseModel):
    total: int
    limit: int
    offset: int
    observations: list[AdaptationObservationItem]


class EngineRoutingRecalibrateResponse(BaseModel):
    status: str
    recalibratedAt: str
    observationsProcessed: int
    calibratedEngines: list[str]


@router.get(
    "/engine-routing/metrics",
    response_model=EngineRoutingMetricsResponse,
    summary="Retrieve engine routing runtime health metrics",
    description="Returns autonomic health snapshots, observed failure rates, and active concurrency across candidate engines.",
    operation_id="admin_engine_routing_metrics",
)
async def get_engine_routing_metrics() -> EngineRoutingMetricsResponse:
    from ..engine_routing import get_health_monitor

    monitor = get_health_monitor()
    snapshots = monitor.get_all_snapshots()
    healthy_count = sum(1 for s in snapshots.values() if s.get("healthStatus") == "HEALTHY")
    degraded_count = sum(1 for s in snapshots.values() if s.get("healthStatus") == "DEGRADED")
    active_total = sum(s.get("activeJobs", 0) for s in snapshots.values())

    return EngineRoutingMetricsResponse(
        summary={
            "totalEngines": len(snapshots),
            "healthyEngines": healthy_count,
            "degradedEngines": degraded_count,
            "activeJobs": active_total,
        },
        engines=snapshots,
    )


@router.get(
    "/engine-routing/observations",
    response_model=EngineRoutingObservationsResponse,
    summary="List historical MAPE-K adaptation observations",
    description="Returns paginated records of instance features, candidate evaluations, predicted metrics and actual execution telemetry.",
    operation_id="admin_engine_routing_observations",
)
async def list_engine_routing_observations(
    session: AsyncSession = Depends(session_dependency),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    engine: Optional[str] = Query(default=None),
) -> EngineRoutingObservationsResponse:
    from ..db.models import AdaptationObservation

    query = select(AdaptationObservation)
    count_query = select(func.count()).select_from(AdaptationObservation)

    if engine:
        query = query.where(AdaptationObservation.engine_selected == engine)
        count_query = count_query.where(AdaptationObservation.engine_selected == engine)

    total = (await session.scalar(count_query)) or 0
    rows = await session.execute(
        query.order_by(AdaptationObservation.created_at.desc()).offset(offset).limit(limit)
    )
    obs_list = rows.scalars().all()

    items = [
        AdaptationObservationItem(
            id=str(obs.id),
            jobId=str(obs.job_id) if obs.job_id else None,
            adaptationLoopId=obs.adaptation_loop_id,
            engineSelected=obs.engine_selected,
            workloadFeatures=obs.workload_features or {},
            candidateEvaluations=obs.candidate_evaluations or [],
            predictedMetrics=obs.predicted_metrics or {},
            actualMetrics=obs.actual_metrics,
            residuals=obs.residuals,
            outcome=obs.outcome,
            engineHealthSnapshot=obs.engine_health_snapshot,
            createdAt=obs.created_at.isoformat() if obs.created_at else None,
        )
        for obs in obs_list
    ]

    return EngineRoutingObservationsResponse(
        total=total,
        limit=limit,
        offset=offset,
        observations=items,
    )


@router.post(
    "/engine-routing/recalibrate",
    response_model=EngineRoutingRecalibrateResponse,
    summary="Trigger model recalibration across historical observations",
    description="Updates empirical confidence densities and predictive models using stored observations.",
    operation_id="admin_engine_routing_recalibrate",
)
async def recalibrate_engine_routing(
    session: AsyncSession = Depends(session_dependency),
) -> EngineRoutingRecalibrateResponse:
    from ..engine_routing import get_adaptation_manager

    result = await get_adaptation_manager().recalibrate(session)
    return EngineRoutingRecalibrateResponse(
        status=result.get("status", "recalibrated"),
        recalibratedAt=result.get("recalibratedAt", utcnow().isoformat()),
        observationsProcessed=result.get("observationsProcessed", 0),
        calibratedEngines=result.get("calibratedEngines", []),
    )
