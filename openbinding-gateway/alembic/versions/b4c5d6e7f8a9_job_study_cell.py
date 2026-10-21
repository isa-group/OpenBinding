"""Tie a job to the study cell it was launched for, at most one job per cell."""
from alembic import op
import sqlalchemy as sa

revision = 'b4c5d6e7f8a9'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade():
    # Plain ADD COLUMN rather than batch_alter_table: on SQLite a batch rebuilds
    # the table and silently drops the triggers on jobs (protect_jobs and
    # pin_job_configuration). Neither trigger looks at this column.
    if op.get_bind().dialect.name == 'sqlite':
        # SQLite cannot ADD CONSTRAINT, but accepts an inline REFERENCES on a
        # nullable column with no default.
        op.execute('ALTER TABLE jobs ADD COLUMN study_cell_id CHAR(32) REFERENCES study_cells (id) ON DELETE SET NULL')
    else:
        op.add_column('jobs', sa.Column('study_cell_id', sa.Uuid(), nullable=True))
        op.create_foreign_key(
            'fk_jobs_study_cell_id', 'jobs', 'study_cells', ['study_cell_id'], ['id'], ondelete='SET NULL'
        )
    op.create_index(
        'uq_jobs_study_cell_id', 'jobs', ['study_cell_id'], unique=True,
        sqlite_where=sa.text('study_cell_id IS NOT NULL'),
        postgresql_where=sa.text('study_cell_id IS NOT NULL'),
    )


def downgrade():
    op.drop_index('uq_jobs_study_cell_id', table_name='jobs')
    bind = op.get_bind()
    if bind.dialect.name != 'sqlite':
        op.drop_constraint('fk_jobs_study_cell_id', 'jobs', type_='foreignkey')
        op.drop_column('jobs', 'study_cell_id')
        return
    # SQLite refuses DROP COLUMN on a column with a foreign key, so the table is
    # rebuilt; that drops its triggers, which are saved and recreated.
    triggers = [
        row[0] for row in bind.execute(
            sa.text("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs' AND sql IS NOT NULL")
        )
    ]
    with op.batch_alter_table('jobs') as batch:
        batch.drop_column('study_cell_id')
    for statement in triggers:
        op.execute(statement)
