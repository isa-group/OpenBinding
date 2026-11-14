"""Organization-owned identities, editable drafts and immutable releases."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, Uuid, column, false, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base
from .platform_models import utcnow

if TYPE_CHECKING:
    from .platform_models import Blob


class Artifact(Base):
    __tablename__ = "artifacts"
    __table_args__ = (
        # Partial on ``archived``, so retiring an artifact frees its identity for a new one.
        # SPHERE reaches the same end with ``partialFilterExpression: {deleted: false}`` on
        # its pricing identities, and the reason is the same: an identity is the name people
        # cite, and a name that can never be reused makes a withdrawal permanent in a way
        # nobody asked for. A plain ``UniqueConstraint`` kept the name taken forever.
        Index(
            "uq_artifact_identity",
            "namespace",
            "name",
            unique=True,
            sqlite_where=column("archived") == false(),
            postgresql_where=column("archived") == false(),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), index=True)
    namespace: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(128))
    display_name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(128), index=True)
    description: Mapped[str] = mapped_column(String(4000), default="")
    labels: Mapped[dict] = mapped_column(JSON, default=dict)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())


class ArtifactVersion(Base):
    __tablename__ = "artifact_versions"
    __table_args__ = (
        UniqueConstraint("artifact_id", "version", name="uq_artifact_version"),
        UniqueConstraint("artifact_id", "ordinal", name="uq_artifact_ordinal"),
        CheckConstraint("ordinal > 0", name="artifact_ordinal_positive"),
        # The re-fork query reads this edge backwards: given an origin version and a target
        # organization, find the fork that already exists rather than creating a second
        # artifact every time the origin publishes. SPHERE denormalises a whole
        # ``forkedFrom`` record for the same question because its origin can disappear;
        # here the FK is ``RESTRICT``, so the lineage cannot break and the index is enough.
        Index("ix_artifact_versions_based_on_id", "based_on_id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifacts.id", ondelete="RESTRICT"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    version: Mapped[str] = mapped_column(String(64))
    blob_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("blobs.id", ondelete="RESTRICT"))
    blob: Mapped["Blob"] = relationship("Blob", foreign_keys=[blob_id], lazy="joined")
    content_digest: Mapped[str] = mapped_column(String(80), index=True)
    version_digest: Mapped[str] = mapped_column(String(80), unique=True)
    manifest: Mapped[dict] = mapped_column(JSON)
    based_on_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"))
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())


class ArtifactDraft(Base):
    __tablename__ = "artifact_drafts"
    __table_args__ = (CheckConstraint("revision > 0", name="artifact_draft_revision_positive"),)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifacts.id", ondelete="CASCADE"), index=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    payload: Mapped[dict] = mapped_column(JSON)
    based_on_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"))
    sealed_version_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"))
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ArtifactDependency(Base):
    __tablename__ = "artifact_dependencies"
    __table_args__ = (CheckConstraint("version_id != dependency_id", name="artifact_no_self_dependency"),)
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"), primary_key=True)
    dependency_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"), primary_key=True)


class ProjectArtifact(Base):
    __tablename__ = "project_artifacts"
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    artifact_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifacts.id", ondelete="RESTRICT"), primary_key=True)


class ArtifactPublication(Base):
    __tablename__ = "artifact_publications"
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"), primary_key=True)
    withdrawn: Mapped[bool] = mapped_column(Boolean, default=False)
    citation: Mapped[dict] = mapped_column(JSON, default=dict)
    published_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CaseArtifact(Base):
    __tablename__ = "case_artifacts"
    revision_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("binding_case_revisions.id", ondelete="RESTRICT"), primary_key=True)
    alias: Mapped[str] = mapped_column(String(128), primary_key=True)
    role: Mapped[str] = mapped_column(String(128))
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"), index=True)
    bindings: Mapped[dict] = mapped_column(JSON, default=dict)


class ArtifactCaseReference(Base):
    __tablename__ = "artifact_case_references"
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("artifact_versions.id", ondelete="RESTRICT"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    case_revision_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("binding_case_revisions.id", ondelete="RESTRICT"), index=True)
    __table_args__ = (CheckConstraint("position >= 0", name="artifact_case_position_nonnegative"),)
