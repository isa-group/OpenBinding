## MODIFIED Requirements

### Requirement: Canonical evaluator parity
THE `binding-core` evaluator SHALL compute features, constraint violations, penalties and objectives of a binding with the `qos-binding/v1` semantics of the BIM toolchain, without hidden tolerances.

`req~engines-java-canonical-evaluator~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/CanonicalEvaluatorConformanceTest.java`; GAP: no shared test vectors prove parity with `bim-core`

#### Scenario: Candidate selected in XOR and repeat
- **GIVEN** a workflow where one candidate is selected in an XOR branch and inside a repeat
- **WHEN** a `selectedCandidate`-scoped feature is aggregated
- **THEN** the candidate counts once

### Requirement: Synchronous by default, asynchronous on request
WHILE `ENGINE_JOB_MODE` is not `async`, THE Java engine SHALL answer `POST /internal/v1/binding-problems` synchronously and expose no job endpoints; WHERE `ENGINE_JOB_MODE=async`, THE Java engine SHALL answer 202 and expose `GET`/`DELETE /internal/v1/jobs/{id}` and `/openapi.json`.

`req~engines-java-job-mode~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineHttpTest.java`

#### Scenario: Default deployment
- **GIVEN** a random-search container without `ENGINE_JOB_MODE`
- **WHEN** a client calls `GET /internal/v1/jobs/x`
- **THEN** the endpoint does not exist and solves are answered with 200

### Requirement: Pareto modes return a canonical archive
WHEN a Pareto mode (`pareto-sampling`, `pareto-genetic`) finishes, THE engine SHALL return the non-dominated bindings it found as solutions.

`req~engines-java-pareto-archive~2`

Evidence: `engines/many-heuristic/src/test/java/es/us/isa/qosawarewsbinding/search/V1ManySearchTest.java`; `engines/evolutionary-heuristics/src/test/java/es/us/isa/openbinding/evolutionary/EvolutionarySolverTest.java`

#### Scenario: Two incomparable bindings
- **GIVEN** a two-objective problem where bindings A and B do not dominate each other
- **WHEN** the many-heuristic engine finishes
- **THEN** both A and B are returned as solutions
