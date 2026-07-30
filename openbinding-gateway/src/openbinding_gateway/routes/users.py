"""The account a caller owns: their profile, and later their keys and usage."""

from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, get_user_by_identifier, session_dependency
from ..db.models import ApiKey, Job, User, utcnow
from ..models.accounts import (
    ApiKeyList,
    ApiKeySummary,
    CreateApiKeyRequest,
    CreatedApiKey,
    JobHistory,
    JobSummary,
    LimitUsageView,
    PlanCapsView,
    PricingTokenView,
    UpdateProfileRequest,
    UsageView,
    UserProfile,
)
from ..models.errors import (
    CONFLICT_RESPONSE,
    NOT_FOUND_RESPONSE,
    QUOTA_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
from ..security.apikeys import mint
from ..security.passwords import hash_password, password_complaint, verify_password
from ..space_client import PricingUnavailable, get_gate

router = APIRouter(prefix="/v1/users", tags=["Users"])


async def _caps_for(user: User):
    """This account's ceilings, or the cautious defaults if SPACE cannot say.

    Failing open here is deliberate and narrow: it lets somebody mint a key
    while the pricing service is restarting, which is a smaller harm than
    locking them out of their own account over it.
    """
    from ..space_client import PlanCaps

    try:
        return await get_gate().caps(user.id)
    except PricingUnavailable:
        return PlanCaps()


def profile_of(user: User) -> UserProfile:
    return UserProfile(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role.value,
        is_active=user.is_active,
        plan=user.plan_cache.value,
        created_at=user.created_at,
    )


@router.get(
    "/me",
    response_model=UserProfile,
    operation_id="getOwnProfile",
    summary="The signed-in account",
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def read_own_profile(user: User = Depends(get_current_user)) -> UserProfile:
    return profile_of(user)


@router.patch(
    "/me",
    response_model=UserProfile,
    operation_id="updateOwnProfile",
    summary="Change your email or password",
    responses={
        401: UNAUTHORIZED_RESPONSE,
        409: CONFLICT_RESPONSE,
        422: {"description": "The new password is not acceptable."},
        503: UNAVAILABLE_RESPONSE,
    },
)
async def update_own_profile(
    request: UpdateProfileRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> UserProfile:
    """Change what the account holder is allowed to change.

    Both changes need the current password. Email is included in that because
    the email address is one of the two ways to sign in, so changing it is a
    change of credential, not of contact details.
    """
    if request.new_password is None and request.email is None:
        return profile_of(user)

    if not request.current_password or not verify_password(
        request.current_password, user.password_hash
    ):
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "invalid_credentials",
            "The current password is required to change these details.",
        )

    if request.email is not None:
        email = request.email.lower()
        if email != user.email:
            existing = await get_user_by_identifier(session, email)
            if existing is not None:
                raise api_error(
                    status.HTTP_409_CONFLICT,
                    "already_registered",
                    "That email is already in use.",
                )
            user.email = email

    if request.new_password is not None:
        complaint = password_complaint(request.new_password)
        if complaint:
            raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "weak_password", complaint)
        user.password_hash = hash_password(request.new_password)

    await session.flush()
    return profile_of(user)


async def _own_active_keys(session: AsyncSession, user: User) -> list[ApiKey]:
    result = await session.execute(
        select(ApiKey)
        .where(ApiKey.user_id == user.id, ApiKey.revoked_at.is_(None))
        .order_by(ApiKey.created_at)
    )
    return list(result.scalars().all())


@router.get(
    "/me/api-keys",
    response_model=ApiKeyList,
    operation_id="listOwnApiKeys",
    summary="Your API keys",
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def list_own_api_keys(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> ApiKeyList:
    """List the keys that still work. Revoked ones are gone, not shown greyed out."""
    keys = await _own_active_keys(session, user)
    return ApiKeyList(api_keys=[ApiKeySummary.model_validate(key) for key in keys])


@router.post(
    "/me/api-keys",
    response_model=CreatedApiKey,
    status_code=status.HTTP_201_CREATED,
    operation_id="createApiKey",
    summary="Mint an API key",
    responses={
        401: UNAUTHORIZED_RESPONSE,
        402: QUOTA_RESPONSE,
        503: UNAVAILABLE_RESPONSE,
    },
)
async def create_api_key(
    request: CreateApiKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> CreatedApiKey:
    """Mint a key and return it once.

    This is the only response that ever contains the secret. What is stored is
    a hash, so there is no way to produce it again - a caller who loses it has
    to revoke the key and mint another.

    How many a plan allows is counted here rather than asked of SPACE. An API
    key is a row in this database, so the number of live ones is a fact the
    gateway already holds - and counting it avoids the drift that comes from
    keeping a tally of something somebody else stores.
    """
    caps = await _caps_for(user)
    if caps.api_keys_limit is not None:
        live = len(await _own_active_keys(session, user))
        if live >= caps.api_keys_limit:
            raise api_error(
                status.HTTP_402_PAYMENT_REQUIRED,
                "quota_exceeded",
                f"Your plan allows {caps.api_keys_limit} API key"
                f"{'' if caps.api_keys_limit == 1 else 's'}, and you have {live}. "
                f"Revoke one, or move to a plan that allows more.",
                quota={
                    "limit_id": "apiKeysLimit",
                    "limit": caps.api_keys_limit,
                    "used": live,
                    "renews_at": None,
                },
            )

    minted = mint()
    api_key = ApiKey(
        user_id=user.id,
        name=request.name,
        prefix=minted.prefix,
        secret_hash=minted.secret_hash,
    )
    session.add(api_key)
    await session.flush()

    return CreatedApiKey(
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        created_at=api_key.created_at,
        last_used_at=None,
        secret=minted.secret,
    )


@router.delete(
    "/me/api-keys/{key_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="revokeApiKey",
    summary="Revoke an API key",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def revoke_api_key(
    key_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> None:
    """Revoke a key of your own.

    Somebody else's key answers 404 rather than 403: a caller who may not
    touch it should not be able to learn that it exists.
    """
    api_key = await session.get(ApiKey, key_id)
    if api_key is None or api_key.user_id != user.id or not api_key.is_active:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No such API key.")

    api_key.revoked_at = utcnow()
    await session.flush()
    return None


@router.get(
    "/me/jobs",
    response_model=JobHistory,
    operation_id="listOwnJobs",
    summary="Solves you have asked for",
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def list_own_jobs(
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency),
) -> JobHistory:
    """Your own solves, newest first, as far back as your plan keeps them.

    The retention window is the ``jobHistoryRetentionLimit`` in the pricing -
    seven days on the free plan, ninety on PRO. It was carried all the way to
    ``GET /v1/users/me/usage`` and displayed there while nothing applied it,
    because there was no endpoint for it to bound. This is that endpoint, and
    the cutoff is applied here rather than by deleting rows: a job that has
    aged out of somebody's history is still the row the metering reconciler
    and any audit need.

    Summaries only. A result can be hundreds of megabytes, and a history is for
    finding the one you want; ``GET /v1/jobs/{id}`` returns the answer itself.
    """
    caps = await _caps_for(user)
    cutoff = utcnow() - timedelta(days=caps.job_history_days)

    visible = (
        select(Job)
        .where(Job.owner_id == user.id)
        .where(Job.created_at >= cutoff)
    )

    total = await session.scalar(
        select(func.count()).select_from(visible.subquery())
    )

    rows = (
        (
            await session.execute(
                visible.order_by(Job.created_at.desc())
                .limit(max(1, min(limit, 200)))
                .offset(max(0, offset))
            )
        )
        .scalars()
        .all()
    )

    return JobHistory(
        jobs=[_job_summary(row) for row in rows],
        total=int(total or 0),
        retention_days=caps.job_history_days,
    )


def _job_summary(job: Job) -> JobSummary:
    """What is worth showing without opening the result.

    ``result`` is JSON on the row and may be enormous, so only its shape is
    read - how many solutions, and what the feasibility verdict was.
    """
    result = job.result if isinstance(job.result, dict) else {}
    solutions = result.get("solutions")

    return JobSummary(
        id=job.id,
        engine_id=job.engine_id,
        status=job.state.value,
        feasibility=result.get("feasibility"),
        solutions=len(solutions) if isinstance(solutions, list) else None,
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


@router.get(
    "/me/usage",
    response_model=UsageView,
    operation_id="getOwnUsage",
    summary="Your plan, quotas and what is left of them",
    responses={
        401: UNAUTHORIZED_RESPONSE,
        503: {**UNAVAILABLE_RESPONSE, "description": "The pricing service is not reachable."},
    },
)
async def read_own_usage(user: User = Depends(get_current_user)) -> UsageView:
    """Everything the account page needs about entitlements, in one call."""
    return await usage_view_for(user)


async def usage_view_for(user: User) -> UsageView:
    """An account's entitlements, read from the contract.

    The plan on the ``User`` row is a display cache; the contract in the
    pricing service is what actually decides. This reads the contract, so what
    a caller sees is what a solve will be judged against. Shared with the
    administration routes, so that an administrator and an account holder are
    never shown different numbers.
    """
    gate = get_gate()
    try:
        snapshot = await gate.usage(user.id)
        caps = await gate.caps(user.id)
    except PricingUnavailable as error:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            f"Quotas cannot be read right now: {error}",
        ) from error

    return UsageView(
        plan=snapshot.plan,
        contract_pending=user.contract_pending,
        caps=PlanCapsView(
            max_timeout_s=caps.max_timeout_s,
            max_iterations=caps.max_iterations,
            max_payload_mb=caps.max_payload_mb,
            max_binding_space_log10=caps.max_binding_space_log10,
            job_history_days=caps.job_history_days,
        ),
        limits=[
            LimitUsageView(
                limit_id=limit.limit_id,
                limit=limit.limit,
                used=limit.used,
                remaining=limit.remaining,
                unit=limit.unit,
                renews_at=limit.renews_at,
            )
            for limit in snapshot.limits.values()
        ],
    )


@router.get(
    "/me/pricing-token",
    response_model=PricingTokenView,
    operation_id="getOwnPricingToken",
    summary="A signed token for evaluating features in the browser",
    responses={
        401: UNAUTHORIZED_RESPONSE,
        503: {**UNAVAILABLE_RESPONSE, "description": "The pricing service is not reachable."},
    },
)
async def read_own_pricing_token(user: User = Depends(get_current_user)) -> PricingTokenView:
    """Mint the token the interface gates features with.

    The browser never talks to the pricing service directly - it is not
    published, and it holds every account's contract. It gets this instead: a
    signed statement of what this one account may do, which the frontend
    evaluates locally.
    """
    try:
        token = await get_gate().pricing_token(user.id)
    except PricingUnavailable as error:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            f"A pricing token cannot be issued right now: {error}",
        ) from error

    return PricingTokenView(pricing_token=token)
