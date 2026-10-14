# JVM engines against IR 0.2.0 (`bim_core` 0.2.0)

What was checked, how, and the figures it produced on 2026-10-14. Engines: `random-search`, `many-heuristic`,
`multi-heuristic`, `evolutionary-heuristics` (they share `engines/binding-core`). Cancellation is described in
`docs/qa/ENGINE_CANCELLATION_JAVA.md`.

## 1. Why `mvn test` failed on the base, and what it meant

`mvn -B test` in `engines/` failed in `binding-core`: `CanonicalEvaluatorConformanceTest` had 1 failure and 5 errors out of
25, and the reactor skipped every engine module after it (so nothing else was exercised). Diagnosis: **the Java code follows the current contract; the tests had not been moved to it.** It is a lag between
the tests and IR 0.2.0, not an evaluator bug.

Evidence, from `bim_core` 0.2.0:

* The canonical `spec.optimization` has exactly `resource`, `criteria` and `penalties`
  (`binding-problem.schema.json`, `optimization.schema.json`, `compiler.py:3486`). It has no `terms`, `mode` or
  `type`. `BindingProblem.validateOptimization` and `CanonicalEvaluator.evaluate` already read `criteria` and
  `penalties`, and the shared fixture `TestProblems` was already built that way.
* The objective type (`SINGLE | MULTI | MANY`), the scalarization and the weights are **execution** input, in the
  request's `optimization` (`engine-contract.openapi.yaml`, `ExecutionOptimization`; `compat.resolve_optimization`).
  `EngineContract.validateOptimization` enforces the cardinality (MULTI two or three criteria, MANY at least three).
* The loss is the one of `compiler.py:4233-4235` (`normalized` or `1 - normalized` when maximizing, `-value` without
  normalization), identical to `CanonicalEvaluator.objectiveLoss`.
* A `BindingSolution` is closed: `decision, features, objectives, penalties, violations`
  (`protocol._SOLUTION_FIELDS`; OpenAPI `additionalProperties: false`). It has no `metrics` alias.

| failing test | cause | change (no assertion was loosened) |
|---|---|---|
| `canonicalObjectiveTypeEnforcesOnlyItsDeclaredCardinality` | wrote `optimization.type/mode/terms` into the IR | the cardinality is now asserted where it lives, on `EngineContract.parse` of a request, for SINGLE/MULTI/MANY and a fourth criterion; an unknown type (`MONO`) is refused |
| `changingObjectiveAndHardConstraintChangesThePreferredBinding` | `terms[0].metric` | `criteria[0].feature` |
| `objectiveNormalizationClampsOnlyWhenExplicitlyRequested` | `terms[0]` | `criteria[0]`; the expected losses 1.8 / 1.0 / -0.8 / -9.0 and the `clamp` requirement are unchanged |
| `weightedLexicographicParetoAndSatisfyHaveDistinctExactOrders` | `optimization.mode` and per-term `weight` | the same four orders, now selected by the execution: `SINGLE weighted-sum` (7.75 / 3.0), `MULTI lexicographic` (`[1,10,0]` / `[9,1,0]`), `MULTI pareto-front` (no dominance), `SINGLE feasibility` with no criteria |
| `canonicalIdentityPinsProfileDialectsAdaptersAndResources` (last block) | a non-canonical criterion `weight` that no longer exists | the two canonical-weight rules that do exist: execution weights not summing to 1 are refused, and so are IR penalty weights not normalized |
| `featureModelEvaluatesAndExposesFeaturesAndMetrics` (line 830) | expected `solution.has("metrics")` | the test now asserts the solution key set is exactly the five of `bim-engine/v1` and that `metrics` is absent; `Evaluation.metrics()` is still the Java-side alias |

The same lag was behind `V1ManySearchTest` (3 errors, shown once `binding-core` passed) and `V1MultiSearchTest`
(same construction, fixed alike); both now ask for the objective class in the request. The evolutionary module's tests
had never run in this setup because the reactor stopped earlier; they pass. `multi-heuristic/README.md` still described
the old `optimization.type: MULTI, mode: pareto` and was corrected.

Two small evaluator alignments came out of comparing with `bim_core` (neither changes what the engines answer):

* `EngineContract.parse` required no `optimization.weights`, although the contract does; a request without it caused a
  `NullPointerException` and a `500`. It is now a `422`.
* `CanonicalEvaluator.evaluate(decision)` (the library overload without an execution) weighted each criterion `1.0`;
  `bim_core` uses `1/n`. Requests carry their own weights, so engine answers are unaffected.

One divergence is **not** changed because the declared modes cannot reach it: for a `SINGLE` execution with a scalarization
other than `weighted-sum` or `feasibility`, and for `feasibility` with `MULTI/MANY`, `bim_core` returns a score vector
where the Java evaluator returns a scalar or a vector respectively. The manifests offer `SINGLE` only with
`weighted-sum` and `feasibility`, and `feasibility` only with `SINGLE`.

## 2. What the end-to-end run does

`engines/e2e/java_engines_ir02.py` (standard library plus `bim_core`; `bim_client.InProcessBim` is used when importable,
and it was):

1. Builds a deterministic `.bim.zip` (5 sequential tasks, 3 candidates each, features `cost`, `latency`, `availability`,
   one criterion per feature) and compiles it with `bim_core` 0.2.0 to the canonical `bim/v1 BindingProblem`. The binding
   space has 3^5 = 243 bindings and the script **enumerates all of them** with `bim_core`, so it knows the true optimum
   and the true Pareto front (45 points).
2. Launches each engine as a real `java` process (`engines/<module>/target/classes` and `binding-core/target/classes` from
   `mvn test`, and the Gson jar that `mvn test` itself resolved: the path is read from the surefire reports, nothing is
   downloaded) with `PORT` set, once synchronous and once with `ENGINE_JOB_MODE=async`.
3. Sends the same `BindingProblemRequest` (seed 20260514, 3000 iterations or evaluations) and gets the answer: the `200`
   body, or the completed job after `202` + polling.
4. Validates it with `validate_result`, re-evaluates every decision with `bim_core.reevaluate` using the termination
   guarantees the engine's manifest declares, and compares everything the engine claimed (`features`, `objectives`,
   `penalties`, `violations`, tolerance 1e-9) with the authoritative values.
5. Cancels a job that cannot finish (a million iterations over forty tasks, or ten million evaluations) with `DELETE` on a
   real process and reads `/proc/<pid>/stat` and the stat of the `engine-job-*` thread before and after.

The mode each engine declares is read from its manifest (`schemas/bim/v1/manifests`, or
`examples/federation/multi-heuristic/engine.json`). **All four declare `exact: false` and terminations
`FEASIBLE`/`UNKNOWN`**: none is an optimal or complete mode. The matrix therefore reports three different things and
keeps them apart: what the mode *declares*, what the engine *claimed*, and what `bim_core` says after re-evaluating.
"Found the optimum" is an observation about this 243-binding instance, never a claim of the engine.

## 3. Commands and real output

```
cd engines && mvn -B test
```

```
[INFO] Tests run: 25, Failures: 0, Errors: 0, Skipped: 0 ... CanonicalEvaluatorConformanceTest
[INFO] Tests run: 17, Failures: 0, Errors: 0, Skipped: 0 ... EngineJobsTest
[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0 ... EngineHttpTest
[INFO] Tests run: 56, Failures: 0, Errors: 0, Skipped: 0                       (binding-core)
[INFO] Tests run: 4,  ... V1RandomSearchTest;  Tests run: 8 ... RandomSearchCancelTest
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0                       (random-search)
[INFO] Tests run: 3,  ... V1ManySearchTest;    Tests run: 8 ... ManyHeuristicCancelTest
[INFO] Tests run: 11, Failures: 0, Errors: 0, Skipped: 0                       (many-heuristic)
[INFO] Tests run: 3,  ... V1MultiSearchTest;   Tests run: 9 ... MultiHeuristicCancelTest
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0                       (multi-heuristic)
[INFO] Tests run: 5,  ... EvolutionarySolverTest; Tests run: 8 ... EvolutionaryCancelTest
[INFO] Tests run: 13, Failures: 0, Errors: 0, Skipped: 0                       (evolutionary-heuristics)
[INFO] BUILD SUCCESS
```

That is **104 JUnit tests, 0 failures, 0 errors, 0 skipped** (`bim-generator` has no tests). Before the change: core
25 tests with 1 failure and 5 errors, and nothing else ran.

```
cd openbinding-gateway
PYTHONPATH=src:../bim-toolchain/packages/bim-core/src:../bim-toolchain/packages/bim-service/src:../bim-toolchain/packages/bim-client/src \
  uv run pytest -p no:cacheprovider -rs -q ../engines/e2e/test_java_engines_ir02.py ../lab/tests/test_lab_engines_java_profile.py
```

```
35 passed in 34.55s            (no test skipped: every Java engine ran)
```

### Engine x mode x result (seed 20260514; `bim_core 0.2.0 via bim_client.InProcessBim`; 243 bindings)

| engine | case | mode | declared | claimed | re-evaluated | solutions | best score | space optimum | found optimum | claims agree | same answer sync/async |
|---|---|---|---|---|---|---|---|---|---|---|---|
| random-search | weighted-sum | sync | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 1 | 0.041333 | 0.041333 | yes | yes | yes |
| random-search | weighted-sum | async | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 1 | 0.041333 | 0.041333 | yes | yes | yes |
| many-heuristic | pareto-front MANY | sync | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 45 | 45 of 45 on the true front | front of 45 | - | yes | yes |
| many-heuristic | pareto-front MANY | async | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 45 | 45 of 45 on the true front | front of 45 | - | yes | yes |
| multi-heuristic | pareto-front MULTI | sync | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 45 | 45 of 45 on the true front | front of 45 | - | yes | yes |
| multi-heuristic | pareto-front MULTI | async | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 45 | 45 of 45 on the true front | front of 45 | - | yes | yes |
| evolutionary-heuristics | elitist-genetic weighted-sum | sync | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 1 | 0.041333 | 0.041333 | yes | yes | yes |
| evolutionary-heuristics | elitist-genetic weighted-sum | async | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 1 | 0.041333 | 0.041333 | yes | yes | yes |
| evolutionary-heuristics | pareto-genetic pareto-front MANY | sync | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 37 | 37 of 37 on the true front | front of 45 | - | yes | yes |
| evolutionary-heuristics | pareto-genetic pareto-front MANY | async | heuristic / FEASIBLE, UNKNOWN | FEASIBLE | FEASIBLE | 37 | 37 of 37 on the true front | front of 45 | - | yes | yes |

Reading it: every engine answered in both modes with a valid `bim-engine/v1` result; `bim_core` reproduced every
claimed number (`claims agree`); no engine claimed `OPTIMAL` or `INFEASIBLE`; the answer of a job is the answer of the
synchronous POST for the same seed. The single-objective engines happened to find the true optimum of this small
instance; that says nothing about larger ones. The Pareto sampling engines recovered the whole true front of 45
points; the evolutionary Pareto mode returned 37 points, every one on the true front but not all 45. None of this is a
guarantee, which is why the declared mode stays heuristic.

### Cancellation of a real process (job of 1,000,000 iterations / 10,000,000 evaluations, 40 tasks)

| engine | DELETE | after DELETE | busy CPU s per s (process / job thread) | CPU s in the 1.5 s after cancel (process / job thread) | GET after cancel | 2nd DELETE | follow-up job | DELETE in sync mode |
|---|---|---|---|---|---|---|---|---|
| random-search | 200 cancelled in 0.002 s | alive | 1.77 / 0.92 | 0.01 / 0.0 | failed: cancelled: requested by DELETE | 200 cancelled | completed | 404 |
| many-heuristic | 200 cancelled in 0.002 s | alive | 1.89 / 0.90 | 0.0 / 0.0 | failed: cancelled: requested by DELETE | 200 cancelled | completed | 404 |
| multi-heuristic | 200 cancelled in 0.003 s | alive | 1.70 / 0.90 | 0.01 / 0.0 | failed: cancelled: requested by DELETE | 200 cancelled | completed | 404 |
| evolutionary (elitist) | 200 cancelled in 0.003 s | alive | 1.79 / 0.86 | 0.02 / 0.0 | failed: cancelled: requested by DELETE | 200 cancelled | completed | 404 |
| evolutionary (pareto) | 200 cancelled in 0.003 s | alive | 1.89 / 0.88 | 0.04 / 0.0 | failed: cancelled: requested by DELETE | 200 cancelled | completed | 404 |

(Figures of the first of two complete runs; the second gave the same outcomes in every column, with CPU readings that
differ in the second decimal, e.g. busy 1.95 / 0.91 for random-search and 0.06 s after cancel for the evolutionary Pareto
mode.) The job thread (`engine-job-*`) burns about 0.9 CPU-seconds per second while the job runs (the rest of the process total is the
JIT compiler and collector working for it) and **0.0 after the confirmed cancel**; the process falls to 0.00-0.04 CPU
seconds over 1.5 s. The slot is free again (a follow-up job completes in the same process), the process stays up, and a
synchronous engine answers `404` to `DELETE`.

The assertions behind these figures: busy at least 0.3 CPU-seconds per second; at most 0.35 s for the process and 0.05 s for
the job thread in the 1.5 s after the cancel.

## 4. What the end-to-end run also covers

* A real process with `ENGINE_AUTH_TOKENS`: `401` without or with a wrong token, `202` for the owner, `401` for the owner's id
  without token, `404` for the same id with another tenant's token (both `GET` and `DELETE`), and `DELETE` of a finished
  job answers `completed`.
* A real process with a malformed `ENGINE_AUTH_TOKENS`, `PORT`, `ENGINE_JOB_MODE` or `ENGINE_JOB_MAX_QUEUED` exits non-zero
  and names the variable.
* `multi-heuristic`: in the default mode `/openapi.json` is byte-for-byte the pinned
  `src/main/resources/openapi.json`; in async mode it is that document plus the job endpoints and
  `extensions.cancellation`.
* The harness itself: package determinism, brute-force space, a truthful result agrees, a lie (`OPTIMAL`, forged
  features and score) is lowered and replaced, `/proc` CPU readings.

## 5. Lab run (current) and what was NOT run

**Lab run, `compose.lab-engines-java.json` at `31b7de6f` (reported by the controller, Docker real; this document did not
re-run it).** The JUnit suites ran in the engines' own builder stages: JDK 8 (seed, builder of `random-search`) and JDK 21
(evolutionary). `binding-core` 56 tests (25 `CanonicalEvaluatorConformanceTest` + 17 `EngineJobsTest` + 14 `EngineHttpTest`);
`random-search` 12 (4 `V1RandomSearchTest` + 8 `RandomSearchCancelTest`); `many-heuristic` 11 (3 + 8); `multi-heuristic` 12 (3 + 9);
`evolutionary-heuristics` 13 (5 + 8 `EvolutionaryCancelTest`). All 0 Failures, 0 Errors, 0 Skipped. Before the fix of `31b7de6f`
the services failed with `cp: Permission denied` (mode 700 of the builder's `COPY`); `RUN chmod -R a+rX /app` was added to the
four Dockerfiles. The Java engines are synchronous by default; remote cancellation is opt-in with `ENGINE_JOB_MODE=async`, and
in the lab they were **not** run in async mode behind the gateway (**NO EJECUTADO** end to end).

What follows is the worker-time list of limits; the first item is **superseded** by the run above.

* ~~**`compose.lab-engines-java.json` — NO EJECUTADO.**~~ (Superseded: executed in the lab, see above.) At the time of
  writing: it re-runs the JUnit suites in the engines' own builder stages (the
  JDK 8 of the production images, and JDK 21 for the evolutionary engine). The worker has no Docker; only its static
  rules ran (`lab/tests/test_lab_engines_java_profile.py`, part of the 35 above). It reuses the existing Dockerfile
  stages because adding a Dockerfile was outside the allowed files, and it needs network access to Maven Central when it runs.
* **No run on a JDK 8 runtime in the worker.** The container's JDK is newer; the modules are compiled with `source/target 1.8`
  (not `--release 8`), so a Java 9+ API used by mistake would compile here. The lab run above executed the tests on JDK 8
  (builder stage), which covers the test phase; a JDK 8 *runtime* of the production image behind the gateway was not run.
* **The gateway does not call `DELETE` for the Java engines.** (Superseded in part: since G2 the gateway sends `DELETE` for
  running jobs of an engine whose registration declares the capability; the bundled registrations declare it only for
  `minizinc-csp` or for names in `ENGINE_CANCELLATION_BUILTIN`. The Java engines in async mode behind the gateway are
  **NO EJECUTADO**.)
* **Timing-based assertions** (CPU, stop latency) are tolerant by design; on a heavily throttled host the CPU-burn
  precondition of the JUnit scenarios could still fail.
* **`multi-heuristic` has no manifest in `schemas/bim/v1/manifests`**; its declared guarantees come from the federation
  example `engine.json`.
