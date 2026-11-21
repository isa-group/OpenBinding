"""The account a caller owns: their profile, and later their keys and usage."""

from __future__ import annotations

import secrets
import uuid

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, get_user_by_identifier, session_dependency
from ..db.models import (
    ApiKey, AuditEvent, AuthIdentity, BindingCase, Composition, CompositionEnvironment, CompositionEnvironmentKey,
    IdentitySession, Job, JobEngineAttempt, Notification, NotificationStreamTicket, Organization,
    OrganizationInvitationCode, OrganizationMembership, OrganizationRole, PasswordResetToken, Study, StudyRun, User,
    UserRole, utcnow,
)
from ..modules.identity.application import PSEUDONYM_PREFIX, end_all, institutional_email, managed_by_identity, owner_may_use_keys
from ..models.accounts import (
    ApiKeyList,
    ApiKeyBoundary,
    ApiKeyEngineAccess,
    ApiKeyEngineRef,
    ApiKeySummary,
    AccountDeleteRequest,
    AccountDeletionPreview,
    PersonalOrganizationLoss,
    CreateApiKeyRequest,
    CreatedApiKey,
    PricingTokenView,
    UpdateProfileRequest,
    UsageView,
    UserProfile,
)
from ..core.like import LIKE_ESCAPE, like_contains
from ..models.avatars import avatar_of, stored_avatar
from ..models.platform import UserRef
from ..models.errors import (
    CONFLICT_RESPONSE,
    ErrorResponse,
    NOT_FOUND_RESPONSE,
    QUOTA_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
from ..modules.plans.application import entitlement_map as entitlement_ids
from ..security.apikeys import (
    ADMIN_PERMISSIONS,
    authenticated_api_key,
    boundary_is_subset,
    boundary_of,
    engine_access_of,
    grants_document,
    mint,
    permissions_of,
)
from ..security.passwords import hash_password, password_complaint, verify_password
from ..core import revision
from ..core.settings import get_settings
from ..core.public_errors import pricing_unavailable_error
from ..services import engine_registry
from ..db.platform_models import RunState
from ..jobs import lifecycle
from ..jobs import remote_attempts
from ..study_jobs import StudyRunTerminal, cancel_run as cancel_study_run
from .organizations import delete_personal_organization
from ..services.entitlements import entitlement_service
from ..space_client import PricingUnavailable, get_gate

router = APIRouter(prefix="/v1/users", tags=["Users"])


async def _caps_for(user: User):
    """Read authoritative entitlements; unavailable pricing fails closed."""
    return await entitlement_service.caps_or_503(
        user.id, prefix="Entitlements cannot be read right now: "
    )


async def profile_of(session: AsyncSession, user: User) -> UserProfile:
    """The profile of ``user``, from the database alone: reading it never needs SPACE."""
    return UserProfile(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role.value,
        is_active=user.is_active,
        plan=user.plan_cache,
        created_at=user.created_at,
        email_verified=user.email_verified,
        institutional_email=institutional_email(user),
        display_name=user.display_name,
        avatar=avatar_of(user.avatar),
        password_enabled=user.password_enabled,
        api_keys_suspended_at=owner_may_use_keys(user, settings=get_settings()).suspended_at,
    )


class BetaFeatures(BaseModel):
    """Whether the account sees the features still behind SPHERE's BetaGate."""

    model_config = ConfigDict(extra="forbid")
    enabled: bool = False


@router.get(
    "/me/settings/beta-features",
    response_model=BetaFeatures,
    operation_id="getBetaFeatures",
    summary="Whether the account opted into beta features",
    responses={**revision.ETAG_RESPONSE, 401: UNAUTHORIZED_RESPONSE},
)
async def get_beta_features(response: Response, user: User = Depends(get_current_user)) -> BetaFeatures:
    revision.set_etag(response, user)
    return BetaFeatures(enabled=bool((user.preferences or {}).get("beta_features", False)))


@router.put(
    "/me/settings/beta-features",
    response_model=BetaFeatures,
    operation_id="updateBetaFeatures",
    summary="Opt into or out of beta features",
    responses={**revision.EDIT_RESPONSES, 401: UNAUTHORIZED_RESPONSE},
)
async def update_beta_features(
    payload: BetaFeatures,
    response: Response,
    if_match: str | None = revision.IF_MATCH_HEADER,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> BetaFeatures:
    """Opt into or out of the beta features, as SPHERE's ``PUT /users/me/settings/beta-features``. The revision
    is the account row's, shared with the profile and the notification preferences."""
    await revision.guard(session, user, if_match)
    user.preferences = {**(user.preferences or {}), "beta_features": payload.enabled}
    await session.flush()
    await session.refresh(user, ["updated_at"])
    revision.set_etag(response, user)
    return payload


#: The shortest text a user search takes, and the most users it answers (SPHERE's user search).
USER_SEARCH_MIN = 4
USER_SEARCH_LIMIT = 20


@router.get(
    "",
    response_model=list[UserRef],
    operation_id="searchUsers",
    summary="Find users by username",
    responses={401: UNAUTHORIZED_RESPONSE},
)
async def search_users(
    q: str = Query(..., min_length=USER_SEARCH_MIN, max_length=64, description="Text in the username."),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> list[UserRef]:
    """Active users whose username holds ``q`` (at least four characters), by username, at most twenty: their
    id, username and avatar only, never an email. What inviting users to an organization picks from."""
    pattern = like_contains(q.strip())
    rows = (await session.scalars(
        select(User).where(
            User.username.ilike(pattern, escape=LIKE_ESCAPE),
            User.is_active.is_(True),
            User.deleted_at.is_(None),
            User.id != user.id,
        ).order_by(User.username).limit(USER_SEARCH_LIMIT)
    )).all()
    return [UserRef.of(row) for row in rows]


@router.get(
    "/me",
    response_model=UserProfile,
    operation_id="getOwnProfile",
    summary="The signed-in account",
    responses={**revision.ETAG_RESPONSE, 401: UNAUTHORIZED_RESPONSE},
)
async def read_own_profile(
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> UserProfile:
    revision.set_etag(response, user)
    return await profile_of(session, user)


@router.patch(
    "/me",
    response_model=UserProfile,
    operation_id="updateOwnProfile",
    summary="Change your email, password, display name or avatar",
    responses={
        **revision.EDIT_RESPONSES,
        401: UNAUTHORIZED_RESPONSE,
        409: CONFLICT_RESPONSE,
        422: {"description": "The new password is not acceptable."},
    },
)
async def update_own_profile(
    request: UpdateProfileRequest,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
    if_match: str | None = revision.IF_MATCH_HEADER,
) -> UserProfile:
    """Change what the account holder is allowed to change.

    The email and the password need the current password. Email is included in
    that because the email address is one of the two ways to sign in, so
    changing it is a change of credential, not of contact details. The display
    name and the avatar (local mode) need no password: they are what others see,
    not a way in. In SCORETech Identity mode all four are Identity's (409).

    The revision is the account row's, shared with the notification preferences.
    """
    profile = {"display_name", "avatar"} & request.model_fields_set
    credentials = request.new_password is not None or request.email is not None
    if credentials:
        managed_by_identity(get_settings())
    if profile:
        managed_by_identity(get_settings(), "Your display name and avatar are")
    if not credentials and not profile:
        # A read: the tag is still checked, but nothing is stored and the revision stays.
        revision.precondition(user, if_match)
        revision.set_etag(response, user)
        return await profile_of(session, user)

    if credentials and (
        not request.current_password or not verify_password(request.current_password, user.password_hash)
    ):
        raise api_error(
            status.HTTP_401_UNAUTHORIZED,
            "invalid_credentials",
            "The current password is required to change these details.",
        )

    await revision.guard(session, user, if_match)

    if "display_name" in profile:
        user.display_name = request.display_name
    if "avatar" in profile:
        user.avatar = stored_avatar(request.avatar)

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
    await session.refresh(user, ["updated_at"])
    revision.set_etag(response, user)
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
        403: {"model": ErrorResponse, "description": "The plan does not include API access (`feature_not_entitled`), or the key would escalate."},
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
    entitlement_service.require_feature(
        caps, entitlement_ids.API_ACCESS, detail="The current plan does not entitle API keys."
    )
    api_keys_limit = caps.limit(entitlement_ids.MAX_API_KEYS)
    if api_keys_limit is not None:
        # Serialize this user's count-and-insert on PostgreSQL. Without the
        # row lock, concurrent requests could both observe nine live keys and
        # both exceed the active contract's dynamic allowance.
        await session.execute(select(User.id).where(User.id == user.id).with_for_update(key_share=True))
        live = len(await _own_active_keys(session, user))
        if live >= api_keys_limit:
            raise api_error(
                status.HTTP_402_PAYMENT_REQUIRED,
                "quota_exceeded",
                f"Your plan allows {int(api_keys_limit)} API key"
                f"{'' if api_keys_limit == 1 else 's'}, and you have {live}. "
                f"Revoke one, or move to a plan that allows more.",
                quota={
                    "limit_id": entitlement_ids.MAX_API_KEYS,
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
    "/me/usage",
    response_model=UsageView,
    operation_id="getOwnUsage",
    summary="Your plan, its features and its functional limits",
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
    pricing service is what actually decides. Shared with the administration
    routes, so that an administrator and an account holder are never shown
    different numbers.
    """
    caps = await _caps_for(user)
    return UsageView(
        plan=caps.plan,
        contract_pending=user.contract_pending,
        features=caps.features,
        capabilities=caps.http_view()["capabilities"],
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
        raise pricing_unavailable_error(
            error, where="pricing token", prefix="A pricing token cannot be issued right now: "
        ) from error

    return PricingTokenView(pricing_token=token)


@router.delete(
    "/me",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="deleteOwnAccount",
    summary="Delete the account: revoke every credential and pseudonymise what stays",
    responses={
        401: UNAUTHORIZED_RESPONSE,
        409: {
            "model": ErrorResponse,
            "description": "`last_owner` (the account is the last OWNER of an organization other than its personal "
            "one) and `personal_runs_stopping` (runs of its personal organization were running: they are being "
            "cancelled; delete again once they have stopped).",
        },
        422: {"description": "The confirmation is not the username (`confirmation_mismatch`)."},
        503: {**UNAVAILABLE_RESPONSE, "description": "The contract could not be removed; nothing was changed."},
    },
)
async def delete_own_account(
    payload: AccountDeleteRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> None:
    """Delete the account.

    The user row stays, so that the runs, revisions and engines it created keep
    naming somebody, but nothing in it identifies a person any more: the
    username and email are replaced, the password is unusable, the preferences
    are emptied and ``deleted_at`` is set. Every credential, membership,
    identity, notification and invitation of the account is deleted, its
    federated engines are deactivated and an administrator becomes an ordinary
    (inactive) user. Its personal organization is deleted with everything it
    holds, runs included, as SPHERE deletes it: its queued runs and study runs
    are cancelled first, and while a run of it is still running (or an engine
    attempt is still being told to stop) the cancellation is committed and the
    answer is ``409 personal_runs_stopping``, so no solver is left orphaned. The SPACE contract is removed last, before the commit; if
    that fails, nothing is changed (503).
    """
    if payload.confirmation != user.username:
        raise api_error(status.HTTP_422_UNPROCESSABLE_ENTITY, "confirmation_mismatch", "Type the exact username to delete the account.")
    if user.password_enabled and (
        not payload.current_password or not verify_password(payload.current_password, user.password_hash)
    ):
        raise api_error(status.HTTP_401_UNAUTHORIZED, "invalid_credentials", "The current password is required.")

    # The personal organization does not count: it is pseudonymised with the account.
    owner_memberships = (await session.execute(select(OrganizationMembership).join(
        Organization, Organization.id == OrganizationMembership.organization_id,
    ).where(
        OrganizationMembership.user_id == user.id,
        OrganizationMembership.role == OrganizationRole.OWNER,
        or_(Organization.personal_owner_id.is_(None), Organization.personal_owner_id != user.id),
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

    personal = await session.scalar(select(Organization).where(Organization.personal_owner_id == user.id))
    if personal is not None and await _stop_personal_runs(session, personal.id):
        # The cancellations stand (the workers carry them to the engines); the account waits for them.
        await session.commit()
        raise api_error(
            status.HTTP_409_CONFLICT,
            "personal_runs_stopping",
            "Runs of your personal organization are being cancelled; delete the account again once they have stopped.",
        )

    # Every browser session ends now, and the SCORETech sessions behind them (best effort); pseudonymise
    # then deletes the rows. The access token of this very request stops working with them.
    await end_all(session, get_settings(), user, "deleted")
    # Pseudonymised and flushed first, so that a database refusal (a taken
    # pseudonym, a RESTRICT) stops the deletion while the contract still exists;
    # a contract that cannot be removed then rolls the whole request back.
    await pseudonymise(session, user)
    if personal is not None:
        # After the pseudonymisation: a deleted account's personal organization is the one whose study runs may go.
        await delete_personal_organization(session, personal)
    try:
        await get_gate().remove_contract(user.id)
    except PricingUnavailable as exc:
        raise pricing_unavailable_error(exc, where="contract removal") from exc




async def pseudonymise(session: AsyncSession, user: User) -> None:
    """Replace what identifies ``user`` and delete what belongs to them alone, in the caller's transaction."""
    user.username = f"{PSEUDONYM_PREFIX}{user.id.hex[:12]}"
    user.email = f"deleted+{user.id.hex}@users.invalid"
    user.password_hash = hash_password(secrets.token_urlsafe(48))
    user.password_enabled = False
    user.preferences = {}
    user.email_verified = False
    user.display_name = None
    user.avatar = None
    user.last_identity_refresh_at = None
    user.plan_cache = ""
    user.contract_pending = False
    user.is_active = False
    # A deleted administrator is no administrator: the bootstrap counts them.
    user.role = UserRole.USER
    user.deleted_at = utcnow()

    for model, column in (
        (ApiKey, ApiKey.user_id),
        (PasswordResetToken, PasswordResetToken.user_id),
        (NotificationStreamTicket, NotificationStreamTicket.user_id),
        (IdentitySession, IdentitySession.user_id),
        (AuthIdentity, AuthIdentity.user_id),
        (Notification, Notification.user_id),
        (OrganizationMembership, OrganizationMembership.user_id),
    ):
        await session.execute(delete(model).where(column == user.id))
    # The invitation codes the account made would let people in on its behalf.
    await session.execute(delete(OrganizationInvitationCode).where(OrganizationInvitationCode.created_by_id == user.id))
    # After the username is replaced, so the administrators' notice names nobody.
    deactivated = await engine_registry.deactivate_owned_registrations(session, user)
    session.add(AuditEvent(
        actor_id=user.id,
        action="account.deleted",
        target_type="User",
        target_id=user.id,
        detail={"engine_registrations_deactivated": deactivated},
    ))
    await session.flush()
    # The bulk deletes bypassed the session; forget the collections it may hold.
    session.expire(user, ["api_keys"])


async def _stop_personal_runs(session: AsyncSession, organization_id: uuid.UUID) -> int:
    """Cancel every run of the personal organization through the usual paths; how many have not stopped yet.

    Study runs first (``study_jobs.cancel_run``: the run, its cells, then their jobs, the order every writer takes),
    then the organization's other live runs (``lifecycle.request_cancellation``: a queued run is cancelled on the spot,
    a running one is left to its worker, which sees the request and stops the engine). What is left counts: a run still
    running, or an engine attempt whose cancellation is still being sent. Its rows must outlive them, or the worker and
    the reconciler would lose what they need to stop the solver.
    """
    live_study_runs = (await session.scalars(
        select(StudyRun.id).join(Study, Study.id == StudyRun.study_id)
        .where(Study.organization_id == organization_id, StudyRun.state.in_([RunState.QUEUED, RunState.RUNNING]))
        .order_by(StudyRun.id)
    )).all()
    for run_id in live_study_runs:
        try:
            await cancel_study_run(session, run_id)
        except (LookupError, StudyRunTerminal):
            pass
    live = (await session.scalars(
        select(Job).where(Job.organization_id == organization_id, Job.state.not_in(lifecycle.TERMINAL_STATES))
        .order_by(Job.id).with_for_update()
    )).all()
    for job in live:
        await lifecycle.request_cancellation(session, job)
    await session.flush()
    running = int(await session.scalar(
        select(func.count(Job.id)).where(
            Job.organization_id == organization_id, Job.state.not_in(lifecycle.TERMINAL_STATES)
        )
    ) or 0)
    stopping = int(await session.scalar(
        select(func.count(JobEngineAttempt.id)).join(Job, Job.id == JobEngineAttempt.job_id).where(
            Job.organization_id == organization_id,
            or_(
                JobEngineAttempt.cancel_state == remote_attempts.PENDING,
                (JobEngineAttempt.cancel_state == remote_attempts.FAILED)
                & (JobEngineAttempt.cancel_attempts < get_settings().remote_cancel_max_attempts),
            ),
        )
    ) or 0)
    return running + stopping


@router.get(
    "/me/deletion",
    response_model=AccountDeletionPreview,
    operation_id="previewOwnAccountDeletion",
    summary="What deleting the account deletes with it",
    responses={401: UNAUTHORIZED_RESPONSE},
)
async def preview_own_account_deletion(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(session_dependency, scope="function"),
) -> AccountDeletionPreview:
    """The personal organization ``DELETE /v1/users/me`` deletes, with what it holds; nothing is changed."""
    personal = await session.scalar(select(Organization).where(Organization.personal_owner_id == user.id))
    if personal is None:
        return AccountDeletionPreview()

    async def count(column, *conditions) -> int:
        return int(await session.scalar(select(func.count(column)).where(*conditions)) or 0)

    live_key = (
        select(CompositionEnvironmentKey.id)
        .where(CompositionEnvironmentKey.environment_id == CompositionEnvironment.id,
               CompositionEnvironmentKey.revoked_at.is_(None))
        .exists()
    )
    return AccountDeletionPreview(personal_organization=PersonalOrganizationLoss(
        slug=personal.slug,
        name=personal.name,
        compositions=await count(Composition.id, Composition.organization_id == personal.id),
        public_compositions=await count(
            Composition.id, Composition.organization_id == personal.id, Composition.visibility == "public"
        ),
        problems=await count(BindingCase.id, BindingCase.organization_id == personal.id),
        runs=await count(Job.id, Job.organization_id == personal.id),
        feed_environments=await count(
            CompositionEnvironment.id, CompositionEnvironment.organization_id == personal.id, live_key
        ),
    ))
