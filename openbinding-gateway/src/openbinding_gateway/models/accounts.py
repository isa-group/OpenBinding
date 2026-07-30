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
    FREE = "FREE"
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


class LimitUsageView(BaseModel):
    """One usage limit and what is left of it."""

    limit_id: str = Field(..., description="Identifier of the limit in the pricing.")
    limit: float = Field(..., description="What the plan allows.")
    used: float = Field(..., description="What has been consumed so far.")
    remaining: float = Field(..., description="What is left. Never negative.")
    unit: Optional[str] = None
    renews_at: Optional[str] = Field(
        default=None, description="When a renewable limit next resets, if it renews."
    )


class PlanCapsView(BaseModel):
    """The ceilings a single request runs into, rather than a monthly balance."""

    max_timeout_s: float = Field(..., description="Longest solver budget one job may ask for.")
    max_iterations: int = Field(..., description="Ceiling for iteration-driven options.")
    max_payload_mb: int = Field(..., description="Largest instance accepted in one request.")
    max_binding_space_log10: float = Field(
        ..., description="Largest instance solvable, as log10 of its binding space."
    )
    job_history_days: int = Field(..., description="How long finished jobs stay queryable.")
    api_keys_limit: Optional[int] = Field(
        default=None, description="How many live API keys the plan allows."
    )


class JobSummary(BaseModel):
    """One solve this account asked for.

    Deliberately a summary: the result of a job can be hundreds of megabytes,
    and a history is for finding the one you want rather than for reading them
    all. ``GET /v1/jobs/{id}`` is where the answer itself lives.
    """

    id: uuid.UUID
    engine_id: str
    status: str = Field(..., description="queued, running, completed or failed.")
    feasibility: Optional[str] = Field(
        default=None, description="Of the result, once there is one."
    )
    solutions: Optional[int] = Field(
        default=None, description="How many solutions came back."
    )
    created_at: datetime
    finished_at: Optional[datetime] = None


class JobHistory(BaseModel):
    """A page of an account's own solves."""

    jobs: List[JobSummary]
    total: int = Field(..., description="How many are visible in total.")
    retention_days: int = Field(
        ...,
        description=(
            "How far back this plan keeps them. Jobs older than this are not "
            "returned, which is the jobHistoryRetentionLimit in the pricing."
        ),
    )


class UsageView(BaseModel):
    """What an account is on, what it has spent, and what bounds one request.

    Served so that the interface can draw quota bars without talking to the
    pricing service itself, and so that an API client can find out the same
    things the interface shows.
    """

    plan: PlanName
    contract_pending: bool = Field(
        default=False,
        description="True when the account has no contract yet because the pricing service was unreachable.",
    )
    caps: PlanCapsView
    limits: List[LimitUsageView] = Field(default_factory=list)


class PricingTokenView(BaseModel):
    """A signed token the browser evaluates pricing features against locally."""

    pricing_token: str


class AdminUserView(UserProfile):
    """A user as an administrator sees them: the profile, plus what it costs."""

    contract_pending: bool = Field(
        default=False, description="True when the account still owes a contract."
    )
    api_key_count: int = Field(default=0, description="How many keys are in use.")


class AdminUserPage(BaseModel):
    """One page of accounts.

    Paged rather than complete, because an administrator screen that fetches
    every account works until it does not.
    """

    users: List[AdminUserView]
    total: int = Field(..., description="How many accounts match, across every page.")
    offset: int
    limit: int


class UpdateUserRequest(BaseModel):
    """What an administrator may change about somebody else's account.

    Not their password or their email: those are the account holder's, and an
    administrator who could change them could take the account over silently.
    """

    is_active: Optional[bool] = Field(
        default=None, description="Deactivating takes effect on the account's next request."
    )
    role: Optional[RoleName] = None


class ChangePlanRequest(BaseModel):
    plan: PlanName = Field(..., description="The plan to move this account onto.")


class UsageResyncResult(BaseModel):
    """What a resync corrected.

    Concurrency is counted optimistically - a check and a claim are two calls,
    and a crash between them leaves a slot held. This is the escape hatch for
    an account whose count has drifted, and it reports what it found rather
    than fixing it silently.
    """

    plan: PlanName
    slots_in_flight: int = Field(..., description="Jobs actually still running for this account.")
    slots_recorded: float = Field(..., description="What the pricing service had counted.")
    corrected_by: float = Field(..., description="The adjustment applied. Zero means no drift.")
