"""Persist API error telemetry and align legacy unique indexes."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "6e8de7683914"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_error_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("organization_id", sa.Uuid(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=False),
        sa.Column("endpoint", sa.String(length=256), nullable=False),
        sa.Column("http_method", sa.String(length=10), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("user_id", "organization_id", "status_code", "category", "error_code", "created_at"):
        op.create_index(f"ix_api_error_events_{column}", "api_error_events", [column])

    with op.batch_alter_table("v1_dialect_revisions") as batch:
        batch.drop_constraint("uq_v1_dialect_revisions_digest", type_="unique")
        batch.drop_index("ix_v1_dialect_revisions_digest")
        batch.create_index("ix_v1_dialect_revisions_digest", ["digest"], unique=True)

    with op.batch_alter_table("v1_engine_credentials") as batch:
        batch.drop_constraint("uq_v1_engine_credentials_registration_id", type_="unique")

    with op.batch_alter_table("v1_engine_revisions") as batch:
        batch.drop_constraint("uq_v1_engine_revisions_digest", type_="unique")
        batch.drop_index("ix_v1_engine_revisions_digest")
        batch.create_index("ix_v1_engine_revisions_digest", ["digest"], unique=True)

    with op.batch_alter_table("v1_job_provenance") as batch:
        batch.drop_constraint("uq_v1_job_provenance_job_id", type_="unique")


def downgrade() -> None:
    with op.batch_alter_table("v1_job_provenance") as batch:
        batch.drop_index("ix_v1_job_provenance_job_id")
        batch.create_unique_constraint("uq_v1_job_provenance_job_id", ["job_id"])

    with op.batch_alter_table("v1_engine_revisions") as batch:
        batch.drop_index("ix_v1_engine_revisions_digest")
        batch.create_unique_constraint("uq_v1_engine_revisions_digest", ["digest"])
        batch.create_index("ix_v1_engine_revisions_digest", ["digest"])

    with op.batch_alter_table("v1_engine_credentials") as batch:
        batch.create_unique_constraint("uq_v1_engine_credentials_registration_id", ["registration_id"])

    with op.batch_alter_table("v1_dialect_revisions") as batch:
        batch.drop_index("ix_v1_dialect_revisions_digest")
        batch.create_unique_constraint("uq_v1_dialect_revisions_digest", ["digest"])
        batch.create_index("ix_v1_dialect_revisions_digest", ["digest"])

    for column in ("user_id", "organization_id", "status_code", "category", "error_code", "created_at"):
        op.drop_index(f"ix_api_error_events_{column}", table_name="api_error_events")
    op.drop_table("api_error_events")
