"""Collaborative platform tables built around the BIM v1 pipeline.

Organizations own problems (``binding_cases``), whose revisions are uploaded
packages kept as blobs, the compilations of those revisions, studies whose
runs freeze the definition they ran, compositions with their sealed
versions, their evaluations and how they were derived, and the run presets
a run can start from.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base

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
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    #: The organization's image: one of the predefined avatars (its file name, ``avatar-3.svg``), or the
    #: ``sha256-`` digest of an uploaded image kept as a blob of the organization; null for the initials.
    avatar: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    #: The colours the avatar (or the initials) is drawn with, ``#rgb`` or ``#rrggbb``.
    avatar_bg_color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)
    avatar_fg_color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)
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


class OrganizationInvitationCode(Base):
    """A shareable invitation to an organization, as SPHERE's: whoever holds the code joins as MEMBER.

    It may expire and may be used a bounded number of times (``use_count`` against ``max_uses``); an
    invitation to named users (``invite-users``) is a code with as many uses as users, sent to each of them.
    """

    __tablename__ = "organization_invitation_codes"
    __table_args__ = (
        CheckConstraint("use_count >= 0", name="invitation_code_use_count_nonnegative"),
        CheckConstraint("max_uses IS NULL OR max_uses > 0", name="invitation_code_max_uses_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    max_uses: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
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
        CheckConstraint(
            "origin IN ('upload', 'editor', 'qacoforge', 'sphere')", name="binding_case_revision_origin",
        ),
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
    #: Where the revision came from, read from its producer when stored (``modules/problems/domain/origin.py``).
    origin: Mapped[str] = mapped_column(String(16), nullable=False, default="upload", server_default="upload")
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
        # A composition's link holds while the compilation it names and the installed one mean the same.
        Index("ix_problem_compilations_revision_semantic", "revision_id", "semantic_digest"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    revision_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("binding_case_revisions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    compiler_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    compilation_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    #: The digest of what the IR means (``domain.compilation.semantic_digest``), written at insert.
    semantic_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    toolchain: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    ir_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    ir: Mapped[dict] = mapped_column(JSON, nullable=False)
    source_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    analysis: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class Study(Base):
    """A comparative study of an organization: its editable matrix, inline.

    ``definition`` is the current matrix and changes under If-Match; every study run freezes its own
    copy (``study_runs.definition``), so editing the study never changes what a run ran (D7).
    """

    __tablename__ = "studies"
    __table_args__ = (UniqueConstraint("organization_id", "slug", name="uq_study_org_slug"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    #: The ``StudyDefinition`` document (revision ids, engines with resolved modes, parameter sets, seeds).
    definition: Mapped[dict] = mapped_column(JSON, nullable=False)
    definition_digest: Mapped[str] = mapped_column(String(80), nullable=False)
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


class CompositionKind(str, enum.Enum):
    """What a composition composes: the ``kind`` of Composition2Yaml (``composition.document.KINDS``)."""

    APPLICATION = "application"
    WORKFLOW = "workflow"
    PIPELINE = "pipeline"
    SYSTEM = "system"


class Composition(Base):
    """A composition of an organization: a named binding of a workflow to services, as Composition2Yaml.

    Mutable, like a problem (the ETag is ``updated_at``). An empty composition, with no version yet, is the
    editor's starting point and a derivation's target. ``kind`` is metadata: the latest version's kind, and
    the one given at creation until a version exists. ``visibility`` says who reads it: ``private`` (the
    default) for the organization's members only, ``public`` for anybody, through the same routes.
    """

    __tablename__ = "compositions"
    __table_args__ = (
        UniqueConstraint("organization_id", "slug", name="uq_compositions_organization_slug"),
        CheckConstraint("visibility IN ('private', 'public')", name="visibility"),
        # The public list across organizations, newest first.
        Index("ix_compositions_visibility_updated", "visibility", "updated_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    kind: Mapped[CompositionKind] = enum_column(CompositionKind, CompositionKind.APPLICATION, length=16)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    visibility: Mapped[str] = mapped_column(
        String(16), nullable=False, default="private", server_default="private"
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class CompositionFollow(Base):
    """A user following a composition: each version sealed later tells them (``CompositionUpdated``)."""

    __tablename__ = "composition_follows"
    __table_args__ = (UniqueConstraint("user_id", "composition_id", name="uq_composition_follows_user_composition"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    composition_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("compositions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class ValuesStatus(str, enum.Enum):
    """Where a version's values come from: the toolchain (linked to a problem) or the author."""

    VERIFIED = "verified"
    DECLARED = "declared"


class EvaluationBasis(str, enum.Enum):
    """What evaluated a version: the toolchain on a compilation, or nobody (the author's values)."""

    BIM = "bim"
    DECLARED = "declared"


class EvaluationOutcome(str, enum.Enum):
    """What an evaluation concluded. A seal stores only ``verified`` or ``declared``."""

    VERIFIED = "verified"
    BINDING_INVALID = "binding_invalid"
    SEMANTICS_CHANGED = "semantics_changed"
    DECLARED = "declared"


class CompositionVersion(Base):
    """One sealed version of a composition: its canonical Composition2Yaml bytes. Insert only.

    The bytes are inline (at most 256 KiB) and written in the same transaction as the version's first
    evaluation. A version linked to a problem keeps the link as ids (the revision and the compilation the
    document names), so renaming a slug never breaks it. ``offering`` is the normalised source of the
    offering the document names, and ``analytics`` a summary of the document computed once at seal. Fork
    lineage is data (``based_on``, and ``forked_from``, the source as it was named when forked): a fork
    outlives its source and its renames.
    """

    __tablename__ = "composition_versions"
    __table_args__ = (
        UniqueConstraint("composition_id", "ordinal", name="uq_composition_versions_composition_ordinal"),
        UniqueConstraint("composition_id", "label", name="uq_composition_versions_composition_label"),
        UniqueConstraint("composition_id", "content_digest", name="uq_composition_versions_composition_digest"),
        CheckConstraint("ordinal > 0", name="composition_version_ordinal_positive"),
        CheckConstraint("size_bytes > 0 AND size_bytes <= 262144", name="composition_version_size_bounded"),
        CheckConstraint(
            "(revision_id IS NULL) = (linked_compilation_id IS NULL)", name="composition_version_link_whole",
        ),
        CheckConstraint(
            "(values_status = 'verified') = (revision_id IS NOT NULL)", name="composition_version_verified_linked",
        ),
        # The compilation the document names is one of its revision's.
        ForeignKeyConstraint(
            ["linked_compilation_id", "revision_id"],
            ["problem_compilations.id", "problem_compilations.revision_id"],
            ondelete="RESTRICT",
            name="fk_composition_versions_link",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    composition_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("compositions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    #: The document's ``version:`` (semver).
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    #: The ``syntaxVersion`` the document was sealed with.
    syntax_version: Mapped[str] = mapped_column(String(16), nullable=False)
    kind: Mapped[CompositionKind] = enum_column(CompositionKind, CompositionKind.APPLICATION, length=16)
    values_status: Mapped[ValuesStatus] = enum_column(ValuesStatus, ValuesStatus.DECLARED, length=16)
    #: The canonical bytes of the document.
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    revision_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True, index=True)
    #: The compilation the document names (not necessarily the one evaluated).
    linked_compilation_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    #: The run the evidence names, once it was found to hold the binding.
    evidence_job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("jobs.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    #: The offering's source: ``{sphere, registry?}`` or ``{url}``.
    offering: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    #: Fork lineage: ``{composition_id, version_id, label}``.
    based_on: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    #: The fork's source as it was named at fork time: ``{compositionId, versionId, label,
    #: organization{id, name, displayName}, slug, name, droppedProblem}``.
    forked_from: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    #: A summary of the document (tasks, bindings, workflow shape), for evolution charts.
    analytics: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class CompositionEvaluation(Base):
    """One evaluation of a version: by one toolchain release, or the author's values. Insert only.

    A version has one evaluation per ``basis_key`` (a toolchain's ``compilerDigest``, or ``declared``).
    The values are the toolchain's floats as it returned them. ``diagnostics`` are located in the
    version's content.
    """

    __tablename__ = "composition_evaluations"
    __table_args__ = (
        UniqueConstraint("version_id", "basis_key", name="uq_composition_evaluations_version_basis"),
        CheckConstraint(
            "(basis = 'bim') = (compilation_id IS NOT NULL)", name="composition_evaluation_bim_compiled",
        ),
        CheckConstraint(
            "(basis = 'declared') = (outcome = 'declared')", name="composition_evaluation_declared_outcome",
        ),
        ForeignKeyConstraint(
            ["compilation_id", "revision_id"],
            ["problem_compilations.id", "problem_compilations.revision_id"],
            ondelete="RESTRICT",
            name="fk_composition_evaluations_compilation",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("composition_versions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    basis: Mapped[EvaluationBasis] = enum_column(EvaluationBasis, EvaluationBasis.DECLARED, length=16)
    basis_key: Mapped[str] = mapped_column(String(80), nullable=False)
    outcome: Mapped[EvaluationOutcome] = enum_column(EvaluationOutcome, EvaluationOutcome.DECLARED, length=24)
    revision_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True, index=True)
    #: The compilation evaluated: the installed toolchain's.
    compilation_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    compiler_digest: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    compilation_digest: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    semantic_digest: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    ir_digest: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    toolchain: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    #: The binding as the toolchain was given it, ``{task: {resource, id}}``.
    binding: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    #: ``{name: {value, unit}}``.
    values: Mapped[dict] = mapped_column("values", JSON, nullable=False)
    #: What the toolchain's evaluation returned, as it returned it.
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    diagnostics: Mapped[list] = mapped_column(JSON, nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class DerivationSource(str, enum.Enum):
    """What a version was derived from: a solution of a run, or a binding given with a problem revision."""

    RUN = "run"
    BINDING = "binding"


class CompositionDerivation(Base):
    """How a version was derived: the problem binding it was built from, and the run that found it. Insert only.

    A version has at most one. The binding is kept besides the point, in BIM form, because a solution index
    means something only within the run's stored result. ``compilation_id`` is the compilation the document
    links (the run's, for a run); ``provenance`` names the compilation the toolchain evaluated.
    """

    __tablename__ = "composition_derivations"
    __table_args__ = (
        CheckConstraint("source IN ('run', 'binding')", name="composition_derivation_source_known"),
        CheckConstraint("(source = 'run') = (job_id IS NOT NULL)", name="composition_derivation_run_job"),
        CheckConstraint("point IS NULL OR job_id IS NOT NULL", name="composition_derivation_point_of_run"),
        CheckConstraint("point IS NULL OR point >= 0", name="composition_derivation_point_nonnegative"),
        ForeignKeyConstraint(
            ["compilation_id", "revision_id"],
            ["problem_compilations.id", "problem_compilations.revision_id"],
            ondelete="RESTRICT",
            name="fk_composition_derivations_compilation",
        ),
        Index("ix_composition_derivations_binding", "revision_id", "compilation_id", "binding_digest"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("composition_versions.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    source: Mapped[DerivationSource] = enum_column(DerivationSource, DerivationSource.BINDING, length=16)
    revision_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    #: The compilation the derived document links: the run's, for a run.
    compilation_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("jobs.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    #: The solution of the run's stored result (``result.solutions[point]``).
    point: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    #: ``{task: {resource, id}}``, as the toolchain was given it.
    binding: Mapped[dict] = mapped_column(JSON, nullable=False)
    binding_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    #: ``{toolchain, irDigest, semanticDigest, evaluatedCompilationId, run: {engine, engineDigest, mode,
    #: evaluatorDigest} | null}``.
    provenance: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class RunPreset(Base):
    """Named run settings of an organization: the engine, registration, mode, options and optimization a run
    can start from (``createRun {revision, preset}``).

    Mutable, like a study (the ETag is ``updated_at``). A run copies the settings it expands, so editing or
    deleting a preset never changes a run, and nothing keeps a reference to it.
    """

    __tablename__ = "run_presets"
    __table_args__ = (UniqueConstraint("organization_id", "slug", name="uq_run_presets_organization_slug"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), nullable=False, default="")
    #: A built-in engine name or an immutable reference ``{namespace, name, version, digest}``, as a run request's.
    engine: Mapped[object] = mapped_column(JSON, nullable=False)
    registration: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    mode: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    options: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    #: ``{type, scalarization, weights: [{criteria, value}]}``, resolved against the problem when a run uses it.
    optimization: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
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
    run_number: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[RunState] = enum_column(RunState, RunState.QUEUED)
    matrix_digest: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    #: The frozen ``openbinding/study-run/v1`` document: each problem revision with the compilation the
    #: run uses, the engines, parameter sets and seeds. Written once at launch (D7).
    definition: Mapped[dict] = mapped_column(JSON, nullable=False)
    definition_digest: Mapped[str] = mapped_column(String(80), nullable=False)
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
        # The compilation a cell runs is one of its revision's, pinned when the run is created (D7).
        ForeignKeyConstraint(
            ["compilation_id", "binding_case_revision_id"],
            ["problem_compilations.id", "problem_compilations.revision_id"],
            ondelete="RESTRICT",
            name="fk_study_cells_compilation_revision",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    study_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("study_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    binding_case_revision_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("binding_case_revisions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    compilation_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
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


class PricingSnapshot(Base):
    """An immutable copy of one upstream pricing version as read: SPHERE, a registry or a URL (F3).

    The bytes live in the global content-addressed store (``modules/shared/blobs``); this row says where they
    came from, for whom (``scope_key``: ``public``, ``registry:<alias>`` or an organization id) and what they
    were judged to be. Insert-only: UPDATE is always refused and DELETE is refused for public and registry
    rows; an organization's own rows go only with the organization (``routes/organizations._delete_subtree``).
    """

    __tablename__ = "pricing_snapshots"
    __table_args__ = (
        UniqueConstraint("source_key", "scope_key", "sha256", name="uq_pricing_snapshot_source_scope_sha256"),
        CheckConstraint("source_kind IN ('sphere', 'registry', 'url')", name="ck_pricing_snapshot_source_kind"),
        CheckConstraint(
            "(organization_id IS NULL) = (scope_key = 'public' OR substr(scope_key, 1, 9) = 'registry:')",
            name="ck_pricing_snapshot_scope_organization",
        ),
        Index("ix_pricing_snapshots_source_scope", "source_key", "scope_key", "fetched_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    source_key: Mapped[str] = mapped_column(String(160), nullable=False)
    scope_key: Mapped[str] = mapped_column(String(48), nullable=False)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    content_hash_verified: Mapped[bool] = mapped_column(Boolean, nullable=False)
    source_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    registry: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    pricing_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True, index=True)
    version_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True, index=True)
    version_label: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    version_created_at: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    sphere_organization_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    owner: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    slug: Mapped[Optional[str]] = mapped_column(String(160), nullable=True)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    collection_slug: Mapped[Optional[str]] = mapped_column(String(160), nullable=True)
    url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    etag: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    last_modified: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    syntax_version: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    valid: Mapped[bool] = mapped_column(Boolean, nullable=False)
    renamed_from_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_snapshots.id"), nullable=True
    )
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    #: Who read it (NULL for a system read); not a foreign key, so that it never blocks deleting an account.
    fetched_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True, index=True)


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


class NotificationStreamTicket(Base):
    """A single-use ticket that opens a user's notification stream (``GET /v1/notifications/stream``).

    An ``EventSource`` sends no ``Authorization`` header, and an access token in a URL would be logged by every
    proxy on the way, so the stream takes a ticket instead: minted by a signed-in request, kept as a hash, valid
    for a minute, and deleted when the stream opens.
    """

    __tablename__ = "notification_stream_tickets"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ticket_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
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
