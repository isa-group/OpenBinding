"""Durable, cancellable archive analysis without solve billing semantics."""
from alembic import op
import sqlalchemy as sa

revision = "a2b3c4d5e6f7"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("analysis_tasks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("fingerprint", sa.String(80), nullable=False),
        sa.Column("revision", sa.String(80), nullable=False),
        sa.Column("request", sa.JSON(), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("cancellation_requested", sa.Boolean(), nullable=False),
        sa.Column("lease_token", sa.String(36)),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("result", sa.JSON()),
        sa.Column("error", sa.String(512)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("owner_id", "fingerprint", name="uq_analysis_tasks_owner_fingerprint"))
    op.create_index("ix_analysis_tasks_owner_id", "analysis_tasks", ["owner_id"])
    op.create_index("ix_analysis_tasks_state", "analysis_tasks", ["state"])


def downgrade():
    op.drop_table("analysis_tasks")
