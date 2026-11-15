# 0030. The columns of a run

- Status: accepted
- Date: 2026-11-14 (F0b, decision D9 of the F0b implementation plan)

## Context

Runs moved from projects to organizations (B5, B6). Their table carried columns that only the old project and snapshot
model needed.

## Decision

- `original_request` stays, minus `bindingProblem`.
- `organization_id` is NOT NULL: every revision has an organization.
- `owner_id` keeps its name and becomes `RESTRICT`. Renaming it to `created_by_id` would touch hundreds of test lines
  for no behaviour, so it waits for F2.
- `jobs.project_id` is dropped, and so is the `v1_job_provenance` table (ADR 0039): it was write-only and duplicated
  `jobs.provenance`.
- Under `/v1/organizations/{org}/runs` the errors use the platform JSON envelope, not `application/problem+json`; the
  frontend's error reader understands both.

## Consequences

- `GET /v1/organizations/{org}/runs/{run}` returns the organization, problem, revision and compilation of the run.
- Run access is organization-wide (D10): a VIEWER reads with redaction, a MEMBER creates, cancels, retries and
  re-evaluates; the concurrency limit stays per account.

Where: `db/models.py`, `modules/execution/adapters/routes.py`.
