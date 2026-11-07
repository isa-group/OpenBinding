"""An archived artifact frees its identity, and a fork's origin is indexed.

Two index changes, no data and no columns.

**The identity becomes partial on ``archived``.** ``uq_artifact_identity`` was a plain
unique constraint over ``(namespace, name)``, so retiring an artifact kept its name taken
for ever and nothing could be created, or forked, under it again. An identity is the name
people cite; making a withdrawal permanent in that way is a consequence nobody asked for.
SPHERE reaches the same end on its pricing identities with
``partialFilterExpression: {deleted: false}``.

The new index is strictly weaker than the constraint it replaces -- it covers the rows the
constraint covered, minus the archived ones -- so no existing row can violate it and the
upgrade needs no data check.

**``artifact_versions.based_on_id`` gains an index.** That edge is read backwards by the
re-fork query: given an origin version and a target organization, find the fork that
already exists instead of creating a second artifact every time the origin publishes a new
version. SPHERE denormalises a whole ``forkedFrom`` record to answer the same question,
because there an origin can disappear; here the foreign key is ``RESTRICT``, so the lineage
cannot break and the index is all the query needs.

The predicate is spelled per dialect because the two write a boolean differently: SQLite
takes ``archived = 0`` and PostgreSQL ``archived = false``. Both have supported partial
indexes for long enough that neither needs a fallback.
"""
from alembic import op
import sqlalchemy as sa

revision = 'c9d0e1f2a3b4'
down_revision = 'e7f8a9b0c1d2'
branch_labels = None
depends_on = None

#: One per dialect, because a boolean literal is not spelled the same way in both.
PREDICATE = {'sqlite': 'archived = 0', 'postgresql': 'archived = false'}


def _predicate() -> str:
    return PREDICATE.get(op.get_bind().dialect.name, 'archived = false')


def upgrade():
    with op.batch_alter_table('artifacts') as batch:
        batch.drop_constraint('uq_artifact_identity', type_='unique')
    op.create_index(
        'uq_artifact_identity', 'artifacts', ['namespace', 'name'],
        unique=True, sqlite_where=sa.text(_predicate()), postgresql_where=sa.text(_predicate()),
    )
    op.create_index('ix_artifact_versions_based_on_id', 'artifact_versions', ['based_on_id'])


def downgrade():
    # The check comes before anything is dropped, and the order is the whole point. Going
    # back means the name is taken again, archived or not, so an identity reused while the
    # partial index was in force cannot be restored to a plain constraint. Dropping first
    # and checking second -- which is how this was written at first, and measured -- left a
    # database with no identity index at all while still recorded at this revision: a schema
    # that matches neither side of the migration. A refusal has to leave the database where
    # it was.
    duplicates = op.get_bind().execute(sa.text(
        'SELECT COUNT(*) FROM (SELECT namespace, name FROM artifacts '
        'GROUP BY namespace, name HAVING COUNT(*) > 1) AS reused',
    )).scalar()
    if duplicates:
        raise RuntimeError(
            f'{duplicates} artifact identities are reused across archived rows; '
            'the plain unique constraint cannot be restored without resolving them.',
        )
    op.drop_index('ix_artifact_versions_based_on_id', table_name='artifact_versions')
    op.drop_index('uq_artifact_identity', table_name='artifacts')
    with op.batch_alter_table('artifacts') as batch:
        batch.create_unique_constraint('uq_artifact_identity', ['namespace', 'name'])
