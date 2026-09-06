"""The account a caller owns: their profile, and later their keys and usage."""

from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, get_user_by_identifier, session_dependency
from ..db.models import (
    ApiKey, Artifact, AuthIdentity, BindingCase, BindingCaseRevision, Collection,
    CollectionItem, CollectionRevision, Job, Organization, OrganizationMembership,
    OrganizationRole, PricingRelease, Project, ProjectResource,
    ProjectResourceRevision, Publication, Report, Study, StudyRun, User, utcnow,
)
from ..models.accounts import (
    ApiKeyList,
    ApiKeyBoundary,
    ApiKeyEngineAccess,
    ApiKeyEngineRef,
    ApiKeySummary,
    AccountDeleteRequest,
    CreateApiKeyRequest,
    CreatedApiKey,
    JobHistory,
    JobSummary,
    LimitUsageView,
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
from ..security.apikeys import (
    ADMIN_PERMISSIONS,
    allows_engine,
    authenticated_api_key,
    boundary_is_subset,
    boundary_of,
    engine_access_of,
    grants_document,
    mint,
    permissions_of,
)
from ..security.passwords import hash_password, password_complaint, verify_password
from ..space_client import PricingUnavailable, get_gate

router = APIRouter(prefix="/v1/users", tags=["Users"])


async def _caps_for(user: User):
    """Read authoritative entitlements; unavailable pricing fails closed."""
    try:
        return await get_gate().caps(user.id)
    except PricingUnavailable as error:
        raise api_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            f"Entitlements cannot be read right now: {error}",
        ) from error


async def profile_of(session: AsyncSession, user: User) -> UserProfile:
    cas_verified = bool(await session.scalar(select(func.count(AuthIdentity.id)).where(
        AuthIdentity.user_id == user.id, AuthIdentity.provider == "us-cas"
    )))
    caps = await _caps_for(user)
    institutional_branding = cas_verified and caps.allows("institutionalBranding")
    return UserProfile(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role.value,
        is_active=user.is_active,
        plan=caps.plan,
        created_at=user.created_at,
        cas_verified=cas_verified,
        institutional_branding=institutional_branding,
    )


@router.get(
    "/me",
    response_model=UserProfile,
    operation_id="getOwnProfile",
    summary="The signed-in account",
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def read_own_profile(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UserProfile:
    return await profile_of(session, user)


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
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UserProfile:
    """Change what the account holder is allowed to change.

    Both changes need the current password. Email is included in that because
    the email address is one of the two ways to sign in, so changing it is a
    change of credential, not of contact details.
    """
    if request.new_password is None and request.email is None:
        return await profile_of(session, user)

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
        user.password_enabled = True

    await session.flush()
    return await profile_of(session, user)


async def _own_active_keys(session: AsyncSession, user: User) -> list[ApiKey]:
    result = await session.execute(
        select(ApiKey)
        .where(ApiKey.user_id == user.id, ApiKey.revoked_at.is_(None))
        .order_by(ApiKey.created_at)
    )
    return list(result.scalars().all())


def _api_key_summary(api_key: ApiKey) -> ApiKeySummary:
    all_engines, engine_refs = engine_access_of(api_key)
    boundary = boundary_of(api_key)
    boundary_data = {} if boundary is None else {
        "methods": sorted(boundary.get("methods", [])) or None,
        "organizations": sorted(boundary.get("organizations", [])) or None,
        "projects": sorted(boundary.get("projects", [])) or None,
        "resource_kinds": sorted(boundary.get("resourceKinds", [])) or None,
        "slugs": sorted(boundary.get("slugs", [])) or None,
    }
    return ApiKeySummary(
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        created_at=api_key.created_at,
        last_used_at=api_key.last_used_at,
        expires_at=api_key.expires_at,
        permissions=sorted(permissions_of(api_key)),
        engine_access=ApiKeyEngineAccess(
            all=all_engines,
            engines=[
                ApiKeyEngineRef(
                    namespace=reference[0],
                    name=reference[1],
                    version=reference[2],
                    digest=reference[3],
                )
                for reference in sorted(engine_refs)
            ],
        ),
        boundary=ApiKeyBoundary(**boundary_data),
    )


@router.get(
    "/me/api-keys",
    response_model=ApiKeyList,
    operation_id="listOwnApiKeys",
    summary="Your API keys",
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def list_own_api_keys(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> ApiKeyList:
    """List the keys that still work. Revoked ones are gone, not shown greyed out."""
    keys = await _own_active_keys(session, user)
    return ApiKeyList(api_keys=[_api_key_summary(key) for key in keys])


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
    request: Request,
    payload: CreateApiKeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
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
    requested_permissions = {permission.value for permission in payload.permissions}
    if not user.is_admin and requested_permissions & ADMIN_PERMISSIONS:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "permission_not_grantable",
            "Only an administrator account may grant moderation or account-administration permissions.",
        )

    parent_key = authenticated_api_key(user)
    if parent_key is not None:
        parent_permissions = permissions_of(parent_key)
        if not requested_permissions <= parent_permissions:
            raise api_error(
                status.HTTP_403_FORBIDDEN,
                "api_key_escalation",
                "A key may create only keys whose permissions are a subset of its own.",
            )
        parent_all_engines, parent_engines = engine_access_of(parent_key)
        requested_engines = {
            (engine.namespace, engine.name, engine.version, engine.digest)
            for engine in payload.engine_access.engines
        }
        if payload.engine_access.all and not parent_all_engines:
            raise api_error(
                status.HTTP_403_FORBIDDEN,
                "api_key_escalation",
                "A key limited to selected Engines cannot create an all-Engines key.",
            )
        if not parent_all_engines and not requested_engines <= parent_engines:
            raise api_error(
                status.HTTP_403_FORBIDDEN,
                "api_key_escalation",
                "A key may grant only Engine revisions it can access itself.",
            )
        if not boundary_is_subset(payload.boundary.grants_shape(), boundary_of(parent_key)):
            raise api_error(
                status.HTTP_403_FORBIDDEN,
                "api_key_escalation",
                "A key may only narrow its own method and resource boundary.",
            )

    caps = await _caps_for(user)
    api_keys_limit = caps.limit("apiKeys")
    if api_keys_limit is not None:
        # Serialize this user's count-and-insert on PostgreSQL. Without the
        # row lock, concurrent requests could both observe nine live keys and
        # both exceed the active contract's dynamic allowance.
        await session.execute(select(User.id).where(User.id == user.id).with_for_update())
        live = len(await _own_active_keys(session, user))
        if live >= api_keys_limit:
            raise api_error(
                status.HTTP_402_PAYMENT_REQUIRED,
                "quota_exceeded",
                f"Your plan allows {int(api_keys_limit)} API key"
                f"{'' if api_keys_limit == 1 else 's'}, and you have {live}. "
                f"Revoke one, or move to a plan that allows more.",
                quota={
                    "limit_id": "apiKeys",
                    "limit": api_keys_limit,
                    "used": live,
                    "renews_at": None,
                },
            )

    minted = mint()
    api_key = ApiKey(
        user_id=user.id,
        name=payload.name,
        prefix=minted.prefix,
        secret_hash=minted.secret_hash,
        grants=grants_document(
            sorted(requested_permissions),
            all_engines=payload.engine_access.all,
            engines=[engine.model_dump() for engine in payload.engine_access.engines],
            boundary=payload.boundary.grants_shape(),
        ),
        expires_at=payload.expires_at,
    )
    session.add(api_key)
    await session.flush()

    return CreatedApiKey(
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        created_at=api_key.created_at,
        last_used_at=None,
        expires_at=api_key.expires_at,
        permissions=sorted(requested_permissions),
        engine_access=payload.engine_access,
        boundary=payload.boundary,
        secret=minted.secret,
    )


@router.post(
    "/me/api-keys/{key_id}/rotate",
    response_model=CreatedApiKey,
    operation_id="rotateApiKey",
    summary="Rotate an API key without changing its authority",
    responses={401: UNAUTHORIZED_RESPONSE, 404: NOT_FOUND_RESPONSE, 503: UNAVAILABLE_RESPONSE},
)
async def rotate_api_key(
    key_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> CreatedApiKey:
    old = await session.get(ApiKey, key_id)
    if old is None or old.user_id != user.id or not old.is_active:
        raise api_error(status.HTTP_404_NOT_FOUND, "not_found", "No such API key.")
    minted = mint()
    replacement = ApiKey(
        user_id=user.id,
        name=old.name,
        prefix=minted.prefix,
        secret_hash=minted.secret_hash,
        grants=old.grants,
        expires_at=old.expires_at,
        rotated_from_id=old.id,
    )
    session.add(replacement)
    old.revoked_at = utcnow()
    await session.flush()
    summary = _api_key_summary(replacement)
    return CreatedApiKey(**summary.model_dump(), secret=minted.secret)


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
    session: AsyncSession = Depends(session_dependency, scope="function"),
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
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> JobHistory:
    """Your own solves, newest first, as far back as your plan keeps them.

    The retention window comes from SPACE under the canonical ``jobHistoryDays``
    identifier. It
    was carried all the way to ``GET /v1/users/me/usage`` and displayed there
    while nothing applied it, because there was no endpoint for it to bound.
    This is that endpoint, and the cutoff is applied here rather than by
    deleting rows: a job that has aged out of somebody's history is still the
    row the metering reconciler and any audit need.

    Summaries only. A result can be hundreds of megabytes, and a history is for
    finding the one you want; ``GET /v1/jobs/{id}`` returns the answer itself.
    """
    caps = await _caps_for(user)
    retention_days = caps.limit("jobHistoryDays")

    visible = (
        select(Job)
        .where(Job.owner_id == user.id)
    )
    if retention_days is not None:
        visible = visible.where(Job.created_at >= utcnow() - timedelta(days=retention_days))

    if authenticated_api_key(user) is None:
        total = await session.scalar(select(func.count()).select_from(visible.subquery()))
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
    else:
        candidates = (
            (await session.execute(visible.order_by(Job.created_at.desc())))
            .scalars()
            .all()
        )
        permitted = [
            job
            for job in candidates
            if allows_engine(
                user,
                (job.provenance or {}).get("engine", {})
                if isinstance(job.provenance, dict)
                else {},
            )
        ]
        total = len(permitted)
        start = max(0, offset)
        rows = permitted[start : start + max(1, min(limit, 200))]

    return JobHistory(
        jobs=[_job_summary(row) for row in rows],
        total=int(total or 0),
        retention_days=retention_days,
    )


def _job_summary(job: Job) -> JobSummary:
    """What is worth showing without opening the result.

    ``result`` is JSON on the row and may be enormous, so only its shape is
    read - how many solutions, and what the canonical termination was.
    """
    result = job.result if isinstance(job.result, dict) else {}
    solutions = result.get("solutions")

    return JobSummary(
        id=job.id,
        engine_id=job.engine_id,
        status=job.state.value,
        termination=job.termination,
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
        features=caps.features,
        capabilities=caps.http_view()["capabilities"],
        limits={
            name: LimitUsageView(
                limit_id=limit.limit_id,
                limit=limit.limit,
                used=limit.used,
                remaining=limit.remaining,
                unit=limit.unit,
                renews_at=limit.renews_at,
            )
            for name, limit in snapshot.limits.items()
        },
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


@router.delete(
    "/me",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteOwnAccount",
    summary="Delete the account and revoke every credential",
)
async def delete_own_account(
    payload: AccountDeleteRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    if payload.confirmation != user.username:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "confirmation_mismatch", "Type the exact username to delete the account.")
    if user.password_enabled and (
        not payload.current_password or not verify_password(payload.current_password, user.password_hash)
    ):
        raise api_error(status.HTTP_401_UNAUTHORIZED, "invalid_credentials", "The current password is required.")

    owner_memberships = (await session.execute(select(OrganizationMembership).where(
        OrganizationMembership.user_id == user.id,
        OrganizationMembership.role == OrganizationRole.OWNER,
    ))).scalars().all()
    for membership in owner_memberships:
        owners = int(await session.scalar(select(func.count(OrganizationMembership.id)).where(
            OrganizationMembership.organization_id == membership.organization_id,
            OrganizationMembership.role == OrganizationRole.OWNER,
        )) or 0)
        if owners <= 1:
            raise api_error(
                status.HTTP_409_CONFLICT, "last_owner",
                "Transfer or delete every organization for which this is the last owner.",
            )

    replacement = (await session.execute(
        select(User).where(User.id != user.id, User.is_active.is_(True)).order_by(User.is_admin.desc(), User.created_at)
    )).scalars().first()
    if replacement is None:
        # The last account cannot own collaborative resources because that
        # would also make it the last owner, checked above.
        replacement_id = None
    else:
        replacement_id = replacement.id

    sponsored = (await session.execute(select(Organization).where(
        Organization.billing_sponsor_user_id == user.id
    ))).scalars().all()
    for organization in sponsored:
        next_owner = (await session.execute(select(OrganizationMembership).where(
            OrganizationMembership.organization_id == organization.id,
            OrganizationMembership.user_id != user.id,
            OrganizationMembership.role == OrganizationRole.OWNER,
        ).order_by(OrganizationMembership.created_at))).scalars().first()
        if next_owner is None:
            raise api_error(status.HTTP_409_CONFLICT, "sponsor_transfer_required", "Transfer sponsorship before deleting this account.")
        organization.billing_sponsor_user_id = next_owner.user_id

    authored = (
        (Organization, Organization.created_by_id),
        (Project, Project.created_by_id),
        (ProjectResource, ProjectResource.created_by_id),
        (ProjectResourceRevision, ProjectResourceRevision.created_by_id),
        (BindingCase, BindingCase.created_by_id),
        (BindingCaseRevision, BindingCaseRevision.created_by_id),
        (Collection, Collection.created_by_id),
        (CollectionRevision, CollectionRevision.created_by_id),
        (CollectionItem, CollectionItem.added_by_id),
        (Study, Study.created_by_id),
        (StudyRun, StudyRun.created_by_id),
        (Report, Report.created_by_id),
        (Publication, Publication.published_by_id),
        (Artifact, Artifact.created_by_id),
        (PricingRelease, PricingRelease.created_by_id),
    )
    if replacement_id is not None:
        for model, column in authored:
            await session.execute(update(model).where(column == user.id).values({column.key: replacement_id}))

    try:
        remove_contract = getattr(get_gate(), "remove_contract", None)
        if remove_contract is not None:
            await remove_contract(user.id)
    except PricingUnavailable as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "pricing_unavailable", str(exc)) from exc
    await session.delete(user)
    await session.flush()
