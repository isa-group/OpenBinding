# 0045. Composition versions are canonical bytes in the row, sealed in two phases and read back in stored mode

- Status: accepted
- Date: 2026-11-15 (F1, decisions D11, D14, D20 and D21 of the F1 implementation plan; design choice C1)

## Context

The plan stores version bytes as a blob. Blobs are written outside the transaction, can be unavailable and need a
sweeper ([ADR 0032](0032-blobs-are-file-storage.md)); a document is at most 256 KiB. Sealing evaluates through the
toolchain, which may compile on a miss, and must not hold a lock or a write transaction meanwhile. A sealed version
is re-read later by diff, re-evaluation, evaluation, the neighbourhood and the F4 feed, after the deployment's
registries may have changed.

## Decision

- A version stores the **canonical bytes** of its effective document (values replaced or kept, evidence stamped) in
  an insert-only `TEXT` column under an immutability trigger, with its UTF-8 size and content digest, its
  `syntax_version` and an `analytics` summary computed once. Author comments and layout are not kept.
- Sealing is two-phase: reading, compiling and evaluating run with no lock; one short transaction then locks the
  composition row `FOR NO KEY UPDATE`, answers the version that already holds the bytes (200), refuses a label
  another content holds (409 `version_label_taken`), takes the next ordinal and inserts the version, its evaluation
  and its derivation edge. A unique violation re-selects; a problem deleted meanwhile is `c2y_problem_not_found`.
- A stored version is read with `text.read_stored`, which skips the checks that depend on the deployment (registry
  aliases) or the entity (the slug). New seals and forks keep the full read.
- An evaluation's stored diagnostics are re-located in the stored content (span `null` where the path no longer
  exists); seal and check responses keep the spans of the submitted text.

## Consequences

- Derive is byte-idempotent, seals deduplicate by meaning, and the feed's ETag (the content digest) changes only
  when the composition does.
- No file outside the transaction, no `content_unavailable`, no sweeper; deleting an organization stays one
  transaction.
- A sealed version stays readable after a registry alias leaves `SPHERE_REGISTRIES`.

Where: `modules/compositions/application/seal.py`, `composition/text.py`, `db/platform_models.py`, `db/triggers.py`.
