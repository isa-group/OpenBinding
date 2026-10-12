"""Retire the job columns that only served consumption accounting.

``metered`` and ``concurrency_released`` were the compare-and-set flags of the
settlement of a solve, and ``billing_sponsor_user_id`` recorded who would be
charged for it. Nothing is charged any more, so the three go.
"""
from alembic import op
import sqlalchemy as sa

revision = 'c8d9e0f1a2b3'
down_revision = 'b4c5d6e7f8a9'
branch_labels = None
depends_on = None

FOREIGN_KEY = 'fk_jobs_billing_sponsor_user_id_users'
INDEX = 'ix_jobs_billing_sponsor_user_id'


def _saved_sql(bind, kind):
    """The DDL of the triggers or indexes of ``jobs``, which a SQLite rebuild drops or reshapes."""
    return [
        row[0] for row in bind.execute(
            sa.text(
                "SELECT sql FROM sqlite_master WHERE type = :kind AND tbl_name = 'jobs' AND sql IS NOT NULL"
                + (" AND name = 'uq_jobs_study_cell_id'" if kind == 'index' else '')
            ),
            {'kind': kind},
        )
    ]


def upgrade():
    bind = op.get_bind()
    sqlite = bind.dialect.name == 'sqlite'
    triggers = _saved_sql(bind, 'trigger') if sqlite else []
    partial_indexes = _saved_sql(bind, 'index') if sqlite else []
    # SQLite cannot drop a column that carries a foreign key, so the table is
    # rebuilt; that drops its triggers, which are saved and recreated, and the
    # partial unique index of the study cell, which is recreated as written.
    with op.batch_alter_table('jobs') as batch:
        if not sqlite:
            batch.drop_constraint(FOREIGN_KEY, type_='foreignkey')
        batch.drop_index(INDEX)
        batch.drop_column('billing_sponsor_user_id')
        batch.drop_column('metered')
        batch.drop_column('concurrency_released')
    if sqlite:
        for statement in partial_indexes:
            op.execute('DROP INDEX IF EXISTS uq_jobs_study_cell_id')
            op.execute(statement)
        for statement in triggers:
            op.execute(statement)


def downgrade():
    bind = op.get_bind()
    sqlite = bind.dialect.name == 'sqlite'
    triggers = _saved_sql(bind, 'trigger') if sqlite else []
    partial_indexes = _saved_sql(bind, 'index') if sqlite else []
    with op.batch_alter_table('jobs') as batch:
        batch.add_column(sa.Column('metered', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column('concurrency_released', sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column('billing_sponsor_user_id', sa.Uuid(), nullable=True))
        batch.create_index(INDEX, ['billing_sponsor_user_id'], unique=False)
        batch.create_foreign_key(
            FOREIGN_KEY, 'users', ['billing_sponsor_user_id'], ['id'], ondelete='SET NULL'
        )
    if sqlite:
        for statement in partial_indexes:
            op.execute('DROP INDEX IF EXISTS uq_jobs_study_cell_id')
            op.execute(statement)
        for statement in triggers:
            op.execute(statement)
