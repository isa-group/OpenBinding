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
from typing import Any, Optional

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
    text,
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
    """An external login identity; ``(provider, issuer, subject)`` is the only identity key.

    The only provider is SCORETech Identity: the issuer is the realm's issuer and the subject its ``sub``.
    """

    __tablename__ = "auth_identities"
    __table_args__ = (
        UniqueConstraint("provider", "issuer", "subject", name="uq_identity_provider_issuer_subject"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    issuer: Mapped[str] = mapped_column(String(512), nullable=False)
    subject: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    attributes: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    verified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


#: Why a browser session ended (``identity_sessions.revoked_reason``).
SESSION_REVOKE_REASONS = (
    "logout",
    "logout_all",
    "replaced",
    "identity_ended",
    "admin",
    "deactivated",
    "password_reset",
    "deleted",
    "provider_changed",
)


class IdentitySession(Base):
    """A browser session: the opaque cookie (kept as its sha256) and, for Identity, the sealed refresh token.

    PostgreSQL is the authority on sessions (Redis holds only the sign-in flow, pending sign-ups and the
    refresh lock). Every gateway token names its row (``sid``) and is checked against it on every request,
    so revoking the row ends the session at once. ``refresh_generation`` is the compare-and-swap that keeps
    two workers from storing two different rotated refresh tokens.
    """

    __tablename__ = "identity_sessions"
    __table_args__ = (
        CheckConstraint("provider IN ('local', 'scoretech')", name="identity_session_provider"),
        CheckConstraint(
            "provider <> 'scoretech' OR identity_id IS NOT NULL", name="identity_session_scoretech_identity"
        ),
        CheckConstraint(
            "revoked_reason IS NULL OR revoked_reason IN ("
            + ", ".join(f"'{reason}'" for reason in SESSION_REVOKE_REASONS)
            + ")",
            name="identity_session_revoked_reason",
        ),
        Index("ix_identity_sessions_user_revoked", "user_id", "revoked_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    identity_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("auth_identities.id", ondelete="CASCADE"), nullable=True, index=True
    )
    #: Fernet over ``{"sid", "rt", "gen"}``: a ciphertext copied to another row or generation does not open.
    refresh_ciphertext: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    refresh_generation: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    access_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    refresh_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    idle_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    last_renewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_reason: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)


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
        CheckConstraint("personal_owner_id IS NULL OR parent_id IS NULL", name="personal_organization_is_root"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    parent_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    #: The account whose personal organization this is (SPHERE's ``isPersonal``): one per account, always a
    #: root, never transferred, left, moved, renamed or deleted on its own: it is deleted with its account, by
    #: ``DELETE /v1/users/me``, runs included.
    personal_owner_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True, unique=True
    )
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


class ProblemValueOrigin(Base):
    """Where one value of a revision's package came from (F3): a SPHERE pricing's price, usage limit, feature or
    guarantee, or a value set by hand when importing (``manual``).

    One row per generated value, written in the revision's transaction, never changed (insert-only); the rows go
    with their revision. ``value`` is the scalar the package writes, so a later revision can carry the row when it
    keeps the value (``carried_from_revision_id``). ``snapshot_id`` and the SPHERE ids are ``NULL`` for a hand-made
    candidate's values.
    """

    __tablename__ = "problem_value_origins"
    __table_args__ = (
        UniqueConstraint("revision_id", "candidate_key", "target_kind", "target", name="uq_problem_value_origin_target"),
        CheckConstraint("target_kind IN ('feature', 'property')", name="ck_problem_value_origin_target_kind"),
        CheckConstraint(
            "source_kind IN ('priced', 'guarantee', 'limit', 'feature', 'manual')",
            name="ck_problem_value_origin_source_kind",
        ),
        Index("ix_problem_value_origins_pricing_version", "pricing_id", "version_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    revision_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("binding_case_revisions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: ``<resource>/<id>``.
    candidate_key: Mapped[str] = mapped_column(String(260), nullable=False)
    target_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    target: Mapped[str] = mapped_column(String(128), nullable=False)
    source_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)
    snapshot_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_snapshots.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    registry: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    pricing_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    version_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    #: The raw plan and add-on names, as the pricing writes them.
    plan: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    add_ons: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    #: The readable ``owner/slug`` of the family at snapshot time.
    sphere_ref: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    detail: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    #: The revision this row was copied from (an editor save that kept the value); not a foreign key: the
    #: revisions of a problem go together.
    carried_from_revision_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
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
        # The target of composition environments' composite key: an environment's organization is its composition's.
        UniqueConstraint("id", "organization_id", name="uq_compositions_id_organization"),
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
        # The target of the composite keys that keep an adopted version within its environment's composition.
        UniqueConstraint("id", "composition_id", name="uq_composition_versions_id_composition"),
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
        # The target of the composite key that keeps an adoption's pinned evaluation one of its version's.
        UniqueConstraint("id", "version_id", name="uq_composition_evaluations_id_version"),
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
    #: The offering version read when this row was created (F3): its snapshot, and ``read``, ``unreadable``,
    #: ``invalid_pricing`` or ``registry_unknown``; both NULL for a document without an offering.
    offering_snapshot_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_snapshots.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    offering_status: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
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


class CompositionEnvironment(Base):
    """A composition environment: where an application reads the version of a composition in effect.

    Mutable (the ETag is ``updated_at``), except for what names it: its organization, composition and ``slug``
    (the feed's address) never change. ``adopted_version_id`` is the version in effect and ``adoption_ordinal``
    the number of the adoption that put it there (0: nothing adopted yet); both change only on adopt, which
    also inserts the ``composition_adoptions`` row. ``adopt_role`` is who may adopt (``MEMBER`` or ``ADMIN``),
    ``operator_id`` the member answerable for it, and ``expected_users`` the demand its margins assume.
    """

    __tablename__ = "composition_environments"
    __table_args__ = (
        UniqueConstraint("composition_id", "slug", name="uq_composition_environments_composition_slug"),
        CheckConstraint("adopt_role IN ('MEMBER', 'ADMIN')", name="adopt_role"),
        CheckConstraint(
            "expected_users IS NULL OR (expected_users >= 1 AND expected_users <= 1000000000)",
            name="expected_users",
        ),
        CheckConstraint("adoption_ordinal >= 0", name="ordinal_nonnegative"),
        CheckConstraint(
            "(adoption_ordinal = 0) = (adopted_version_id IS NULL)", name="adopted_whole",
        ),
        # The environment's organization is its composition's.
        ForeignKeyConstraint(
            ["composition_id", "organization_id"],
            ["compositions.id", "compositions.organization_id"],
            ondelete="RESTRICT",
            name="fk_composition_environments_composition",
        ),
        # The version in effect is one of the composition's.
        ForeignKeyConstraint(
            ["adopted_version_id", "composition_id"],
            ["composition_versions.id", "composition_versions.composition_id"],
            ondelete="RESTRICT",
            name="fk_composition_environments_adopted_version",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    composition_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    slug: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    operator_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    adopt_role: Mapped[str] = mapped_column(String(8), nullable=False, default="ADMIN", server_default="ADMIN")
    expected_users: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    adopted_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True, index=True)
    adoption_ordinal: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
    )


class CompositionAdoption(Base):
    """One adoption of a version in an environment: who, when, what was in effect before. Insert only.

    The history of an environment, numbered 1, 2, 3 per environment. ``evaluation_id`` pins the evaluation the
    version was judged on when adopted, so the environment's margins move only with an adoption, and
    ``content_digest`` is the version's: the feed's ETag after this adoption. ``source`` says how a person made it:
    ``direct`` (the adopt route, the lab seed) or ``proposal`` (a confirmed proposal's step, named by
    ``proposal_id``). Rows go only with their environment or organization.
    """

    __tablename__ = "composition_adoptions"
    __table_args__ = (
        UniqueConstraint("environment_id", "ordinal", name="uq_composition_adoptions_environment_ordinal"),
        CheckConstraint("ordinal > 0", name="ordinal_positive"),
        CheckConstraint("source IN ('direct', 'proposal')", name="source"),
        CheckConstraint("(source = 'proposal') = (proposal_id IS NOT NULL)", name="proposal_named"),
        ForeignKeyConstraint(
            ["version_id", "composition_id"],
            ["composition_versions.id", "composition_versions.composition_id"],
            ondelete="RESTRICT",
            name="fk_composition_adoptions_version",
        ),
        ForeignKeyConstraint(
            ["previous_version_id", "composition_id"],
            ["composition_versions.id", "composition_versions.composition_id"],
            ondelete="RESTRICT",
            name="fk_composition_adoptions_previous_version",
        ),
        ForeignKeyConstraint(
            ["evaluation_id", "version_id"],
            ["composition_evaluations.id", "composition_evaluations.version_id"],
            ondelete="RESTRICT",
            name="fk_composition_adoptions_evaluation",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("composition_environments.id", ondelete="RESTRICT"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    composition_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    previous_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True, index=True)
    #: The evaluation the version was adopted on (its margins read it).
    evaluation_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    #: The version's content digest: the feed's ETag after this adoption.
    content_digest: Mapped[str] = mapped_column(String(80), nullable=False)
    actor_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    note: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    #: ``direct`` or ``proposal``; no default, every writer says which (F6).
    source: Mapped[str] = mapped_column(String(8), nullable=False)
    proposal_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("proposals.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class PricingWatch(Base):
    """One watched upstream pricing source and read scope (F6): mutable system state, shared by every composition
    that reads it.

    ``watch_key`` (``sphere|<pricing>|<scope>``, ``registry:<alias>|<pricing>|<scope>`` or ``url|<url_key>|<scope>``)
    is the identity, written by ``watches.watch_for`` (NULLs are distinct in a unique constraint). ``scope_key`` is
    the snapshot scope of what it reads: ``public``, ``registry:<alias>`` or an organization id, which then sets
    ``organization_id`` (private keyed reads and URL offerings). The schedule columns move freely; what names the
    source never changes. ``version_order`` lists every versionId the manifest lists, newest first (membership
    decides a withdrawn version, so it is never truncated). ``gone_epoch`` grows by one each time the source is
    confirmed gone (two 404s from requests actually sent, at least one interval apart by the database clock).
    """

    __tablename__ = "pricing_watches"
    __table_args__ = (
        CheckConstraint("source_kind IN ('sphere', 'registry', 'url')", name="source_kind"),
        CheckConstraint("(source_kind = 'registry') = (registry IS NOT NULL)", name="registry_named"),
        CheckConstraint("(source_kind = 'url') = (url IS NOT NULL)", name="url_named"),
        CheckConstraint("source_kind = 'url' OR pricing_id IS NOT NULL", name="pricing_named"),
        CheckConstraint(
            "(organization_id IS NULL) = (scope_key = 'public' OR substr(scope_key, 1, 9) = 'registry:')",
            name="scope_organization",
        ),
        CheckConstraint(
            "status IN ('pending', 'active', 'unavailable', 'not_found', 'gone', 'credential_missing', "
            "'registry_unknown')",
            name="status",
        ),
        CheckConstraint("not_found_count >= 0 AND failures >= 0 AND gone_epoch >= 0", name="counters"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    source_kind: Mapped[str] = mapped_column(String(8), nullable=False)
    registry: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    pricing_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    url: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    url_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    scope_key: Mapped[str] = mapped_column(String(60), nullable=False)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    watch_key: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", server_default="pending")
    manifest_etag: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    last_modified: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    latest_version_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    latest_snapshot_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_snapshots.id", ondelete="RESTRICT"), nullable=True
    )
    version_order: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    equivalent: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    not_found_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    not_found_since: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    gone_epoch: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    retry_after_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    polled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    observed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    next_poll_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now(), index=True
    )
    classify_after: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class PricingWatchRef(Base):
    """What one sealed composition version reads upstream (F6): an insert-only index, written in the version's
    own transaction, so that "every live version that pins pricing X" is a query and no cycle parses a document.

    One row per version x watch x subject x pinned version (``ref_key``). An **unresolved** ref (``watch_id``
    NULL) names a ``from`` whose family had no stored snapshot at seal; the watcher resolves it later by inserting
    a second, resolved ref for the same version (``pricing_ref_attempts`` schedules the attempts). Rows are never
    updated; they go only with their composition or organization.
    """

    __tablename__ = "pricing_watch_refs"
    __table_args__ = (
        UniqueConstraint("version_id", "ref_key", name="uq_pricing_watch_refs_version_key"),
        CheckConstraint("subject IN ('binding', 'offering')", name="subject"),
        CheckConstraint("via IN ('from', 'origins', 'offering')", name="via"),
        CheckConstraint("(subject = 'offering') = (via = 'offering')", name="offering_via"),
        ForeignKeyConstraint(
            ["composition_id", "organization_id"],
            ["compositions.id", "compositions.organization_id"],
            ondelete="RESTRICT",
            name="fk_pricing_watch_refs_composition",
        ),
        ForeignKeyConstraint(
            ["version_id", "composition_id"],
            ["composition_versions.id", "composition_versions.composition_id"],
            ondelete="RESTRICT",
            name="fk_pricing_watch_refs_version",
        ),
        Index("ix_pricing_watch_refs_unresolved", "version_id",
              sqlite_where=text("watch_id IS NULL"), postgresql_where=text("watch_id IS NULL")),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    composition_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    watch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_watches.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    subject: Mapped[str] = mapped_column(String(8), nullable=False)
    via: Mapped[str] = mapped_column(String(8), nullable=False)
    #: ``owner/slug`` (plus the registry alias) or the canonical URL: for unresolved refs and display.
    sphere_ref: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    tasks: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    pinned_version_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    pinned_snapshot_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_snapshots.id", ondelete="RESTRICT"), nullable=True
    )
    #: ``{task: {plan, addOns, billing?, seats?, currency?, candidate?}}`` for a binding; ``{}`` for an offering.
    selection: Mapped[dict] = mapped_column(JSON, nullable=False)
    ref_key: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class PricingRefAttempt(Base):
    """The persisted schedule of resolving unresolved refs (F6): one row per organization, family and pinned
    version; exponential back-off by the database clock, deleted when the family is resolved."""

    __tablename__ = "pricing_ref_attempts"
    __table_args__ = (CheckConstraint("failures >= 0", name="failures_nonnegative"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    sphere_ref: Mapped[str] = mapped_column(String(300), nullable=False)
    pinned_version_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    attempt_key: Mapped[str] = mapped_column(String(340), nullable=False, unique=True)
    failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_error: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now(), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


class CompositionUpstreamEvent(Base):
    """An upstream event (F6): a classified change of a pricing a live composition version reads. Immutable but
    for its state, the review note and the review and resolution stamps (``db/triggers``).

    ``open`` -> ``reviewed`` (a member's review, with its note) -> ``resolved`` (only inside ``seal_into``, when a
    person seals a version that pins the new pricing version or a newer one; or born resolved when such a version
    already existed). An offering event belongs to the composition (``version_id`` is a reference version) and
    never resolves. The partial unique indexes are the watcher's idempotency across replicas.
    """

    __tablename__ = "composition_upstream_events"
    __table_args__ = (
        UniqueConstraint("id", "composition_id", name="uq_upstream_events_id_composition"),
        CheckConstraint("subject IN ('binding', 'offering')", name="subject"),
        CheckConstraint(
            "category IN ('no_impact', 'values_changed', 'binding_invalid', 'offering_changed')", name="category",
        ),
        CheckConstraint("(subject = 'offering') = (category = 'offering_changed')", name="offering_category"),
        CheckConstraint("state IN ('open', 'reviewed', 'resolved')", name="state"),
        CheckConstraint("subject <> 'offering' OR state <> 'resolved'", name="offering_never_resolved"),
        CheckConstraint("(reviewed_by_id IS NULL) = (reviewed_at IS NULL)", name="reviewed_whole"),
        CheckConstraint(
            "(state = 'resolved') = (resolved_by_version_id IS NOT NULL AND resolved_by_id IS NOT NULL "
            "AND resolved_at IS NOT NULL)",
            name="resolved_whole",
        ),
        CheckConstraint(
            "(resolved_by_version_id IS NULL) = (resolved_at IS NULL) AND (resolved_by_id IS NULL) = (resolved_at IS NULL)",
            name="resolved_stamps",
        ),
        ForeignKeyConstraint(
            ["composition_id", "organization_id"],
            ["compositions.id", "compositions.organization_id"],
            ondelete="RESTRICT",
            name="fk_upstream_events_composition",
        ),
        ForeignKeyConstraint(
            ["version_id", "composition_id"],
            ["composition_versions.id", "composition_versions.composition_id"],
            ondelete="RESTRICT",
            name="fk_upstream_events_version",
        ),
        ForeignKeyConstraint(
            ["resolved_by_version_id", "composition_id"],
            ["composition_versions.id", "composition_versions.composition_id"],
            ondelete="RESTRICT",
            name="fk_upstream_events_resolved_by_version",
        ),
        Index("uq_upstream_events_binding", "version_id", "watch_id", "old_ref", "new_ref", unique=True,
              sqlite_where=text("subject = 'binding'"), postgresql_where=text("subject = 'binding'")),
        Index("uq_upstream_events_offering", "composition_id", "watch_id", "new_ref", unique=True,
              sqlite_where=text("subject = 'offering'"), postgresql_where=text("subject = 'offering'")),
        Index("ix_upstream_events_composition_state", "composition_id", "state"),
        Index("ix_upstream_events_version_state", "version_id", "state"),
        Index("ix_upstream_events_watch_new", "watch_id", "new_ref"),
        Index("ix_upstream_events_organization_detected", "organization_id", "detected_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    composition_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    version_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    watch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pricing_watches.id", ondelete="RESTRICT"), nullable=False)
    subject: Mapped[str] = mapped_column(String(8), nullable=False)
    tasks: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    reasons: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    notify: Mapped[bool] = mapped_column(Boolean, nullable=False)
    old_ref: Mapped[str] = mapped_column(String(80), nullable=False)
    new_ref: Mapped[str] = mapped_column(String(80), nullable=False)
    old_version_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    new_version_id: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    old_label: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    new_label: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    old_snapshot_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_snapshots.id", ondelete="RESTRICT"), nullable=True
    )
    new_snapshot_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("pricing_snapshots.id", ondelete="RESTRICT"), nullable=True
    )
    #: ``openbinding/upstream-event-diff@1`` (at most 64 KiB).
    diff: Mapped[dict] = mapped_column(JSON, nullable=False)
    classifier: Mapped[str] = mapped_column(String(16), nullable=False)
    state: Mapped[str] = mapped_column(String(10), nullable=False, default="open", server_default="open")
    note: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    reviewed_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    resolved_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )


PROPOSAL_STATUSES = ("pending", "executing", "completed", "partial", "failed", "cancelled", "superseded", "stale")
PROPOSAL_STEP_STATUSES = ("pending", "done", "failed", "skipped")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


class Proposal(Base):
    """A proposal (F6, plan §8, ORBIT's plan model): an organization's typed steps that change nothing until its
    author confirms them.

    Built in code from a validated request (the web form; F7's tools), stored with each step's base revisions, shown,
    and applied step by step by the executor (``proposal_executor``) once its author confirms. ``composition_id`` is
    set when every step targets one composition (always in F6). ``scope_key`` is what "the pending one" is relative to
    (``composition:<id>`` on the web): a new proposal by the same author in the same scope supersedes the pending one,
    and the partial unique index makes two pending ones impossible. ``upstream_event_id`` names the event the
    proposal answers (display only), always one of its own composition (composite key). ``progressed_at`` is stamped
    at the claim and after every step outcome: an execution with no progress past the deadline is closed by the
    watcher's housekeeping. Only ``status``, ``superseded_by_id`` and the stamps ever change (``db/triggers``).
    """

    __tablename__ = "proposals"
    __table_args__ = (
        CheckConstraint("origin IN ('web', 'mcp', 'chat')", name="origin"),
        CheckConstraint(_in("status", PROPOSAL_STATUSES), name="status"),
        CheckConstraint("upstream_event_id IS NULL OR composition_id IS NOT NULL", name="event_composition"),
        CheckConstraint("(status = 'superseded') = (superseded_by_id IS NOT NULL)", name="superseded_by"),
        ForeignKeyConstraint(
            ["composition_id", "organization_id"],
            ["compositions.id", "compositions.organization_id"],
            ondelete="RESTRICT",
            name="fk_proposals_composition",
        ),
        ForeignKeyConstraint(
            ["upstream_event_id", "composition_id"],
            ["composition_upstream_events.id", "composition_upstream_events.composition_id"],
            ondelete="RESTRICT",
            name="fk_proposals_upstream_event",
        ),
        Index("uq_proposals_one_pending", "proposed_by_id", "scope_key", unique=True,
              sqlite_where=text("status = 'pending'"), postgresql_where=text("status = 'pending'")),
        Index("ix_proposals_organization_composition_created", "organization_id", "composition_id", "created_at"),
        Index("ix_proposals_proposed_by_created", "proposed_by_id", "created_at"),
        Index("ix_proposals_status_progressed", "status", "progressed_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    composition_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    origin: Mapped[str] = mapped_column(String(8), nullable=False)
    scope_key: Mapped[str] = mapped_column(String(80), nullable=False)
    proposed_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    warnings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    confirmation_phrase: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    upstream_event_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending", server_default="pending")
    #: Deferred to the commit: a supersession marks the pending proposal before the new one is inserted, as the
    #: one-pending unique index requires.
    superseded_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("proposals.id", ondelete="RESTRICT", deferrable=True, initially="DEFERRED"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    progressed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class ProposalStep(Base):
    """One typed step of a proposal (F6): its kind, validated parameters and the base revisions it was built against.

    ``params`` may hold ``@s<n>.<output>`` for a parameter its kind declares referenceable (an earlier step's output);
    ``base`` then lists the parts decided at apply time under ``deferred``. ``preview`` holds the exact canonical
    document a ``seal_derived`` step derived for the person to see (its digest is ``base.contentDigest``); NULL when
    an earlier step decides the content. ``description`` is written by the builder, never by a client. Only the
    outcome changes, once: ``pending`` -> ``done`` | ``failed`` | ``skipped``, with ``result``, ``error`` and
    ``finished_at`` (``db/triggers``). ``kind`` is a name of the step-kind registry (``domain.proposals.REGISTRY``),
    which is the one list of kinds: F7 registers its own without a schema change.
    """

    __tablename__ = "proposal_steps"
    __table_args__ = (
        UniqueConstraint("proposal_id", "ordinal", name="uq_proposal_steps_proposal_ordinal"),
        CheckConstraint("ordinal >= 1 AND ordinal <= 8", name="ordinal_range"),
        CheckConstraint(_in("status", PROPOSAL_STEP_STATUSES), name="status"),
        CheckConstraint("(status = 'pending') = (finished_at IS NULL)", name="finished_whole"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    proposal_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("proposals.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    params: Mapped[dict] = mapped_column(JSON, nullable=False)
    base: Mapped[dict] = mapped_column(JSON, nullable=False)
    preview: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    depends_on: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    destructive: Mapped[bool] = mapped_column(Boolean, nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="pending", server_default="pending")
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    error: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class CompositionEnvironmentKey(Base):
    """A feed key of an environment (``obe_…``): it reads that environment's feed and nothing else.

    It belongs to the environment, not to a person: its creator leaving the organization or deleting the
    account does not break the feed. Only the SHA-256 of the whole key is stored; ``prefix`` finds the row.
    A revoked key never authenticates again, and stays revoked.
    """

    __tablename__ = "composition_environment_keys"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    environment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("composition_environments.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    prefix: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    secret_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[str] = mapped_column(String(80), nullable=False, default="", server_default="")
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
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


class OrgConnection(Base):
    """An organization's connection to an outside service (``sphere``; ``space`` in F8), with a write-only secret.

    ``secret`` is a Fernet token of the key (``security/secrets.CredentialStore``), decrypted only for one call
    and never returned; ``key_hint`` is its last four characters. Of SPHERE's ``/users/me`` only the user id,
    the username, the key's scopes and its expiry are kept. ``updated_at`` is the ETag's revision.
    """

    __tablename__ = "org_connections"
    __table_args__ = (
        UniqueConstraint("organization_id", "kind", name="uq_org_connection_organization_kind"),
        CheckConstraint("kind IN ('sphere', 'space')", name="ck_org_connection_kind"),
        CheckConstraint("status IN ('active', 'invalid')", name="ck_org_connection_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    secret: Mapped[str] = mapped_column(Text, nullable=False)
    key_hint: Mapped[str] = mapped_column(String(8), nullable=False)
    sphere_user_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    sphere_username: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    scopes: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    last_error: Mapped[Optional[str]] = mapped_column(String(240), nullable=True)
    validated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Who set it; not a foreign key, so that it never blocks deleting an account.
    created_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, server_default=func.now()
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
    #: The browser session that bought the ticket (null for an API key): the stream ends with that session.
    session_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("identity_sessions.id", ondelete="CASCADE"), nullable=True, index=True
    )
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
