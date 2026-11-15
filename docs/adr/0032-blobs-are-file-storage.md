# 0032. Blobs are file storage; requests never unlink files

- Status: accepted
- Date: 2026-11-14 (F0b, decision D14 of the F0b implementation plan)

## Context

Package files are content addressed and global. A request that unlinked a file could race with another
organization's uncommitted upload of the same bytes, and a rolled-back delete would still lose the file. After F0b the
blob is the only copy of a package, which `compile_or_get` needs to recompile.

## Decision

Blob rows are unique per `(organization_id, digest)`, have no public route and no `public` or `expires_at` column, and
carry no quota meaning. `deleteProblem` deletes rows only and leaves blob rows; `deleteOrganization` deletes the
organization's blob rows. No request handler unlinks a file. `binding_case_revisions.package_blob_id` is `RESTRICT`,
which replaces the old semantic reference counting.

## Consequences

- Disk space is reclaimed by a later sweeper that removes files no committed blob row references after a grace
  period (deferred).
- The upload compiles with no transaction open, answers 200 for a package that is already a revision before storing
  anything, and holds the user-row lock only for the short quota-check-and-insert transaction.

Where: `modules/shared/blobs.py`, `routes/organizations.py`.
