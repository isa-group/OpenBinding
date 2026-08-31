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
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    LargeBinary,
    String,
    UniqueConstraint,
    Uuid,
    func,
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
    #: Immutable least-privilege policy. Missing or malformed fields are
    #: interpreted as no access by ``security.apikeys``.
    grants: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

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
    __table_args__ = (
        UniqueConstraint("owner_id", "idempotency_key", name="uq_jobs_owner_idempotency_key"),
        CheckConstraint(
            "termination IS NULL OR termination IN ('OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN')",
            name="ck_jobs_termination",
        ),
    )

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
    instance_complexity: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    termination: Mapped[Optional[str]] = mapped_column(String(16), nullable=True, index=True)
    # v1 jobs pin the immutable source snapshot and every request identity so
    # a restart or a second replica can answer the same polling request.
    instance_snapshot_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("v1_instance_snapshots.id", ondelete="SET NULL"), nullable=True, index=True
    )
    provenance: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(256), nullable=True, index=True)
    idempotency_fingerprint: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)

    #: What the caller was allowed to spend, so an abandoned job can be
    #: reconciled against something rather than guessed at.
    requested_budget_s: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    metered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    concurrency_released: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now(), index=True
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


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


class InstanceSnapshot(Base):
    """Immutable v1 source index retained independently from a solve job."""

    __tablename__ = "v1_instance_snapshots"
    __table_args__ = (UniqueConstraint("owner_id", "package_digest", name="uq_v1_snapshot_owner_package"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    instance_digest: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    package_digest: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    root_document: Mapped[dict] = mapped_column(JSON, nullable=False)
    resource_digests: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    source_archive: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())


class InstanceResource(Base):
    __tablename__ = "v1_instance_resources"
    __table_args__ = (
        UniqueConstraint("snapshot_id", "resource_id", name="uq_v1_resource_snapshot_id"),
        UniqueConstraint("snapshot_id", "path", name="uq_v1_resource_snapshot_path"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("v1_instance_snapshots.id", ondelete="CASCADE"), nullable=False, index=True)
    resource_id: Mapped[str] = mapped_column(String(128), nullable=False)
    role: Mapped[str] = mapped_column(String(128), nullable=False)
    api_version: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(128), nullable=False)
    dialect_id: Mapped[str] = mapped_column(String(132), nullable=False)
    path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    digest: Mapped[str] = mapped_column(String(80), nullable=False)
    registered_namespace: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    registered_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    registered_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    registered_digest: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    media_type: Mapped[str] = mapped_column(String(128), nullable=False)
    document: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)


class BindingIRSnapshot(Base):
    __tablename__ = "v1_binding_ir"
    __table_args__ = (UniqueConstraint("snapshot_id", name="uq_v1_ir_snapshot"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("v1_instance_snapshots.id", ondelete="CASCADE"), nullable=False, index=True)
    ir_digest: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    source_map: Mapped[dict] = mapped_column(JSON, nullable=False)
    compiler_version: Mapped[str] = mapped_column(String(64), nullable=False, default="bim-compiler/v1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())


class EngineRevision(Base):
    __tablename__ = "v1_engine_revisions"
    __table_args__ = (UniqueConstraint("namespace", "name", "version", name="uq_v1_engine_identity"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    version: Mapped[str] = mapped_column(String(64), nullable=False)
    digest: Mapped[str] = mapped_column(String(80), unique=True, index=True, nullable=False)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    state: Mapped[str] = mapped_column(String(32), nullable=False, default="private")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())


class EngineRegistrationRevision(Base):
    __tablename__ = "v1_engine_registration_revisions"
    __table_args__ = (
        UniqueConstraint("namespace", "name", "version", name="uq_v1_registration_identity"),
        UniqueConstraint("namespace", "manifest_digest", name="uq_v1_registration_namespace_digest"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(64), nullable=False)
    manifest_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    engine_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    endpoint: Mapped[str] = mapped_column(String(512), nullable=False)
    protocol_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    openapi_document: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    openapi_digest: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    mappings: Mapped[dict] = mapped_column(JSON, nullable=False)
    auth_scheme: Mapped[str] = mapped_column(String(32), nullable=False, default="none")
    verification_report: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # Publication and owner activation are independent. A private deployment
    # can be active for its owner without becoming visible to an administrator,
    # while a published deployment remains public even if its owner disables it
    # for their own account.
    publication_status: Mapped[str] = mapped_column(
        "state", String(32), nullable=False, default="private"
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())


class DialectRevision(Base):
    __tablename__ = "v1_dialect_revisions"
    __table_args__ = (UniqueConstraint("namespace", "name", "version", name="uq_v1_dialect_identity"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    namespace: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    version: Mapped[str] = mapped_column(String(64), nullable=False)
    digest: Mapped[str] = mapped_column(String(80), nullable=False, unique=True, index=True)
    adapter_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    state: Mapped[str] = mapped_column(String(32), nullable=False, default="pending_review")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())


class RegisteredResourceRevision(Base):
    """Immutable, locally stored BIM source resource approved for exact refs."""

    __tablename__ = "v1_registered_resource_revisions"
    __table_args__ = (
        UniqueConstraint(
            "namespace", "name", "version", name="uq_v1_registered_resource_identity"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    namespace: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(64), nullable=False)
    digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(128), nullable=False)
    api_version: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(128), nullable=False)
    dialect_id: Mapped[str] = mapped_column(String(132), nullable=False)
    media_type: Mapped[str] = mapped_column(String(128), nullable=False)
    document: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    state: Mapped[str] = mapped_column(String(32), nullable=False, default="pending_review")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class EngineCredential(Base):
    __tablename__ = "v1_engine_credentials"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    registration_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("v1_engine_registration_revisions.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    credential_ref: Mapped[str] = mapped_column(String(256), nullable=False)
    credential_encrypted: Mapped[str] = mapped_column(String(4096), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now())


class ManifestPublication(Base):
    __tablename__ = "v1_manifest_publications"
    __table_args__ = (UniqueConstraint("resource_kind", "resource_digest", name="uq_v1_publication_resource"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    resource_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    resource_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    publisher_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    state: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())


class JobProvenance(Base):
    __tablename__ = "v1_job_provenance"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now())
