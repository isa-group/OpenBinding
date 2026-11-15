# 0023. Trigger DDL has one source

- Status: accepted
- Date: 2026-11-14 (F0b, decision D2 of the F0b implementation plan)

## Context

`create_all` (the SQLite test suite) and the migrations (PostgreSQL) used to declare the immutability triggers
separately: 27 against 26, with different messages. A renamed or dropped table silently lost its guard.

## Decision

`openbinding-gateway/src/openbinding_gateway/db/triggers.py` is the only source of trigger DDL: a declarative list
built with `immutable(table)`, `protect(table, columns)` and `retain(table)`. `register_triggers(Base.metadata)` runs
once, explicitly, at the end of `db/models.py` after every model is imported, and raises on a trigger whose table or
column the metadata lacks. `render(dialect)` gives the SQL; the baseline embeds it as frozen literals and never
imports application code. Each PostgreSQL trigger has its own plpgsql function named after it.

## Consequences

- Removing a model means deleting its trigger entries in the same commit, or the import fails.
- The parity test compares the trigger set of a migrated database with `create_all`, so the two cannot drift.
- `protect()` compares JSON columns as `::jsonb` on PostgreSQL (json has no equality operator) and accepts an extra
  `when` condition.

Where: `db/triggers.py`, `tests/test_schema_baseline.py`, `docs/ARCHITECTURE.md` §10.
