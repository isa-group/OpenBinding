## MODIFIED Requirements

### Requirement: Refusal before work
IF the IR or the options are not supported by the requested mode (unknown option, construct outside the mode), THEN THE engine SHALL answer 422 with a problem document before creating any job.

`req~engine-protocol-refusal-before-work~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineHttpTest.java`

#### Scenario: Unknown option
- **GIVEN** the `seeded` mode of random-search
- **WHEN** a request carries an option `temperature`
- **THEN** the engine answers 422 and no job id is issued

### Requirement: Catalog-qualified candidate identity
THE engine SHALL identify every candidate in a returned decision by the full `{resource, id}` reference, never by a bare local id or an index.

`req~engine-protocol-qualified-identity~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/CanonicalEvaluatorConformanceTest.java`; `engines/minizinc-csp/src/conformance.test.ts`

#### Scenario: Equal local ids in two catalogs
- **GIVEN** two catalogs that both contain a candidate with id `s1`
- **WHEN** an engine returns a binding that selects the second catalog's `s1`
- **THEN** the decision names `{resource: <second catalog>, id: "s1"}`

### Requirement: Optional cancellation extension
WHERE an engine declares the cancellation capability, THE engine SHALL answer `DELETE /internal/v1/jobs/{id}` by stopping and reaping the solver (200 `cancelled`) and removing a queued job without running it.

`req~engine-protocol-cancellation~2`

Evidence: `engines/minizinc-csp/src/cancel.test.ts`; GAP: `DELETE` and the capability are not in `schemas/engine-contract.openapi.yaml`

#### Scenario: Queued job is cancelled
- **GIVEN** a queued job
- **WHEN** a client calls `DELETE /internal/v1/jobs/{id}`
- **THEN** the job is removed and its solver never starts

### Requirement: Cancellation confirmation
WHERE an engine declares the cancellation capability, THE engine SHALL answer `DELETE` with 202 `cancelling` and `Retry-After` while the solver is not confirmed gone, and with the final state unchanged for a finished job.

`req~engine-protocol-cancel-confirmation~1`

Evidence: `engines/binding-core/src/test/java/es/us/isa/openbinding/core/EngineJobsTest.java`; `engines/minizinc-csp/src/cancel.test.ts`

#### Scenario: Cancel races completion
- **GIVEN** a running job whose solver finishes at the moment `DELETE` arrives
- **WHEN** both happen
- **THEN** exactly one final state is reported and never changes afterwards

### Requirement: Honest termination
THE engine SHALL claim `OPTIMAL` or `INFEASIBLE` only when its mode proves it, and heuristic modes SHALL answer `FEASIBLE` when they found a feasible binding and `UNKNOWN` otherwise.

`req~engine-protocol-honest-termination~1`

Evidence: `engines/random-search/src/test/java/es/us/isa/qosawarewsbinding/search/V1RandomSearchTest.java`

#### Scenario: Empty sample
- **GIVEN** a random search that found no feasible binding in its budget
- **WHEN** it answers
- **THEN** the termination is `UNKNOWN`, not `INFEASIBLE`
