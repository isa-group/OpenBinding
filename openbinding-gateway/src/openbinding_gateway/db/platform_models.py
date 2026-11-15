"""Collaborative platform tables built around the BIM v1 pipeline.

Organizations own problems (``binding_cases``), whose revisions are uploaded
packages kept as blobs, and the compilations of those revisions; projects own
studies until they are retired.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base

if TYPE_CHECKING:
    from .artifact_models import ArtifactVersion


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def enum_column(python_enum: type[enum.Enum], default, *, length: int = 32):
    return mapped_column(
        Enum(
            python_enum,
            native_enum=False,
            length=length,
            values_callable=lambda values: [member.value for member in values],
        ),
        nullable=False,
        default=default,
    )


class OrganizationRole(str, enum.Enum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"
    MEMBER = "MEMBER"
    VIEWER = "VIEWER"


class Visibility(str, enum.Enum):
    PRIVATE = "private"
    PUBLIC = "public"


class StudyState(str, enum.Enum):
    DRAFT = "draft"
    READY = "ready"


class RunState(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AuthIdentity(Base):
    """An external login identity; provider + subject is the only identity key."""

    __tablename__ = "auth_identities"
    __table_args__ = (UniqueConstraint("provider", "subject", name="uq_identity_provider_subject"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    subject: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    verified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_prefix: Mapped[str] = mapped_column(String(24), unique=True, nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class Organization(Base):
    __tablename__ = "organizations"
    __table_args__ = (
        CheckConstraint("parent_id IS NULL OR parent_id <> id", name="organization_not_own_parent"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    parent_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class OrganizationMembership(Base):
    __tablename__ = "organization_memberships"
    __table_args__ = (
        UniqueConstraint("organization_id", "user_id", name="uq_organization_member"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[OrganizationRole] = enum_column(OrganizationRole, OrganizationRole.MEMBER)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class OrganizationInvitation(Base):
    __tablename__ = "organization_invitations"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    role: Mapped[OrganizationRole] = enum_column(OrganizationRole, OrganizationRole.MEMBER)
    token_prefix: Mapped[str] = mapped_column(String(24), unique=True, index=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    invited_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("organization_id", "slug", name="uq_project_org_slug"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    visibility: Mapped[Visibility] = enum_column(Visibility, Visibility.PRIVATE)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class BindingCase(Base):
    """A problem: a named BIM problem of an organization, whose revisions are uploaded packages."""

    __tablename__ = "binding_cases"
    __table_args__ = (UniqueConstraint("organization_id", "slug", name="uq_binding_case_org_slug"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class BindingCaseRevision(Base):
    """One immutable revision of a problem: the uploaded package (a blob), its digests and its file facts.

    What depends on the installed toolchain (the IR, its digests, per-resource kind and dialect) is
    in ``problem_compilations``, one row per revision and toolchain.
    """

    __tablename__ = "binding_case_revisions"
    __table_args__ = (
        UniqueConstraint("binding_case_id", "revision", name="uq_binding_case_revision"),
        UniqueConstraint("binding_case_id", "package_digest", name="uq_binding_case_package_digest"),
        CheckConstraint("revision > 0", name="binding_case_revision_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    binding_case_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("binding_cases.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    #: The toolchain's canonical ``packageDigest`` (of the canonical archive, not of the uploaded bytes).
    package_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    instance_digest: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    package_blob_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("blobs.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    #: Size of the uploaded archive: what ``maxRepositoryStorage`` charges to ``created_by_id``.
    package_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    #: The root ``instance.json``.
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    #: Package facts only: ``path``, ``role``, ``resource_id``, ``digest`` and ``media_type`` of every file.
    files: Mapped[list] = mapped_column(JSON, nullable=False)
    resource_digests: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    #: Who produced the package (an upload's file name, the Workbench, a producer); free form.
    provenance: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class ProblemCompilation(Base):
    """What one toolchain made of one revision: the IR, its source map and analysis. Insert only.

    Keyed twice within a revision: by the compiler that produced it (what a lookup knows before
    compiling) and by the compilation digest (what the toolchain reports). A toolchain release adds
    a row and never rewrites one, so runs keep the IR they ran on.
    """

    __tablename__ = "problem_compilations"
    __table_args__ = (
        UniqueConstraint("revision_id", "compilation_digest", name="uq_problem_compilations_revision_digest"),
        UniqueConstraint("revision_id", "compiler_digest", name="uq_problem_compilations_revision_compiler"),
        # The target of the composite foreign keys that tie a run's compilation to its revision.
        UniqueConstraint("id", "revision_id", name="uq_problem_compilations_id_revision"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    revision_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("binding_case_revisions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    compiler_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    compilation_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    toolchain: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    ir_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    ir: Mapped[dict] = mapped_column(JSON, nullable=False)
    source_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    analysis: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class ProjectResource(Base):
    """A named project resource whose revisions are immutable JSON documents."""

    __tablename__ = "project_resources"
    __table_args__ = (UniqueConstraint("project_id", "slug", name="uq_project_resource_slug"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    kind: Mapped[str] = mapped_column(String(128), nullable=False, default="bim-resource")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class ProjectResourceRevision(Base):
    __tablename__ = "project_resource_revisions"
    __table_args__ = (
        UniqueConstraint("project_resource_id", "revision", name="uq_project_resource_revision"),
        UniqueConstraint("project_resource_id", "digest", name="uq_project_resource_digest"),
        CheckConstraint("revision > 0", name="project_resource_revision_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_resource_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("project_resources.id", ondelete="CASCADE"), nullable=False, index=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    document: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class Study(Base):
    __tablename__ = "studies"
    __table_args__ = (UniqueConstraint("project_id", "slug", name="uq_study_project_slug"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    definition_version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"), nullable=False, index=True)
    definition_version: Mapped["ArtifactVersion"] = relationship("ArtifactVersion", foreign_keys=[definition_version_id], lazy="joined")

    @property
    def definition(self) -> dict:
        from ..studies import definition_from_version
        return definition_from_version(self.definition_version)

    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    state: Mapped[StudyState] = enum_column(StudyState, StudyState.DRAFT)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class StudyRun(Base):
    __tablename__ = "study_runs"
    __table_args__ = (
        UniqueConstraint("study_id", "run_number", name="uq_study_run_number"),
        CheckConstraint("run_number > 0", name="study_run_number_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    study_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("studies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    definition_version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"), nullable=False, index=True)
    run_number: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[RunState] = enum_column(RunState, RunState.QUEUED)
    matrix_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    summary: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class StudyCell(Base):
    __tablename__ = "study_cells"
    __table_args__ = (
        UniqueConstraint("study_run_id", "ordinal", name="uq_study_cell_ordinal"),
        UniqueConstraint("study_run_id", "fingerprint", name="uq_study_cell_fingerprint"),
        CheckConstraint("ordinal >= 0", name="study_cell_ordinal_nonnegative"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    study_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    binding_case_revision_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("binding_case_revisions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    engine_ref: Mapped[dict] = mapped_column(JSON, nullable=False)
    parameters: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(80), nullable=False)
    job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    state: Mapped[RunState] = enum_column(RunState, RunState.QUEUED)
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)


class Blob(Base):
    """A stored file of an organization. Files are global and content addressed; rows are per organization."""

    __tablename__ = "blobs"
    __table_args__ = (UniqueConstraint("organization_id", "digest", name="uq_blob_organization_digest"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    media_type: Mapped[str] = mapped_column(String(160), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_uri: Mapped[str] = mapped_column(String(1024), nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    subject: Mapped[str] = mapped_column(String(240), nullable=False)
    body: Mapped[str] = mapped_column(String(4000), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    read_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now(), index=True
    )


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    actor_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(String(96), nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    detail: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now(), index=True
    )


class ApiErrorEvent(Base):
    __tablename__ = "api_error_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, nullable=True, index=True
    )
    status_code: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    error_code: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    endpoint: Mapped[str] = mapped_column(String(256), nullable=False)
    http_method: Mapped[str] = mapped_column(String(10), nullable=False)
    detail: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now(), index=True
    )
