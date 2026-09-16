"""Pin reusable execution configurations on jobs."""
from alembic import op
import sqlalchemy as sa

revision = 'b9c0d1e2f3a4'
down_revision = 'a8b9c0d1e2f3'
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == 'sqlite':
        # Native ADD preserves the existing job-evidence triggers.
        op.execute('ALTER TABLE jobs ADD COLUMN configuration_version_id CHAR(32) REFERENCES artifact_versions(id) ON DELETE RESTRICT')
    else:
        op.add_column('jobs', sa.Column('configuration_version_id', sa.Uuid(), nullable=True))
        op.create_foreign_key('fk_jobs_configuration_version_id', 'jobs', 'artifact_versions', ['configuration_version_id'], ['id'], ondelete='RESTRICT')
    op.create_index('ix_jobs_configuration_version_id', 'jobs', ['configuration_version_id'])
    if op.get_bind().dialect.name == 'sqlite':
        op.execute("CREATE TRIGGER pin_job_configuration BEFORE UPDATE ON jobs WHEN OLD.configuration_version_id IS NOT NEW.configuration_version_id BEGIN SELECT RAISE(ABORT, 'job configuration is immutable'); END")
    else:
        op.execute("CREATE OR REPLACE FUNCTION pin_job_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.configuration_version_id IS DISTINCT FROM NEW.configuration_version_id THEN RAISE EXCEPTION 'job configuration is immutable'; END IF; RETURN NEW; END $$")
        op.execute('CREATE TRIGGER pin_job_configuration BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION pin_job_configuration()')


def downgrade():
    raise RuntimeError('Execution provenance cannot be discarded; rebuild development data.')
