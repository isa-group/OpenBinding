"""Protect exact case revisions consumed by scientific artifact versions."""
from alembic import op
import sqlalchemy as sa

revision = 'c4d5e6f7a8b9'
down_revision = 'b3c4d5e6f7a8'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('artifact_case_references',
        sa.Column('version_id', sa.Uuid(), sa.ForeignKey('artifact_versions.id', ondelete='RESTRICT'), primary_key=True),
        sa.Column('position', sa.Integer(), primary_key=True),
        sa.Column('case_revision_id', sa.Uuid(), sa.ForeignKey('binding_case_revisions.id', ondelete='RESTRICT'), nullable=False),
        sa.CheckConstraint('position >= 0', name='artifact_case_position_nonnegative'))
    op.create_index('ix_artifact_case_references_case_revision_id', 'artifact_case_references', ['case_revision_id'])
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("CREATE OR REPLACE FUNCTION reject_artifact_case_references_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sealed artifact data is immutable'; END $$")
    for operation in ('UPDATE', 'DELETE'):
        if op.get_bind().dialect.name == 'sqlite':
            op.execute(f"CREATE TRIGGER immutable_artifact_case_references_{operation.lower()} BEFORE {operation} ON artifact_case_references BEGIN SELECT RAISE(ABORT, 'sealed artifact data is immutable'); END")
        else:
            op.execute(f"CREATE TRIGGER immutable_artifact_case_references_{operation.lower()} BEFORE {operation} ON artifact_case_references FOR EACH ROW EXECUTE FUNCTION reject_artifact_case_references_change()")


def downgrade():
    raise RuntimeError('Cannot discard historical artifact references; rebuild the local development database instead.')
