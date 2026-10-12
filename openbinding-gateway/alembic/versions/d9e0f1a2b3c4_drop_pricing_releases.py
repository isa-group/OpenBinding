"""Drop the local pricing release registry.

SPHERE and SPACE own pricings, versions, plans and contracts and are administered
in their own consoles. ``pricing_releases`` only mirrored that metadata (and the
LIVE pointer); the version in force is now the ``SPACE_PRICING_VERSION`` setting.
The rows carry nothing that SPHERE does not hold, so they are dropped, not moved.
The downgrade recreates the empty table as the baseline defined it.
"""
from alembic import op
import sqlalchemy as sa

revision = 'd9e0f1a2b3c4'
down_revision = 'c8d9e0f1a2b3'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('pricing_releases', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_pricing_releases_version'))
        batch_op.drop_index(batch_op.f('ix_pricing_releases_is_live'))
        batch_op.drop_index(batch_op.f('ix_pricing_releases_digest'))
    op.drop_table('pricing_releases')


def downgrade():
    op.create_table('pricing_releases',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('version', sa.String(length=64), nullable=False),
    sa.Column('digest', sa.String(length=80), nullable=False),
    sa.Column('sphere_organization', sa.String(length=64), nullable=False),
    sa.Column('sphere_organization_id', sa.String(length=128), nullable=False),
    sa.Column('sphere_slug', sa.String(length=64), nullable=False),
    sa.Column('sphere_state', sa.Enum('PRIVATE_DRAFT', 'PUBLIC_RELEASE', name='pricingspherestate', native_enum=False, length=32), nullable=False),
    sa.Column('public_url', sa.String(length=1024), nullable=True),
    sa.Column('space_state', sa.Enum('NOT_DEPLOYED', 'ACTIVE', 'DRAINING', 'ARCHIVED', name='pricingspacestate', native_enum=False, length=32), nullable=False),
    sa.Column('is_live', sa.Boolean(), nullable=False),
    sa.Column('changelog', sa.String(length=4000), nullable=False),
    sa.Column('migration_manifest', sa.JSON(), nullable=False),
    sa.Column('created_by_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.CheckConstraint("sphere_organization = 'OpenBinding'", name=op.f('ck_pricing_releases_pricing_fixed_organization')),
    sa.CheckConstraint("sphere_slug = 'openbinding'", name=op.f('ck_pricing_releases_pricing_fixed_slug')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_pricing_releases_created_by_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_pricing_releases')),
    sa.UniqueConstraint('version', name='uq_pricing_release_version')
    )
    with op.batch_alter_table('pricing_releases', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_pricing_releases_digest'), ['digest'], unique=False)
        batch_op.create_index(batch_op.f('ix_pricing_releases_is_live'), ['is_live'], unique=False)
        batch_op.create_index(batch_op.f('ix_pricing_releases_version'), ['version'], unique=False)
