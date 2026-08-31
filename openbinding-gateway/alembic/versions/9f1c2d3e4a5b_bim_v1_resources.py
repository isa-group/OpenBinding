"""BIM v1 immutable resources and destructive language cut-over."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "9f1c2d3e4a5b"
down_revision: Union[str, None] = "441e59a50be2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The old solve history and registrations are intentionally not migrated:
    # their payloads point at a removed language and cannot be replayed. User
    # accounts, keys and plans are in separate tables and remain untouched.
    bind = op.get_bind()
    for table in ("jobs", "federated_engines"):
        count = bind.execute(sa.text(f"SELECT COUNT(*) FROM {table}")).scalar_one()
        print(f"BIM v1 cut-over: purging {count} rows from {table}")
        bind.execute(sa.text(f"DELETE FROM {table}"))
    # The legacy registration model is not part of the active BIM v1 database.
    op.drop_table("federated_engines")

    op.create_table(
        "v1_instance_snapshots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("instance_digest", sa.String(length=80), nullable=False),
        sa.Column("package_digest", sa.String(length=80), nullable=False),
        sa.Column("root_document", sa.JSON(), nullable=False),
        sa.Column("resource_digests", sa.JSON(), nullable=False),
        sa.Column("source_archive", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "package_digest", name="uq_v1_snapshot_owner_package"),
    )
    op.create_index("ix_v1_instance_snapshots_owner_id", "v1_instance_snapshots", ["owner_id"])
    op.create_index("ix_v1_instance_snapshots_instance_digest", "v1_instance_snapshots", ["instance_digest"])
    op.create_index("ix_v1_instance_snapshots_package_digest", "v1_instance_snapshots", ["package_digest"])
    op.create_table(
        "v1_instance_resources",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), nullable=False),
        sa.Column("resource_id", sa.String(length=128), nullable=False),
        sa.Column("role", sa.String(length=128), nullable=False),
        sa.Column("api_version", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=128), nullable=False),
        sa.Column("dialect_id", sa.String(length=132), nullable=False),
        sa.Column("path", sa.String(length=512), nullable=True),
        sa.Column("digest", sa.String(length=80), nullable=False),
        sa.Column("registered_namespace", sa.String(length=128), nullable=True),
        sa.Column("registered_name", sa.String(length=128), nullable=True),
        sa.Column("registered_version", sa.String(length=64), nullable=True),
        sa.Column("registered_digest", sa.String(length=80), nullable=True),
        sa.Column("media_type", sa.String(length=128), nullable=False),
        sa.Column("document", sa.JSON(), nullable=True),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["v1_instance_snapshots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("snapshot_id", "resource_id", name="uq_v1_resource_snapshot_id"),
        sa.UniqueConstraint("snapshot_id", "path", name="uq_v1_resource_snapshot_path"),
    )
    op.create_index("ix_v1_instance_resources_snapshot_id", "v1_instance_resources", ["snapshot_id"])
    op.create_table(
        "v1_binding_ir",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), nullable=False),
        sa.Column("ir_digest", sa.String(length=80), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("source_map", sa.JSON(), nullable=False),
        sa.Column("compiler_version", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["v1_instance_snapshots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("snapshot_id", name="uq_v1_ir_snapshot"),
    )
    op.create_index("ix_v1_binding_ir_snapshot_id", "v1_binding_ir", ["snapshot_id"])
    op.create_index("ix_v1_binding_ir_ir_digest", "v1_binding_ir", ["ir_digest"])
    op.create_table(
        "v1_registered_resource_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("namespace", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("digest", sa.String(length=80), nullable=False),
        sa.Column("role", sa.String(length=128), nullable=False),
        sa.Column("api_version", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=128), nullable=False),
        sa.Column("dialect_id", sa.String(length=132), nullable=False),
        sa.Column("media_type", sa.String(length=128), nullable=False),
        sa.Column("document", sa.JSON(), nullable=True),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "namespace", "name", "version", name="uq_v1_registered_resource_identity"
        ),
    )
    op.create_index(
        "ix_v1_registered_resource_revisions_owner_id",
        "v1_registered_resource_revisions",
        ["owner_id"],
    )
    op.create_index(
        "ix_v1_registered_resource_revisions_namespace",
        "v1_registered_resource_revisions",
        ["namespace"],
    )
    op.create_index(
        "ix_v1_registered_resource_revisions_name",
        "v1_registered_resource_revisions",
        ["name"],
    )
    op.create_index(
        "ix_v1_registered_resource_revisions_digest",
        "v1_registered_resource_revisions",
        ["digest"],
    )
    def alter_jobs(batch) -> None:
        batch.alter_column("binding_space", new_column_name="instance_complexity", existing_type=sa.JSON(), nullable=True)
        batch.add_column(sa.Column("instance_snapshot_id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("provenance", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("idempotency_key", sa.String(length=256), nullable=True))
        batch.add_column(sa.Column("idempotency_fingerprint", sa.String(length=80), nullable=True))
        batch.add_column(sa.Column("termination", sa.String(length=16), nullable=True))
        batch.create_index("ix_jobs_instance_snapshot_id", ["instance_snapshot_id"])
        batch.create_index("ix_jobs_idempotency_key", ["idempotency_key"])
        batch.create_index("ix_jobs_termination", ["termination"])
        batch.create_unique_constraint("uq_jobs_owner_idempotency_key", ["owner_id", "idempotency_key"])
        batch.create_check_constraint(
            "ck_jobs_termination",
            "termination IS NULL OR termination IN ('OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN')",
        )
        batch.create_foreign_key(
            "fk_jobs_instance_snapshot_id_v1_instance_snapshots",
            "v1_instance_snapshots",
            ["instance_snapshot_id"],
            ["id"],
            ondelete="SET NULL",
        )

    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("jobs", recreate="always") as batch:
            alter_jobs(batch)
    else:
        with op.batch_alter_table("jobs") as batch:
            alter_jobs(batch)
    op.create_table(
        "v1_engine_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("namespace", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("digest", sa.String(length=80), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("digest"),
        sa.UniqueConstraint("namespace", "name", "version", name="uq_v1_engine_identity"),
    )
    op.create_index("ix_v1_engine_revisions_owner_id", "v1_engine_revisions", ["owner_id"])
    op.create_index("ix_v1_engine_revisions_digest", "v1_engine_revisions", ["digest"])
    op.create_table(
        "v1_engine_registration_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("namespace", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("manifest_digest", sa.String(length=80), nullable=False),
        sa.Column("engine_digest", sa.String(length=80), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("endpoint", sa.String(length=512), nullable=False),
        sa.Column("protocol_digest", sa.String(length=80), nullable=False),
        sa.Column("openapi_document", sa.JSON(), nullable=True),
        sa.Column("openapi_digest", sa.String(length=80), nullable=True),
        sa.Column("mappings", sa.JSON(), nullable=False),
        sa.Column("auth_scheme", sa.String(length=32), nullable=False),
        sa.Column("verification_report", sa.JSON(), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("namespace", "name", "version", name="uq_v1_registration_identity"),
        sa.UniqueConstraint("namespace", "manifest_digest", name="uq_v1_registration_namespace_digest"),
    )
    op.create_index("ix_v1_engine_registration_revisions_owner_id", "v1_engine_registration_revisions", ["owner_id"])
    op.create_index("ix_v1_engine_registration_revisions_namespace", "v1_engine_registration_revisions", ["namespace"])
    op.create_index("ix_v1_engine_registration_revisions_name", "v1_engine_registration_revisions", ["name"])
    op.create_index("ix_v1_engine_registration_revisions_manifest_digest", "v1_engine_registration_revisions", ["manifest_digest"])
    op.create_index("ix_v1_engine_registration_revisions_engine_digest", "v1_engine_registration_revisions", ["engine_digest"])
    op.create_table(
        "v1_dialect_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("namespace", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("digest", sa.String(length=80), nullable=False),
        sa.Column("adapter_digest", sa.String(length=80), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("digest"),
        sa.UniqueConstraint("namespace", "name", "version", name="uq_v1_dialect_identity"),
    )
    op.create_index("ix_v1_dialect_revisions_owner_id", "v1_dialect_revisions", ["owner_id"])
    op.create_index("ix_v1_dialect_revisions_digest", "v1_dialect_revisions", ["digest"])
    op.create_table(
        "v1_engine_credentials",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("registration_id", sa.Uuid(), nullable=False),
        sa.Column("credential_ref", sa.String(length=256), nullable=False),
        sa.Column("credential_encrypted", sa.String(length=4096), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["registration_id"], ["v1_engine_registration_revisions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("registration_id"),
    )
    op.create_index("ix_v1_engine_credentials_registration_id", "v1_engine_credentials", ["registration_id"], unique=True)
    op.create_table(
        "v1_manifest_publications",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("resource_kind", sa.String(length=32), nullable=False),
        sa.Column("resource_digest", sa.String(length=80), nullable=False),
        sa.Column("publisher_id", sa.Uuid(), nullable=False),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["publisher_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("resource_kind", "resource_digest", name="uq_v1_publication_resource"),
    )
    op.create_index("ix_v1_manifest_publications_resource_digest", "v1_manifest_publications", ["resource_digest"])
    op.create_table(
        "v1_job_provenance",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("digest", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id"),
    )
    op.create_index("ix_v1_job_provenance_job_id", "v1_job_provenance", ["job_id"], unique=True)
    op.create_index("ix_v1_job_provenance_digest", "v1_job_provenance", ["digest"])


def downgrade() -> None:
    raise RuntimeError("The destructive BIM v1 language cut-over is intentionally irreversible")
