# engine-minizinc Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c = owner's 014e43a + platform work) — reverse-engineered, spec-anchored.

## Purpose

The exact engine `bim.builtin/minizinc-csp@1.1.1` (`engines/minizinc-csp/`): lowers an explicitly declared subset of
the canonical IR to `model/binding_problem.mzn`, flattens it with MiniZinc and solves it with `fzn-gecode` from the
pinned MiniZinc 2.8.7 / Gecode 6.3.0 bundle, and answers through `bim-engine/v1` with asynchronous jobs and
cancellation. Engine documentation: `engines/minizinc-csp/README.md`, `engines/minizinc-csp/MULTIPLICATIVE_AGGREGATIONS.md`.

## Requirements

### Requirement: Declared exact-weighted subset
IF an IR uses a construct outside the 1.1.1 `exact-weighted` mode (conditional XOR, custom aggregation expressions, dynamic soft penalties, expressions other than `and`-joined comparisons, interval feature values), THEN THE engine SHALL reject it with 422 naming the construct before queueing a job.

`req~engine-minizinc-declared-subset~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `schemas/bim/v1/manifests/minizinc-csp.json`

#### Scenario: Conditional XOR
- **GIVEN** an IR with a conditional exclusive gateway
- **WHEN** it is posted to the `exact-weighted` mode
- **THEN** the engine answers 422 naming the construct and no job id is issued

### Requirement: Supported constructs of 1.1.1
WHEN an IR uses only task, empty, sequence, parallel, probabilistic XOR, repeat with `count` or `expectedCount`, and additive, min/max or multiplicative aggregations (`product`, `weightedProduct`, `power`), THE engine SHALL solve it.

`req~engine-minizinc-supported-constructs~2`

Evidence: `schemas/bim/v1/manifests/minizinc-csp.json`; `openbinding-gateway/tests/test_generator_routes.py::test_target_engine_rejects_unsupported_objective_and_aggregation`

#### Scenario: Parallel block with a product aggregation
- **GIVEN** an IR with a parallel block and a `product` aggregation
- **WHEN** it is posted
- **THEN** the engine accepts it and returns a decision

### Requirement: Supported constraints and placement
WHEN an IR adds hard or soft comparison constraints with constant non-negative penalties (optionally joined by `and`), the complete placement overlay, or both to the declared constructs, THE engine SHALL solve it.

`req~engine-minizinc-supported-constraints~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `schemas/bim/v1/manifests/minizinc-csp.json`

#### Scenario: Selected-candidate product with a soft constraint
- **GIVEN** an IR with a `selection.product` feature and a soft constraint with a constant penalty
- **WHEN** it is posted
- **THEN** the engine accepts it and returns a decision

### Requirement: Status mapping
WHEN a run finishes, THE engine SHALL report `OPTIMAL` for a completed optimality proof, `FEASIBLE` for an incumbent at the time limit, `INFEASIBLE` only for a solver proof that no assignment exists, and `UNKNOWN` for a run without an incumbent.

`req~engine-minizinc-status-mapping~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `engines/minizinc-csp/src/solver.ts`; `schemas/bim/v1/manifests/minizinc-csp.json`

#### Scenario: Time limit with an incumbent
- **GIVEN** `time_budget_ms: 1000` and a problem the solver cannot prove in 1 s
- **WHEN** the run reaches the time limit with a solution
- **THEN** the termination is `FEASIBLE`

### Requirement: Options
THE engine SHALL accept only the options `solver` (fixed to `gecode`), `time_budget_ms` (flattening and search together) and `product_constraints` (`log`, default, or `real`).

`req~engine-minizinc-options~1`

Evidence: `schemas/bim/v1/manifests/minizinc-csp.json`; `engines/minizinc-csp/README.md`; `engines/minizinc-csp/src/minizinc_runner.test.ts`

#### Scenario: Another solver requested
- **GIVEN** a request with `solver: "chuffed"`
- **WHEN** it is posted
- **THEN** the engine answers 422

### Requirement: No false optima at boundaries
WHEN the lowering prints technical bounds or the literal of a non-strict comparison, THE engine SHALL widen it by the documented numeric slack so that a binding whose value equals a bound exactly is not excluded by float rounding during flattening.

`req~engine-minizinc-boundary-slack~1`

Evidence: `engines/minizinc-csp/src/numeric.ts`; `engines/minizinc-csp/README.md`; `engines/minizinc-csp/src/conformance.test.ts`

#### Scenario: Limit generated from a reference binding
- **GIVEN** a constraint limit equal to the exact value of a reference binding (as in `qfbs_guaranteed_20_011`)
- **WHEN** the problem is solved
- **THEN** the reference binding remains feasible for the solver

### Requirement: Index translation
WHEN the solver returns selection indices, THE engine SHALL translate them back to full `{resource, id}` candidate references before answering.

`req~engine-minizinc-index-translation~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `engines/minizinc-csp/src/dzn_builder.ts`

#### Scenario: Candidate at index 3
- **GIVEN** a task whose eligibility list has `{catalog-b, s1}` at position 3
- **WHEN** the solver selects index 3
- **THEN** the decision names `{resource: "catalog-b", id: "s1"}`

### Requirement: Solver process containment
WHEN a job is cancelled or exceeds its budget, THE engine SHALL terminate the process group of every phase (flatten, `fzn-gecode`, optional `.ozn` rendering), escalating from SIGTERM to SIGKILL, and reap it before reporting the job cancelled.

`req~engine-minizinc-process-containment~1`

Evidence: `engines/minizinc-csp/src/minizinc_runner.test.ts`; `engines/minizinc-csp/src/cancel.test.ts`; `openbinding-gateway/tools/cancel_probe.py`

#### Scenario: Cancel during search
- **GIVEN** a job in the `fzn-gecode` phase
- **WHEN** it is cancelled
- **THEN** no process of that phase is alive when the engine answers `cancelled`

### Requirement: Bounded queue
IF the job queue is full, THEN THE engine SHALL answer 503 with `Retry-After` and SHALL NOT accept the job.

`req~engine-minizinc-bounded-queue~1`

Evidence: `engines/minizinc-csp/src/cancel.test.ts`; `engines/minizinc-csp/src/job_manager.test.ts`

#### Scenario: Full queue
- **GIVEN** the configured number of queued jobs
- **WHEN** another job is posted
- **THEN** the engine answers 503 with a `Retry-After` header

### Requirement: Pinned solver version
THE engine image SHALL install the official MiniZinc 2.8.7 bundle (Gecode 6.3.0) verified by SHA-256 and self-tested at build time, and SHALL report the solver version so that experiments can record it.

`req~engine-minizinc-pinned-solver~1`

Evidence: `engines/minizinc-csp/Dockerfile`; `experimentation/qacobench/reference/1.1.1/minizinc_versions.txt`; `docs/adr/0007-pinned-minizinc-bundle.md`

#### Scenario: Image build with a tampered bundle
- **GIVEN** a downloaded bundle whose SHA-256 differs from the pinned one
- **WHEN** the image is built
- **THEN** the build fails

## Out of scope

- Heuristic engines (`engines-java`); gateway-side re-evaluation (`job-execution`).

## TODO

- Placement lowering requirements (pools, capacity, network latency) in detail.
- `product_constraints: real` semantics and its tolerance as a requirement.
- Real-solver tests run only in the lab (`pnpm test:lab`); decide whether CI should run them in the engine image.
