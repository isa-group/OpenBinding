# engine-protocol Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

The `bim-engine/v1` contract every engine service implements (`schemas/engine-contract.openapi.yaml`) and the
manifest by which an engine declares its modes (`schemas/bim/v1/engine.schema.json`, bundled manifests in
`schemas/bim/v1/manifests/`). It applies to the bundled engines and to federated third-party engines.

## Requirements

### Requirement: IR-only solve endpoint
WHEN an engine receives `POST /internal/v1/binding-problems`, THE engine SHALL accept only a canonical `bim/v1` `BindingProblem` request with the options of one declared mode, and SHALL answer 200 with a `BindingResult` or 202 with a job receipt.

`req~engine-protocol-ir-only~1`

Evidence: `schemas/engine-contract.openapi.yaml`; `engines/random-search/src/test/java/es/us/isa/qosawarewsbinding/search/V1RandomSearchTest.java`

#### Scenario: Source package sent to an engine
- **GIVEN** a request whose body is an `Instance` source envelope instead of an IR
- **WHEN** it reaches any bundled engine
- **THEN** the engine answers 422 and creates no job

### Requirement: Refusal before work
IF the IR or the options are not supported by the requested mode (unknown option, construct outside the mode), THEN THE engine SHALL answer 422 with a problem document before creating any job.

`req~engine-protocol-refusal-before-work~1`

Evidence: `engines/random-search/src/test/java/es/us/isa/qosawarewsbinding/api/RandomSearchCancelTest.java`; `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineHttpTest.java`

#### Scenario: Unknown option
- **GIVEN** the `seeded` mode of random-search
- **WHEN** a request carries an option `temperature`
- **THEN** the engine answers 422 and no job id is issued

### Requirement: Catalog-qualified candidate identity
THE engine SHALL identify every candidate in a returned decision by the full `{resource, id}` reference, never by a bare local id or an index.

`req~engine-protocol-qualified-identity~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/CanonicalEvaluatorConformanceTest.java`; `engines/random-search/src/test/java/es/us/isa/qosawarewsbinding/search/V1RandomSearchTest.java`; `engines/minizinc-csp/src/conformance.test.ts`

#### Scenario: Equal local ids in two catalogs
- **GIVEN** two catalogs that both contain a candidate with id `s1`
- **WHEN** an engine returns a binding that selects the second catalog's `s1`
- **THEN** the decision names `{resource: <second catalog>, id: "s1"}`

### Requirement: Asynchronous jobs
WHERE an engine runs in asynchronous mode, THE engine SHALL issue random unguessable job ids, report `GET /internal/v1/jobs/{id}` as `queued`, `running`, `completed` or `failed`, and keep terminal states immutable.

`req~engine-protocol-async-jobs~2`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineHttpTest.java`; `engines/minizinc-csp/src/job_manager.test.ts`

#### Scenario: Cancelled job whose solver later returns
- **GIVEN** a cancelled job whose solver later returns a result
- **WHEN** a client polls it
- **THEN** the job is not reopened

### Requirement: Job isolation between tenants
WHERE an engine runs in asynchronous mode, THE engine SHALL answer an unknown job id and another tenant's job id with an identical 404.

`req~engine-protocol-job-isolation~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineJobsTest.java::aForeignOrUnknownIdIsNotFoundAndNothingIsCancelledForAnotherTenant`

#### Scenario: Another tenant polls a job
- **GIVEN** a job created with tenant A's token
- **WHEN** tenant B calls `GET /internal/v1/jobs/{id}`
- **THEN** the engine answers 404 with the same body as for an unknown id

### Requirement: Optional cancellation extension
WHERE an engine declares the cancellation capability, THE engine SHALL answer `DELETE /internal/v1/jobs/{id}` by stopping and reaping the solver (200 `cancelled`) and removing a queued job without running it.

`req~engine-protocol-cancellation~2`

Evidence: `engines/minizinc-csp/src/cancel.test.ts`; `engines/minizinc-csp/README.md`; GAP: `DELETE` and the capability are not in `schemas/engine-contract.openapi.yaml`

#### Scenario: Queued job is cancelled
- **GIVEN** a queued job
- **WHEN** a client calls `DELETE /internal/v1/jobs/{id}`
- **THEN** the job is removed and its solver never starts

### Requirement: Cancellation confirmation
WHERE an engine declares the cancellation capability, THE engine SHALL answer `DELETE` with 202 `cancelling` and `Retry-After` while the solver is not confirmed gone, and with the final state unchanged for a finished job.

`req~engine-protocol-cancel-confirmation~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineJobsTest.java`; `engines/minizinc-csp/src/cancel.test.ts`; `openbinding-gateway/tools/cancel_probe.py`

#### Scenario: Cancel races completion
- **GIVEN** a running job whose solver finishes at the moment `DELETE` arrives
- **WHEN** both happen
- **THEN** exactly one final state is reported and never changes afterwards

### Requirement: Determinism under a seed
WHEN a randomised engine mode receives the same IR, options and seed, THE engine SHALL return the same decisions.

`req~engine-protocol-seeded-determinism~1`

Evidence: `engines/random-search/src/test/java/es/us/isa/qosawarewsbinding/api/RandomSearchCancelTest.java`; `engines/evolutionary-heuristics/src/test/java/es/us/isa/openbinding/evolutionary/EvolutionaryCancelTest.java`

#### Scenario: Re-run with the same seed
- **GIVEN** an IR and `seed: 42`
- **WHEN** the evolutionary engine is called twice
- **THEN** both answers contain the same bindings

### Requirement: Honest termination
THE engine SHALL claim `OPTIMAL` or `INFEASIBLE` only when its mode proves it, and heuristic modes SHALL answer `FEASIBLE` when they found a feasible binding and `UNKNOWN` otherwise.

`req~engine-protocol-honest-termination~1`

Evidence: `engines/random-search/src/test/java/es/us/isa/qosawarewsbinding/search/V1RandomSearchTest.java`; `engines/evolutionary-heuristics/src/test/java/es/us/isa/openbinding/evolutionary/EvolutionarySolverTest.java`

#### Scenario: Empty sample
- **GIVEN** a random search that found no feasible binding in its budget
- **WHEN** it answers
- **THEN** the termination is `UNKNOWN`, not `INFEASIBLE`

## Out of scope

- How the gateway selects, verifies, calls and re-evaluates engines (`job-execution`, `engine-registry`).
- Engine-specific modelling (`engine-minizinc`, `engines-java`).

## TODO

- Add the `DELETE` cancellation operation and the job-cancel capability to `schemas/engine-contract.openapi.yaml` (contract change → CRP).
- Engine manifest requirements (modes, selectors, options schema, termination guarantees) as their own requirements.
- Authentication between gateway and engines (`ENGINE_AUTH_TOKENS`, registration credentials).
