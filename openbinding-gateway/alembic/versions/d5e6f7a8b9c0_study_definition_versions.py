"""Study contexts select library versions; runs pin their original definition."""
from alembic import op
import sqlalchemy as sa

revision = 'd5e6f7a8b9c0'
down_revision = 'c4d5e6f7a8b9'
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().execute(sa.text('SELECT COUNT(*) FROM studies')).scalar():
        raise RuntimeError('Rebuild the local development database before the study definition cutover.')
    for table in ('studies', 'study_runs'):
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column('definition_version_id', sa.Uuid(), nullable=False))
            batch.create_foreign_key(f'fk_{table}_definition_version_id_artifact_versions', 'artifact_versions', ['definition_version_id'], ['id'], ondelete='RESTRICT')
            batch.create_index(f'ix_{table}_definition_version_id', ['definition_version_id'])
            if table == 'studies':
                batch.drop_column('definition')
                batch.add_column(sa.Column('archived', sa.Boolean(), nullable=False, server_default=sa.false()))

    condition = 'OLD.definition_version_id IS DISTINCT FROM NEW.definition_version_id OR OLD.study_id IS DISTINCT FROM NEW.study_id OR OLD.run_number IS DISTINCT FROM NEW.run_number OR OLD.matrix_digest IS DISTINCT FROM NEW.matrix_digest'
    if op.get_bind().dialect.name == 'sqlite':
        condition = condition.replace('IS DISTINCT FROM', 'IS NOT')
        op.execute(f"CREATE TRIGGER protect_study_runs BEFORE UPDATE ON study_runs WHEN {condition} BEGIN SELECT RAISE(ABORT, 'study run inputs are immutable'); END")
        op.execute("CREATE TRIGGER retain_study_runs BEFORE DELETE ON study_runs BEGIN SELECT RAISE(ABORT, 'study run history is retained'); END")
    else:
        op.execute(f"CREATE OR REPLACE FUNCTION protect_study_runs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF {condition} THEN RAISE EXCEPTION 'study run inputs are immutable'; END IF; RETURN NEW; END $$")
        op.execute("CREATE TRIGGER protect_study_runs BEFORE UPDATE ON study_runs FOR EACH ROW EXECUTE FUNCTION protect_study_runs()")
        op.execute("CREATE OR REPLACE FUNCTION retain_study_runs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'study run history is retained'; END $$")
        op.execute("CREATE TRIGGER retain_study_runs BEFORE DELETE ON study_runs FOR EACH ROW EXECUTE FUNCTION retain_study_runs()")


def downgrade():
    raise RuntimeError('Rebuild the local development database; sealed study history cannot be downgraded.')
