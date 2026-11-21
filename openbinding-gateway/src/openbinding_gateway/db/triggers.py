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

Four builders cover every guard:

* ``immutable(table)``: rows are sealed; UPDATE and DELETE are rejected.
* ``immutable(table, delete=False)``: UPDATE is rejected; DELETE is left to the
  foreign keys that history holds (``RESTRICT``), D3.
* ``protect(table, columns)``: UPDATE is rejected when one of ``columns``
  changes (or when the extra ``when`` condition holds).
* ``retain(table)``: DELETE is rejected; the rows are history.
* ``state_machine(table, column, transitions, set_once=...)``: an UPDATE must keep ``column`` or move it along
  ``transitions``, and each ``set_once`` column group may change only on the moves named for it (F6's upstream
  events and proposals).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import DDL, MetaData, event

__all__ = [
    "TRIGGERS", "Trigger", "function_names", "immutable", "protect", "register_triggers", "render", "retain", "retain_when",
    "state_machine",
]


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


def immutable(table: str, *, delete: bool = True, message: str | None = None) -> tuple[Trigger, ...]:
    """Sealed rows: any UPDATE of ``table`` is rejected, and any DELETE unless ``delete`` is false.

    ``delete=False`` is for rows whose deletion history governs instead (D3): a problem revision or a
    compilation that no run or study cell references may go, and the ``RESTRICT`` foreign keys of
    ``jobs`` and ``study_cells`` keep the ones that were used.
    """
    message = message or f"{table} rows are sealed and immutable"
    update = _trigger(f"immutable_{table}_update", table, "UPDATE", message)
    if not delete:
        return (update,)
    return (update, _trigger(f"immutable_{table}_delete", table, "DELETE", message))


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


def retain_when(table: str, when: tuple[str, str], columns: tuple[str, ...], *, name: str, message: str) -> Trigger:
    """A DELETE of ``table`` is rejected when ``when`` (``(sqlite, postgresql)``, over ``OLD``) holds."""
    return _trigger(name, table, "DELETE", message, when[0], when[1], columns)


def state_machine(
    table: str,
    column: str,
    transitions: dict[str, tuple[str, ...]],
    *,
    set_once: tuple[tuple[tuple[str, ...], tuple[tuple[str, str], ...]], ...] = (),
    json_columns: tuple[str, ...] = (),
    name: str | None = None,
    message: str | None = None,
) -> Trigger:
    """An UPDATE of ``table`` is rejected unless ``column`` stays or moves along ``transitions`` (``{old: news}``;
    a state with no entry is terminal), and unless each group of ``set_once`` columns changes only on one of the
    ``(old, new)`` moves named for it. ``json_columns`` among them are compared as ``jsonb`` on PostgreSQL."""
    for state, targets in transitions.items():
        for value in (state, *targets):
            if "'" in value:
                raise ValueError(f"state_machine({table}): a state must not contain a quote")

    def moves(pairs: tuple[tuple[str, str], ...]) -> str:
        if not pairs:
            return "FALSE"
        return " OR ".join(f"(OLD.{column} = '{old}' AND NEW.{column} = '{new}')" for old, new in pairs)

    allowed = tuple((old, new) for old, targets in transitions.items() for new in targets)
    sqlite_terms = [f"(OLD.{column} IS NOT NEW.{column} AND NOT ({moves(allowed)}))"]
    pg_terms = [f"(OLD.{column} IS DISTINCT FROM NEW.{column} AND NOT ({moves(allowed)}))"]
    columns = [column]
    for group, pairs in set_once:
        columns.extend(group)
        sqlite_changed = " OR ".join(f"OLD.{c} IS NOT NEW.{c}" for c in group)
        pg_changed = " OR ".join(
            f"OLD.{c}::jsonb IS DISTINCT FROM NEW.{c}::jsonb" if c in json_columns else f"OLD.{c} IS DISTINCT FROM NEW.{c}"
            for c in group
        )
        sqlite_terms.append(f"(({sqlite_changed}) AND NOT ({moves(pairs)}))")
        pg_terms.append(f"(({pg_changed}) AND NOT ({moves(pairs)}))")
    # SQLite has no FALSE keyword before 3.23; 0 means the same there.
    sqlite_when = " OR ".join(sqlite_terms).replace("(FALSE)", "(0)")
    return _trigger(
        name or f"state_{table}", table, "UPDATE", message or f"{table}: that change of {column} is not allowed",
        sqlite_when, " OR ".join(pg_terms), tuple(columns),
    )


#: The columns of an upstream event that never change (state, note and the stamps are the state machine's).
_UPSTREAM_EVENT_FIXED = (
    "id", "organization_id", "composition_id", "version_id", "watch_id", "subject", "tasks", "category", "reasons",
    "notify", "old_ref", "new_ref", "old_version_id", "new_version_id", "old_label", "new_label", "old_snapshot_id",
    "new_snapshot_id", "diff", "classifier", "detected_at",
)

#: The columns of a proposal that never change (its status, the supersession and the stamps move).
_PROPOSAL_FIXED = (
    "id", "organization_id", "composition_id", "origin", "scope_key", "proposed_by_id", "summary", "warnings",
    "confirmation_phrase", "upstream_event_id", "created_at",
)

#: Joins a study (``s``) to its organization when that is the personal organization of a deleted account.
_DELETED_PERSONAL = (
    "JOIN organizations o ON o.id = s.organization_id JOIN users u ON u.id = o.personal_owner_id "
    "AND u.deleted_at IS NOT NULL"
)

TRIGGERS: tuple[Trigger, ...] = (
    *immutable("binding_case_revisions", delete=False),
    *immutable("problem_compilations", delete=False),
    # A revision's value origins never change; they go with their revision (ON DELETE CASCADE).
    *immutable("problem_value_origins", delete=False, message="problem value origins are immutable"),
    *immutable("composition_versions", delete=False),
    *immutable("composition_evaluations", delete=False),
    *immutable("composition_derivations", delete=False),
    protect("study_runs", ("study_id", "run_number", "matrix_digest", "definition", "definition_digest"),
            json_columns=("definition",)),
    # History, but for the one exception (F5-D, SPHERE's rule): a deleted account's personal organization goes whole,
    # its study runs and cells too. The account is pseudonymised (``deleted_at``) before its organization is deleted.
    retain_when(
        "study_runs",
        (f"NOT EXISTS (SELECT 1 FROM studies s {_DELETED_PERSONAL} WHERE s.id = OLD.study_id)",) * 2,
        ("study_id",),
        name="retain_study_runs",
        message="study_runs history is retained",
    ),
    protect("study_cells",
            ("study_run_id", "ordinal", "binding_case_revision_id", "compilation_id", "engine_ref", "parameters",
             "seed", "fingerprint"),
            json_columns=("engine_ref", "parameters")),
    retain_when(
        "study_cells",
        ("NOT EXISTS (SELECT 1 FROM study_runs r JOIN studies s ON s.id = r.study_id "
         f"{_DELETED_PERSONAL} WHERE r.id = OLD.study_run_id)",) * 2,
        ("study_run_id",),
        name="retain_study_cells",
        message="study_cells history is retained",
    ),
    # Pricing snapshots are insert-only; public and registry rows are shared by every organization and are
    # never deleted, an organization's own rows go with it (routes/organizations._delete_subtree).
    *immutable("pricing_snapshots", delete=False, message="pricing snapshots are immutable"),
    retain_when(
        "pricing_snapshots",
        ("OLD.scope_key = 'public' OR substr(OLD.scope_key, 1, 9) = 'registry:'",
         "OLD.scope_key = 'public' OR substr(OLD.scope_key, 1, 9) = 'registry:'"),
        ("scope_key",),
        name="retain_pricing_snapshots_shared",
        message="shared pricing snapshots are retained",
    ),
    # A composition environment keeps what names it (its feed's address); an adoption is history, deleted only
    # with its environment or organization; a feed key keeps its secret and owner, and a revoked one stays so.
    protect("composition_environments", ("organization_id", "composition_id", "slug", "created_by_id", "created_at")),
    *immutable("composition_adoptions", delete=False, message="composition adoptions are history and immutable"),
    protect("composition_environment_keys", ("environment_id", "prefix", "secret_hash", "created_by_id", "created_at")),
    protect(
        "composition_environment_keys",
        when=(
            "OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at"
            " OR NEW.revoked_by_id IS NOT OLD.revoked_by_id)",
            "OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at"
            " OR NEW.revoked_by_id IS DISTINCT FROM OLD.revoked_by_id)",
        ),
        name="revoked_composition_environment_keys",
        message="a revoked feed key stays revoked",
    ),
    # A connection is replaced or deleted, never moved to another organization or kind.
    protect("org_connections", ("organization_id", "kind")),
    # F6: a watch never changes what it watches (its schedule moves freely); a watch reference is insert-only; an
    # upstream event changes only its state, its review (once, open -> reviewed) and its resolution (once).
    protect("pricing_watches", ("source_kind", "registry", "pricing_id", "url", "url_key", "scope_key",
                                "organization_id", "watch_key", "created_at")),
    *immutable("pricing_watch_refs", delete=False, message="pricing watch references are immutable"),
    protect("composition_upstream_events", _UPSTREAM_EVENT_FIXED, json_columns=("tasks", "reasons", "diff"),
            message="an upstream event is immutable but for its state, review and resolution"),
    state_machine(
        "composition_upstream_events", "state",
        {"open": ("reviewed", "resolved"), "reviewed": ("resolved",)},
        set_once=(
            (("note", "reviewed_by_id", "reviewed_at"), (("open", "reviewed"),)),
            (("resolved_by_version_id", "resolved_by_id", "resolved_at"), (("open", "resolved"), ("reviewed", "resolved"))),
        ),
        message="an upstream event moves forward only, is reviewed once and resolved once",
    ),
    # F6: a proposal never changes what it proposes (its steps, bases and preview included); only its status moves,
    # forward, with the stamps of each move, and a step's outcome is written once.
    protect("proposals", _PROPOSAL_FIXED, json_columns=("warnings",),
            message="a proposal is immutable but for its status and stamps"),
    state_machine(
        "proposals", "status",
        {"pending": ("executing", "cancelled", "superseded", "stale"), "executing": ("completed", "partial", "failed")},
        set_once=(
            (("superseded_by_id",), (("pending", "superseded"),)),
            (("confirmed_at",), (("pending", "executing"),)),
            (("completed_at",), (("executing", "completed"), ("executing", "partial"), ("executing", "failed"))),
        ),
        message="a proposal moves forward only",
    ),
    protect("proposal_steps", ("id", "proposal_id", "ordinal", "kind", "description", "params", "base", "preview",
                               "depends_on", "destructive"),
            json_columns=("params", "base", "depends_on"), message="a proposal step is immutable but for its outcome"),
    state_machine(
        "proposal_steps", "status",
        {"pending": ("done", "failed", "skipped")},
        set_once=((("result", "error", "finished_at"),
                   (("pending", "done"), ("pending", "failed"), ("pending", "skipped"))),),
        json_columns=("result", "error"),
        message="a proposal step ends once",
    ),
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
