# MiniZinc exact engine

This service lowers a deliberately small canonical `bim/v1` `BindingProblem`
subset to `model/binding_problem.mzn`. It never reads an `Instance` package or
authoring resource.

The `exact-weighted` mode supports SINGLE weighted-sum utility, task, empty,
sequence, parallel, probabilistic XOR and exact repeat nodes. Its executable
aggregations are sequence/parallel sum/min/max, XOR weighted sum/min/max,
repeat scale or identity, and selected-candidate sum/min/max. Hard comparison
constraints may read global metrics and task candidate, provider, property or
metric paths.

Placement is optional. With no Placement IR, its arrays and constraints are
vacuous. When supplied, the same exact model consumes canonical pools,
candidate-to-pool demands, per-invocation or selected-candidate capacity rules,
directed network and event latency, hard/soft transition bounds, and global
workflow latency (probabilistic XOR plus parallel max or sum, with optional
execution latency). The mode therefore declares `placement=all` and the
versioned `qos-binding-placement/v1` IR extension. Conditional XOR, expected
repeat counts, soft ConstraintSet expressions, custom expressions and
nonlinear aggregations remain outside this mode and are rejected before
execution.

Options are `solver` (fixed to `gecode`) and `time_budget_ms`. The latter is
mapped directly to MiniZinc's `--time-limit`. A completed proof returns
`OPTIMAL`, a timed incumbent `FEASIBLE`, a proof of no assignment `INFEASIBLE`,
and a run without an incumbent `UNKNOWN`. Returned candidate indices are
translated back to full `{resource,id}` references and reevaluated into the
common result shape.

## Jobs and cancellation

The engine is asynchronous: `POST /internal/v1/binding-problems` answers `202 {id, status: "queued"}` and
`GET /internal/v1/jobs/:id` reports `queued | running | completed | failed` exactly as `bim-engine/v1`
defines them. Cancellation is an **optional extension** of that contract (it has no `DELETE`), offered per
capability, not a change of `bim-core`:

| Request | Answer |
| --- | --- |
| `DELETE /internal/v1/jobs/:id`, job over (cancelled, completed or failed) | `200 {id, status: "cancelled" \| "completed" \| "failed"}` |
| `DELETE`, job running | the solver is stopped and reaped, then `200 {id, status: "cancelled"}` |
| `DELETE`, job queued | leaves the queue without running: `200 {id, status: "cancelled"}` |
| `DELETE`, solver not confirmed gone within `ENGINE_CANCEL_WAIT_MS` | `202 {id, status: "cancelling"}` (+ `Retry-After: 1`); repeat later |
| unknown id, expired id, or the job of another tenant | `404` (identical body) |

Internally a job is `queued → running → (cancelling →) completed | failed | cancelled`; terminal states are
immutable. `GET` projects it onto the contract: `cancelling` reads as `running`, and `cancelled` reads as
`failed` with an `error` that starts with `cancelled:`.

* **What "cancelled" means.** The MiniZinc process is started in its own process group. A `DELETE` sends
  SIGTERM to the group, SIGKILL after `ENGINE_KILL_GRACE_MS` (2 s), then waits for the leader's `close`
  (reaped, no zombie) and for every other member of the group to be gone. Only then is the job `cancelled`.
  Dropping the HTTP connection, or only signalling the process, never produces `cancelled`.
* **A solver that cannot be stopped.** If the group is still alive `ENGINE_KILL_GRACE_MS +
  ENGINE_REAP_WAIT_MS` after the signals, the job ends `failed` with `cancel failed: solver process group N is
  still alive ...`; meanwhile `DELETE` answers `202 cancelling`. It is never reported as cancelled.
* **Late results.** Once a cancellation was accepted the job can only end `cancelled` (the work stopped; what
  it may have returned is discarded) or `failed`. A terminal job is never reopened or overwritten.
* **Ids.** `crypto.randomUUID()`, one per `POST`. The engine does **not** deduplicate by the gateway's
  `X-Openbinding-Job-Id` / `X-Openbinding-Attempt` headers: a resubmission is a new job with a new id, and
  cancelling an older id never touches it. That is why the engine declares `idScope: "attempt"`.
* **Timeout.** A job that runs longer than `time_budget_ms + ENGINE_TIMEOUT_GRACE_MS` (default 15 s) is
  stopped the same way and ends `failed` with `execution timeout after N ms`.
* **Expiry.** Terminal jobs are forgotten after `ENGINE_JOB_TTL_MS` (default 1 h) and then answer 404.
* **Restart.** Jobs live in memory. After an engine restart every old id is `404`, and a solver started by
  the previous process is not tracked any more: on a normal exit (including SIGTERM/SIGINT) the engine stops
  its solvers first; if the engine is killed with SIGKILL or by the OOM killer nothing can, and only the
  container runtime ending the cgroup does. Run it under an init (`tini`, as the image does) so that members
  of a killed group are reaped.
* **Concurrency.** `ENGINE_MAX_CONCURRENCY` (default 2) jobs run at once, `ENGINE_MAX_QUEUED` (default 64)
  wait; a submission beyond that is `503` with `Retry-After`.

### Tenants and authentication

`ENGINE_AUTH_TOKENS="tenant-a=<token>,tenant-b=<token>"` (tokens of at least 16 characters; a malformed value
stops the engine from starting) turns on bearer authentication. The token selects the tenant that owns the
jobs it submits; `GET` and `DELETE` of an id that is not yours answer the same `404` as an id that does not
exist. Missing or wrong tokens get `401` on every job endpoint. `/health` stays open for the orchestrator's
probe; `/internal/v1/health` is the authenticated twin for registrations that map `health` with
authentication. **Without `ENGINE_AUTH_TOKENS` the engine is open, as it always was**: every caller is one
shared tenant, so it must only be reachable from the internal network.

### Publishing the capability

`GET /openapi.json` serves the deployment OpenAPI (the `bim-engine/v1` schemas, asynchronous mode, plus the
`DELETE` operation, with bearer security when tokens are configured). A registration enables cancellation
only by declaring it next to that document:

```json
{
  "spec": {
    "mappings": {"request": "/internal/v1/binding-problems", "job": "/internal/v1/jobs/{id}",
                 "health": "/internal/v1/health", "openapi": "/openapi.json"},
    "auth": {"scheme": "bearer"},
    "extensions": {"cancellation": {"supported": true, "idScope": "attempt"}}
  }
}
```

(`"scheme": "none"` and `"health": "/health"` when no tokens are configured.) The gateway turns the
capability off by itself if the registered OpenAPI does not describe the `DELETE`.

### Environment

`PORT`, `ENGINE_AUTH_TOKENS`, `ENGINE_MAX_CONCURRENCY`, `ENGINE_MAX_QUEUED`, `ENGINE_JOB_TTL_MS`,
`ENGINE_CANCEL_WAIT_MS` (default 2500, below the gateway's 3 s read timeout), `ENGINE_CANCEL_DEADLINE_MS`
(default 30000: a cancel or timeout that has not stopped the work by then makes the job `failed`),
`ENGINE_TIMEOUT_GRACE_MS`, `ENGINE_KILL_GRACE_MS`, `ENGINE_REAP_WAIT_MS`, and `MINIZINC_COMMAND` (a program
path or a JSON array such as `["node","tests/fake_minizinc.mjs"]`, used by the tests; `minizinc` by default).

## Tests

Run `pnpm test` with Node.js 20 or newer (reporter `dot`: a green run prints dots and the list below).

* `job_manager.test.ts`: state machine, semaphore, ownership, TTL, timeout, races, token parsing.
* `minizinc_runner.test.ts` and `cancel.test.ts`: **real child processes** (`tests/fake_minizinc.mjs` sleeps or
  burns CPU and leaves a grandchild in the group). They check, from `/proc`, that a `DELETE` kills the whole
  group, reaps it, stops the CPU use and leaves no zombie child; SIGTERM-ignoring groups; a grandchild that
  outlives the leader; an unkillable group; and the HTTP races (cancel vs finish, vs start, vs resubmission).
* Tests against the **real MiniZinc** need the executable and are enabled with `MINIZINC_REAL=1`
  (`pnpm run test:lab`). Without it they are listed as `NO EJECUTADO` (never silently skipped). The laboratory
  profile `compose.lab-engines.json` runs them and the end-to-end harness
  (`openbinding-gateway/tools/engine_e2e.py`).
