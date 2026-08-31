"""Separate private activation from EngineRegistration publication."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7b2a4d91e30"
down_revision: Union[str, None] = "9f1c2d3e4a5b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "v1_engine_registration_revisions",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE v1_engine_registration_revisions "
            "SET is_active = CASE WHEN state IN ('active', 'public') THEN true ELSE false END"
        )
    )
    # Fail closed during the lifecycle cut-over: an old pending row was made
    # visible to administrators at creation time and therefore cannot be
    # assumed to be an intentional publication request.
    bind.execute(
        sa.text(
            "UPDATE v1_engine_registration_revisions SET state = CASE state "
            "WHEN 'active' THEN 'private' "
            "WHEN 'public' THEN 'published' "
            "WHEN 'disabled' THEN 'private' "
            "WHEN 'pending_review' THEN 'private' "
            "ELSE state END"
        )
    )
    bind.execute(
        sa.text(
            "UPDATE v1_engine_revisions SET state = 'private' "
            "WHERE state IN ('draft', 'pending_review')"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE v1_engine_registration_revisions SET state = CASE state "
            "WHEN 'private' THEN CASE WHEN is_active THEN 'active' ELSE 'disabled' END "
            "WHEN 'published' THEN 'public' "
            "ELSE state END"
        )
    )
    op.drop_column("v1_engine_registration_revisions", "is_active")
