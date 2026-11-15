# 0035. Storage is charged per revision

- Status: accepted
- Date: 2026-11-14 (F0b, decision D23 of the F0b implementation plan)

## Context

Blobs are deduplicated per organization and have one `created_by_id`. Charging `maxRepositoryStorage` on blobs would
let a second uploader of the same package pay nothing and leave the first paying for a teammate's revision, with no way
to free the space.

## Decision

`maxRepositoryStorage` is checked against the sum of `binding_case_revisions.package_size` of the revisions the
account created. The check and the insert run in one short transaction that locks the account's row.

## Consequences

- Two members uploading the same package each pay for their own revision.
- Deleting a problem nobody ran frees its revisions' size for their creators.

Where: `modules/problems/application/problems.py`, `modules/plans/domain/quotas.py`.
