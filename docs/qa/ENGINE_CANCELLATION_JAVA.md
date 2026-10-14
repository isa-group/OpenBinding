# Remote cancellation of the JVM engines

Scope: `random-search`, `many-heuristic`, `multi-heuristic` and `evolutionary-heuristics`, the four engines that
share `engines/binding-core`. `minizinc-csp` has its own implementation (`docs/qa/ENGINE_CANCELLATION.md`, written
together with its code); `bim-generator` is a command-line tool, not an engine, and is out of scope.

Before this work these engines were **synchronous**: `POST /internal/v1/binding-problems` answered `200` with the
result when the search ended. A synchronous POST has no job id, so there was nothing a client could cancel: closing
the connection did not stop the search, which kept a thread and a core busy until its budget ran out.

## What was added

An **opt-in asynchronous mode**, common to the four engines (`binding-core`: `Cancellation`, `EngineJobs`,
`EngineHttp`). The default is unchanged.

| `ENGINE_JOB_MODE` | `POST /internal/v1/binding-problems` | job endpoints | `/openapi.json` |
|---|---|---|---|
| unset, empty or `sync` (default) | `200` with the result, exactly as before | none (`404`) | as before (only `multi-heuristic` serves one: the pinned file, byte for byte) |
| `async` | `202 {"id","status":"queued"}` | `GET` and `DELETE /internal/v1/jobs/{id}` | deployment document with `DELETE` and `extensions.cancellation` |
| anything else | the engine does not start | | |

`bim-engine/v1` (`engine-contract.openapi.yaml`) already defines the asynchronous half: `202 EngineJobAccepted`, `GET
/internal/v1/jobs/{id}` and the four-state `EngineJob` (`queued | running | completed | failed`). It defines **no
`DELETE`**. Cancellation is therefore an *optional extension, advertised by capability*:

```json
"extensions": { "cancellation": { "supported": true, "idScope": "attempt" } }
```

in the `/openapi.json` that an asynchronous engine serves. A client must read that capability before it sends a
`DELETE`; an engine without it (every engine in synchronous mode) answers `404`/`405`. `idScope: "attempt"` means the
id names one execution attempt, that is, one accepted POST, and not a logical job of the platform: re-submitting
creates another attempt with another id. This is the same shape `minizinc-csp` implements (see
`docs/qa/ENGINE_CANCELLATION.md` once that change is integrated).

## Configuration

| variable | default | meaning |
|---|---|---|
| `PORT` | `8080` | listening port (random-search, many-heuristic and multi-heuristic used to hard-code `8080`) |
| `ENGINE_JOB_MODE` | `sync` | `sync` or `async` |
| `ENGINE_AUTH_TOKENS` | unset | `tenant=token,tenant2=token2`: turns on bearer authentication and job ownership |
| `ENGINE_JOB_MAX_CONCURRENT` | `2` | solver threads (1-64) |
| `ENGINE_JOB_MAX_QUEUED` | `16` | accepted jobs waiting for a thread (0-4096) |
| `ENGINE_JOB_MAX_RETAINED` | `1024` | jobs kept in memory, finished ones included; at least concurrent + queued |
| `ENGINE_JOB_TTL_SECONDS` | `900` | how long a finished job stays readable (1-604800) |
| `ENGINE_JOB_STOP_GRACE_MS` | `5000` | how long a `DELETE` waits for the solver to confirm it stopped (0-600000) |

A malformed value (a non-numeric port, an unknown mode, a token list that is not exactly `tenant=token,...`, a limit out
of range) is a startup error: the JVM exits with a message naming the variable. Nothing falls back to a default
silently. The `ENGINE_JOB_*` limits are only read in `async` mode.

## Protocol

```
POST   /internal/v1/binding-problems    202 {"id","status":"queued"}   | 401 | 413 | 422 | 503 (+ Retry-After: 5)
GET    /internal/v1/jobs/{id}           200 EngineJob                  | 401 | 404
DELETE /internal/v1/jobs/{id}           200 {"id","status"}  stopped   | 202 {"id","status":"cancelling"} | 401 | 404
GET    /openapi.json                    200 deployment document (async mode only)
```

The request is validated **before** a job exists: a request the engine would answer with `422` in synchronous mode
(unknown option, wrong objective class, source document instead of IR) is a `422` here too and creates nothing.

### States

```
queued ──> running ──> completed
   │          │  └───> failed
   └──────────┴─ DELETE ─> cancelling ──> cancelled
```

`completed`, `failed` and `cancelled` are final and immutable. `GET` projects the internal states onto the four of the
contract: `cancelling` is shown as `running`, and `cancelled` as `failed` with an `error` that starts with
`cancelled:` (`cancelled: requested by DELETE`). `created_at` is whole seconds since the epoch.

### `DELETE` answers

| situation | answer |
|---|---|
| the solver is confirmed stopped (it returned from the search, or the job never started) | `200 {"id","status":"cancelled"}` |
| the job had already finished | `200 {"id","status":"completed"}` or `"failed"`; nothing changes |
| the solver is still running after the grace | `202 {"id","status":"cancelling"}`; repeat the `DELETE` (or `GET`) to confirm |
| unknown, expired or somebody else's id | `404` |

`DELETE` is idempotent: repeating it returns the same answer and never restarts or changes a job.

## Guarantees

* **`cancelled` is never reported while the solver thread is still running.** The state changes to `cancelled` only
  after the search returned (or after the job was removed from the queue before it started). A `Future` is not used
  as proof: `FutureTask.cancel(false)` marks a task done while its body keeps running, so the job keeps its own
  record that the body returned.
* **Cooperative stop.** Every search loop calls `Cancellation.checkpoint()` once per iteration, and
  `CanonicalEvaluator.evaluate` calls it once per evaluation. After `DELETE` the next checkpoint throws and unwinds the
  search; the worker thread is also interrupted. A solver that does not reach a checkpoint cannot be stopped, and the
  job then stays `cancelling` (answer `202`) instead of lying.
* **A late result never reopens or overwrites a cancelled job.** Under the job's lock, whichever of "cancel recorded"
  and "work finished" comes first decides: finished first gives `completed` (and `DELETE` then answers
  `completed`); cancel first gives `cancelled` and the result, even a perfectly valid one, is discarded.
* **A job cancelled in the queue never runs** and does not use a solver thread.
* **The slot is freed when the solver stops**, so the next queued job starts then. Capacity is bounded (`concurrent +
  queued`); beyond it the answer is `503` with `Retry-After`.
* **Ownership.** With `ENGINE_AUTH_TOKENS`, a job belongs to the tenant of the token that submitted it. No token or a
  wrong one is `401`; another tenant's id and an id that never existed produce the **same `404`**, byte for byte, so
  ids cannot be probed. Tokens are compared in constant time (SHA-256 digests, every token examined). Without tokens
  the engine is open, as it always was. In synchronous mode the same tokens, when configured, also guard the POST.
* **Unpredictable ids.** Job ids are random UUIDs (`java.util.UUID.randomUUID()`, backed by `SecureRandom`).
* **Bounded memory.** Finished jobs expire after the TTL (then they are a `404`, like unknown ones); the request
  held by a finished job is dropped immediately; a store at its retained-job limit answers `503`.
* **Same seed, same answer.** The job runs the very same search as the synchronous POST; the tests compare both.
* **Default mode untouched.** Without `ENGINE_JOB_MODE=async` the HTTP behaviour is the pre-existing one: the same
  routes, statuses and bodies, no job endpoints, and for `multi-heuristic` the pinned `openapi.json` served byte for
  byte (checked against the file by the end-to-end test).

## Failure modes and what is *not* guaranteed

* **Best effort with the engine's own confirmation.** The platform asks; the engine says whether it stopped. If the
  JVM is wedged, the network drops the `DELETE`, or the solver is not cooperative, the answer is `202 cancelling`, an
  error, or nothing. A client must treat "no confirmation" as "may still be running".
* **No exactly-once.** A `POST` whose answer was lost may have created a job nobody knows the id of; retrying it creates a
  second one. There is no idempotency key.
* **A restart loses every id.** Jobs live in memory. After a restart `GET` and `DELETE` of an old id answer `404`, and a
  job that was running is simply gone (its work is not resumed). A client that sees `404` for an id it submitted must
  re-submit, and cannot tell "finished and expired" from "lost in a restart".
* **Granularity.** The stop latency is one iteration (random, many, multi) or one evaluation (evolutionary). An
  evaluation of a very large placement model is not subdividable; it finishes before the thread notices.
* **No wall-clock limit** other than the request's own `time_budget_ms`; a job runs until its budget ends or it is
  cancelled.
* **One process.** Jobs are not shared between replicas; behind a load balancer the `DELETE` must reach the replica that
  holds the job (the id gives no hint of which).
* **No TLS.** As before, the engines speak plain HTTP and expect to sit on an internal network; the bearer token
  is only as private as that network.
* **The gateway does not use `DELETE` yet.** This change gives the engines the capability and a reference
  protocol; calling it from `remote_attempts` is the gateway's part.

## Tests

JUnit (run by `mvn -B test` in `engines/`):

* `EngineJobsTest` (17): states, the `Stubborn` solver that ignores cancel (stays `cancelling`, its late result is
  discarded), cooperative stop, queued cancel never runs, finished job not cancelled, cancel racing the end 60 times,
  foreign/unknown ids, TTL with an injected clock, capacity, retention, failures, UUIDs and restart, re-submission,
  `close()`, `Cancellation` semantics, environment parsing.
* `EngineHttpTest` (14): the exact `EngineJob` shapes, `202` vs `200` on `DELETE`, the four-state projection, real work on
  the shared scenarios, tenants, `422` before enqueue, synchronous mode without jobs, tokens in synchronous mode,
  methods and malformed ids, `503`, the OpenAPI extension, token and settings parsing.
* One `*CancelTest` per engine (`RandomSearchCancelTest`, `ManyHeuristicCancelTest`, `MultiHeuristicCancelTest`,
  `EvolutionaryCancelTest`), each over real HTTP against that engine's own solver, with a workload that cannot finish
  (a million iterations, or ten million evaluations, over forty tasks, fixed seed 42): the solver thread is found by
  its stack frame, its CPU time (`ThreadMXBean`) and the global checkpoint counter grow while it runs and stop growing
  after the confirmed `DELETE`; the slot is freed and a queued job runs; a queued job is cancelled without running;
  tenants; `DELETE` after and racing the end; `422`; synchronous mode has no `DELETE`; same seed gives the same
  result through a job; ids are lost on restart; and for `multi-heuristic` the deployment `openapi.json` extends the
  pinned one without changing it.

`engines/e2e/test_java_engines_ir02.py` (pytest, from `openbinding-gateway`) repeats the cancellation against **real
`java` processes** and measures the CPU of the process and of its `engine-job-*` thread from `/proc`; it also checks
the malformed-configuration refusals and the tenants on a real process. Its results are in
`docs/qa/ENGINES_JAVA_IR02.md`.

## Execution profile

`compose.lab-engines-java.json` is a one-shot profile (`seed`, non-root, size-capped tmpfs, no published port) that
re-runs the JUnit suites of the four engines inside the `builder` stage of each engine's own Dockerfile: the JDK 8 of
the production images for `engines-java-random-search`, `engines-java-many-heuristic` and
`engines-java-multi-heuristic`, and JDK 21 for `engines-java-evolutionary`. **NO EJECUTADO** by the worker (no
Docker there); `lab/tests/test_lab_engines_java_profile.py` checks it statically. It needs network access to Maven
Central at run time (surefire is not in the builder images). No new Dockerfile was added, so the profile reuses the
existing stages; the end-to-end Python run is not in a container.

To run one service with the lab tool: `lab_compose up file=compose.lab-engines-java.json profile=seed
service=engines-java-random-search`; success prints `engines-java-random-search-ok`.

## Compatibility notes

* The core is Java 8 bytecode (the production images run a JDK 8 runtime); the engine classes added here use Java 8 APIs
  only. `evolutionary-heuristics` targets Java 17.
* `EngineContract.parse` now rejects a request without `optimization.weights` with `422` (the contract requires the
  field; before, the missing array caused a `NullPointerException` and a `500`).
* `CanonicalEvaluator.evaluate(decision)` (the library overload without an execution) now weights the criteria
  `1/n` each, like `bim_core`; it used to use `1.0` each. Requests to the engines always carry their own weights, so
  engine answers do not change.
