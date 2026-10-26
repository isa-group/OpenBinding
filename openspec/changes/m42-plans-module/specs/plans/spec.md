## ADDED Requirements

### Requirement: Entitlement map of pricing 0.2.0
The plans module SHALL hold one entitlement map that assigns to every gated operation the pricing 0.2.0 feature it requires and the usage limits it is checked against.

`req~plans-entitlement-map~1`

Needs: impl, utest

#### Scenario: Features and limits of the map
- **GIVEN** the entitlement map and `docs/pricing/openbinding-0.2.0.yml`
- **WHEN** the map is compared with the pricing
- **THEN** the features it names are exactly `repository`, `runs`, `studies`, `generator`, `federatedEngines`, `collaboration` and `apiAccess`
- **AND** the usage limits it names are exactly `maxProblems`, `maxCollections`, `maxRepositoryStorage`, `solverHours`, `maxRunMinutes`, `maxConcurrentRuns`, `maxStudyCells`, `generatedInstances`, `maxInstancesPerGeneration`, `maxFederatedEngines`, `maxPrivateProjects` and `maxApiKeys`
- **AND** `solverHours` and `generatedInstances` are the only limits marked as consumed in SPACE; the other ten are marked as compared with the gateway's own counts

#### Scenario: Every gated operation has one entry
- **GIVEN** the gated operations: create a problem, store a problem version, create a collection, run on a built-in engine (submission and retry), run on a federated engine, launch a study run, launch a study cell on a built-in or on a federated engine, generate instances with `persist: true`, the solver part of a solver-aware generation, register or activate a federated engine, create a private project or make a project private, create an organization, create an API key, and authenticate a request with an API key
- **WHEN** the map is read for each of them
- **THEN** each has exactly one entry: `repository` for the three repository operations, `runs` for a built-in run and for the solver part of a generation, `federatedEngines` for a federated run and for engine registration, `studies` for a study run and a built-in study cell, `studies` and `federatedEngines` for a federated study cell, `generator` for a generation, `collaboration` for projects and organizations, and `apiAccess` for API keys
- **AND** a generation without `persist` is not a gated operation

#### Scenario: Identifiers SPACE knows
- **GIVEN** `SPACE_SERVICE_NAME=openbinding`
- **WHEN** the plans module names a feature or usage limit to SPACE
- **THEN** it uses `openbinding-<name>`, for example `openbinding-runs` and `openbinding-solverHours`
- **AND** with `SPACE_SERVICE_NAME=openbinding-dev` it uses `openbinding-dev-runs`

### Requirement: Map verified against the active pricing
IF the pricing context that SPACE returns for a contract lacks a feature or a usage limit that the entitlement map names, or gives it a value that is not a boolean (features) or a number or `null` (limits), THEN the plans module SHALL refuse every gated operation of that contract with 503 `pricing_misconfigured`.

`req~plans-map-verified~1`

Needs: impl, utest

#### Scenario: Complete pricing
- **GIVEN** a FREE contract whose pricing token carries the 7 features and 12 usage limits of pricing 0.2.0
- **WHEN** the account submits a run on a built-in engine
- **THEN** the map check passes and the submission goes on to admission

#### Scenario: A limit missing from the active pricing
- **GIVEN** a contract whose pricing context has no `openbinding-maxStudyCells`
- **WHEN** the account creates a problem
- **THEN** the gateway answers 503 `pricing_misconfigured` and stores nothing
- **AND** the gateway log names `maxStudyCells` and the pricing version of the contract, and no key or token

#### Scenario: Unknown is never unlimited
- **GIVEN** a pricing token whose `openbinding-maxProblems` value is the string `"25"`
- **WHEN** the account creates a problem
- **THEN** the gateway answers 503 `pricing_misconfigured` and never treats the limit as `.inf`
- **AND** with `SPACE_NULL_LIMIT_IS_UNKNOWN` unset, a `null` value, SPACE's encoding of `.inf`, is read as unlimited; with it set, a `null` value is a missing limit and answers 503 `pricing_misconfigured`

#### Scenario: Verification after a new active version
- **GIVEN** a contract verified on version `0.2.0` and a SPACE event reporting that version `0.3.0`, which drops `maxCollections`, is activated
- **WHEN** the account creates a collection after the event
- **THEN** the plans module checks the map again against the pricing context of version `0.3.0` and the gateway answers 503 `pricing_misconfigured`

### Requirement: Feature not in the plan
IF the plan of the caller's contract sets the feature of a gated operation to false, THEN the gateway SHALL refuse the operation with 403 `feature_not_entitled` before any SPACE evaluation.

`req~plans-feature-refusal~1`

Needs: impl, utest

#### Scenario: Generator switched off
- **GIVEN** a recorded pricing where plan `FREE` sets `generator` to `false`, and a FREE account
- **WHEN** the account requests a generation of 10 instances with `persist: true`
- **THEN** the gateway answers 403 `feature_not_entitled` naming `generator`
- **AND** the plans module sends no evaluation of `openbinding-generator` to SPACE

### Requirement: Solver hours consumed at admission
WHEN the gateway admits a run on a built-in engine, the plans module SHALL evaluate the run's feature in SPACE with an expected consumption of `solverHours` equal to the run's effective time budget in hours, before the run is stored.

`req~plans-solver-hours-admission~1`

Needs: impl, utest

#### Scenario: Direct run
- **GIVEN** a FREE account with 1 hour of `solverHours` used this month
- **WHEN** it submits a run on a built-in engine with a time budget of 300 000 ms
- **THEN** the plans module evaluates `openbinding-runs` for that account with expected consumption `openbinding-solverHours` = 300 / 3600 hours
- **AND** the run is stored only after SPACE answers that the evaluation is positive

#### Scenario: Study cell and the solver part of a generation
- **GIVEN** a study cell on a built-in engine with an effective budget of 120 000 ms, and a solver-aware generation whose solver part runs on a built-in engine with a budget of 60 000 ms
- **WHEN** each is admitted
- **THEN** the cell is evaluated as `openbinding-studies` with `openbinding-solverHours` = 120 / 3600
- **AND** the solver part is evaluated as `openbinding-runs` with `openbinding-solverHours` = 60 / 3600

#### Scenario: Effective budget after the ceiling
- **GIVEN** a FREE account (`maxRunMinutes` 5) that asks a time budget of 900 000 ms
- **WHEN** the run is admitted
- **THEN** the expected consumption is 300 / 3600 hours, the clamped budget, not 900 / 3600
- **AND** a LAB run asking 7 200 000 ms with `ENGINE_SOLVE_TIMEOUT_S=1800` consumes 1800 / 3600 hours

#### Scenario: Federated run and idempotent replay
- **GIVEN** a run on a federated engine, and a second submission with the `Idempotency-Key` of a run already stored
- **WHEN** each reaches admission
- **THEN** no evaluation with a `solverHours` consumption is sent for the federated run
- **AND** the replay returns the stored run and sends no evaluation

### Requirement: Usage level exhausted
IF SPACE answers an admission evaluation negatively and without an error while the plan grants the operation's feature, THEN the gateway SHALL refuse the operation with 402 `usage_limit_exceeded` without creating a job or writing an instance for it.

`req~plans-usage-exhausted~1`

Needs: impl, utest

#### Scenario: Monthly solver hours spent
- **GIVEN** a FREE account (`solverHours` 5) with 4.95 hours used this month
- **WHEN** it submits a run on a built-in engine with a budget of 300 000 ms
- **THEN** the gateway answers 402 `usage_limit_exceeded` with `quota.limit_id` `solverHours`, `quota.source` `space` and `quota.unit` `hour/month`
- **AND** no job is created and no engine is contacted

#### Scenario: A study cell refused
- **GIVEN** a running study run whose next cell is refused by SPACE for `solverHours`
- **WHEN** the gateway tries to launch that cell
- **THEN** no job is created for the cell, and the cell is recorded as failed with error code `usage_limit_exceeded`
- **AND** the cells already running go on

### Requirement: Generated instances consumed at admission
WHEN the gateway admits a generation request with `persist: true`, the plans module SHALL evaluate `generator` in SPACE with an expected consumption of `generatedInstances` equal to the number of instances requested, before the generation starts.

`req~plans-generation-admission~1`

Needs: impl, utest

#### Scenario: Generation within the month's instances
- **GIVEN** a FREE account (`generatedInstances` 1000) with 200 instances generated this month
- **WHEN** it requests a generation of 40 instances with `persist: true`
- **THEN** the plans module evaluates `openbinding-generator` with expected consumption `openbinding-generatedInstances` = 40
- **AND** the generation starts after the positive answer

#### Scenario: Month's instances spent
- **GIVEN** a FREE account with 980 instances generated this month
- **WHEN** it requests a generation of 40 instances with `persist: true`
- **THEN** the gateway answers 402 `usage_limit_exceeded` with `quota.limit_id` `generatedInstances` and the generator writes nothing

#### Scenario: Generation that persists nothing
- **GIVEN** an anonymous caller, and a signed-in FREE account
- **WHEN** each posts a configuration of 40 instances without `persist` to `/v1/generator/instances`
- **THEN** the gateway answers 200 as the `generator` capability specifies, and sends no evaluation to SPACE

### Requirement: No refund after an engine claims the run
The plans module SHALL NOT revert the evaluation of a run after an engine has claimed it.

`req~plans-no-refund-after-start~1`

Needs: impl, utest

#### Scenario: Run stopped early
- **GIVEN** three admitted runs on built-in engines with budgets of 300 000 ms, each claimed by an engine
- **WHEN** the first is cancelled after 10 s, the second ends `failed` with an engine error and the third ends after 30 s with a result
- **THEN** the plans module sends no `revert_evaluation` for any of them
- **AND** the 300 / 3600 hours of each stay consumed in SPACE

### Requirement: Revert of the evaluation when the operation fails
IF an operation admitted by an evaluation with an expected consumption is not stored, reaches a terminal state before any engine claims its run, or is a generation that fails before writing any instance, THEN the plans module SHALL send one `revert_evaluation` to SPACE for that account and the evaluated feature.

`req~plans-revert-on-failure~1`

Needs: impl, utest

#### Scenario: The run is never stored
- **GIVEN** a run evaluated positively in SPACE for `openbinding-runs`
- **WHEN** the database transaction that stores it fails
- **THEN** the plans module sends exactly one `revert_evaluation` for that account and `openbinding-runs`
- **AND** the gateway answers 500 with no job

#### Scenario: The run is never claimed
- **GIVEN** a stored run on a built-in engine, evaluated 20 s ago and still `queued`
- **WHEN** its owner cancels it before any engine claims it
- **THEN** the plans module sends exactly one `revert_evaluation` for `openbinding-runs`

#### Scenario: Dispatch failure is not a failure of the run
- **GIVEN** a stored run whose publication to the queue fails after the commit
- **WHEN** the gateway answers the submission
- **THEN** the run stays `queued` for the reconciler to republish, and the plans module sends no `revert_evaluation`

#### Scenario: Operations without consumption
- **GIVEN** a run on a federated engine that is cancelled while `queued`
- **WHEN** the gateway records the cancellation
- **THEN** the plans module sends no `revert_evaluation`, because the admission sent no evaluation with a consumption

#### Scenario: Generations
- **GIVEN** an admitted generation of 40 instances with `persist: true`
- **WHEN** it fails before writing any instance
- **THEN** the plans module sends one `revert_evaluation` for `openbinding-generator`
- **AND** a generation that fails after writing 10 instances is not reverted

### Requirement: Revert that cannot be honoured
IF a revert is due more than 120 s after its evaluation, or the `revert_evaluation` call fails, THEN the plans module SHALL log one `plans.revert_failed` event and send no further revert for that evaluation.

`req~plans-revert-failed~1`

Needs: impl, utest

#### Scenario: Revert after the window
- **GIVEN** a run on a built-in engine evaluated at 10:00:00 and cancelled by its owner while `queued` at 10:02:30
- **WHEN** the gateway records the cancellation
- **THEN** the plans module sends no `revert_evaluation`
- **AND** it logs `plans.revert_failed` with the account id, `openbinding-runs`, `age_s` 150 and the reason `window_expired`
- **AND** a run failed by the reconciler with `queue_timeout` under the default `QUEUE_TIMEOUT_S` of 1800 s is handled the same way

#### Scenario: SPACE refuses the revert
- **GIVEN** a due revert whose `revert_evaluation` call raises a client error
- **WHEN** the plans module handles the error
- **THEN** it logs `plans.revert_failed` with the reason `space_error` and the error type only, never a key, a token or the error text
- **AND** the outcome already answered to the caller does not change

### Requirement: Repository limits against the gateway's counts
IF storing a problem, a problem version or a collection would take its owner of record above `maxProblems`, `maxCollections` or `maxRepositoryStorage`, THEN the gateway SHALL refuse it with 402 and store nothing.

`req~plans-repository-limits~1`

Needs: impl, utest

#### Scenario: Twenty-sixth problem on FREE
- **GIVEN** a FREE account (`maxProblems` 25) that owns 25 problems
- **WHEN** it creates another problem
- **THEN** the gateway answers 402 `quota_exceeded` with `quota` `{"limit_id": "maxProblems", "state": "exhausted", "unit": "problem", "source": "plan", "limit": 25, "used": 25}` and stores no problem

#### Scenario: Sixth collection on FREE
- **GIVEN** a FREE account (`maxCollections` 5) that owns 5 collections
- **WHEN** it creates another collection
- **THEN** the gateway answers 402 `quota_exceeded` with `quota.limit_id` `maxCollections`, `quota.limit` 5 and `quota.used` 5

#### Scenario: Storage
- **GIVEN** a FREE account (`maxRepositoryStorage` 500 MB, 1 MB = 1 000 000 bytes) whose problems and collections store 499 000 000 bytes over all their versions
- **WHEN** it stores a problem version of 2 000 000 bytes
- **THEN** the gateway answers 402 `storage_quota_exceeded` with `quota.limit_id` `maxRepositoryStorage` and `quota.unit` `MB`, and stores no version

#### Scenario: Unlimited on RESEARCH
- **GIVEN** a RESEARCH account, whose `maxProblems`, `maxCollections` and `maxRepositoryStorage` are `.inf`, owning 25 problems
- **WHEN** it creates another problem
- **THEN** the problem is created

#### Scenario: Owner of record of organization work
- **GIVEN** a problem created by a MEMBER in a project of an organization whose owner of record is a FREE account owning 25 problems
- **WHEN** the member creates the problem
- **THEN** the gateway answers 402 `quota_exceeded` with `quota.limit_id` `maxProblems`, because the problem counts against the organization's owner of record and not against the member

### Requirement: Private projects against the gateway's counts
IF creating a private project, or making a project private, would take the owner of record of its organization above `maxPrivateProjects`, THEN the gateway SHALL refuse it with 402 `quota_exceeded` and change nothing.

`req~plans-private-projects-limit~1`

Needs: impl, utest

#### Scenario: Second private project on FREE
- **GIVEN** an organization whose owner of record is a FREE account (`maxPrivateProjects` 1) with one private project
- **WHEN** an ADMIN makes a public project of that organization private
- **THEN** the gateway answers 402 `quota_exceeded` with `quota.limit_id` `maxPrivateProjects`, `quota.limit` 1 and `quota.used` 1, and the project stays public

### Requirement: Request size limits
IF a study run would have more cells than `maxStudyCells`, or a generation request asks for more instances than `maxInstancesPerGeneration`, THEN the gateway SHALL refuse it with 402 `quota_exceeded` before any evaluation in SPACE.

`req~plans-request-size-limits~1`

Needs: impl, utest

#### Scenario: Study run too large for FREE
- **GIVEN** a FREE account (`maxStudyCells` 500) and a study definition that expands to 501 cells
- **WHEN** the account launches a study run
- **THEN** the gateway answers 402 `quota_exceeded` with `quota.limit_id` `maxStudyCells`, `quota.limit` 500 and `quota.used` 501, creates no run or job and sends no evaluation

#### Scenario: Generation request too large for FREE
- **GIVEN** a FREE account (`maxInstancesPerGeneration` 100)
- **WHEN** it requests a generation of 101 instances with `persist: true`
- **THEN** the gateway answers 402 `quota_exceeded` with `quota.limit_id` `maxInstancesPerGeneration` and `quota.limit` 100, and sends no evaluation of `openbinding-generator`

### Requirement: Largest time budget of one run
WHEN a run on a built-in engine or a study cell asks for a time budget above the smaller of `maxRunMinutes` and the technical solve timeout `ENGINE_SOLVE_TIMEOUT_S`, the gateway SHALL reduce the budget to that smaller value and report an `OPTION_CLAMPED` warning with the result.

`req~plans-run-budget-ceiling~1`

Needs: impl, utest

#### Scenario: Budget above the FREE ceiling
- **GIVEN** a FREE account (`maxRunMinutes` 5)
- **WHEN** it submits a run on a built-in engine with `time_budget_ms` 900 000
- **THEN** the run executes with a budget of 300 000 ms
- **AND** its result carries an `OPTION_CLAMPED` warning naming `time_budget_ms`, 900 000 and 300 000

#### Scenario: Budget within the RESEARCH ceiling
- **GIVEN** a RESEARCH account (`maxRunMinutes` 30)
- **WHEN** it submits a run with `time_budget_ms` 900 000
- **THEN** the run executes with 900 000 ms and no `OPTION_CLAMPED` warning

#### Scenario: LAB ceiling above the technical timeout
- **GIVEN** a LAB account (`maxRunMinutes` 1440) and `ENGINE_SOLVE_TIMEOUT_S=1800`
- **WHEN** it submits a run with `time_budget_ms` 7 200 000
- **THEN** the run executes with 1 800 000 ms and an `OPTION_CLAMPED` warning naming 7 200 000 and 1 800 000
- **AND** the gateway does not answer `pricing_misconfigured`

### Requirement: Concurrent runs of the plan
IF an account submits a run while it already has `maxConcurrentRuns` runs queued or running, THEN the gateway SHALL refuse it with 429 `concurrency_limit_exceeded`, `Retry-After: 15` and `concurrency.limit` equal to `maxConcurrentRuns`.

`req~plans-concurrent-runs~1`

Needs: impl, utest

#### Scenario: Second run on FREE
- **GIVEN** a FREE account (`maxConcurrentRuns` 1) with one run `running` on a federated engine
- **WHEN** it submits a run on a built-in engine
- **THEN** the gateway answers 429 `concurrency_limit_exceeded` with `concurrency` `{"limit": 1, "active": 1}` and creates no job

#### Scenario: Plan above the technical cap
- **GIVEN** a LAB account (`maxConcurrentRuns` 32), `MAX_CONCURRENT_JOBS_PER_USER=8` and 8 runs queued or running
- **WHEN** it submits another run
- **THEN** the technical cap of `job-execution` refuses it with `concurrency.limit` 8

#### Scenario: Study cells wait
- **GIVEN** a FREE account with one run `running` and a study run with 3 cells not yet launched
- **WHEN** the gateway schedules cells
- **THEN** no cell is launched and the 3 cells stay waiting, not failed, until the running run ends

### Requirement: Cache invalidated by SPACE events
WHEN the plans module receives a SPACE event for the configured service that reports a synchronization, a pricing created, activated or archived, or the service disabled, it SHALL discard every cached entitlement and pricing token of that service before the next gated decision.

`req~plans-event-cache-invalidation~1`

Needs: impl, utest

#### Scenario: The five events
- **GIVEN** cached entitlements of the service `openbinding`
- **WHEN** any one of the events `synchronized`, `pricing_created`, `pricing_actived`, `pricing_archived` or `service_disabled` arrives for `openbinding` (the client's names, design.md §8)
- **THEN** the next gated decision reads the entitlements from SPACE again

#### Scenario: New active version raises a limit
- **GIVEN** cached entitlements of a FREE account with `maxProblems` 25 and 25 problems owned
- **WHEN** a `pricing_actived` event arrives for a version whose FREE plan sets `maxProblems` to 30, and the account then creates a problem
- **THEN** the plans module reads the contract's entitlements from SPACE again and the problem is created

#### Scenario: Event of another service
- **GIVEN** cached entitlements of the service `openbinding`
- **WHEN** a `pricing_created` event arrives for the service `tomatometer`
- **THEN** the cache of `openbinding` is kept

### Requirement: SPACE events relayed to browsers
WHEN the plans module receives one of the SPACE events of the cache invalidation for the configured service, the gateway SHALL send one `plans.changed` message to every open `GET /v1/plans/events` stream within 5 s.

`req~plans-event-relay~1`

Needs: impl, utest

#### Scenario: Relay of an activation
- **GIVEN** two signed-in browsers with an open `GET /v1/plans/events` stream
- **WHEN** SPACE emits `pricing_actived` for `openbinding`
- **THEN** each stream receives within 5 s one message `event: plans.changed` whose data is `{"event": "pricing_actived", "at": "<ISO 8601 time>"}`
- **AND** the data carries no account, contract, key or token

#### Scenario: Stream without authentication
- **GIVEN** no session and no API key
- **WHEN** a client opens `GET /v1/plans/events`
- **THEN** the gateway answers 401

### Requirement: Cache bound while the event connection is down
WHILE the plans module's event connection to SPACE is down, the plans module SHALL NOT use cached entitlements or pricing tokens read more than 60 s earlier.

`req~plans-cache-bound-without-events~1`

Needs: impl, utest

#### Scenario: Events lost
- **GIVEN** entitlements of an account cached at 10:00:00 and the event connection down since 10:00:10
- **WHEN** the account submits a run at 10:01:05
- **THEN** the plans module reads the entitlements from SPACE again before the admission

### Requirement: Fail closed when SPACE is down
IF SPACE does not answer within `SPACE_TIMEOUT_MS`, answers with an error, or the client raises, THEN the gateway SHALL refuse the gated operation with 503 `pricing_unavailable` and store or start nothing for it.

`req~plans-fail-closed~1`

Needs: impl, utest

#### Scenario: SPACE down during a submission
- **GIVEN** `SPACE_ENABLED=true` and SPACE not answering
- **WHEN** a MEMBER submits a run, creates a problem or creates a private project
- **THEN** each answer is 503 `pricing_unavailable`, with no job, problem or project created

#### Scenario: SPACE down at start-up
- **GIVEN** `SPACE_ENABLED=true` and SPACE not answering when the gateway starts
- **WHEN** a visitor reads a public problem and a signed-in user submits a run
- **THEN** the public read answers 200 and the submission answers 503 `pricing_unavailable`
- **AND** after SPACE answers again, the next submission is admitted without a gateway restart

#### Scenario: Evaluation with an error or without an answer
- **GIVEN** an admission whose `evaluate` call returns a negative result carrying an `error`, and another whose call times out after `SPACE_TIMEOUT_MS`
- **WHEN** the gateway handles each
- **THEN** each answer is 503 `pricing_unavailable` with no job created
- **AND** no `revert_evaluation` is sent, because a revert of the latest evaluation could undo an earlier one that SPACE did record

### Requirement: Open gate outside production
WHERE `SPACE_ENABLED=false` and `APP_ENV` is not `prod`, the plans module SHALL admit every gated operation without calling SPACE.

`req~plans-open-gate~1`

Needs: impl, utest

#### Scenario: Development gateway
- **GIVEN** `SPACE_ENABLED=false` and `APP_ENV=dev`
- **WHEN** an account with 25 problems creates another one and submits a run with a budget of 300 000 ms
- **THEN** both are admitted, and no evaluation or revert is sent anywhere
- **AND** the technical caps (`MAX_CONCURRENT_JOBS_PER_USER`, the solve timeout and the payload ceiling) still apply

#### Scenario: Production refuses the open gate
- **GIVEN** `SPACE_ENABLED=false` and `APP_ENV=prod`
- **WHEN** the gateway starts
- **THEN** it refuses to start

### Requirement: One seam to SPACE
The gateway SHALL import `space_client` (`space-python-client`) only inside `openbinding_gateway/modules/plans/`.

`req~plans-single-space-seam~1`

Needs: impl, utest

#### Scenario: Current tree
- **GIVEN** the gateway sources under `openbinding-gateway/src/openbinding_gateway/`
- **WHEN** the architecture test scans their imports
- **THEN** every import of `space_client` is under `modules/plans/`, and `space_client/` no longer exists as a gateway package

#### Scenario: A new importer
- **GIVEN** a sample module `openbinding_gateway/routes/sample.py` that imports `space_client`
- **WHEN** the architecture rule is applied to it
- **THEN** it is reported as a violation

### Requirement: Contract tests against the lab profile
WHEN the plans contract suite runs against the lab `pricing` profile, it SHALL exercise every SPACE call of the plans module against that SPACE 1.7.1 and fail on any answer that differs from the shape the module expects.

`req~plans-contract-suite~1`

Needs: impl, utest

#### Scenario: Contract and pricing token
- **GIVEN** the lab `pricing` profile with the `openbinding` service `ready` on pricing 0.2.0, and a contract test account
- **WHEN** the suite creates a FREE contract and reads its pricing token
- **THEN** the read-back shows plan `FREE` and the token's pricing context carries the 7 features and 12 usage limits of the entitlement map

#### Scenario: Consumption and revert
- **GIVEN** the same contract with 0 `solverHours` used
- **WHEN** the suite evaluates `openbinding-runs` with `openbinding-solverHours` = 300 / 3600, reads the usage, sends `revert_evaluation` within 120 s and reads the usage again
- **THEN** the first read shows 300 / 3600 hours used and the second shows 0

#### Scenario: Event subscription
- **GIVEN** the plans module subscribed to the events of the lab SPACE
- **WHEN** the suite triggers a synchronization of `openbinding`
- **THEN** the module receives `synchronized` within 60 s

#### Scenario: SPACE stopped
- **GIVEN** a gateway wired to the lab SPACE and `space-api` stopped
- **WHEN** the suite submits a run
- **THEN** the gateway answers 503 `pricing_unavailable` and creates no job

#### Scenario: Without the lab
- **GIVEN** no lab `pricing` profile configured for the suite
- **WHEN** the unit and CI suites run
- **THEN** the contract suite is skipped and no test opens a connection to SPACE or SPHERE
