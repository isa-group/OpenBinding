"""Organization-owned identities, editable drafts and immutable releases."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, DDL, ForeignKey, Integer, String, UniqueConstraint, Uuid, event, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base
from .platform_models import utcnow


class Artifact(Base):
    __tablename__ = "artifacts"
    __table_args__ = (UniqueConstraint("namespace", "name", name="uq_artifact_identity"),)
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


class ArtifactEvidence(Base):
    __tablename__ = 'artifact_evidence'
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('artifact_versions.id', ondelete='RESTRICT'), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    study_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey('study_runs.id', ondelete='RESTRICT'), nullable=True, index=True)
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey('jobs.id', ondelete='RESTRICT'), nullable=True, index=True)
    digest: Mapped[str] = mapped_column(String(80))
    __table_args__ = (CheckConstraint('(study_run_id IS NULL) <> (job_id IS NULL)', name='artifact_evidence_one_target'),)


# Enforce release immutability for SQL writers too, including maintenance jobs.
IMMUTABLE_TABLES = ("artifact_versions", "artifact_dependencies", "case_artifacts", "binding_case_revisions", "artifact_case_references", "artifact_evidence")
for table_name in IMMUTABLE_TABLES:
    table = Base.metadata.tables[table_name]
    for operation in ("UPDATE", "DELETE"):
        event.listen(table, "after_create", DDL(
            f"CREATE TRIGGER immutable_{table_name}_{operation.lower()} BEFORE {operation} ON {table_name} "
            "BEGIN SELECT RAISE(ABORT, 'sealed artifact data is immutable'); END"
        ).execute_if(dialect="sqlite"))
        event.listen(table, "after_create", DDL(
            f"CREATE OR REPLACE FUNCTION reject_{table_name}_change() RETURNS trigger LANGUAGE plpgsql AS $$ "
            "BEGIN RAISE EXCEPTION 'sealed artifact data is immutable'; END $$"
        ).execute_if(dialect="postgresql"))
        event.listen(table, "after_create", DDL(
            f"CREATE TRIGGER immutable_{table_name}_{operation.lower()} BEFORE {operation} ON {table_name} "
            f"FOR EACH ROW EXECUTE FUNCTION reject_{table_name}_change()"
        ).execute_if(dialect="postgresql"))


for table_name, sqlite_condition, postgres_condition in (
    ('artifact_publications', 'OLD.version_id IS NOT NEW.version_id OR OLD.citation IS NOT NEW.citation OR OLD.published_by_id IS NOT NEW.published_by_id OR OLD.published_at IS NOT NEW.published_at OR (OLD.withdrawn = 1 AND NEW.withdrawn = 0)', 'OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.citation::text IS DISTINCT FROM NEW.citation::text OR OLD.published_by_id IS DISTINCT FROM NEW.published_by_id OR OLD.published_at IS DISTINCT FROM NEW.published_at OR (OLD.withdrawn AND NOT NEW.withdrawn)'),
    ('publications', 'OLD.report_id IS NOT NEW.report_id OR OLD.version_id IS NOT NEW.version_id OR OLD.project_id IS NOT NEW.project_id OR OLD.slug IS NOT NEW.slug OR OLD.citation IS NOT NEW.citation OR OLD.published_by_id IS NOT NEW.published_by_id OR OLD.published_at IS NOT NEW.published_at OR (OLD.withdrawn = 1 AND NEW.withdrawn = 0)', 'OLD.report_id IS DISTINCT FROM NEW.report_id OR OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.slug IS DISTINCT FROM NEW.slug OR OLD.citation::text IS DISTINCT FROM NEW.citation::text OR OLD.published_by_id IS DISTINCT FROM NEW.published_by_id OR OLD.published_at IS DISTINCT FROM NEW.published_at OR (OLD.withdrawn AND NOT NEW.withdrawn)'),
    ("jobs", 'EXISTS (SELECT 1 FROM artifact_evidence WHERE job_id = OLD.id) AND (OLD.result IS NOT NEW.result OR OLD.provenance IS NOT NEW.provenance OR OLD.original_request IS NOT NEW.original_request OR OLD.options IS NOT NEW.options OR OLD.state IS NOT NEW.state OR OLD.instance_snapshot_id IS NOT NEW.instance_snapshot_id OR OLD.engine_id IS NOT NEW.engine_id OR OLD.service_url IS NOT NEW.service_url)', 'EXISTS (SELECT 1 FROM artifact_evidence WHERE job_id = OLD.id) AND (OLD.result::text IS DISTINCT FROM NEW.result::text OR OLD.provenance::text IS DISTINCT FROM NEW.provenance::text OR OLD.original_request::text IS DISTINCT FROM NEW.original_request::text OR OLD.options::text IS DISTINCT FROM NEW.options::text OR OLD.state IS DISTINCT FROM NEW.state OR OLD.instance_snapshot_id IS DISTINCT FROM NEW.instance_snapshot_id OR OLD.engine_id IS DISTINCT FROM NEW.engine_id OR OLD.service_url IS DISTINCT FROM NEW.service_url)'),
    ("study_cells", 'OLD.study_run_id IS NOT NEW.study_run_id OR OLD.ordinal IS NOT NEW.ordinal OR OLD.binding_case_revision_id IS NOT NEW.binding_case_revision_id OR OLD.engine_ref IS NOT NEW.engine_ref OR OLD.parameters IS NOT NEW.parameters OR OLD.seed IS NOT NEW.seed OR OLD.fingerprint IS NOT NEW.fingerprint', 'OLD.study_run_id IS DISTINCT FROM NEW.study_run_id OR OLD.ordinal IS DISTINCT FROM NEW.ordinal OR OLD.binding_case_revision_id IS DISTINCT FROM NEW.binding_case_revision_id OR OLD.engine_ref::jsonb IS DISTINCT FROM NEW.engine_ref::jsonb OR OLD.parameters::jsonb IS DISTINCT FROM NEW.parameters::jsonb OR OLD.seed IS DISTINCT FROM NEW.seed OR OLD.fingerprint IS DISTINCT FROM NEW.fingerprint'),
    ("study_runs", "OLD.definition_version_id IS NOT NEW.definition_version_id OR OLD.study_id IS NOT NEW.study_id OR OLD.run_number IS NOT NEW.run_number OR OLD.matrix_digest IS NOT NEW.matrix_digest",
     "OLD.definition_version_id IS DISTINCT FROM NEW.definition_version_id OR OLD.study_id IS DISTINCT FROM NEW.study_id OR OLD.run_number IS DISTINCT FROM NEW.run_number OR OLD.matrix_digest IS DISTINCT FROM NEW.matrix_digest"),
    ("artifacts", "OLD.organization_id IS NOT NEW.organization_id OR OLD.namespace IS NOT NEW.namespace OR OLD.name IS NOT NEW.name OR OLD.kind IS NOT NEW.kind",
     "OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.namespace IS DISTINCT FROM NEW.namespace OR OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind"),
    ("artifact_drafts", "OLD.sealed_version_id IS NOT NULL", "OLD.sealed_version_id IS NOT NULL"),
):
    table = Base.metadata.tables[table_name]
    event.listen(table, "after_create", DDL(
        f"CREATE TRIGGER protect_{table_name} BEFORE UPDATE ON {table_name} WHEN {sqlite_condition} "
        "BEGIN SELECT RAISE(ABORT, 'artifact identity or sealed draft is immutable'); END"
    ).execute_if(dialect="sqlite"))
    event.listen(table, "after_create", DDL(
        f"CREATE OR REPLACE FUNCTION protect_{table_name}() RETURNS trigger LANGUAGE plpgsql AS $$ "
        f"BEGIN IF {postgres_condition} THEN RAISE EXCEPTION 'artifact identity or sealed draft is immutable'; END IF; RETURN NEW; END $$"
    ).execute_if(dialect="postgresql"))
    event.listen(table, "after_create", DDL(
        f"CREATE TRIGGER protect_{table_name} BEFORE UPDATE ON {table_name} "
        f"FOR EACH ROW EXECUTE FUNCTION protect_{table_name}()"
    ).execute_if(dialect="postgresql"))

for dialect, sql in (
    ('sqlite', "CREATE TRIGGER retain_study_runs BEFORE DELETE ON study_runs BEGIN SELECT RAISE(ABORT, 'study run history is retained'); END"),
    ('postgresql', "CREATE OR REPLACE FUNCTION retain_study_runs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'study run history is retained'; END $$"),
    ('postgresql', "CREATE TRIGGER retain_study_runs BEFORE DELETE ON study_runs FOR EACH ROW EXECUTE FUNCTION retain_study_runs()"),
):
    event.listen(Base.metadata.tables['study_runs'], 'after_create', DDL(sql).execute_if(dialect=dialect))

for dialect, sql in (
    ('sqlite', "CREATE TRIGGER retain_study_cells BEFORE DELETE ON study_cells BEGIN SELECT RAISE(ABORT, 'study cell history is retained'); END"),
    ('postgresql', "CREATE OR REPLACE FUNCTION retain_study_cells() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'study cell history is retained'; END $$"),
    ('postgresql', "CREATE TRIGGER retain_study_cells BEFORE DELETE ON study_cells FOR EACH ROW EXECUTE FUNCTION retain_study_cells()"),
):
    event.listen(Base.metadata.tables['study_cells'], 'after_create', DDL(sql).execute_if(dialect=dialect))

for dialect, sql in (('sqlite', "CREATE TRIGGER retain_publications BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT, 'publication history is retained'); END"), ('postgresql', "CREATE OR REPLACE FUNCTION retain_publications() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication history is retained'; END $$"), ('postgresql', 'CREATE TRIGGER retain_publications BEFORE DELETE ON publications FOR EACH ROW EXECUTE FUNCTION retain_publications()')):
    event.listen(Base.metadata.tables['publications'], "after_create", DDL(sql).execute_if(dialect=dialect))

for dialect, sql in (('sqlite', "CREATE TRIGGER retain_artifact_publications BEFORE DELETE ON artifact_publications BEGIN SELECT RAISE(ABORT, 'publication history is retained'); END"), ('postgresql', "CREATE OR REPLACE FUNCTION retain_artifact_publications() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication history is retained'; END $$"), ('postgresql', 'CREATE TRIGGER retain_artifact_publications BEFORE DELETE ON artifact_publications FOR EACH ROW EXECUTE FUNCTION retain_artifact_publications()')):
    event.listen(Base.metadata.tables['artifact_publications'], "after_create", DDL(sql).execute_if(dialect=dialect))


# Once a run is report evidence, its terminal outcome cannot be replaced by a retry.
for table_name, target, columns in (
    ('study_runs', 'id', ('state', 'summary', 'finished_at')),
    ('study_cells', 'study_run_id', ('state', 'job_id', 'metrics')),
):
    exists = f'EXISTS (SELECT 1 FROM artifact_evidence WHERE study_run_id = OLD.{target})'
    sqlite_changed = ' OR '.join(f'OLD.{column} IS NOT NEW.{column}' for column in columns)
    postgres_changed = ' OR '.join(f'OLD.{column}::text IS DISTINCT FROM NEW.{column}::text' for column in columns)
    for dialect, sql in (
        ('sqlite', f"CREATE TRIGGER freeze_evidence_{table_name} BEFORE UPDATE ON {table_name} WHEN {exists} AND ({sqlite_changed}) BEGIN SELECT RAISE(ABORT, 'sealed run evidence is immutable'); END"),
        ('postgresql', f"CREATE OR REPLACE FUNCTION freeze_evidence_{table_name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF {exists} AND ({postgres_changed}) THEN RAISE EXCEPTION 'sealed run evidence is immutable'; END IF; RETURN NEW; END $$"),
        ('postgresql', f"CREATE TRIGGER freeze_evidence_{table_name} BEFORE UPDATE ON {table_name} FOR EACH ROW EXECUTE FUNCTION freeze_evidence_{table_name}()"),
    ):
        event.listen(ArtifactEvidence.__table__, 'after_create', DDL(sql).execute_if(dialect=dialect))
for dialect, sql in (
    ('sqlite', "CREATE TRIGGER freeze_evidence_cell_insert BEFORE INSERT ON study_cells WHEN EXISTS (SELECT 1 FROM artifact_evidence WHERE study_run_id = NEW.study_run_id) BEGIN SELECT RAISE(ABORT, 'sealed run evidence is immutable'); END"),
    ('postgresql', "CREATE OR REPLACE FUNCTION freeze_evidence_cell_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM artifact_evidence WHERE study_run_id = NEW.study_run_id) THEN RAISE EXCEPTION 'sealed run evidence is immutable'; END IF; RETURN NEW; END $$"),
    ('postgresql', "CREATE TRIGGER freeze_evidence_cell_insert BEFORE INSERT ON study_cells FOR EACH ROW EXECUTE FUNCTION freeze_evidence_cell_insert()"),
):
    event.listen(ArtifactEvidence.__table__, 'after_create', DDL(sql).execute_if(dialect=dialect))

for dialect, sql in (
    ('sqlite', "CREATE TRIGGER pin_job_configuration BEFORE UPDATE ON jobs WHEN OLD.configuration_version_id IS NOT NEW.configuration_version_id BEGIN SELECT RAISE(ABORT, 'job configuration is immutable'); END"),
    ('postgresql', "CREATE OR REPLACE FUNCTION pin_job_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.configuration_version_id IS DISTINCT FROM NEW.configuration_version_id THEN RAISE EXCEPTION 'job configuration is immutable'; END IF; RETURN NEW; END $$"),
    ('postgresql', "CREATE TRIGGER pin_job_configuration BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION pin_job_configuration()"),
):
    event.listen(Base.metadata.tables['jobs'], 'after_create', DDL(sql).execute_if(dialect=dialect))
