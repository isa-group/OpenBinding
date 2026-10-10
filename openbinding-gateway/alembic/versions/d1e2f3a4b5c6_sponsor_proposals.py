"""Add sponsor_proposals: billing sponsorship needs the proposed person's acceptance."""
from alembic import op
import sqlalchemy as sa

revision = 'd1e2f3a4b5c6'
down_revision = 'c0d1e2f3a4b5'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'sponsor_proposals',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('organization_id', sa.Uuid(), sa.ForeignKey('organizations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('proposed_user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('proposed_by_user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('status', sa.String(32), nullable=False, server_default='pending'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decided_by_user_id', sa.Uuid(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('decision_reason', sa.String(64), nullable=True),
    )
    op.create_index('ix_sponsor_proposals_organization_id', 'sponsor_proposals', ['organization_id'])
    op.create_index('ix_sponsor_proposals_proposed_user_id', 'sponsor_proposals', ['proposed_user_id'])
    op.create_index('ix_sponsor_proposals_proposed_by_user_id', 'sponsor_proposals', ['proposed_by_user_id'])
    op.create_index('ix_sponsor_proposals_expires_at', 'sponsor_proposals', ['expires_at'])
    # One pending proposal per organization, enforced by the database itself.
    op.create_index(
        'uq_sponsor_proposal_pending',
        'sponsor_proposals',
        ['organization_id'],
        unique=True,
        sqlite_where=sa.text("status = 'pending'"),
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade():
    op.drop_index('uq_sponsor_proposal_pending', table_name='sponsor_proposals')
    op.drop_index('ix_sponsor_proposals_expires_at', table_name='sponsor_proposals')
    op.drop_index('ix_sponsor_proposals_proposed_by_user_id', table_name='sponsor_proposals')
    op.drop_index('ix_sponsor_proposals_proposed_user_id', table_name='sponsor_proposals')
    op.drop_index('ix_sponsor_proposals_organization_id', table_name='sponsor_proposals')
    op.drop_table('sponsor_proposals')
