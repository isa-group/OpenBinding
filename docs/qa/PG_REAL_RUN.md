# PostgreSQL 16 run of the phase-17 tests (`federatedEngines`, duplicate copies, error-event purge)

The phase-17 tests of these two areas ran on SQLite only. This document says which they are, which PostgreSQL tests
now cover the same rules with real sessions, and the exact command the controller runs with `compose.pgtest.json`.

**Status: written, not executed.** The worktree where this was written has no Docker and no PostgreSQL. There the new
modules are collected and **skipped** (`TEST_DATABASE_URL` is unset), so nothing below has passed or failed on a real
server yet. Expectations are in [What to expect](#what-to-expect); the assumptions the tests make about PostgreSQL are in
[Not verified](#not-verified).

## The command

Same sequence as `PG_HARNESS.md` (`lab_compose`, `file=compose.pgtest.json`: `up`, then `seed`, then `down`). The only
difference is the value of `DEMO_PYTEST_ARGS` given to `seed`:

```text
DEMO_PYTEST_ARGS='-rsfExX --tb=short tests/concurrency tests/test_federated_engines_pg.py tests/test_duplicate_copy_purge_pg.py'
```

- Paths are relative to `/app` (the `test` stage of the image copies `tests/`). Do **not** add `tests` or
  `tests/test_pg_harness.py`: the container has no checkout, so the compose-shape tests fail there by design.
- `-rsfExX` prints the reason of every skip (`s`), failure (`f`), error (`E`), expected failure (`x`) and unexpected pass
  (`X`). Any `SKIPPED` line is a defect: the only legitimate reason is a missing `TEST_DATABASE_URL`, and it is set.
- Each `lab_compose` operation has a 420 s limit. The existing `tests/concurrency` took 12 s for 58 tests; the new
  modules are expected to take a similar order of magnitude (several tests wait for a lock on purpose, never more than
  the 20 s of `_pg_support.WAIT_SECONDS`, and every test is cut at 60 s by the watchdog). If a run does not fit, split it
  in two `seed` runs: `tests/concurrency`, then the two new files.
- `OPENBINDING_PG_TEST_TIMEOUT` (seconds) changes the per-test limit, as for `tests/concurrency`.

## What these tests are, and where the originals are

Found by reading the repository (the worktree has no shell, so `git log` was not run): the phase-17 tests are

| Area | Tests that ran on SQLite only |
| --- | --- |
| `federatedEngines` (the plan's numeric limit of active registrations per owner) | `tests/test_federated_engines_limit.py`: the service refuses past the limit (402 `quota_exceeded`, nothing verified), a deactivated registration frees its place, activating what is active is not a second place, no limit / another owner / a limit of zero, other actions are not held to the limit, and the route (`/v1/engine-registrations/{name}/activate`) |
| Purge of old error events | `tests/test_error_event_purge.py`: the reconciler purges at most once an hour (against doubles of the session and of `purge_old_error_events`) |
| Purge of the duplicate copy of a package | `tests/test_ir_cutover.py`: `recompile_stale_snapshots` removes the copy of the same owner and package that nothing points at, and keeps (as `snapshot_conflict`) one that a job uses |

The SQLite files keep running in the ordinary suite. The PostgreSQL modules below add what SQLite cannot show: row locks,
unique-index waits, several connections, real foreign keys and triggers.

## Harness changes (SQLite mode untouched)

- `tests/_pg_support.py`: `PgDatabase` (engine, session factory, `backend_pid`, `wait_until_blocked`), `database()`
  (Alembic `upgrade head`, truncate; skips only when `TEST_DATABASE_URL` is unset, fails if it is not a PostgreSQL `test*`
  database), `settle` (run at once, never hang) and `http_client` (the application with one session per request).
- `tests/conftest.py`: the `pg` fixture, and an autouse `_pg_test_watchdog` that applies the 60 s limit of
  `tests/concurrency` to the `tests/test_*_pg.py` modules only. `db_session` and every other fixture are unchanged; nothing
  else in the suite sees the new code.
- `tests/test_pg_harness.py`: pins that the new modules skip only through the shared fixture (no `skip`, `skipif`,
  `importorskip` or `xfail()` calls in them; every test takes `pg`), that this document gives the command as
  `DEMO_PYTEST_ARGS='...'` with existing paths and without `tests/test_pg_harness.py`, and that every test name below is
  listed here.
- Each test builds its own users and starts from truncated tables, so no test depends on another or on their order.

## The new tests

### `tests/test_federated_engines_pg.py` (20 cases, 2 of them `xfail`)

| Rule | Test |
| --- | --- |
| Race: two sessions, one place | `test_two_sessions_activating_at_once_never_exceed_the_limit` |
| Race: the second waits (observed in `pg_stat_activity`) and then counts the first's commit | `test_the_second_activation_is_seen_waiting_for_the_first_commit_and_then_counts_it` |
| Race: six sessions, two places | `test_six_sessions_competing_for_two_places_are_given_exactly_two` |
| Race: an uncommitted deactivation frees nothing | `test_a_deactivation_that_has_not_committed_frees_no_place_until_it_does` |
| Owners: no shared quota, no waiting for another owner's open transaction | `test_owners_neither_wait_for_each_other_nor_share_a_quota` |
| Idempotency: activating what is active (sequential) | `test_activating_what_is_active_is_not_a_second_place_across_sessions` |
| Idempotency: two concurrent replays, invariants | `test_two_concurrent_replays_of_one_activation_leave_one_active_registration` |
| Idempotency: two concurrent replays, desired answer (`xfail`) | `test_both_callers_of_a_replayed_activation_are_answered_with_the_active_registration` |
| Deduplication: same document twice | `test_the_same_document_registered_twice_is_one_registration` |
| Deduplication: same document at once, blocked by the unique index | `test_two_sessions_registering_the_same_document_at_once_leave_one_registration` |
| Deduplication: same document at once, desired answer (`xfail`) | `test_the_loser_of_a_concurrent_registration_of_the_same_document_gets_the_registration` |
| Other owner, same name and version: separate, no leak, same 404 as an absent key | `test_the_same_name_and_version_of_another_owner_is_another_registration_and_leaks_nothing` |
| Auth: a stranger cannot activate, deactivate or request publication (3 cases) | `test_another_owner_cannot_change_my_registration_and_is_told_it_is_not_there` |
| Roles: only an administrator reviews, and only what is pending | `test_only_an_administrator_reviews_and_only_what_is_pending` |
| Rollback: an activation rolled back uses no place | `test_an_activation_that_is_rolled_back_uses_no_place` |
| Rollback: a failed verification leaves it pending and the place free | `test_a_deployment_that_fails_to_verify_leaves_the_registration_pending_and_the_place_free` |
| Rollback: a registration rolled back leaves no row | `test_a_registration_that_is_rolled_back_leaves_no_row_and_can_be_made_again` |
| Route, two users: 402 with the quota, own quota per owner, 404 for a stranger, 401/403 without a token, a bigger plan | `test_over_http_the_limit_is_per_owner_and_a_refusal_changes_nothing` |

### `tests/test_duplicate_copy_purge_pg.py` (16 tests)

| Rule | Test |
| --- | --- |
| Copy removed with its resources and IR; snapshot regenerated; sealed revision unchanged | `test_an_unused_copy_is_removed_with_its_resources_and_ir_and_the_snapshot_is_regenerated` |
| Copy used by a job kept, `snapshot_conflict` | `test_a_copy_that_a_job_uses_is_kept_and_reported_as_a_conflict` |
| Owners: only the same owner's copy; another owner's snapshot untouched | `test_the_copy_is_the_same_owners_and_another_owners_snapshot_of_the_package_is_untouched` |
| Idempotency: second recompilation changes nothing | `test_a_second_recompilation_changes_nothing` |
| Rollback: recompilation rolled back | `test_a_recompilation_that_is_rolled_back_leaves_the_copy_and_the_stale_snapshot_as_they_were` |
| Rollback: transaction that fails after recompiling | `test_a_transaction_that_fails_after_recompiling_leaves_every_row_it_would_have_removed` |
| Race: two replicas regenerate the same snapshot (second seen waiting) | `test_two_replicas_regenerating_the_same_snapshot_end_in_one_consistent_snapshot` |
| Deduplication: two uploads of one package at once are one snapshot | `test_two_uploads_of_the_same_package_at_once_are_one_snapshot` |
| Owners: another owner's upload is another snapshot nobody else reaches | `test_the_same_package_uploaded_by_another_owner_is_another_snapshot_that_nobody_else_reaches` |
| Purge by age only, every organization alike | `test_the_purge_is_by_age_only_and_treats_every_organization_alike` |
| Purge idempotent | `test_purging_again_removes_nothing_more` |
| Purge rolled back or failed | `test_a_purge_that_is_rolled_back_or_fails_removes_nothing` |
| Race: two purges delete each event once, the second waits | `test_two_purges_of_the_same_events_delete_each_event_once_and_the_second_waits` |
| A purge does not stop new events | `test_a_purge_does_not_stop_new_events_from_being_recorded` |
| Reconciler cycle on the real database, once an hour | `test_the_reconciler_purges_once_an_hour_on_the_real_database` |
| Cycle lock: the replica without it purges nothing | `test_the_replica_without_the_cycle_lock_purges_nothing` |

## What to expect

- Exit code 0; **0 skipped**; 34 passed and up to 2 `xfail` for the two `xfail` tests above (they report `X` if the
  service already answers the replay, which is not a failure either: `strict=False`), i.e. 34 + 2 for the two new modules
  on top of whatever `tests/concurrency` has at that SHA (70 passed at `bef53047`; it has grown since, so no total is
  claimed here).
- A failure of one of the other tests is a finding about the service or about an assumption listed below, not noise:
  read the message, which names what did not happen.

## Findings the `xfail` tests state (not fixed here)

Both are in `services/engine_registry.py`, which this task does not own. They follow from reading the code and are what the
two `xfail` tests will confirm or refute on PostgreSQL.

1. **Replayed activation.** `change_registration(action="activate", max_active=N)` reads the registration, then takes the
   owner's row lock, then counts the owner's active registrations. Two concurrent requests for the *same* inactive
   registration both pass the first read; the loser, after waiting for the lock, counts the winner's activation — which is
   that same registration — and is told `402 quota_exceeded` for what should be an idempotent replay (it answers 402 only
   when `limit` is 1; with more room both succeed). Suggested fix: after taking the lock, refresh the row (`session.refresh`)
   and return the summary if it is active already.
2. **Concurrent identical registration.** `register_engine` checks for an existing row, then inserts inside a savepoint; the
   loser of two concurrent identical registrations hits the unique index and is answered
   `409 immutable_registration`, although the document is identical. Suggested fix: on `IntegrityError`, read the row again
   and return its summary when the digest matches.

The tests beside them (`..._leave_one_active_registration`, `..._leave_one_registration`) pin what must hold either way:
exactly one row, no 500, no second place.

## Not verified

Everything on PostgreSQL. Assumptions the tests make, each to be confirmed by the first real run:

- A statement blocked by another transaction's row lock or unique-index entry shows `wait_event_type = 'Lock'` in
  `pg_stat_activity`, visible to the test's role (the database user of `compose.pgtest.json` is the superuser of the
  ephemeral server). This is how `wait_until_blocked` sees that a session really waits.
- Under `READ COMMITTED` the session that waited for `SELECT ... FOR UPDATE` counts, in its next statement, the rows the
  first session committed.
- `DELETE` of rows that another transaction has already deleted removes 0 rows without an error (SQLAlchemy at most warns for
  the ORM delete of the copy in the two-replica test, whose assertion accepts a `database_error` for the loser but no
  corruption).
- A full `_reconcile_cycle` on migrated, empty tables completes without Redis (the cycle lock test also needs
  `pg_try_advisory_xact_lock`). If a step of the cycle fails it is logged by the reconciler and the two reconciler tests fail on
  the purge assertion.
- The timing of the 20 s waits on a loaded host. No repeat runs were made; none of this is a statistic.
- Not covered: model/migration drift, upgrade from older revisions, and any other suite on PostgreSQL.

## Snapshot diagnosis

The tool for the one snapshot that `recompile_stale_snapshots` could not recompile (`invalid_instance`) is separate; see
[SNAPSHOT_INVALID_INSTANCE.md](SNAPSHOT_INVALID_INSTANCE.md). Its SQLite tests are in the registered checks; the read-only
transaction it opens on PostgreSQL (`SET TRANSACTION READ ONLY`) is not exercised by any test here.
