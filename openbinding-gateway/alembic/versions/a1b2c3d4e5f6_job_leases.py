"""Give a running job a lease, so a dead worker's job can be told from a slow one."""
from alembic import op
import sqlalchemy as sa

revision = 'a1b2c3d4e5f6'
down_revision = 'd1e2f3a4b5c6'
branch_labels = None
depends_on = None


def upgrade():
    # Plain ADD COLUMN rather than batch_alter_table: on SQLite a batch rebuilds
    # the table and silently drops the triggers on jobs (protect_jobs and
    # pin_job_configuration).
    op.add_column('jobs', sa.Column('lease_token', sa.String(36), nullable=True))
    op.add_column('jobs', sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True))
    op.add_column('jobs', sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('jobs', sa.Column('attempt', sa.Integer(), nullable=False, server_default='0'))
    op.create_index('ix_jobs_state_lease_until', 'jobs', ['state', 'lease_until'])


def downgrade():
    op.drop_index('ix_jobs_state_lease_until', table_name='jobs')
    # DROP COLUMN is native on SQLite >= 3.35 and on PostgreSQL; no table rebuild.
    for column in ('attempt', 'claimed_at', 'lease_until', 'lease_token'):
        op.drop_column('jobs', column)
