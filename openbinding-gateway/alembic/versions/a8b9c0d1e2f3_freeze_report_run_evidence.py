"""Retain terminal run and cell outcomes used by sealed reports."""
from alembic import op

revision = 'a8b9c0d1e2f3'
down_revision = 'f7a8b9c0d1e2'
branch_labels = None
depends_on = None


def upgrade():
    # Once a run is report evidence, its terminal outcome cannot be replaced by a retry.
    for table_name, target, columns in (
        ('study_runs', 'id', ('state', 'summary', 'finished_at')),
        ('study_cells', 'study_run_id', ('state', 'job_id', 'metrics')),
    ):
        exists = f'EXISTS (SELECT 1 FROM artifact_evidence WHERE study_run_id = OLD.{target})'
        sqlite_changed = ' OR '.join(f'OLD.{column} IS NOT NEW.{column}' for column in columns)
        postgres_changed = ' OR '.join(f'OLD.{column}::text IS DISTINCT FROM NEW.{column}::text' for column in columns)
        for dialect, sql in (
            ('sqlite', f"CREATE TRIGGER freeze_evidence_{table_name} BEFORE UPDATE ON {table_name} WHEN {exists} AND ({sqlite_changed}) BEGIN SELECT RAISE(ABORT, 'sealed run evidence is immutable'); END"),
            ('postgresql', f"CREATE OR REPLACE FUNCTION freeze_evidence_{table_name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF {exists} AND ({postgres_changed}) THEN RAISE EXCEPTION 'sealed run evidence is immutable'; END IF; RETURN NEW; END $$"),
            ('postgresql', f"CREATE TRIGGER freeze_evidence_{table_name} BEFORE UPDATE ON {table_name} FOR EACH ROW EXECUTE FUNCTION freeze_evidence_{table_name}()"),
        ):
            if op.get_bind().dialect.name == dialect:
                op.execute(sql)
    for dialect, sql in (
        ('sqlite', "CREATE TRIGGER freeze_evidence_cell_insert BEFORE INSERT ON study_cells WHEN EXISTS (SELECT 1 FROM artifact_evidence WHERE study_run_id = NEW.study_run_id) BEGIN SELECT RAISE(ABORT, 'sealed run evidence is immutable'); END"),
        ('postgresql', "CREATE OR REPLACE FUNCTION freeze_evidence_cell_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM artifact_evidence WHERE study_run_id = NEW.study_run_id) THEN RAISE EXCEPTION 'sealed run evidence is immutable'; END IF; RETURN NEW; END $$"),
        ('postgresql', "CREATE TRIGGER freeze_evidence_cell_insert BEFORE INSERT ON study_cells FOR EACH ROW EXECUTE FUNCTION freeze_evidence_cell_insert()"),
    ):
        if op.get_bind().dialect.name == dialect:
            op.execute(sql)


def downgrade():
    raise RuntimeError('Sealed evidence retention cannot be downgraded; rebuild development data.')
