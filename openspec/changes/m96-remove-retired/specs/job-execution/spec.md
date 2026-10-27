## ADDED Requirements

### Requirement: Workers consume only the default queue
`req~job-execution-default-queue-only~1`
THE gateway's Dramatiq worker module SHALL declare actors only on the `default` queue.

Needs: impl, utest

#### Scenario: Declared actors
- **GIVEN** the module `openbinding_gateway.worker` imported with the test broker
- **WHEN** the test collects the queue name of every actor the broker declares
- **THEN** the set of queue names is exactly `{"default"}`
- **AND** the module exports no `analyze_archive_message`

Evidence: `openbinding-gateway/tests/test_worker_queues.py`

### Requirement: Reconciler without retired sweeps
`req~job-execution-reconciler-without-retired-sweeps~1`
WHEN the reconciler runs a cycle, THE gateway SHALL complete it without reading or writing analysis tasks or sponsorship proposals.

Needs: impl, utest

#### Scenario: Cycle on the new schema
- **GIVEN** a schema without the tables `analysis_tasks` and `sponsor_proposals` (built from the application's ORM metadata after this change), with one queued job whose broker message was lost
- **WHEN** one reconciler cycle runs
- **THEN** the job is redelivered as before this change
- **AND** no warning or error is logged by the cycle

Evidence: `openbinding-gateway/tests/test_job_reconciler.py`

The other steps of the cycle (sweep of abandoned jobs, study cell resync, redelivery, cancellation of lost attempts, purges) are unchanged (`req~job-execution-lease-recovery~1`).
