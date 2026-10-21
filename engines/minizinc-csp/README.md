# MiniZinc exact engine

This service lowers a deliberately small canonical `bim/v1` `BindingProblem`
subset to `model/binding_problem.mzn` and solves it with Gecode. It never reads
an `Instance` package or authoring resource.

## Declared subset (`exact-weighted` mode)

* **Objective:** SINGLE weighted-sum utility over normalised (clamped or
  unclamped) or raw criteria, plus constant soft-constraint penalties and
  placement penalties.
* **Workflow nodes:** task, empty, sequence, parallel, probabilistic XOR,
  repeat with an exact `count` or an `expectedCount`.
* **Aggregations:** sequence/parallel `sum`, `product`, `min`, `max`; XOR
  `weightedSum`, `weightedProduct`, `min`, `max`; repeat `scale`, `power`,
  `identity`; selected-candidate `sum`, `product`, `min`, `max`. Multiplicative
  aggregations are lowered with the logarithmic linearisation described in
  [`MULTIPLICATIVE_AGGREGATIONS.md`](MULTIPLICATIVE_AGGREGATIONS.md).
* **Constraints:** hard and soft comparisons (soft ones need a constant,
  non-negative penalty), optionally joined by `and`, over global features and
  task candidate/provider/property/feature paths.
* **Placement:** the complete `qos-binding-placement/v1` overlay (pools,
  demands, per-invocation or selected-candidate capacity rules, directed network
  and event latency, hard/soft transition bounds, global workflow latency).

Conditional XOR, custom aggregation expressions, dynamic soft penalties and
expressions other than comparisons/conjunctions remain outside this mode and are
rejected (HTTP 422 with the construct named) before execution.

## Options

`solver` (fixed to `gecode`), `time_budget_ms` (flattening and search together),
and `product_constraints` (`log`, the default, or `real`: whether comparisons on
multiplicative features are posted in log space or on the real product; the
objective always uses the exact product).

## Execution pipeline

1. The lowering (`src/dzn_builder.ts`) writes the data file. Every number it
   prints that is not instance data is deliberately *not* tight
   (`src/numeric.ts`, slack relative `1e-9`, absolute `1e-9` below magnitude 1):
   * the technical bounds the model needs for finite float domains
     (`metric_bound`, `node_metric_bound`, `term_bound`, `objective_bound`,
     `log_metric_bound`, placement time and penalty bounds) are widened by one
     slack;
   * the literal of every non-strict comparison (`<=`, `>=`, including the
     placement capacity limits and transition maxima) is moved by one slack in
     the direction that enlarges the feasible region. Strict comparisons and
     (in)equalities keep their literal.

   MiniZinc prints float literals into the FlatZinc with 16 significant
   digits, one short of the 17 that round-trip a double, and Gecode propagates
   outward-rounded intervals. A bound or limit that equals an attainable value
   exactly (the sum of the slowest candidate of every task, a limit generated
   from a reference binding) can therefore leave the flattener one ulp below
   that value and exclude precisely the extreme binding it was computed from.
   The first QACOBench campaign recorded two false optima of this kind
   (`qfbs_guaranteed_20_011` and `_033`): the tight `metric_bound` survived as
   an explicit `float_le` that the FlatZinc post-processing below does not
   rewrite. The solver thus reasons about a relaxation; the exact evaluation of
   every returned decision (step 4) is the arbiter.
2. `minizinc -c` flattens the model with the data into FlatZinc.
3. The FlatZinc is post-processed (`src/minizinc_runner.ts`):
   * every bounded float domain is widened by the same slack. MiniZinc derives
     float domains from the parameter data and prints them with finite
     precision, so an optimum lying exactly on a derived bound (the best
     candidate of every task, a normalised loss of 0 or 1) could fall one ulp
     outside the printed domain and produce a false `UNSATISFIABLE` or a false
     optimum. Explicit `float_le`/`float_lt` constraints are left alone: the
     post-processing cannot tell a technical bound from a user constraint,
     which is why step 1 widens the bounds at the source;
   * dead variables (declared but referenced by no constraint) are dropped;
   * every float variable is declared functionally defined. Gecode's FlatZinc
     front-end otherwise appends a default float brancher for floats that are
     neither defined nor searched, and splitting intervals that propagation
     keeps a few ulps wide multiplied the search tree by orders of magnitude
     (millions of nodes on instances that need a hundred). All floats of this
     model are functions of the slot variables, so nothing is lost.
4. `fzn-gecode -a -time <remaining budget>` solves. The solver stream is
   translated back to candidate references; when an output was fixed at
   flattening time (every candidate of a task decided by propagation, a
   constant objective) the solver prints nothing for it and the block is
   rendered through MiniZinc's own output pass (`minizinc --ozn-file`,
   provenance `ozn_rendered`). Every incumbent is re-evaluated exactly: the
   latest one that satisfies the exact constraints is returned, as `OPTIMAL`
   only when it is the last one and the proof completed; an incumbent that
   satisfies only the relaxed comparisons (it lies within one slack beyond a
   limit) is rejected and listed in the provenance
   (`relaxed_incumbents_rejected`). The gateway re-evaluates the decision once
   more and is the authority on feasibility and on the objective value.

The solver is pinned to the official MiniZinc 2.8.7 bundle (Gecode 6.3.0) in
the Dockerfile; `MINIZINC_COMMAND` (or `MINIZINC`) and `FZN_GECODE` override the
executables (a program path or a JSON array, see *Environment*) and
`MINIZINC_CSP_MODEL` the model path (used by the campaign's regression harness).
Every phase (flattening, solving, `.ozn` rendering) runs in its own process
group, so a cancellation or a timeout stops the whole phase (see *Jobs and
cancellation*).

A completed proof returns `OPTIMAL`, a timed incumbent `FEASIBLE`, a proof of
no assignment `INFEASIBLE`, and a run without an incumbent `UNKNOWN`. Returned
candidate indices are translated back to full `{resource,id}` references and
re-evaluated into the common result shape; the provenance carries the flattening
time, the number of widened domains, whether the `.ozn` pass was needed, any
rejected relaxed incumbents and the encoding facts (flat products, log-space
features, log-space atoms, soft constraints, bin-packing columns, relaxed
literals).

## Search and encoding of candidate tables

The model branches on the slot variables only (`first_fail`, `indomain_min`).
The lowering lists each task's candidates from the most to the least promising
estimated weighted loss, so the in-order value choice reaches good incumbents
early; every float variable is functionally determined by the slots.

Gecode has no float element propagator: MiniZinc decomposes `value = table[slot]`
into one reified equality per slot, which never tightens the value's bounds from
the remaining slots and, on catalogs with tens of thousands of candidates
(BWS-SCP: 240 tasks x 240 servers), produced FlatZinc files of half a million
constraints whose flattening alone exceeded the time budget. Every float table
(candidate values, powers, logarithms, demands, constrained task properties) is
therefore read through native integer element constraints over **fixed-point
limbs**: `hi = round(v * s)` with `s` the largest power of ten keeping `|hi| <
2^31`, plus `lo = round((v - hi/s) * s * 1e9)` when the values are not exact
decimals at that scale. The value is recovered through an exact linear
equality (`value * s == hi`, or `value * (s * 1e9) == hi * 1e9 + lo`). For
decimal data the recovered rational is the decimal itself and the interval
Gecode keeps for `value` contains the original double; otherwise the
reconstruction is within one ulp. The same instance flattens in about one
second instead of twelve, and the integer element propagates bounds in both
directions.

Capacity rules whose demand is constant per task (the demand does not depend on
which candidate of the pool's model is chosen) and whose weights and limits are
integral after a common power-of-ten scaling are posted as one native
`bin_packing_capa` per resource column over the task pool variables (Gecode's
bin-packing propagator reasons about the loads of all pools at once); other
rules keep the reified per-pool sums.

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

* **What "cancelled" means.** Each phase of the run (`minizinc -c`, `fzn-gecode`, the optional `.ozn` pass) is
  started in its own process group, and only one runs at a time. A `DELETE` sends
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
`ENGINE_TIMEOUT_GRACE_MS`, `ENGINE_KILL_GRACE_MS`, `ENGINE_REAP_WAIT_MS`, `MINIZINC_COMMAND` (or the older
`MINIZINC`) and `FZN_GECODE` (each a program path or a JSON array such as `["node","tests/fake_minizinc.mjs"]`,
used by the tests; `minizinc` and `fzn-gecode` by default), and `MINIZINC_CSP_MODEL`.

## Tests

Run `pnpm test` with Node.js 20 or newer (reporter `dot`: a green run prints dots and the list below).

* `conformance.test.ts`: the lowering and the declared subset; its end-to-end MiniZinc/Gecode cases run when
  `minizinc` is on `PATH`, and the image build runs this suite against the pinned bundle.

* `job_manager.test.ts`: state machine, semaphore, ownership, TTL, timeout, races, token parsing.
* `minizinc_runner.test.ts` and `cancel.test.ts`: **real child processes** (`tests/fake_minizinc.mjs` stands in
  for both `minizinc` and `fzn-gecode`, follows the flatten/solve/render phases, and sleeps or burns CPU and
  leaves a grandchild in the group). They check, from `/proc`, that a `DELETE` kills the whole
  group, reaps it, stops the CPU use and leaves no zombie child; SIGTERM-ignoring groups; a grandchild that
  outlives the leader; an unkillable group; and the HTTP races (cancel vs finish, vs start, vs resubmission).
* Tests against the **real MiniZinc** need the executable and are enabled with `MINIZINC_REAL=1`
  (`pnpm run test:lab`). Without it they are listed as `NO EJECUTADO` (never silently skipped). The laboratory
  profile `compose.lab-engines.json` runs them and the end-to-end harness
  (`openbinding-gateway/tools/engine_e2e.py`).
