"""Every database trigger the gateway relies on, declared once for both dialects.

The triggers are the guards that hold for every SQL writer, maintenance scripts
included: sealed rows that cannot change, history that cannot be deleted, and
columns that are fixed once written. They used to be written twice, as
``after_create`` listeners for ``create_all`` (SQLite tests) and again in the
migrations (PostgreSQL), and the two drifted apart. Now ``TRIGGERS`` is the only
source:

* ``register_triggers(Base.metadata)`` is called once, at the end of
  ``db/models.py``, after every model module is imported. It attaches the DDL to
  ``create_all`` and raises on a trigger whose table or column is not in the
  metadata, so a renamed or dropped table fails loudly instead of silently
  losing its guard. Removing a model means deleting its entries here.
* ``render(dialect)`` returns the statements in order; ``tools/rebaseline.py``
  freezes them as literal strings in the Alembic baseline, which never imports
  this module. ``tests/test_schema_baseline.py`` checks that both agree.

Three builders cover every guard:

* ``immutable(table)``: rows are sealed; UPDATE and DELETE are rejected.
* ``protect(table, columns)``: UPDATE is rejected when one of ``columns``
  changes (or when the extra ``when`` condition holds).
* ``retain(table)``: DELETE is rejected; the rows are history.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import DDL, MetaData, event

__all__ = ["TRIGGERS", "Trigger", "function_names", "immutable", "protect", "register_triggers", "render", "retain"]


@dataclass(frozen=True)
class Trigger:
    """One trigger, as SQLite DDL and as a PostgreSQL function plus the trigger that calls it."""

    name: str
    table: str
    sqlite_sql: str
    pg_function_sql: str
    pg_trigger_sql: str
    #: The columns the trigger reads, checked against the metadata by ``register_triggers``.
    columns: tuple[str, ...] = field(default=())


def _trigger(name: str, table: str, operation: str, message: str,
             sqlite_when: str | None = None, pg_when: str | None = None, columns: tuple[str, ...] = ()) -> Trigger:
    if "'" in message:
        raise ValueError(f"trigger {name}: the message must not contain a quote")
    sqlite_condition = f" WHEN {sqlite_when}" if sqlite_when else ""
    sqlite_sql = (
        f"CREATE TRIGGER {name} BEFORE {operation} ON {table}{sqlite_condition} "
        f"BEGIN SELECT RAISE(ABORT, '{message}'); END"
    )
    keep = "OLD" if operation == "DELETE" else "NEW"
    body = (
        f"IF {pg_when} THEN RAISE EXCEPTION '{message}'; END IF; RETURN {keep};"
        if pg_when else f"RAISE EXCEPTION '{message}';"
    )
    pg_function_sql = f"CREATE OR REPLACE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN {body} END $$"
    pg_trigger_sql = f"CREATE TRIGGER {name} BEFORE {operation} ON {table} FOR EACH ROW EXECUTE FUNCTION {name}()"
    return Trigger(name, table, sqlite_sql, pg_function_sql, pg_trigger_sql, columns)


def immutable(table: str, *, message: str | None = None) -> tuple[Trigger, Trigger]:
    """Sealed rows: any UPDATE and any DELETE of ``table`` is rejected."""
    message = message or f"{table} rows are sealed and immutable"
    return (
        _trigger(f"immutable_{table}_update", table, "UPDATE", message),
        _trigger(f"immutable_{table}_delete", table, "DELETE", message),
    )


def protect(table: str, columns: tuple[str, ...] = (), *, json_columns: tuple[str, ...] = (),
            when: tuple[str, str] | None = None, name: str | None = None, message: str | None = None) -> Trigger:
    """An UPDATE of ``table`` that changes one of ``columns`` (or for which ``when`` holds) is rejected.

    ``json_columns`` (a subset of ``columns``) are compared as ``jsonb`` on PostgreSQL, which has no
    equality for ``json``. ``when`` is an extra ``(sqlite, postgresql)`` condition, OR-ed with the rest.
    """
    if not set(json_columns) <= set(columns):
        raise ValueError(f"protect({table}): json_columns must be among columns")
    if not columns and when is None:
        raise ValueError(f"protect({table}): nothing to protect")
    sqlite_terms = [f"OLD.{column} IS NOT NEW.{column}" for column in columns]
    pg_terms = [
        f"OLD.{column}::jsonb IS DISTINCT FROM NEW.{column}::jsonb" if column in json_columns
        else f"OLD.{column} IS DISTINCT FROM NEW.{column}"
        for column in columns
    ]
    if when is not None:
        sqlite_terms.append(f"({when[0]})")
        pg_terms.append(f"({when[1]})")
    return _trigger(
        name or f"protect_{table}", table, "UPDATE", message or f"the protected columns of {table} are immutable",
        " OR ".join(sqlite_terms), " OR ".join(pg_terms), columns,
    )


def retain(table: str, *, message: str | None = None) -> Trigger:
    """History: any DELETE of ``table`` is rejected."""
    return _trigger(f"retain_{table}", table, "DELETE", message or f"{table} history is retained")


TRIGGERS: tuple[Trigger, ...] = (
    *immutable("artifact_versions"),
    *immutable("artifact_dependencies"),
    *immutable("case_artifacts"),
    *immutable("binding_case_revisions"),
    *immutable("artifact_case_references"),
    protect("artifacts", ("organization_id", "namespace", "name", "kind")),
    protect("artifact_drafts", when=("OLD.sealed_version_id IS NOT NULL", "OLD.sealed_version_id IS NOT NULL"),
            message="a sealed draft is immutable"),
    protect("artifact_publications", ("version_id", "citation", "published_by_id", "published_at"),
            json_columns=("citation",),
            when=("OLD.withdrawn = 1 AND NEW.withdrawn = 0", "OLD.withdrawn AND NOT NEW.withdrawn"),
            message="a publication is immutable and a withdrawal is final"),
    retain("artifact_publications"),
    protect("study_runs", ("definition_version_id", "study_id", "run_number", "matrix_digest")),
    retain("study_runs"),
    protect("study_cells",
            ("study_run_id", "ordinal", "binding_case_revision_id", "engine_ref", "parameters", "seed", "fingerprint"),
            json_columns=("engine_ref", "parameters")),
    retain("study_cells"),
    protect("jobs", ("configuration_version_id",), name="pin_job_configuration", message="job configuration is immutable"),
)

_REGISTERED = "openbinding_triggers_registered"


def _check(metadata: MetaData, triggers: tuple[Trigger, ...]) -> None:
    names = [trigger.name for trigger in triggers]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise ValueError(f"duplicate trigger names: {duplicates}")
    for trigger in triggers:
        table = metadata.tables.get(trigger.table)
        if table is None:
            raise ValueError(
                f"trigger {trigger.name} guards table {trigger.table!r}, which is not in the metadata: "
                "delete the trigger with its model, or fix the table name"
            )
        missing = [column for column in trigger.columns if column not in table.c]
        if missing:
            raise ValueError(f"trigger {trigger.name} reads columns {missing} that {trigger.table} does not have")


def register_triggers(metadata: MetaData, triggers: tuple[Trigger, ...] = TRIGGERS) -> None:
    """Attach every trigger to ``create_all`` of its table; raise on a table or column the metadata lacks."""
    _check(metadata, triggers)
    if metadata.info.get(_REGISTERED):
        return
    for trigger in triggers:
        table = metadata.tables[trigger.table]
        event.listen(table, "after_create", DDL(trigger.sqlite_sql).execute_if(dialect="sqlite"))
        event.listen(table, "after_create", DDL(trigger.pg_function_sql).execute_if(dialect="postgresql"))
        event.listen(table, "after_create", DDL(trigger.pg_trigger_sql).execute_if(dialect="postgresql"))
    metadata.info[_REGISTERED] = True


def render(dialect: str, triggers: tuple[Trigger, ...] = TRIGGERS) -> list[str]:
    """The statements that create every trigger on ``dialect`` (``sqlite`` or ``postgresql``), in order."""
    if dialect == "sqlite":
        return [trigger.sqlite_sql for trigger in triggers]
    if dialect == "postgresql":
        return [sql for trigger in triggers for sql in (trigger.pg_function_sql, trigger.pg_trigger_sql)]
    raise ValueError(f"no trigger DDL for dialect {dialect!r}")


def function_names(triggers: tuple[Trigger, ...] = TRIGGERS) -> list[str]:
    """The PostgreSQL functions behind the triggers (one per trigger, named after it)."""
    return [trigger.name for trigger in triggers]
