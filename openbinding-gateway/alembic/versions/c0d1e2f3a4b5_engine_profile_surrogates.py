"""Add v1_engine_profile_surrogates table for calibrated surrogate models."""
from alembic import op
import sqlalchemy as sa

revision = 'c0d1e2f3a4b5'
down_revision = 'b9c0d1e2f3a4'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'v1_engine_profile_surrogates',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('engine', sa.String(128), nullable=False),
        sa.Column('mode', sa.String(64), nullable=False, server_default='default'),
        sa.Column('latency_coefficients', sa.JSON(), nullable=False),
        sa.Column('quality_coefficients', sa.JSON(), nullable=False),
        sa.Column('failure_risk_coefficients', sa.JSON(), nullable=False),
        sa.Column('sample_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('r2_score', sa.Float(), nullable=True),
        sa.Column('last_calibrated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('metadata_info', sa.JSON(), nullable=False),
        sa.UniqueConstraint('engine', 'mode', name='uq_v1_engine_surrogate_engine_mode'),
    )
    op.create_index('ix_v1_engine_profile_surrogates_engine', 'v1_engine_profile_surrogates', ['engine'])


def downgrade():
    op.drop_index('ix_v1_engine_profile_surrogates_engine', table_name='v1_engine_profile_surrogates')
    op.drop_table('v1_engine_profile_surrogates')
