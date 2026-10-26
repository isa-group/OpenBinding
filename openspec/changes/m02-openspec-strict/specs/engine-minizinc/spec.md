## MODIFIED Requirements

### Requirement: Declared exact-weighted subset
IF an IR uses a construct outside the 1.1.1 `exact-weighted` mode (conditional XOR, custom aggregation expressions, dynamic soft penalties, expressions other than `and`-joined comparisons, interval feature values), THEN THE engine SHALL reject it with 422 naming the construct before queueing a job.

`req~engine-minizinc-declared-subset~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`

#### Scenario: Conditional XOR
- **GIVEN** an IR with a conditional exclusive gateway
- **WHEN** it is posted to the `exact-weighted` mode
- **THEN** the engine answers 422 naming the construct and no job id is issued

### Requirement: Supported constructs of 1.1.1
WHEN an IR uses only task, empty, sequence, parallel, probabilistic XOR, repeat with `count` or `expectedCount`, and additive, min/max or multiplicative aggregations (`product`, `weightedProduct`, `power`), THE engine SHALL solve it.

`req~engine-minizinc-supported-constructs~2`

Evidence: `schemas/bim/v1/manifests/minizinc-csp.json`; `openbinding-gateway/tests/test_generator_routes.py`

#### Scenario: Parallel block with a product aggregation
- **GIVEN** an IR with a parallel block and a `product` aggregation
- **WHEN** it is posted
- **THEN** the engine accepts it and returns a decision

### Requirement: Status mapping
WHEN a run finishes, THE engine SHALL report `OPTIMAL` for a completed optimality proof, `FEASIBLE` for an incumbent at the time limit, `INFEASIBLE` only for a solver proof that no assignment exists, and `UNKNOWN` for a run without an incumbent.

`req~engine-minizinc-status-mapping~1`

Evidence: `engines/minizinc-csp/src/conformance.test.ts`; `engines/minizinc-csp/src/solver.ts`

#### Scenario: Time limit with an incumbent
- **GIVEN** `time_budget_ms: 1000` and a problem the solver cannot prove in 1 s
- **WHEN** the run reaches the time limit with a solution
- **THEN** the termination is `FEASIBLE`

### Requirement: No false optima at boundaries
WHEN the lowering prints technical bounds or the literal of a non-strict comparison, THE engine SHALL widen it by the documented numeric slack so that a binding whose value equals a bound exactly is not excluded by float rounding during flattening.

`req~engine-minizinc-boundary-slack~1`

Evidence: `engines/minizinc-csp/src/numeric.ts`; `engines/minizinc-csp/src/conformance.test.ts`

#### Scenario: Limit generated from a reference binding
- **GIVEN** a constraint limit equal to the exact value of a reference binding (as in `qfbs_guaranteed_20_011`)
- **WHEN** the problem is solved
- **THEN** the reference binding remains feasible for the solver

### Requirement: Solver process containment
WHEN a job is cancelled or exceeds its budget, THE engine SHALL terminate the process group of every phase (flatten, `fzn-gecode`, optional `.ozn` rendering), escalating from SIGTERM to SIGKILL, and reap it before reporting the job cancelled.

`req~engine-minizinc-process-containment~1`

Evidence: `engines/minizinc-csp/src/minizinc_runner.test.ts`; `engines/minizinc-csp/src/cancel.test.ts`

#### Scenario: Cancel during search
- **GIVEN** a job in the `fzn-gecode` phase
- **WHEN** it is cancelled
- **THEN** no process of that phase is alive when the engine answers `cancelled`

### Requirement: Pinned solver version
THE engine image SHALL install the official MiniZinc 2.8.7 bundle (Gecode 6.3.0) verified by SHA-256 and self-tested at build time, and SHALL report the solver version so that experiments can record it.

`req~engine-minizinc-pinned-solver~1`

Evidence: `engines/minizinc-csp/Dockerfile`; `docs/adr/0007-pinned-minizinc-bundle.md`

#### Scenario: Image build with a tampered bundle
- **GIVEN** a downloaded bundle whose SHA-256 differs from the pinned one
- **WHEN** the image is built
- **THEN** the build fails
