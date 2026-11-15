# 0039. `v1_job_provenance` is dropped

- Status: accepted
- Date: 2026-11-14 (F0b, decision D28 of the F0b implementation plan)

## Context

`v1_job_provenance` had two writers, no reader and no test, and duplicated `jobs.provenance`.

## Decision

The table was dropped in F0b B6 with the other run columns (ADR 0030), as the plan's data-model section scheduled.

## Consequences

- A run's provenance lives in `jobs.provenance` only.
- `tools/check_retired_surface.py` keeps the table retired.

Where: `db/models.py`.
