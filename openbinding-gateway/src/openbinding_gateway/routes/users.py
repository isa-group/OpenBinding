"""The account a caller owns: their profile, and later their keys and usage."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, get_user_by_identifier, session_dependency
from ..db.models import ApiKey, User, utcnow
from ..models.accounts import (
    ApiKeyList,
    ApiKeySummary,
    CreateApiKeyRequest,
    CreatedApiKey,
    UpdateProfileRequest,
    UserProfile,
)
from ..models.errors import (
    CONFLICT_RESPONSE,
    NOT_FOUND_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
from ..security.apikeys import mint
from ..security.passwords import hash_password, password_complaint, verify_password

router = APIRouter(prefix="/v1/users", tags=["Users"])


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
    responses={401: UNAUTHORIZED_RESPONSE, 503: UNAVAILABLE_RESPONSE},
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
    """
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
