# Remote cancellation of engine jobs (C1: `engines/minizinc-csp`)

**Status.** Implemented and tested in the worker with a *fake* MiniZinc that is a real child process. The tests
against the *real* MiniZinc are written and enabled by `MINIZINC_REAL=1`; they have **not** been executed
(`NO EJECUTADO`): the worker container has no `minizinc`. The laboratory profile that runs them is
`compose.lab-engines.json` (below). The Java engines are out of scope here (**pendiente C2**).

## What was verified before building (findings of the previous attempt)

| Finding | Verified |
| --- | --- |
| `random-search`, `multi-heuristic`, `many-heuristic`, `evolutionary-heuristics` are synchronous: `POST` returns the result, no ids, no jobs, no `DELETE` | yes: their `Controller`/`Server` classes answer 200/405 only, there is no job resource |
| `bim-generator` is a CLI (`BimGeneratorCli`), not an HTTP engine | yes |
| only `engines/minizinc-csp` is asynchronous (202 + `GET /jobs/:id`); it had `Math.random` ids, no auth, no `DELETE`, and never killed the process | yes (`jobs.ts`, `index.ts`, `minizinc_runner.ts` before this change) |
| the gateway already implements best-effort remote cancellation (`jobs/remote_attempts.py`, rules R1-R5, `spec.extensions.cancellation` with `idScope`) | yes; **R1-R5 were not changed** |
| `pnpm test` passed with 13 tests | yes (`conformance.test.ts`, unchanged) |

## Protocol

`bim-engine/v1` has **no `DELETE`**. Cancellation is an optional extension, enabled per registration by a
declaration the deployment's OpenAPI must back; `bim-core` needs no change (a proposal that would standardise it is
at the end, **not applied**).

```
gateway                                         engine (minizinc-csp)
  POST /internal/v1/binding-problems  ───────>  202 {id (UUID v4), status: "queued"}
  GET  /internal/v1/jobs/{id}         ───────>  queued | running | completed | failed      (contract states)
  DELETE /internal/v1/jobs/{id}       ───────>  200 {id, status: cancelled|completed|failed}
                                                202 {id, status: "cancelling"}  (+ Retry-After: 1)
                                                404 (unknown, expired, restarted, or another tenant's)
```

* **Registration.** `spec.extensions.cancellation = {"supported": true, "idScope": "attempt"}`, mappings
  `request`, `job` (`/internal/v1/jobs/{id}`), `health`, `openapi`. The engine serves the OpenAPI at `/openapi.json`
  (the `bim-engine/v1` schemas in asynchronous mode plus the `DELETE`, bearer security when tokens are configured). If
  the registered OpenAPI does not describe the `DELETE`, the gateway turns the capability off by itself (unchanged).
* **`idScope: "attempt"` is true.** Every `POST` creates a new job with `crypto.randomUUID()`. The engine ignores
  `X-Openbinding-Job-Id` / `X-Openbinding-Attempt` for identity: it does **not** deduplicate. A resubmission after a
  cancel is a new job; the cancelled one is never reopened, and cancelling an old id never touches the new job.
* **States** (engine): `queued → running → (cancelling →) completed | failed | cancelled`; the three terminal
  states are immutable. `GET` projects them onto the contract: `cancelling` reads as `running`; `cancelled` reads as
  `failed` with `error: "cancelled: ..."`.
* **When is a job `cancelled`.** Only after the MiniZinc *process group* was terminated and reaped: `detached`
  spawn (pid = pgid), SIGTERM to the group, SIGKILL after `ENGINE_KILL_GRACE_MS` (2 s), wait for the leader's
  `close` event (reaped, no zombie) and for every live member of the group (read from `/proc`, zombies do not
  count) to be gone. Abandoning the HTTP connection, or only signalling, is never `cancelled`.
* **Not stopped in time.** `DELETE` waits `ENGINE_CANCEL_WAIT_MS` (2.5 s, below the gateway's 3 s read timeout)
  and then answers `202 cancelling`. If the group is still alive `grace + ENGINE_REAP_WAIT_MS` after the signals, the
  job ends **`failed`** with `cancel failed: solver process group N is still alive ...`; a backstop
  (`ENGINE_CANCEL_DEADLINE_MS`, 30 s) does the same if the work never settles. Never `cancelled`.
* **Queued jobs.** `DELETE` removes the job from the queue; its solver never starts.
* **Concurrency / backpressure.** Semaphore `ENGINE_MAX_CONCURRENCY` (2), queue `ENGINE_MAX_QUEUED` (64); beyond it
  `503` + `Retry-After`.
* **Idempotence.** Repeating `DELETE` gives the same answer (`200` with the final state); on a terminal job nothing
  changes (`finished_at` included).
* **Tenants.** `ENGINE_AUTH_TOKENS="tenant=token,..."` (tokens ≥ 16 characters, constant-time comparison, a malformed
  value stops the start-up instead of opening the engine). The token selects the owner of the jobs it submits. An
  id that is not yours and an id that does not exist give the identical `404`; no token / a wrong token is `401`.
  **Without `ENGINE_AUTH_TOKENS` the engine stays open (the documented behaviour it always had): every caller is one
  shared tenant.** `/health` is always open; `/internal/v1/health` is its authenticated twin.
* **Timeout.** `time_budget_ms + ENGINE_TIMEOUT_GRACE_MS` (15 s). Past it the group is stopped as for a cancel and the
  job ends `failed: execution timeout after N ms`.
* **Expiry.** Terminal jobs are forgotten after `ENGINE_JOB_TTL_MS` (1 h) and answer `404`.

### Gateway side (`services/execution.py`, `_send_cancellation`)

`sent` means the engine **confirmed** (200/204). A `202` is "accepted, not confirmed": it settles as `failed` and is
retried with backoff, bounded by `remote_cancel_max_attempts`, exactly like a network error; it is never counted as
`sent`. `404/405/501` still end as `skipped` without a retry. R1-R5 (`decide`) are untouched: the `DELETE` goes only to
the endpoint of the attempt (R3), only when the capability is declared, never to an id a newer attempt holds, and
without `idScope: attempt` only for a terminal job (R2).

## Guarantees, and what is not guaranteed

* There is **no distributed exactly-once**. The cancellation is **best effort, confirmed by the engine**: the gateway
  records `sent` only when the engine says 200/204. A lost response, a crashed gateway or a `202` that never turns
  into `200` leaves the row `failed` after its bounded claims, and the gateway has then **not** got a confirmation.
* The engine guarantees, for the process it started, that `cancelled` means *terminated and reaped*, and that a late
  result never overwrites a cancelled job. It cannot guarantee anything about a process it no longer tracks.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| engine restarted (jobs are in memory) | every old id is `404` → the gateway marks the attempt `skipped`; a solver of the previous process is not tracked. On a normal exit (SIGTERM/SIGINT/`app.close`) the engine first stops its solvers; if the engine itself is SIGKILLed or OOM-killed nothing can, and only the container runtime ending the cgroup stops them. The image runs under `tini` so members of a killed group are reaped |
| solver ignores SIGTERM | SIGKILL after the grace; `DELETE` answers `202` meanwhile, `200 cancelled` afterwards |
| solver group cannot be stopped | job `failed` with the reason; `DELETE` → `202` then `200 failed`; the process is reported alive, not cancelled |
| `DELETE` races with the end of the job | whichever transition comes first wins: finished first → `200 completed` and the result stays; cancel first → `cancelled`, the late result is discarded |
| `DELETE` races with the start (job still queued) | leaves the queue, never runs |
| resubmission with the same `X-Openbinding-Job-Id` | a new job, a new id; the cancelled job stays cancelled (rule defined and tested) |
| TTL expiry | `404`; the gateway treats it as "gone", no retry |
| another tenant's id | `404`, identical to an unknown id; the job is untouched |
| engine unreachable / `401` / `5xx` | gateway retries with backoff, bounded |

## Proposed change to `bim-core` (NOT applied)

Not needed: the extension is optional and detected from the OpenAPI. If the `DELETE` should become normative, the
contract `bim-toolchain/packages/bim-core/src/bim_core/resources/schemas/engine-contract.openapi.yaml` would gain
(this changes `protocol_digest()`, so every registration pinning the digest would have to be re-registered):

```diff
   /internal/v1/jobs/{id}:
     get: ...
+    delete:
+      summary: Cancel an asynchronous engine job (optional).
+      parameters:
+        - in: path
+          name: id
+          required: true
+          schema: {type: string, minLength: 1}
+      responses:
+        '200': {description: The job is over., content: {application/json: {schema: {$ref: '#/components/schemas/EngineJobCancelReceipt'}}}}
+        '202': {description: Cancelling; not confirmed yet., content: {application/json: {schema: {$ref: '#/components/schemas/EngineJobCancelReceipt'}}}}
+        '404': {description: Unknown job., content: {application/problem+json: {schema: {$ref: '#/components/schemas/Problem'}}}}
 components:
   schemas:
+    EngineJobCancelReceipt:
+      type: object
+      additionalProperties: false
+      required: [id, status]
+      properties:
+        id: {type: string, minLength: 1}
+        status: {type: string, enum: [cancelled, completed, failed, cancelling]}
```

## Verification

Executed in the worker (see `docs/qa/ENGINES_IR02.md` for the matrix):

* `pnpm test` (reporter `dot`, which prints one dot per test *and* per suite): 80 tests in the sources (13 conformance,
  23 job manager, 16 runner, 28 cancel), 75 executed and green, 5 `NO EJECUTADO` (printed by the script). Real processes
  (`tests/fake_minizinc.mjs`, with a grandchild that burns CPU): group killed, leader reaped, no live member and no
  zombie child read from `/proc`, SIGTERM-ignoring groups, a grandchild that outlives the leader, an unkillable group
  (`NotTerminatedError`, never `cancelled`), HTTP races (cancel vs finish / start / resubmission), tenants (identical
  404, 401), TTL, timeout, queue limits, engine shutdown.
* `uv run pytest` of `test_remote_cancel.py`, `test_engine_cancel_contract.py` (a real local HTTP engine: `DELETE` only
  to the attempt's endpoint and id, only with the capability, never to another tenant, `202` retried and bounded,
  races) and `tools/tests/test_engine_e2e.py` (the harness against a real local engine with the fake solver).
* `ruff check` of the three Python sources I touch.

**Not executed:** everything against the real MiniZinc. What the fake cannot show: that the MiniZinc model solves the
problem (the fake returns a canned incumbent), that `minizinc` + `fzn-gecode` really die as a group, and the
behaviour of a real hard instance. Those are the five `MINIZINC_REAL=1` tests and `engine_e2e.py --url`.

## Laboratory: `compose.lab-engines.json`

Services: `engine` (the `lab` stage of `engines/minizinc-csp/Dockerfile`: MiniZinc, `tini`, user 1000, 192 MiB),
`image-builder` (builds the gateway image with the harness, as in `compose.pgtest.json`), `engine-real-tests`
(same engine image; runs the real-MiniZinc tests when `up` starts it and is healthy only if they passed) and `seed`
(profile `seed`: the harness against `http://engine:3000`). No port is published, no secret, nothing runs as root,
the limits sum to 832 MiB.

Why two services and not one: `lab_compose seed` runs only the service named `seed`, which must be the gateway image
(it has `bim_core` and the harness), while the real tests need the engine image (node, MiniZinc); the root
`.dockerignore` keeps `engines/` out of the gateway's context and the engine's context has no `bim-core`.

1. `lab_compose up file=compose.lab-engines.json` (builds, waits until `engine` and `engine-real-tests` are healthy).
   If `engine-real-tests` never gets healthy, a test failed: `lab_compose logs` shows the `spec` output and
   `REAL_TESTS_EXIT=<code>`; a green run prints `REAL_TESTS_EXIT=0` and no `NO EJECUTADO` line (those five tests run).
2. `lab_compose seed` (with `file=compose.lab-engines.json`): runs `python tools/engine_e2e.py --url http://engine:3000
   --scenario all --expect optimal`. Its exit code is the harness'. In `--url` mode the process checks (group dead, CPU
   free, no zombie) are printed as `NO EJECUTADO`: the solver is in another container; the real tests of step 1 cover
   them with real MiniZinc.
3. `lab_compose down`.

The cancel scenario against a real solver uses a deliberately hard package (150 tasks × 30 candidates, multiple-choice
knapsack). If MiniZinc finishes it before the `DELETE`, the step is reported `inconclusive` (and the run fails), never
as passed.

## Configuration

`PORT`, `ENGINE_AUTH_TOKENS`, `ENGINE_MAX_CONCURRENCY`, `ENGINE_MAX_QUEUED`, `ENGINE_JOB_TTL_MS`,
`ENGINE_CANCEL_WAIT_MS`, `ENGINE_CANCEL_DEADLINE_MS`, `ENGINE_TIMEOUT_GRACE_MS`, `ENGINE_KILL_GRACE_MS`,
`ENGINE_REAP_WAIT_MS`, `MINIZINC_COMMAND`. See `engines/minizinc-csp/README.md`.

## Note on the check `pnpm test`

The registered check fails if the output contains `fail` or `error` (case-insensitive). The default TAP reporter always
prints `# fail 0`, so the check could not pass; `package.json` uses the `dot` reporter, which prints only dots (and the
details of any broken test). The exit status of `node --test` is unchanged and still decides.
