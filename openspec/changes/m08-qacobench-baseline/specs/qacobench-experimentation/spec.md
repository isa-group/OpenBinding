## MODIFIED Requirements

### Requirement: Capability rejections are data
WHEN a submission or a job ends in an engine capability refusal, THE campaign runner SHALL record the execution as `INCOMPATIBLE` with its diagnostics only if the failed job's result `code` equals `engine_incompatible` or the top-level `code` of the submission's 422 problem document equals `engine_mode_incompatible`, SHALL record every other error (including `engine_rejected`, `validation_error` and a failed job without a code or an error text) as `ERROR`, and SHALL never parse the error message text to classify it; IF a quota, communication or unclassified infrastructure error occurs, THEN THE campaign runner SHALL stop.

`req~qacobench-experimentation-incompatible-is-data~2`

Needs: impl, utest

Evidence: `experimentation/qacobench/campaign.py`; `experimentation/qacobench/test_qacobench.py`

This revision resolves in part the TODO "Job-level capability rejections" of the living spec: the classification by
code is specified here. Re-running the campaign as 1.1.2 against `reference/1.1.1` provenance digests stays an owner
step (CRP-M08-2) and is out of scope. Until the gateway emits `engine_incompatible` (slice S1, after CRP-M08-1), a
job coded `engine_rejected` is recorded `ERROR`, and an `ERROR` result stops the campaign (`campaign.py` raises on
`ERROR`), so the 1.1.2 re-run needs S1.

The submission refusal is the gateway's RFC 7807 problem document: the campaign runner reads its top-level `code` and
its top-level `diagnostics` list; `detail` is a string and is never parsed. A job counts as failed only when its
status is `failed`: a completed job is never `INCOMPATIBLE`, whatever `code` its result carries.

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

#### Scenario: Failed job without a code or an error text
- **GIVEN** a job with status `failed` whose result is `{termination: "UNKNOWN", solutions: []}`, with no `code` and no `error`
- **WHEN** the campaign runner normalises the result
- **THEN** the record is `ERROR`, not `INCOMPATIBLE` and not `TIMEOUT`

#### Scenario: Completed job carrying a code
- **GIVEN** a job with status `completed` whose result has `termination: "FEASIBLE"` and `code: "engine_incompatible"`
- **WHEN** the campaign runner normalises the result
- **THEN** the record is not `INCOMPATIBLE`

#### Scenario: Submission refused for the engine mode
- **GIVEN** `POST /v1/jobs` answers 422 with a problem document whose top-level fields are `status: 422`, `code: "engine_mode_incompatible"`, a string `detail` and `diagnostics: [{"code": "engine_mode_incompatible", "message": "mode optimize is not supported"}]`
- **WHEN** the campaign runner records the submission
- **THEN** the record is `INCOMPATIBLE` with diagnostics equal to the document's top-level `diagnostics` list
- **AND** the campaign continues

#### Scenario: Submission refused for validation
- **GIVEN** `POST /v1/jobs` answers 422 with a problem document whose top-level `code` is `validation_error`
- **WHEN** the campaign runner records the submission
- **THEN** the record is `ERROR`
