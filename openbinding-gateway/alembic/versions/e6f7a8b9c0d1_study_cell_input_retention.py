"""Retain the exact cell inputs underlying each historical study matrix."""
from alembic import op

revision = 'e6f7a8b9c0d1'
down_revision = 'd5e6f7a8b9c0'
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == 'sqlite':
        op.execute("CREATE TRIGGER protect_study_cells BEFORE UPDATE ON study_cells WHEN OLD.study_run_id IS NOT NEW.study_run_id OR OLD.ordinal IS NOT NEW.ordinal OR OLD.binding_case_revision_id IS NOT NEW.binding_case_revision_id OR OLD.engine_ref IS NOT NEW.engine_ref OR OLD.parameters IS NOT NEW.parameters OR OLD.seed IS NOT NEW.seed OR OLD.fingerprint IS NOT NEW.fingerprint BEGIN SELECT RAISE(ABORT, 'study cell inputs are immutable'); END")
        op.execute("CREATE TRIGGER retain_study_cells BEFORE DELETE ON study_cells BEGIN SELECT RAISE(ABORT, 'study cell history is retained'); END")
    else:
        op.execute("CREATE OR REPLACE FUNCTION protect_study_cells() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.study_run_id IS DISTINCT FROM NEW.study_run_id OR OLD.ordinal IS DISTINCT FROM NEW.ordinal OR OLD.binding_case_revision_id IS DISTINCT FROM NEW.binding_case_revision_id OR OLD.engine_ref::jsonb IS DISTINCT FROM NEW.engine_ref::jsonb OR OLD.parameters::jsonb IS DISTINCT FROM NEW.parameters::jsonb OR OLD.seed IS DISTINCT FROM NEW.seed OR OLD.fingerprint IS DISTINCT FROM NEW.fingerprint THEN RAISE EXCEPTION 'study cell inputs are immutable'; END IF; RETURN NEW; END $$")
        op.execute("CREATE TRIGGER protect_study_cells BEFORE UPDATE ON study_cells FOR EACH ROW EXECUTE FUNCTION protect_study_cells()")
        op.execute("CREATE OR REPLACE FUNCTION retain_study_cells() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'study cell history is retained'; END $$")
        op.execute("CREATE TRIGGER retain_study_cells BEFORE DELETE ON study_cells FOR EACH ROW EXECUTE FUNCTION retain_study_cells()")


def downgrade():
    raise RuntimeError('Rebuild the development database; historical cell protection cannot be removed.')
