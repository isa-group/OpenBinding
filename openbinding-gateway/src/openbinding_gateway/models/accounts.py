"""The wire shapes for accounts, sessions and API keys.

Kept apart from ``models.api``, which describes solving. The two have nothing to
say to each other, and a reader looking for the shape of a solution should not
have to scroll past a login form to find it.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field

USERNAME_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$"


class RoleName(str, Enum):
    USER = "user"
    ADMIN = "admin"


class PlanName(str, Enum):
    BASIC = "BASIC"
    PRO = "PRO"


class RegisterRequest(BaseModel):
    username: str = Field(
        ...,
        pattern=USERNAME_PATTERN,
        description="Letters, digits, dot, underscore or hyphen; 3 to 64 characters.",
    )
    email: EmailStr = Field(..., description="Used to sign in and to reach the account's owner.")
    password: str = Field(..., description="At least 10 characters.")


class LoginRequest(BaseModel):
    username_or_email: str = Field(..., description="Either identifier works.")
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str = Field(..., description="The token to revoke, ending that session.")


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = Field(default="bearer")
    expires_in: int = Field(..., description="Lifetime of the access token, in seconds.")


class UserProfile(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    email: EmailStr
    role: RoleName
    is_active: bool
    plan: PlanName = Field(
        ...,
        description=(
            "Plan last seen on the SPACE contract. The contract itself decides what a "
            "request is allowed to do; this is what the interface displays."
        ),
    )
    created_at: datetime


class UpdateProfileRequest(BaseModel):
    email: Optional[EmailStr] = None
    current_password: Optional[str] = Field(
        default=None, description="Required when changing the password."
    )
    new_password: Optional[str] = None


class ApiKeySummary(BaseModel):
    """An API key as it can safely be shown: everything except the secret."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    prefix: str
    created_at: datetime
    last_used_at: Optional[datetime] = None


class CreateApiKeyRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128, description="What this key is for.")


class CreatedApiKey(ApiKeySummary):
    """The one and only response that carries the secret.

    It is not stored in a form that could produce this again, so a caller that
    loses it has to create another key.
    """

    secret: str = Field(..., description="Shown once. Store it now; it cannot be retrieved later.")


class ApiKeyList(BaseModel):
    api_keys: List[ApiKeySummary]
