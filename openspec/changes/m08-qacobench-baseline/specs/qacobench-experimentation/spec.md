## MODIFIED Requirements

### Requirement: Capability rejections are data
WHEN a submission or a job ends in an engine capability refusal, THE campaign runner SHALL record the execution as `INCOMPATIBLE` with its diagnostics only if the failed job's result `code` equals `engine_incompatible` or the submission's 422 problem `code` equals `engine_mode_incompatible`, SHALL record every other error (including `engine_rejected` and `validation_error`) as `ERROR`, and SHALL never parse the error message text to classify it; IF a quota, communication or unclassified infrastructure error occurs, THEN THE campaign runner SHALL stop.

`req~qacobench-experimentation-incompatible-is-data~2`

Needs: impl, utest

Evidence: `experimentation/qacobench/campaign.py`; `experimentation/qacobench/test_qacobench.py`

This revision resolves in part the TODO "Job-level capability rejections" of the living spec: the classification by
code is specified here. Re-running the campaign as 1.1.2 against `reference/1.1.1` provenance digests stays an owner
step (CRP-M08-2) and is out of scope. Until the gateway emits `engine_incompatible` (slice S1, after CRP-M08-1), a
job coded `engine_rejected` is recorded `ERROR`, and an `ERROR` result stops the campaign (`campaign.py` raises on
`ERROR`), so the 1.1.2 re-run needs S1.

#### Scenario: MiniZinc refuses a soft constraint
- **GIVEN** an instance with a soft constraint expression
- **WHEN** it is submitted to `minizinc-csp` and the job fails with result `code: "engine_incompatible"`
- **THEN** the record is `INCOMPATIBLE` with the job's diagnostics and the campaign continues

#### Scenario: Job fails with engine_incompatible
- **GIVEN** a job on `minizinc-csp` whose failed result is `{termination: "UNKNOWN", solutions: [], code: "engine_incompatible", error: "The engine does not support a construct or option of this problem."}`
- **WHEN** the campaign runner normalises the result
- **THEN** the record is `INCOMPATIBLE` with diagnostics `[{"code": "engine_incompatible", "message": "The engine does not support a construct or option of this problem."}]`
- **AND** the campaign continues

#### Scenario: Job fails with engine_rejected
- **GIVEN** a failed job result with `code: "engine_rejected"` and `error: "engine rejected BindingProblem (422): soft constraint"`
- **WHEN** the campaign runner normalises the result
- **THEN** the record is `ERROR`, not `INCOMPATIBLE`, although the message starts with the old 422 prefix

#### Scenario: Submission refused for the engine mode
- **GIVEN** `POST /v1/jobs` answers 422 with problem `code: "engine_mode_incompatible"` and diagnostics
- **WHEN** the campaign runner records the submission
- **THEN** the record is `INCOMPATIBLE` with those diagnostics and the campaign continues

#### Scenario: Submission refused for validation
- **GIVEN** `POST /v1/jobs` answers 422 with problem `code: "validation_error"`
- **WHEN** the campaign runner records the submission
- **THEN** the record is `ERROR`
