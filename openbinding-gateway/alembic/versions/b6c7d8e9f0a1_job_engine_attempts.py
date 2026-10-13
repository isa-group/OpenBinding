"""Keep the engine's id of every attempt of a job, for the best-effort remote cancellation (additive: one new table).

``jobs.engine_job_id`` keeps one id and the next attempt overwrites it. The new
table keeps one row per (job, attempt) with the id, the endpoint it came from and
the state of its cancellation.

The downgrade drops the table, and with it the ids of the attempts whose remote
job was not yet cancelled and the cancellations still pending: the remote jobs of
attempts that lost their lease can then no longer be asked to stop, and keep
running in the engine until they end on their own. ``jobs.engine_job_id`` is
untouched.
"""
from alembic import op
import sqlalchemy as sa

revision = 'b6c7d8e9f0a1'
down_revision = 'a5b6c7d8e9f0'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'job_engine_attempts',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('job_id', sa.Uuid(), nullable=False),
        sa.Column('attempt', sa.Integer(), nullable=False),
        sa.Column('engine_job_id', sa.String(length=128), nullable=False),
        sa.Column('endpoint', sa.String(length=512), nullable=False),
        sa.Column('registered_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('cancel_state', sa.String(length=16), server_default='none', nullable=False),
        sa.Column('cancel_attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('next_cancel_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint(
            "cancel_state IN ('none', 'pending', 'sent', 'skipped', 'failed')",
            name='ck_job_engine_attempts_cancel_state',
        ),
    )
    op.create_index('uq_job_engine_attempts_job_attempt', 'job_engine_attempts', ['job_id', 'attempt'], unique=True)
    op.create_index('ix_job_engine_attempts_cancel_due', 'job_engine_attempts', ['cancel_state', 'next_cancel_at'])


def downgrade():
    # Destroys the ids and the pending cancellations still kept; see the docstring.
    op.drop_index('ix_job_engine_attempts_cancel_due', table_name='job_engine_attempts')
    op.drop_index('uq_job_engine_attempts_job_attempt', table_name='job_engine_attempts')
    op.drop_table('job_engine_attempts')
