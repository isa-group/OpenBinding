# engine-minizinc Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/baseline` @ 9b5be00 — reverse-engineered, spec-anchored. The owner's release 014e43a (`origin/feat-isa`)
changes this engine (pinned bundle, multiplicative aggregations, numeric encoding); those changes are not in the baseline.

## Purpose

The exact engine `bim.builtin/minizinc-csp@1.0.0` (`engines/minizinc-csp/`): lowers an explicitly declared subset of
the canonical IR to `model/binding_problem.mzn`, solves it with MiniZinc + Gecode, and answers through
`bim-engine/v1` with asynchronous jobs and cancellation.

## Requirements

### Requirement: Declared exact-weighted subset
IF an IR uses a construct outside the `exact-weighted` mode (conditional XOR, expected repeat counts, soft ConstraintSet expressions, custom expressions, nonlinear aggregations), THEN THE engine SHALL reject it with 422 before queueing any job.

`req~engine-minizinc-declared-subset~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `engines/minizinc-csp/README.md`; `schemas/bim/v1/manifests/minizinc-csp.json`

#### Scenario: Soft constraint expression
- **GIVEN** an IR with a soft ConstraintSet expression
- **WHEN** it is posted to the `exact-weighted` mode
- **THEN** the engine answers 422 and no job id is issued

### Requirement: Status mapping
WHEN MiniZinc finishes, THE engine SHALL report `OPTIMAL` for a completed optimality proof, `FEASIBLE` for an incumbent at the time limit, `INFEASIBLE` only for a solver proof that no assignment exists, and `UNKNOWN` for a run without an incumbent.

`req~engine-minizinc-status-mapping~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `engines/minizinc-csp/src/solver.ts`; `schemas/bim/v1/manifests/minizinc-csp.json`

#### Scenario: Time limit with an incumbent
- **GIVEN** `time_budget_ms: 1000` and a problem MiniZinc cannot prove in 1 s
- **WHEN** the run reaches the time limit with a solution
- **THEN** the termination is `FEASIBLE`

### Requirement: Options
THE engine SHALL accept only the options `solver` (fixed to `gecode`) and `time_budget_ms`, and SHALL pass `time_budget_ms` to MiniZinc as `--time-limit`.

`req~engine-minizinc-options~1`

Evidence: `engines/minizinc-csp/README.md`; `engines/minizinc-csp/src/minizinc_runner.ts`; `engines/minizinc-csp/src/minizinc_runner.test.ts`

#### Scenario: Another solver requested
- **GIVEN** a request with `solver: "chuffed"`
- **WHEN** it is posted
- **THEN** the engine answers 422

### Requirement: Index translation
WHEN MiniZinc returns selection indices, THE engine SHALL translate them back to full `{resource, id}` candidate references before answering.

`req~engine-minizinc-index-translation~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `engines/minizinc-csp/src/dzn_builder.ts`

#### Scenario: Candidate at index 3
- **GIVEN** a task whose eligibility list has the candidate `{catalog-b, s1}` at position 3
- **WHEN** MiniZinc selects index 3
- **THEN** the decision names `{resource: "catalog-b", id: "s1"}`

### Requirement: Solver process containment
WHEN a job is cancelled or exceeds its budget, THE engine SHALL terminate the whole solver process group (escalating from SIGTERM to SIGKILL) and reap it before reporting the job as cancelled.

`req~engine-minizinc-process-containment~1`

Evidence: `engines/minizinc-csp/src/minizinc_runner.test.ts`; `engines/minizinc-csp/src/cancel.test.ts`; `engines/minizinc-csp/Dockerfile`

#### Scenario: Grandchild outlives the leader
- **GIVEN** a solver whose grandchild keeps running after the leader exits
- **WHEN** the job is cancelled
- **THEN** no process of the group is alive when the engine answers `cancelled`

### Requirement: Bounded queue
IF the job queue is full, THEN THE engine SHALL answer 503 with `Retry-After` and SHALL NOT accept the job.

`req~engine-minizinc-bounded-queue~1`

Evidence: `engines/minizinc-csp/src/cancel.test.ts`; `engines/minizinc-csp/src/job_manager.test.ts`

#### Scenario: Full queue
- **GIVEN** the configured number of queued jobs
- **WHEN** another job is posted
- **THEN** the engine answers 503 with a `Retry-After` header

### Requirement: Pinned solver version
THE engine image SHALL install a MiniZinc/Gecode release pinned by version and verified by SHA-256, and SHALL report the solver version so that experiments can record it.

`req~engine-minizinc-pinned-solver~1`

Evidence: GAP on the baseline branch (`engines/minizinc-csp/Dockerfile` installs the distribution package, 2.6.4 per `docs/qa/JOINT_STATUS.md`); implemented on the owner's branch origin/feat-isa (MiniZinc 2.8.7 + Gecode 6.3.0, see `docs/adr/0007-pinned-minizinc-bundle.md`)

#### Scenario: Image build with a tampered bundle
- **GIVEN** a downloaded bundle whose SHA-256 differs from the pinned one
- **WHEN** the image is built
- **THEN** the build fails

## Out of scope

- Heuristic engines (`engines-java`); gateway-side re-evaluation (`job-execution`).
- Multiplicative aggregations (`MULTIPLICATIVE_AGGREGATIONS.md` on `origin/feat-isa`), pending integration.

## TODO

- Placement lowering requirements (pools, capacity, network latency).
- Real-MiniZinc tests run only in the lab (`pnpm test:lab`, 5 tests); decide whether CI should run them in the engine image.
- Re-baseline this spec after the owner's 014e43a engine changes are integrated.
