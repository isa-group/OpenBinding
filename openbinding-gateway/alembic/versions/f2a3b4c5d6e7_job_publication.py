"""Job publication state (the QUEUED row is the outbox) and analysis task attempts."""
from alembic import op
import sqlalchemy as sa

revision = 'f2a3b4c5d6e7'
down_revision = 'e1f2a3b4c5d6'
branch_labels = None
depends_on = None


def upgrade():
    # ``recreate='never'`` keeps batch_alter_table from rebuilding the table on
    # SQLite, which would silently drop the triggers on jobs (protect_jobs and
    # pin_job_configuration); the columns are added with ALTER TABLE ADD COLUMN.
    with op.batch_alter_table('jobs', recreate='never') as batch:
        batch.add_column(sa.Column('publish_attempts', sa.Integer(), nullable=False, server_default='0'))
        batch.add_column(sa.Column('next_publish_at', sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table('analysis_tasks', recreate='never') as batch:
        batch.add_column(sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'))


def downgrade():
    with op.batch_alter_table('analysis_tasks', recreate='never') as batch:
        batch.drop_column('attempts')
    with op.batch_alter_table('jobs', recreate='never') as batch:
        batch.drop_column('next_publish_at')
        batch.drop_column('publish_attempts')
