"""The account a caller owns: their profile, and later their keys and usage."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..access.dependencies import get_current_user, get_user_by_identifier, session_dependency
from ..db.models import User
from ..models.accounts import UpdateProfileRequest, UserProfile
from ..models.errors import (
    CONFLICT_RESPONSE,
    UNAUTHORIZED_RESPONSE,
    UNAVAILABLE_RESPONSE,
    api_error,
)
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

