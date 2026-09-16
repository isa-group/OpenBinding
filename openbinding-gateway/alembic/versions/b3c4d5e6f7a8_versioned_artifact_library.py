"""Organization artifact identities, releases, drafts and protected references."""
from alembic import op
import sqlalchemy as sa

revision = 'b3c4d5e6f7a8'
down_revision = 'a2b3c4d5e6f7'
branch_labels = None
depends_on = None


def ident(name='id'):
    return sa.Column(name, sa.Uuid(), primary_key=True)


def fk(name, target, *, nullable=False, primary_key=False, ondelete='RESTRICT'):
    return sa.Column(name, sa.Uuid(), sa.ForeignKey(target, ondelete=ondelete), nullable=nullable, primary_key=primary_key)


def created():
    return sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


def upgrade():
    with op.batch_alter_table('v1_instance_snapshots') as batch:
        batch.add_column(sa.Column('compilation_digest', sa.String(80), nullable=False, server_default=''))
        batch.drop_constraint('uq_v1_snapshot_owner_package', type_='unique')
        batch.create_unique_constraint('uq_v1_snapshot_owner_package', ['owner_id', 'package_digest', 'compilation_digest'])
    op.rename_table('artifacts', 'blobs')
    inspector = sa.inspect(op.get_bind())
    for index in inspector.get_indexes('blobs'):
        if index['name'].startswith('ix_artifacts_'):
            op.drop_index(index['name'], table_name='blobs')
            op.create_index(index['name'].replace('ix_artifacts_', 'ix_blobs_', 1), 'blobs', index['column_names'], unique=index['unique'])
    if op.get_bind().dialect.name == 'postgresql':
        op.execute('ALTER TABLE blobs RENAME CONSTRAINT pk_artifacts TO pk_blobs')
    foreign_keys = inspector.get_foreign_keys('blobs')
    with op.batch_alter_table('blobs') as batch:
        batch.alter_column('project_id', existing_type=sa.Uuid(), nullable=True)
        for constraint in foreign_keys:
            if constraint['constrained_columns'] in (['project_id'], ['organization_id']):
                batch.drop_constraint(constraint['name'], type_='foreignkey')
                column = constraint['constrained_columns'][0]
                batch.create_foreign_key(f"fk_blobs_{column}_{constraint['referred_table']}", constraint['referred_table'], [column], ['id'], ondelete='RESTRICT')
    op.create_table('artifacts', ident(), fk('organization_id', 'organizations.id'),
        sa.Column('namespace', sa.String(128), nullable=False), sa.Column('name', sa.String(128), nullable=False),
        sa.Column('display_name', sa.String(160), nullable=False), sa.Column('kind', sa.String(128), nullable=False),
        sa.Column('description', sa.String(4000), nullable=False), sa.Column('labels', sa.JSON(), nullable=False),
        sa.Column('archived', sa.Boolean(), nullable=False), fk('created_by_id', 'users.id'), created(),
        sa.UniqueConstraint('namespace', 'name', name='uq_artifact_identity'))
    op.create_table('artifact_versions', ident(), fk('artifact_id', 'artifacts.id'),
        sa.Column('ordinal', sa.Integer(), nullable=False), sa.Column('version', sa.String(64), nullable=False),
        fk('blob_id', 'blobs.id'), sa.Column('content_digest', sa.String(80), nullable=False),
        sa.Column('version_digest', sa.String(80), nullable=False, unique=True), sa.Column('manifest', sa.JSON(), nullable=False),
        fk('based_on_id', 'artifact_versions.id', nullable=True), fk('created_by_id', 'users.id'), created(),
        sa.UniqueConstraint('artifact_id', 'version', name='uq_artifact_version'),
        sa.UniqueConstraint('artifact_id', 'ordinal', name='uq_artifact_ordinal'),
        sa.CheckConstraint('ordinal > 0', name='artifact_ordinal_positive'))
    op.create_table('artifact_drafts', ident(), fk('artifact_id', 'artifacts.id', ondelete='CASCADE'),
        sa.Column('revision', sa.Integer(), nullable=False), sa.Column('payload', sa.JSON(), nullable=False),
        fk('based_on_id', 'artifact_versions.id', nullable=True), fk('sealed_version_id', 'artifact_versions.id', nullable=True),
        fk('created_by_id', 'users.id'), sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint('revision > 0', name='artifact_draft_revision_positive'))
    op.create_table('artifact_dependencies', fk('version_id', 'artifact_versions.id', primary_key=True),
        fk('dependency_id', 'artifact_versions.id', primary_key=True),
        sa.CheckConstraint('version_id != dependency_id', name='artifact_no_self_dependency'))
    op.create_table('project_artifacts', fk('project_id', 'projects.id', primary_key=True, ondelete='CASCADE'),
        fk('artifact_id', 'artifacts.id', primary_key=True))
    op.create_table('artifact_publications', fk('version_id', 'artifact_versions.id', primary_key=True),
        sa.Column('withdrawn', sa.Boolean(), nullable=False), sa.Column('citation', sa.JSON(), nullable=False),
        fk('published_by_id', 'users.id'), sa.Column('published_at', sa.DateTime(timezone=True), nullable=False))
    op.create_table('case_artifacts', fk('revision_id', 'binding_case_revisions.id', primary_key=True),
        sa.Column('alias', sa.String(128), primary_key=True), sa.Column('role', sa.String(128), nullable=False),
        fk('version_id', 'artifact_versions.id'), sa.Column('bindings', sa.JSON(), nullable=False))
    for table, columns in {'artifacts': ['organization_id', 'kind'], 'artifact_versions': ['artifact_id', 'content_digest'],
                           'artifact_drafts': ['artifact_id'], 'case_artifacts': ['version_id']}.items():
        for column in columns:
            op.create_index(f'ix_{table}_{column}', table, [column])
    for table in ('artifact_versions', 'artifact_dependencies', 'case_artifacts', 'binding_case_revisions'):
        if op.get_bind().dialect.name == 'postgresql':
            op.execute(f"CREATE OR REPLACE FUNCTION reject_{table}_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sealed artifact data is immutable'; END $$")
        for operation in ('UPDATE', 'DELETE'):
            if op.get_bind().dialect.name == 'sqlite':
                op.execute(f"CREATE TRIGGER immutable_{table}_{operation.lower()} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT, 'sealed artifact data is immutable'); END")
            else:
                op.execute(f"CREATE TRIGGER immutable_{table}_{operation.lower()} BEFORE {operation} ON {table} FOR EACH ROW EXECUTE FUNCTION reject_{table}_change()")

    for table, condition in (
        ('artifacts', 'OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.namespace IS DISTINCT FROM NEW.namespace OR OLD.name IS DISTINCT FROM NEW.name OR OLD.kind IS DISTINCT FROM NEW.kind'),
        ('artifact_drafts', 'OLD.sealed_version_id IS NOT NULL'),
    ):
        if op.get_bind().dialect.name == 'sqlite':
            condition = condition.replace('IS DISTINCT FROM', 'IS NOT')
            op.execute(f"CREATE TRIGGER protect_{table} BEFORE UPDATE ON {table} WHEN {condition} BEGIN SELECT RAISE(ABORT, 'artifact identity or sealed draft is immutable'); END")
        else:
            op.execute(f"CREATE OR REPLACE FUNCTION protect_{table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF {condition} THEN RAISE EXCEPTION 'artifact identity or sealed draft is immutable'; END IF; RETURN NEW; END $$")
            op.execute(f"CREATE TRIGGER protect_{table} BEFORE UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION protect_{table}()")


def downgrade():
    # This development cutover deliberately has no lossy reverse data conversion.
    raise RuntimeError('Restore the pre-cutover development database instead of discarding sealed artifact history.')
