"""What an administrator can do to somebody else's account.

Deliberately a short list. An administrator can see accounts, deactivate one,
change its role, move it between plans, and take back a key. They cannot change
a password or an email address: those are the two ways to sign in, so an
administrator able to change them could take an account over without its owner
noticing, and nothing here needs that.

Moving somebody between plans is the only reason the PRO plan works at all -
there is no payment gateway, so an upgrade is an administrator performing a
novation on the SPACE contract.

Every one of these is an endpoint rather than a database chore, because the
administration screen is a client of this API like any other.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import require_admin, session_dependency
from ..db.models import ApiKey, Job, JobState, Plan, User, UserRole, utcnow
from ..models.accounts import (
    AdminUserPage,
    AdminUserView,
    ChangePlanRequest,
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
from ..space_client import PricingUnavailable, get_gate
from .users import usage_view_for

router = APIRouter(
    prefix="/v1/admin",
    tags=["Administration"],
    dependencies=[Depends(require_admin)],
    responses={401: UNAUTHORIZED_RESPONSE, 403: FORBIDDEN_RESPONSE},
)


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
    session: AsyncSession = Depends(session_dependency),
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

    return AdminUserPage(
        users=[
            AdminUserView(
                id=user.id,
                username=user.username,
                email=user.email,
                role=user.role.value,
                is_active=user.is_active,
                plan=user.plan_cache.value,
                created_at=user.created_at,
                contract_pending=user.contract_pending,
                api_key_count=key_counts.get(user.id, 0),
            )
            for user in users
        ],
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
    session: AsyncSession = Depends(session_dependency),
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
    return AdminUserView(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role.value,
        is_active=user.is_active,
        plan=user.plan_cache.value,
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
    session: AsyncSession = Depends(session_dependency),
) -> AdminUserView:
    """Perform the novation, then update what the interface displays.

    In that order, and it matters: the contract is what decides what a request
    may do, and the column here only decides what a list looks like. If the
    novation fails, nothing should claim it succeeded.
    """
    user = await _user_or_404(session, user_id)

    try:
        await get_gate().change_plan(user.id, request.plan.value)
    except PricingUnavailable as error:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            f"The plan cannot be changed right now: {error}",
        ) from error

    user.plan_cache = Plan(request.plan.value)
    user.contract_pending = False
    await session.flush()

    return AdminUserView(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role.value,
        is_active=user.is_active,
        plan=user.plan_cache.value,
        created_at=user.created_at,
        contract_pending=user.contract_pending,
        api_key_count=0,
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
    session: AsyncSession = Depends(session_dependency),
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
    session: AsyncSession = Depends(session_dependency),
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
    session: AsyncSession = Depends(session_dependency),
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
        recorded = snapshot.limits["concurrentTasksLimit"].used if "concurrentTasksLimit" in snapshot.limits else 0.0
        drift = in_flight - recorded
        if drift:
            await gate.adjust_usage(user.id, {"concurrentTasksLimit": drift})
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
