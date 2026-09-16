"""Move report payloads to library drafts and publications to exact versions."""
from alembic import op
import sqlalchemy as sa

revision = 'f7a8b9c0d1e2'
down_revision = 'e6f7a8b9c0d1'
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().execute(sa.text('SELECT COUNT(*) FROM reports')).scalar():
        raise RuntimeError('Rebuild the local development database before the report cutover.')
    with op.batch_alter_table('reports') as b:
        b.drop_column('document')
        b.drop_index('ix_reports_digest')
        b.drop_column('digest')
        for name, target, nullable in [('artifact_id', 'artifacts', False), ('draft_id', 'artifact_drafts', True), ('version_id', 'artifact_versions', True)]:
            b.add_column(sa.Column(name, sa.Uuid(), nullable=nullable))
            b.create_foreign_key('fk_reports_' + name, target, [name], ['id'], ondelete='RESTRICT')
        b.create_index('ix_reports_artifact_id', ['artifact_id'])
        b.create_index('ix_reports_version_id', ['version_id'])
        b.drop_constraint('fk_reports_study_run_id_study_runs', type_='foreignkey')
        b.create_foreign_key('fk_reports_study_run_id_study_runs', 'study_runs', ['study_run_id'], ['id'], ondelete='RESTRICT')
    with op.batch_alter_table('publications') as b:
        b.drop_constraint('uq_publication_report', type_='unique')
        b.add_column(sa.Column('version_id', sa.Uuid(), nullable=False))
        b.add_column(sa.Column('withdrawn', sa.Boolean(), nullable=False, server_default=sa.false()))
        b.create_foreign_key('fk_publications_version_id', 'artifact_versions', ['version_id'], ['id'], ondelete='RESTRICT')
        b.create_index('ix_publications_version_id', ['version_id'])
        b.create_unique_constraint('uq_publication_report_version', ['report_id', 'version_id'])
        b.drop_constraint('fk_publications_report_id_reports', type_='foreignkey')
        b.create_foreign_key('fk_publications_report_id_reports', 'reports', ['report_id'], ['id'], ondelete='RESTRICT')

    op.create_table('artifact_evidence',
        sa.Column('version_id', sa.Uuid(), sa.ForeignKey('artifact_versions.id', ondelete='RESTRICT'), primary_key=True),
        sa.Column('position', sa.Integer(), primary_key=True),
        sa.Column('study_run_id', sa.Uuid(), sa.ForeignKey('study_runs.id', ondelete='RESTRICT')),
        sa.Column('job_id', sa.Uuid(), sa.ForeignKey('jobs.id', ondelete='RESTRICT')),
        sa.Column('digest', sa.String(80), nullable=False),
        sa.CheckConstraint('(study_run_id IS NULL) <> (job_id IS NULL)', name='artifact_evidence_one_target'))
    for column in ('study_run_id', 'job_id'):
        op.create_index('ix_artifact_evidence_' + column, 'artifact_evidence', [column])
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("CREATE OR REPLACE FUNCTION reject_artifact_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sealed evidence is immutable'; END $$")
    for operation in ('UPDATE', 'DELETE'):
        if op.get_bind().dialect.name == 'sqlite':
            op.execute(f"CREATE TRIGGER immutable_artifact_evidence_{operation.lower()} BEFORE {operation} ON artifact_evidence BEGIN SELECT RAISE(ABORT, 'sealed evidence is immutable'); END")
        else:
            op.execute(f"CREATE TRIGGER immutable_artifact_evidence_{operation.lower()} BEFORE {operation} ON artifact_evidence FOR EACH ROW EXECUTE FUNCTION reject_artifact_evidence_change()")
    if op.get_bind().dialect.name == 'sqlite':
        op.execute("CREATE TRIGGER protect_jobs BEFORE UPDATE ON jobs WHEN EXISTS (SELECT 1 FROM artifact_evidence WHERE job_id = OLD.id) AND (OLD.result IS NOT NEW.result OR OLD.provenance IS NOT NEW.provenance OR OLD.original_request IS NOT NEW.original_request OR OLD.options IS NOT NEW.options OR OLD.state IS NOT NEW.state OR OLD.instance_snapshot_id IS NOT NEW.instance_snapshot_id OR OLD.engine_id IS NOT NEW.engine_id OR OLD.service_url IS NOT NEW.service_url) BEGIN SELECT RAISE(ABORT, 'sealed job evidence is immutable'); END")
    else:
        op.execute("CREATE OR REPLACE FUNCTION protect_jobs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM artifact_evidence WHERE job_id = OLD.id) AND (OLD.result::text IS DISTINCT FROM NEW.result::text OR OLD.provenance::text IS DISTINCT FROM NEW.provenance::text OR OLD.original_request::text IS DISTINCT FROM NEW.original_request::text OR OLD.options::text IS DISTINCT FROM NEW.options::text OR OLD.state IS DISTINCT FROM NEW.state OR OLD.instance_snapshot_id IS DISTINCT FROM NEW.instance_snapshot_id OR OLD.engine_id IS DISTINCT FROM NEW.engine_id OR OLD.service_url IS DISTINCT FROM NEW.service_url) THEN RAISE EXCEPTION 'sealed job evidence is immutable'; END IF; RETURN NEW; END $$")
        op.execute("CREATE TRIGGER protect_jobs BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION protect_jobs()")

    if op.get_bind().dialect.name == "sqlite":
        op.execute("CREATE TRIGGER protect_publications BEFORE UPDATE ON publications WHEN OLD.report_id IS NOT NEW.report_id OR OLD.version_id IS NOT NEW.version_id OR OLD.project_id IS NOT NEW.project_id OR OLD.slug IS NOT NEW.slug OR OLD.citation IS NOT NEW.citation OR OLD.published_by_id IS NOT NEW.published_by_id OR OLD.published_at IS NOT NEW.published_at OR (OLD.withdrawn = 1 AND NEW.withdrawn = 0) BEGIN SELECT RAISE(ABORT, 'publication identity is immutable'); END")
    else:
        op.execute("CREATE OR REPLACE FUNCTION protect_publications() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.report_id IS DISTINCT FROM NEW.report_id OR OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.slug IS DISTINCT FROM NEW.slug OR OLD.citation::text IS DISTINCT FROM NEW.citation::text OR OLD.published_by_id IS DISTINCT FROM NEW.published_by_id OR OLD.published_at IS DISTINCT FROM NEW.published_at OR (OLD.withdrawn AND NOT NEW.withdrawn) THEN RAISE EXCEPTION 'publication identity is immutable'; END IF; RETURN NEW; END $$")
        op.execute('CREATE TRIGGER protect_publications BEFORE UPDATE ON publications FOR EACH ROW EXECUTE FUNCTION protect_publications()')
    if op.get_bind().dialect.name == 'sqlite':
        op.execute("CREATE TRIGGER retain_publications BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT, 'publication history is retained'); END")
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("CREATE OR REPLACE FUNCTION retain_publications() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication history is retained'; END $$")
    if op.get_bind().dialect.name == 'postgresql':
        op.execute('CREATE TRIGGER retain_publications BEFORE DELETE ON publications FOR EACH ROW EXECUTE FUNCTION retain_publications()')

    if op.get_bind().dialect.name == "sqlite":
        op.execute("CREATE TRIGGER protect_artifact_publications BEFORE UPDATE ON artifact_publications WHEN OLD.version_id IS NOT NEW.version_id OR OLD.citation IS NOT NEW.citation OR OLD.published_by_id IS NOT NEW.published_by_id OR OLD.published_at IS NOT NEW.published_at OR (OLD.withdrawn = 1 AND NEW.withdrawn = 0) BEGIN SELECT RAISE(ABORT, 'publication identity is immutable'); END")
    else:
        op.execute("CREATE OR REPLACE FUNCTION protect_artifact_publications() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.citation::text IS DISTINCT FROM NEW.citation::text OR OLD.published_by_id IS DISTINCT FROM NEW.published_by_id OR OLD.published_at IS DISTINCT FROM NEW.published_at OR (OLD.withdrawn AND NOT NEW.withdrawn) THEN RAISE EXCEPTION 'publication identity is immutable'; END IF; RETURN NEW; END $$")
        op.execute('CREATE TRIGGER protect_artifact_publications BEFORE UPDATE ON artifact_publications FOR EACH ROW EXECUTE FUNCTION protect_artifact_publications()')
    if op.get_bind().dialect.name == 'sqlite':
        op.execute("CREATE TRIGGER retain_artifact_publications BEFORE DELETE ON artifact_publications BEGIN SELECT RAISE(ABORT, 'publication history is retained'); END")
    if op.get_bind().dialect.name == 'postgresql':
        op.execute("CREATE OR REPLACE FUNCTION retain_artifact_publications() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication history is retained'; END $$")
    if op.get_bind().dialect.name == 'postgresql':
        op.execute('CREATE TRIGGER retain_artifact_publications BEFORE DELETE ON artifact_publications FOR EACH ROW EXECUTE FUNCTION retain_artifact_publications()')


def downgrade():
    raise RuntimeError('Rebuild the development database; report version history cannot be downgraded.')
