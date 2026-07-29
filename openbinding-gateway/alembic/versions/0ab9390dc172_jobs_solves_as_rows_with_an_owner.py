"""jobs: solves as rows, with an owner

Jobs lived in a dictionary on the process until now, which lost every result
on restart and let any caller who guessed an identifier read somebody else's
answer. The owner column is what closes the second of those.

It is nullable on purpose: a gateway configured without accounts still
solves, and those jobs belong to nobody.

Revision ID: 0ab9390dc172
Revises: b366910fede4
Create Date: 2026-07-29 11:26:53.590394+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0ab9390dc172'
down_revision: Union[str, None] = 'b366910fede4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('jobs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('owner_id', sa.Uuid(), nullable=True),
    sa.Column('engine_id', sa.String(length=128), nullable=False),
    sa.Column('engine_job_id', sa.String(length=128), nullable=False),
    sa.Column('service_url', sa.String(length=512), nullable=False),
    sa.Column('state', sa.Enum('queued', 'running', 'completed', 'failed', name='jobstate', native_enum=False, length=16), nullable=False),
    sa.Column('verbose', sa.Boolean(), nullable=False),
    sa.Column('original_request', sa.JSON(), nullable=True),
    sa.Column('warnings', sa.JSON(), nullable=True),
    sa.Column('binding_space', sa.JSON(), nullable=True),
    sa.Column('result', sa.JSON(), nullable=True),
    sa.Column('requested_budget_s', sa.Float(), nullable=True),
    sa.Column('metered', sa.Boolean(), nullable=False),
    sa.Column('concurrency_released', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], name=op.f('fk_jobs_owner_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_jobs'))
    )
    with op.batch_alter_table('jobs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_jobs_created_at'), ['created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_jobs_owner_id'), ['owner_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('jobs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_jobs_owner_id'))
        batch_op.drop_index(batch_op.f('ix_jobs_created_at'))

    op.drop_table('jobs')
