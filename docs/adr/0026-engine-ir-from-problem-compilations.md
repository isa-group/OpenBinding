# 0026. A run executes the IR of its compilation

- Status: accepted
- Date: 2026-11-14 (F0b, decision D5 of the F0b implementation plan)

## Context

Before F0b a run copied the IR it was sent (snapshots, `v1_binding_ir`), so the same compiled problem was stored many
times and a run could name one problem while executing another's IR.

## Decision

A run names a revision and a compilation (`jobs.revision_id`, `jobs.compilation_id`) and never copies the IR. The
worker loads the compilation from `problem_compilations` when it claims the job and checks its `ir_digest` against
`provenance.irDigest`; a mismatch fails the run with `job_input_invalid`. Re-evaluation, the neighbourhood and the IR
view dereference the same row. The composite foreign key `(compilation_id, revision_id)` makes a run that names one
revision and executes another's IR impossible at the database level. The `bim-engine/v1` wire contract and the
Dramatiq message (the job id only) did not change.

## Consequences

- The IR is stored once per revision and toolchain (`openbinding-gateway/tests/test_run_does_not_copy_ir.py`,
  `tests/test_f0b_walk.py`).
- A retry refuses early with `contract_not_installed` when the IR belongs to a toolchain that is no longer installed,
  and the message says to launch a new run of the revision.

Where: `services/execution.py`, `services/job_submission.py`, `db/platform_models.py`.
