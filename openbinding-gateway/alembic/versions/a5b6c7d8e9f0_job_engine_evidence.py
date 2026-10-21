"""Keep the raw answer of an engine until BIM has evaluated it (additive: one new table).

The downgrade drops the table, and with it every raw answer that is still kept:
a job that failed with ``bim_evaluation_failed`` can then no longer be
re-evaluated and has to be retried (which runs the engine again).
"""
from alembic import op
import sqlalchemy as sa

revision = 'a5b6c7d8e9f0'
down_revision = 'f2a3b4c5d6e7'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'job_engine_evidence',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('job_id', sa.Uuid(), nullable=False),
        sa.Column('attempt', sa.Integer(), nullable=False),
        sa.Column('raw_result', sa.JSON(), nullable=False),
        sa.Column('digest', sa.String(length=80), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('uq_job_engine_evidence_job_attempt', 'job_engine_evidence', ['job_id', 'attempt'], unique=True)
    op.create_index('ix_job_engine_evidence_expires_at', 'job_engine_evidence', ['expires_at'])


def downgrade():
    # Destroys the evidence rows still kept; see the docstring.
    op.drop_index('ix_job_engine_evidence_expires_at', table_name='job_engine_evidence')
    op.drop_index('uq_job_engine_evidence_job_attempt', table_name='job_engine_evidence')
    op.drop_table('job_engine_evidence')
