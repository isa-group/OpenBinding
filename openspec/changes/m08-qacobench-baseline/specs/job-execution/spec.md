## MODIFIED Requirements

### Requirement: Failed jobs show catalog sentences only
WHEN a job fails, THE gateway SHALL store and show only a stable failure code from the job-failure catalog (e.g. `engine_rejected`, `engine_incompatible`, `lease_lost`) with its fixed sentence, and SHALL keep the engine's own text, hosts and addresses out of every table and response, logging them with the job id instead.

`req~job-execution-failure-catalog~2`

Needs: impl, utest

Revision 2: the observable outcome of an engine 422 changes from `engine_rejected` to `engine_incompatible` (CRP-M08-1),
so code and tests that cover revision 1 must be re-checked and re-tagged by slice S1.

Evidence: `openbinding-gateway/tests/test_job_error_text.py`; `openbinding-gateway/src/openbinding_gateway/core/public_errors.py`

#### Scenario: Engine refuses the IR with 422
- **GIVEN** a running job whose engine answers 422 with a detailed rejection
- **WHEN** the worker records the failure
- **THEN** the job shows code `engine_incompatible` and its catalog sentence, and the engine's detail appears only in the log

#### Scenario: Engine refuses the IR with 503
- **GIVEN** a running job whose engine answers 503 with a detailed message
- **WHEN** the worker records the failure
- **THEN** the job shows code `engine_rejected` and "The engine rejected the request." and the engine's detail appears only in the log

## ADDED Requirements

### Requirement: Engine capability refusal has its own failure code
WHEN the engine answers 422 to `POST BindingProblem` for a running job, THE gateway SHALL fail the job with code `engine_incompatible` instead of `engine_rejected`.
`req~job-execution-engine-incompatible~1`

Needs: impl, utest

Evidence: `openbinding-gateway/tests/test_job_error_text.py`; `openbinding-gateway/tests/test_job_failure_contract.py`

#### Scenario: Engine 422 at execution
- **GIVEN** a running job on `minizinc-csp` whose engine answers 422 with body `{"detail": "soft constraint not supported"}`
- **WHEN** the worker records the failure
- **THEN** the job's result has `code: "engine_incompatible"` and `error` equal to the catalog sentence of `engine_incompatible`
- **AND** the text `soft constraint not supported` appears in no response or table, only in the log line with the job id

#### Scenario: Engine 400 at execution
- **GIVEN** a running job whose engine answers 400 to `POST BindingProblem`
- **WHEN** the worker records the failure
- **THEN** the job's result has `code: "engine_rejected"`
