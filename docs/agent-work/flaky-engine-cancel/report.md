# Intermittent failure of `test_the_credential_of_another_tenant_cannot_stop_the_job_and_the_404_is_not_retried`

## Symptom

`openbinding-gateway/tests/test_engine_cancel_contract.py`, the test named above, fails now and then in CI with
`assert engine.deletes == [remote_id]` receiving `[]` after three `cycle(db_session, frozen)` calls. The rest of the
suite passes in the same run (3143 passed). It is unrelated to the changes of the PRs where it appeared.

## Root cause (test only, production code is correct)

Two clocks take part in the test and nothing keeps them together:

1. The `frozen` fixture (`test_remote_cancel.py`) replaces `jobs.clock.utcnow` with a clock fixed at the moment the
   fixture is built, `T0`. It is the last fixture to be built, so `T0` is taken before the test body runs.
2. `lost_attempt` builds the registration and the job (several database writes and commits), claims the job and calls `lose_and_sweep`. `lose_the_worker`
   (`tests/analysis_b3_b4_b6/_helpers.py:111`) stamps the lease with `db.models.utcnow()`, the **real** clock:
   `lease_until = real_now - 1 s`. The patch does not reach it because it imports `utcnow` from `db.models`,
   not from `jobs.clock`.
3. `reconciler.sweep_abandoned` then reads `now = clock.read_now(session)`, which on SQLite is the **frozen**
   clock, `T0` (`jobs/clock.py:80`), and keeps a job alive while `lease_until > now` (`jobs/reconciler.py:267`).

The lease has lapsed for the sweep only if `real_now - 1 s <= T0`, i.e. if the setup between the fixture and
`lose_the_worker` took at most one second. On a loaded CI runner it can take longer: `lease_until` is then in the
frozen clock's future, the sweep takes the `continue` at line 268, it never requeues the job and never calls
`remote_attempts.mark_lost`. No attempt row becomes `pending`, `claim_due` finds nothing, and the engine receives no
`DELETE`: `engine.deletes == []`. On a fast machine the margin holds, which is why it passes most of the time.

Nothing else can explain `[]`: a 404 that is not retried gives `[remote_id]` (one request), and a retry deadline
(`next_cancel_at`) that has not elapsed cannot apply to the first cycle, because a row that was never claimed has
`next_cancel_at IS NULL` (`remote_attempts._due`, line 222) and is due at once. The backoff matters only for later
cycles, and `cycle` moves the frozen clock forward by 3600 s after each one.

## Hypotheses ruled out

* Retry deadline ("lost_attempt" backoff) not yet reached: a first claim has no `next_cancel_at`; also `cycle`
  advances the clock an hour per call.
* Order of reconciler cycles: `cancel_lost_attempts` only claims rows already `pending`; the sweep that marks them
  runs inside `lost_attempt`, before the first `cycle`, in the same session.
* State shared between tests: every test has its own `db_session` and `SimulatedEngine` (a new server on port 0 and
  new random job ids); `frozen` and `credential` are function-scoped fixtures undone by `monkeypatch`.
* Engine thread race: `handle_job` records the request under a lock before replying, and the gateway awaits the
  answer, so `seen` is complete when `cycle` returns.

## Evidence

Reproduced deterministically through the registered check by simulating a slow setup, i.e. moving the frozen clock
5 s behind the real one before `lost_attempt` (new regression test
`test_a_slow_setup_behind_the_frozen_clock_still_gets_its_lost_attempt_cancelled`). Before the fix:

```
>       assert engine.deletes == [remote_id]
E       AssertionError: assert [] == ['811b5e53-df4a-4bc8-bdf4-59a9031c7a7b']
1 failed, 12 passed
```

After the fix: `13 passed`.

## Fix (applied, test file only)

`openbinding-gateway/tests/test_engine_cancel_contract.py`:

* `lost_attempt` takes an optional `frozen` clock. When it is given, the helper calls `lose_the_worker`, then sets
  `frozen.now = max(frozen.now, utcnow())` (real time, which is later than the `real_now - 1 s` just written), and
  only then runs `sweep_abandoned`. The lease has lapsed for the sweep whatever the setup cost.
  Without `frozen` it behaves as before (real clock on both sides, which cannot race).
* The six tests that use `frozen` (the flaky one, the unauthenticated one, the two 202 ones, the forgotten-job one
  and the new regression test) pass it to `lost_attempt`.

Moving the frozen clock forward is harmless for the assertions: the first `cycle` claims a row with no deadline, and
every `cycle` advances the clock afterwards past any backoff.

## Possible follow-up (outside this scope)

`test_remote_cancel.py` combines `frozen` with `lose_and_sweep` too (`lose_and_sweep` is the same
`lose_the_worker` + `sweep_abandoned`). Any of its tests that builds a slow setup between the `frozen` fixture and
`lose_and_sweep` has the same one-second margin. A cleaner, general fix is for `lose_the_worker` to use
`jobs.clock.utcnow()` instead of `db.models.utcnow`, so the lease follows whichever clock the sweep reads. That
helper is shared by other suites and was not changed here.
