"""The tables behind accounts, sessions and API keys.

Two decisions here are worth stating, because both were deliberate and both
would look arbitrary later.

Enumerated columns are stored as strings with a check constraint rather than as
a native database enum. A native enum reads better in ``psql``, but altering one
is a migration with a table rewrite, and these are exactly the columns that grow
a value later - another role, another plan.

The plan a user is on is cached here, but it is not the truth. The contract in
SPACE is, because that is what decides whether a request is allowed. The column
exists so a user list can be rendered without one SPACE call per row, and
``contract_pending`` records the case that makes the cache necessary: a
registration that succeeded locally while SPACE was unreachable, to be
reconciled the next time that user turns up.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


def utcnow() -> datetime:
    """Timezone-aware "now", so stored timestamps are never ambiguous."""
    return datetime.now(timezone.utc)


class UserRole(str, enum.Enum):
    USER = "user"
    ADMIN = "admin"


class Plan(str, enum.Enum):
    FREE = "FREE"
    PRO = "PRO"


def _enum_column(python_enum, default, length: int = 16):
    return mapped_column(
        Enum(
            python_enum,
            native_enum=False,
            length=length,
            values_callable=lambda e: [member.value for member in e],
        ),
        nullable=False,
        default=default,
    )


class User(Base):
    """Someone with an account, whichever channel they arrive through.

    The web session and an API key resolve to the same row on purpose: the
    pricing plan applies to the user, not to how they happened to call.
    """

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    #: Stored lower-cased, so that logging in is not a guessing game about case.
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    role: Mapped[UserRole] = _enum_column(UserRole, UserRole.USER)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    #: Display cache of the SPACE contract; see the module docstring.
    plan_cache: Mapped[Plan] = _enum_column(Plan, Plan.FREE)
    contract_pending: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )

    api_keys: Mapped[List["ApiKey"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    refresh_tokens: Mapped[List["RefreshToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    #: Engines this user has registered. Deleting the account takes them with
    #: it: an engine is reachable only through its owner's credential, so an
    #: ownerless one could not be solved on anyway.
    engines: Mapped[List["FederatedEngine"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )

    @property
    def is_admin(self) -> bool:
        return self.role is UserRole.ADMIN


class ApiKey(Base):
    """A personal key for the API channel.

    Only a hash of the key is kept, so a database read does not hand over
    working credentials. The prefix is stored in the clear and indexed because
    something has to find the row before there is anything to compare against;
    it identifies the key without being enough to use it.
    """

    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    prefix: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    secret_hash: Mapped[str] = mapped_column(String(128), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    #: Written at most once a minute; an audit hint, not an access log.
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="api_keys")

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None


class JobState(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class Job(Base):
    """One solve, and who asked for it.

    Jobs used to live in a dictionary on the process, which meant a restart
    lost every result and no replica could answer for a job another had
    started. Giving them a row fixes both, and adds the thing the accounts
    module actually needs: an owner, so that a job identifier stops being a
    bearer token for whatever it names.

    ``metered`` and ``concurrency_released`` are written with a compare-and-set,
    because a client polling twice at once must not be able to bill the same
    solve twice or release the same slot twice.
    """

    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: Null for jobs created before accounts existed, or while running without
    #: a database. A job with no owner is nobody's to read.
    owner_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )

    engine_id: Mapped[str] = mapped_column(String(128), nullable=False)
    engine_job_id: Mapped[str] = mapped_column(String(128), nullable=False)
    service_url: Mapped[str] = mapped_column(String(512), nullable=False)
    state: Mapped[JobState] = _enum_column(JobState, JobState.QUEUED)

    verbose: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: What the engine was asked, and what it answered. Kept whole so a job can
    #: be re-canonicalized later without asking the engine again.
    original_request: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    #: The solver options as submitted. Part of the request, and the difference
    #: between a job that can be run again and one that only looks like it can:
    #: a seed is what makes a heuristic's answer reproducible.
    options: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    warnings: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    binding_space: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    #: What the caller was allowed to spend, so an abandoned job can be
    #: reconciled against something rather than guessed at.
    requested_budget_s: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    metered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    concurrency_released: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now(), index=True
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class EngineVisibility(str, enum.Enum):
    """Who may see and use a registered engine.

    Private is the default and stays the default: an engine is somebody's
    endpoint, possibly costing them money per call, and publishing it is a
    decision its owner makes rather than one made for them.
    """

    PRIVATE = "private"
    #: Asked to be public, waiting on a human. Still private in the meantime.
    PENDING_REVIEW = "pending_review"
    PUBLIC = "public"


class EngineStatus(str, enum.Enum):
    """Whether the engine may be solved on.

    Only ACTIVE may. The rest exist so that a failing engine keeps its
    registration and its conformance report instead of vanishing, which is the
    difference between "here is what went wrong" and "it did not work".
    """

    DRAFT = "draft"
    VERIFYING = "verifying"
    ACTIVE = "active"
    FAILED = "failed"
    #: Turned off after repeated health failures, or by an administrator.
    DISABLED = "disabled"


class FederatedEngine(Base):
    """Somebody else's solver, registered as an engine.

    The row is the runtime equivalent of what a built-in engine ships as a
    Python plugin plus a manifest file plus an environment variable: the
    manifest holds the first two, ``transport`` inside it holds the third.

    Three columns deserve a note.

    ``manifest`` is stored whole, as given, rather than exploded into columns.
    It is a document with a version, its shape will change, and the thing that
    reads it is a Pydantic model that already knows how - so a schema migration
    per manifest field would buy nothing. The columns that exist alongside it
    are exactly those the database needs to *find* rows: the id, the owner, the
    visibility and the status.

    ``credential_encrypted`` is Fernet ciphertext and is never returned by any
    endpoint. A credential can be replaced but not read back, which is the same
    contract the API keys table offers in the other direction.

    ``openapi_document`` caches what was fetched at registration. Verifying
    against a document and then solving against whatever the URL serves later
    would make the conformance report a statement about the past; pinning it
    means a third party who changes their API gets re-verified rather than
    silently mis-routed.
    """

    __tablename__ = "federated_engines"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: The qualified id, ``<owner>~<name>``, as used everywhere an engine id is
    #: used. Unique across the installation and, by construction, incapable of
    #: colliding with a built-in id.
    engine_id: Mapped[str] = mapped_column(String(160), unique=True, index=True, nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    manifest: Mapped[dict] = mapped_column(JSON, nullable=False)
    openapi_document: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    visibility: Mapped[EngineVisibility] = _enum_column(
        EngineVisibility, EngineVisibility.PRIVATE, length=32
    )
    status: Mapped[EngineStatus] = _enum_column(EngineStatus, EngineStatus.DRAFT, length=32)

    #: Never returned; replaceable only. See the class docstring.
    credential_encrypted: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)

    #: What the conformance probe found, and when it last passed.
    conformance_report: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Consecutive health failures, so one blip does not disable an engine.
    health_failures: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
    )

    owner: Mapped[User] = relationship(back_populates="engines")

    @property
    def is_usable(self) -> bool:
        return self.status is EngineStatus.ACTIVE

    def is_visible_to(self, user: Optional[User]) -> bool:
        """Whether this engine exists, as far as ``user`` is concerned.

        Callers turn a false into a 404 rather than a 403: telling a stranger
        that ``alice~tabu`` exists but is not theirs is telling them something
        about Alice.
        """
        if self.visibility is EngineVisibility.PUBLIC:
            return True
        if user is None:
            return False
        return user.id == self.owner_id or user.is_admin


class RefreshToken(Base):
    """One issued refresh token, so that it can be rotated and revoked.

    Access tokens are short-lived and never stored; refresh tokens are the ones
    worth being able to take back, which is why only these have a row.
    """

    __tablename__ = "refresh_tokens"

    jti: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="refresh_tokens")

    @property
    def is_usable(self) -> bool:
        if self.revoked_at is not None:
            return False
        expires_at = self.expires_at
        if expires_at.tzinfo is None:
            # SQLite hands back naive datetimes; the value is UTC either way.
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return expires_at > utcnow()
