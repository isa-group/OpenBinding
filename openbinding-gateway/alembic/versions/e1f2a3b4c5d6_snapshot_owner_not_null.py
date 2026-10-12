"""Instance snapshots always have an owner.

An ownerless snapshot used to be readable by anyone through the resolver. No
deployment holds such rows (every snapshot is created by an authenticated
caller), so that rule is gone and the column no longer admits NULL.

The upgrade refuses to run, instead of deleting anything, if an ownerless row
exists: the operator has to decide whose it is. The downgrade only relaxes the
constraint again.
"""
from alembic import op
import sqlalchemy as sa

revision = 'e1f2a3b4c5d6'
down_revision = 'd9e0f1a2b3c4'
branch_labels = None
depends_on = None


def upgrade():
    orphans = op.get_bind().execute(
        sa.text("SELECT COUNT(*) FROM v1_instance_snapshots WHERE owner_id IS NULL")
    ).scalar()
    if orphans:
        raise RuntimeError(
            f"{orphans} instance snapshot(s) have no owner; assign an owner_id or delete them "
            "before upgrading (v1_instance_snapshots.owner_id is now NOT NULL)."
        )
    with op.batch_alter_table('v1_instance_snapshots', schema=None) as batch_op:
        batch_op.alter_column('owner_id', existing_type=sa.Uuid(), nullable=False)


def downgrade():
    with op.batch_alter_table('v1_instance_snapshots', schema=None) as batch_op:
        batch_op.alter_column('owner_id', existing_type=sa.Uuid(), nullable=True)
