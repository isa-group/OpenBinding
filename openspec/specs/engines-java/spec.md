# engines-java Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/baseline` @ 9b5be00 — reverse-engineered, spec-anchored.

## Purpose

The JVM engines built by `engines/pom.xml`: the shared canonical evaluator and HTTP/job layer `binding-core`, and the
heuristic engines `random-search` (mode `seeded`), `many-heuristic` (`pareto-sampling`), `evolutionary-heuristics`
(`elitist-genetic`, `pareto-genetic`) and the federated example `multi-heuristic`. Protocol-level behaviour common to
all engines is in `engine-protocol`.

## Requirements

### Requirement: Canonical evaluator parity
THE `binding-core` evaluator SHALL compute features, constraint violations, penalties and objectives of a binding with the `qos-binding/v1` semantics of the BIM toolchain, without hidden tolerances.

`req~engines-java-canonical-evaluator~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/CanonicalEvaluatorConformanceTest.java::objectiveDominanceUsesExactDeclaredValuesWithoutHiddenTolerance`; `engines/binding-core/src/test/java/es/us/isa/openbinding/core/CanonicalEvaluatorConformanceTest.java::selectedCandidateIsCountedOnceAcrossXorAndRepeat`; GAP: no shared test vectors prove parity with `bim-core` (the gateway re-evaluates instead)

#### Scenario: Candidate selected in XOR and repeat
- **GIVEN** a workflow where one candidate is selected in an XOR branch and inside a repeat
- **WHEN** a `selectedCandidate`-scoped feature is aggregated
- **THEN** the candidate counts once

### Requirement: Java 8 bytecode
THE `binding-core`, `random-search` and `many-heuristic` modules SHALL compile to Java 8 bytecode and pass their tests on JDK 8 and JDK 21.

`req~engines-java-bytecode-target~1`

Evidence: `engines/binding-core/README.md`; `engines/binding-core/pom.xml`; `docs/qa/ENGINES_JAVA_IR02.md`

#### Scenario: Build on JDK 21
- **GIVEN** the CI job `engines` with JDK 21
- **WHEN** `mvn -B install` runs in `engines/`
- **THEN** every module builds and its JUnit suite passes

### Requirement: Synchronous by default, asynchronous on request
WHILE `ENGINE_JOB_MODE` is not `async`, THE Java engine SHALL answer `POST /internal/v1/binding-problems` synchronously and expose no job endpoints; WHERE `ENGINE_JOB_MODE=async`, THE Java engine SHALL answer 202 and expose `GET`/`DELETE /internal/v1/jobs/{id}` and `/openapi.json`.

`req~engines-java-job-mode~1`

Evidence: `engines/random-search/src/test/java/es/us/isa/qosawarewsbinding/api/RandomSearchCancelTest.java::withoutTheAsyncModeThereIsNoJobEndpointAndTheAnswerIsStillSynchronous`; `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineHttpTest.java::theDefaultModeIsSynchronousAndExposesNoJobs`

#### Scenario: Default deployment
- **GIVEN** a random-search container without `ENGINE_JOB_MODE`
- **WHEN** a client calls `GET /internal/v1/jobs/x`
- **THEN** the endpoint does not exist and solves are answered with 200

### Requirement: Cooperative cancellation
WHEN an asynchronous job is cancelled, THE Java engine SHALL stop the search at its next checkpoint, report `cancelled` only after the solver returned, and discard a late result of a solver that ignored the stop.

`req~engines-java-cooperative-cancel~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineJobsTest.java::cooperativeSolverStopsAtTheNextCheckpointAndCancelledIsConfirmed`; `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineJobsTest.java::aSolverThatIgnoresCancelIsCancellingNeverCancelledAndItsLateResultIsDiscarded`; `engines/many-heuristic/src/test/java/es/us/isa/qosawarewsbinding/api/ManyHeuristicCancelTest.java::deleteStopsTheSolverThreadAndItsCpu`

#### Scenario: Stubborn solver
- **GIVEN** a solver loop that never calls the checkpoint
- **WHEN** its job is cancelled
- **THEN** the job reads `cancelling`, never `cancelled`, and its eventual result is discarded

### Requirement: Tenant-owned jobs
WHERE `ENGINE_AUTH_TOKENS` is configured, THE Java engine SHALL require a bearer token on every endpoint, including the synchronous one, and SHALL make each job visible and cancellable only by the tenant that created it.

`req~engines-java-tenant-tokens~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineHttpTest.java::tokensGuardTheSynchronousEndpointToo`; `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineHttpTest.java::tenantsOwnTheirJobs`

#### Scenario: Missing token
- **GIVEN** `ENGINE_AUTH_TOKENS=gw=secret`
- **WHEN** a request arrives without `Authorization`
- **THEN** the engine refuses it

### Requirement: Pareto modes return a canonical archive
WHEN a Pareto mode (`pareto-sampling`, `pareto-genetic`) finishes, THE engine SHALL return the non-dominated bindings it found as solutions and SHALL answer `UNKNOWN` when the feasible archive is empty.

`req~engines-java-pareto-archive~1`

Evidence: `engines/many-heuristic/src/test/java/es/us/isa/qosawarewsbinding/search/V1ManySearchTest.java::paretoModeReturnsCanonicalArchive`; `engines/multi-heuristic/src/test/java/es/us/isa/qosawarewsbinding/search/V1MultiSearchTest.java::emptyFeasibleArchiveIsUnknown`; `engines/evolutionary-heuristics/src/test/java/es/us/isa/openbinding/evolutionary/EvolutionarySolverTest.java::paretoAlgorithmRequiresAndReturnsParetoSemantics`

#### Scenario: Two incomparable bindings
- **GIVEN** a two-objective problem where bindings A and B do not dominate each other
- **WHEN** the many-heuristic engine finishes
- **THEN** both A and B are returned as solutions

## Out of scope

- The QACO instance generator `bim-generator` (`generator`).
- Gateway re-evaluation of these answers (`job-execution`).

## TODO

- Option schemas and default budgets per mode (random-search 1,000 evaluations; evolutionary population 100 / 10,000 evaluations per the QACOBench README).
- Placement evaluation in `binding-core` (capacity, network/event latency, transitions) as requirements.
- Java engines in async mode behind the gateway end to end: NOT EXECUTED (`docs/qa/JOINT_STATUS.md`).
