"""The wire shapes for accounts, sessions and API keys.

Kept apart from the compiler and engine contracts. Account views describe
identity, plans, keys, and job history without importing the language model.
"""

from __future__ import annotations

import uuid
import re
from datetime import datetime
from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from ..security.apikeys import ApiKeyPermission, ENGINE_LIMITED_PERMISSIONS

USERNAME_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$"


class RoleName(str, Enum):
    USER = "user"
    ADMIN = "admin"


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


class AuthConfigView(BaseModel):
    """How this gateway signs people in, for the frontend to read before it draws anything."""

    provider: Literal["local", "scoretech"] = Field(
        ..., description="`scoretech`: SCORETech Identity through the gateway; `local`: OpenBinding's own accounts."
    )
    login_url: Optional[str] = Field(
        default=None, description="Where the browser starts a SCORETech sign-in (add `returnTo`); null in `local` mode."
    )
    register_url: Optional[str] = Field(
        default=None, description="Where the browser starts a SCORETech registration; null in `local` mode."
    )
    account_url: Optional[str] = Field(
        default=None, description="The person's SCORETech Identity account page; null in `local` mode."
    )


class AccessGrant(BaseModel):
    """A short gateway access token bound to a browser session (sign-in, or minted from the session cookie).

    The browser keeps it in memory only; the session itself is the HttpOnly cookie.
    """

    access_token: str
    token_type: str = Field(default="bearer")
    expires_in: int = Field(..., description="Lifetime of the access token, in seconds.")


class SignOutRequest(BaseModel):
    scope: Literal["this", "all"] = Field(
        default="this", description="`this` session, or `all` the sessions of the account."
    )


class PendingSignUp(BaseModel):
    """A first SCORETech Identity sign-in waiting for its username."""

    suggested_username: str = Field(..., description="A free username derived from the verified email or the display name; advisory.")
    email: Optional[str] = Field(default=None, description="The email Identity verified; null when it shared none or did not verify it.")
    email_verified: bool
    display_name: Optional[str] = None
    expires_at: datetime = Field(..., description="When this pending sign-up is discarded.")


class CompleteSignUpRequest(BaseModel):
    username: str = Field(
        ...,
        pattern=USERNAME_PATTERN,
        description="Letters, digits, dot, underscore or hyphen; 3 to 64 characters. Public: it names your compositions, engines and organizations.",
    )


class CompletedSignUp(BaseModel):
    return_to: str = Field(..., description="The frontend path to continue at.")


class PlanChange(BaseModel):
    """A plan change the account holder did not ask for by name, and what it costs."""

    model_config = ConfigDict(populate_by_name=True)

    from_plan: str = Field(..., alias="from", description="The plan before.")
    to: str = Field(..., description="The plan after.")
    extra_cost: bool = Field(
        default=False,
        description="Always false: the change carries no extra charge (RESEARCH is part of the institutional agreement).",
    )


class CasSession(AccessGrant):
    """The CAS code exchange: a session, and the plan change linking CAS caused, if any."""

    plan_changed: Optional[PlanChange] = Field(
        default=None,
        description="Set when this sign-in raised the plan (BASIC to RESEARCH on linking CAS); null otherwise.",
    )


class UserProfile(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    email: str = Field(
        ...,
        description=(
            "The account's address as stored: what the person registered, the email SCORETech Identity verified, "
            "or `<id>@identity.openbinding.invalid` when Identity verified none (a reserved name, so not an "
            "`email` format)."
        ),
    )
    role: RoleName
    is_active: bool
    plan: str = Field(
        ...,
        max_length=128,
        description=(
            "Plan last recorded for the SPACE contract (read from the database, so reading the "
            "profile never needs SPACE). The contract itself decides what a request is allowed "
            "to do; this is what the interface displays. Empty when the account has no plan "
            "(the stateless open gate, or SPACE has not assigned one)."
        ),
    )
    created_at: datetime
    cas_verified: bool = False
    email_verified: bool = Field(
        default=False, description="Whether SCORETech Identity verified `email` (never for a local account)."
    )
    institutional_email: bool = Field(
        default=False,
        description="Whether `email` is verified and in an institutional domain that entitles the account to RESEARCH.",
    )
    api_keys_suspended_at: Optional[datetime] = Field(
        default=None,
        description=(
            "SCORETech Identity mode: when this account's API keys stop (or stopped) working unless the person "
            "signs in again (`API_KEY_ORPHAN_DAYS` after the last sign-in or renewal); null in local mode."
        ),
    )


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetComplete(BaseModel):
    token: str = Field(..., min_length=32)
    new_password: str


class AccountDeleteRequest(BaseModel):
    confirmation: str = Field(..., description="Type the current username to confirm deletion.")
    current_password: Optional[str] = None


class UpdateProfileRequest(BaseModel):
    email: Optional[EmailStr] = None
    current_password: Optional[str] = Field(
        default=None, description="Required when changing the password."
    )
    new_password: Optional[str] = None


class ApiKeyEngineRef(BaseModel):
    """One immutable Engine revision a key may discover and execute."""

    model_config = ConfigDict(extra="forbid")

    namespace: str = Field(..., min_length=1, max_length=128)
    name: str = Field(..., min_length=1, max_length=128)
    version: str = Field(..., min_length=1, max_length=64)
    digest: str = Field(..., pattern=r"^sha256-[0-9a-f]{64}$")


class ApiKeyEngineAccess(BaseModel):
    """Either every visible Engine, or an exact immutable allow-list."""

    model_config = ConfigDict(extra="forbid")

    all: bool = Field(
        default=False,
        description="Grant access to every Engine visible now or in the future.",
    )
    engines: List[ApiKeyEngineRef] = Field(
        default_factory=list,
        max_length=1000,
        description="Exact Engine revisions granted when all is false.",
    )

    @model_validator(mode="after")
    def unambiguous(self):
        if self.all and self.engines:
            raise ValueError("engine_access.engines must be empty when all is true")
        identities = {
            (engine.namespace, engine.name, engine.version, engine.digest)
            for engine in self.engines
        }
        if len(identities) != len(self.engines):
            raise ValueError("engine_access.engines contains a duplicate revision")
        return self


class ApiKeyBoundary(BaseModel):
    """Optional exact reductions applied in addition to capabilities and role."""

    model_config = ConfigDict(extra="forbid")

    methods: Optional[List[Literal["GET", "POST", "PUT", "PATCH", "DELETE"]]] = None
    organizations: Optional[List[str]] = Field(default=None, max_length=1000)
    resource_kinds: Optional[List[str]] = Field(default=None, max_length=100)
    slugs: Optional[List[str]] = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def unique_values(self):
        for name in ("methods", "organizations", "resource_kinds", "slugs"):
            values = getattr(self, name)
            if values is not None and (not values or len(values) != len(set(values))):
                raise ValueError(f"{name} must be a non-empty list without duplicates")
        return self

    def grants_shape(self) -> dict[str, list[str]]:
        fields = {
            "methods": self.methods,
            "organizations": self.organizations,
            "resourceKinds": self.resource_kinds,
            "slugs": self.slugs,
        }
        return {key: list(value) for key, value in fields.items() if value is not None}


class ApiKeySummary(BaseModel):
    """An API key as it can safely be shown: everything except the secret."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    prefix: str
    created_at: datetime
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    permissions: List[ApiKeyPermission]
    engine_access: ApiKeyEngineAccess
    boundary: ApiKeyBoundary


class CreateApiKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=128, description="What this key is for.")
    permissions: List[ApiKeyPermission] = Field(
        ...,
        min_length=1,
        description="Closed, immutable set of capabilities granted to this key.",
    )
    engine_access: ApiKeyEngineAccess
    boundary: ApiKeyBoundary = Field(default_factory=ApiKeyBoundary)
    expires_at: Optional[datetime] = Field(
        default=None, description="Optional expiry. Rotation can replace the key before this instant."
    )

    @model_validator(mode="after")
    def useful_and_unique(self):
        if self.expires_at is not None and self.expires_at <= datetime.now(self.expires_at.tzinfo):
            raise ValueError("expires_at must be in the future")
        if len(set(self.permissions)) != len(self.permissions):
            raise ValueError("permissions contains a duplicate")
        permission_values = {permission.value for permission in self.permissions}
        if (
            permission_values & ENGINE_LIMITED_PERMISSIONS
            and not self.engine_access.all
            and not self.engine_access.engines
        ):
            raise ValueError(
                "Engine discovery, analysis, execution and job access require "
                "all Engines or at least one exact Engine revision"
            )
        return self


class CreatedApiKey(ApiKeySummary):
    """The one and only response that carries the secret.

    It is not stored in a form that could produce this again, so a caller that
    loses it has to create another key.
    """

    secret: str = Field(..., description="Shown once. Store it now; it cannot be retrieved later.")


class ApiKeyList(BaseModel):
    api_keys: List[ApiKeySummary]


class UsageView(BaseModel):
    """What an account is on and what its plan allows.

    The plan, the features it includes and its functional limits (``null`` means
    unlimited). It carries no consumption: nothing is counted per account.
    """

    plan: str = Field(..., max_length=128)
    contract_pending: bool = Field(
        default=False,
        description="True when the account has no contract yet because the pricing service was unreachable.",
    )
    features: dict[str, bool] = Field(default_factory=dict)
    capabilities: dict[str, Optional[float]] = Field(default_factory=dict)


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
    plan: str = Field(
        ..., min_length=1, max_length=128,
        pattern=r"^[A-Za-z][A-Za-z0-9._-]*$",
        description="A plan identifier declared by the pricing version in SPACE.",
    )


class ChangeSubscriptionRequest(BaseModel):
    """An audited manual agreement; OpenBinding has no checkout or fake payment."""

    model_config = ConfigDict(extra="forbid")

    plan: str = Field(..., min_length=1, max_length=128, pattern=r"^[A-Za-z][A-Za-z0-9._-]*$")
    add_ons: dict[str, int] = Field(default_factory=dict, max_length=256)
    reason: Literal[
        "new_feature",
        "administrative_decision",
        "institutional_agreement",
        "retirement_or_discount",
    ]
    detail: Optional[str] = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def valid_agreement(self):
        for name, quantity in self.add_ons.items():
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]{0,127}", name):
                raise ValueError(f"invalid add-on identifier {name!r}")
            if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 0:
                raise ValueError(f"{name} quantity must be a non-negative integer")
        self.add_ons = {name: quantity for name, quantity in self.add_ons.items() if quantity}
        return self


class ContractSubscriptionView(BaseModel):
    plan: str = Field(..., max_length=128)
    add_ons: dict[str, int]
    pricing_version: str
    renews_at: Optional[str] = None


class AdminSubscriptionView(BaseModel):
    user: AdminUserView
    subscription: ContractSubscriptionView
    changed: bool
