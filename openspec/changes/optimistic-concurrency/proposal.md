# Change: optimistic-concurrency

## Why

Two people who edit the same organization, project, case, study, profile, notification preferences or
engine credential at the same time silently overwrite each other today: the last `PATCH`/`PUT` wins and the first
writer is never told. INTENT pillar "groups that work together on them" (INTENT §1, §2 enablers) needs edits that
cannot be lost without notice. The owner approved the design of this change (revision = the row's `updated_at`,
strong `ETag`, opt-in `If-Match`, `412 precondition_failed`); design.md §1 restates the decisions, which this change
does not re-open.

## What Changes

- Every covered resource has a revision: the `updated_at` of its row, normalized to UTC with microsecond precision.
  No column is added.
- The single-resource `GET` and the `PATCH`/`PUT` success responses of the covered operations carry a strong, opaque
  `ETag` derived from that revision; every covered write that sends `If-Match` stores a new revision; one that does not send it changes the revision only when a column changes.
- A covered write may send `If-Match` (`*` or a list of strong entity tags). A match applies the request as today; no
  match answers `412 precondition_failed` with the current `ETag` and changes nothing; a malformed header answers
  `400 invalid_if_match`.
- A request without `If-Match` behaves exactly as before this change (it only gains the `ETag` response header). Such
  clients have no lost-update protection; a later change may make the header mandatory (`428`).
- The precondition check and the write are one atomic step: of two writers holding the same `ETag`, exactly one wins.
- `docs/openapi.json` declares the `If-Match` parameter, the `400`/`412` responses and the `ETag` response header on
  the covered operations; `docs/ERRORS.md` documents both new codes.

## Impact

- Capability `gateway-api`: 18 ADDED requirements, all `~1` (`specs/gateway-api/spec.md`). One capability; the
  per-area behaviour (organizations, studies, accounts, engine registry) is the same cross-cutting HTTP contract, so it
  is specified once here rather than in each area's capability.
- Code: `openbinding-gateway/src/openbinding_gateway/core/revision.py` (new shared helper), and the covered handlers in
  `routes/organizations.py`, `routes/studies.py`, `routes/users.py`, `routes/notifications.py`, `routes/v1.py` (with
  `services/engine_registry.py::set_credential`). Slices and owned files: tasks.md.
- Public API: a compatible, additive change. New optional request header, new response header, two new error codes
  that only a client sending `If-Match` can receive. No status code or body changes for clients that do not send it.
- CORS: none needed. `ETag` is already in `CORS_EXPOSED_HEADERS` (`core/settings.py:47`) and requests may carry any
  header (`allow_headers=["*"]`, `main.py:351`).
- Data: no migration. `updated_at` exists on `organizations`, `projects`, `binding_cases`, `studies`, `users` and
  `v1_engine_credentials`. The collection has none and is not covered (below).
- Decision (design.md §3): `updateCollection` edits an `artifacts` row (`routes/studies.py:105-115`), and `artifacts`
  has no `updated_at` (`db/artifact_models.py:18-31`, migration `b3c4d5e6f7a8`). The owner chose to add no column
  here, so collections are not covered; a later change owns the `artifacts.updated_at` migration.
- Risks: design.md §7.

## Out of scope

- **Frontend**: sending the loaded `ETag`, warning on `412`, offering a reload that keeps the typed text. That is a
  separate follow-up change, because `frontend/src/pages/**` belongs to change `m26-navigation`.
- **`PATCH /v1/admin/users/{user_id}`** (`adminUpdateUser`, `routes/admin.py:244`): a follow-up after the `admin.py`
  LIKE fix merges.
- **`PUT /v1/organizations/{org}/members/{member_id}`** (`routes/organizations.py:601`): the membership row has no
  `updated_at`, so it has no revision under this design. Not covered; recorded as a follow-up.
- **`updateCollection` / `getCollection`** (and the other artifact `PATCH`es): the `artifacts` row has no
  `updated_at`. A later change adds the column by migration and covers them all (design.md §3).
- **Mandatory `If-Match`** (`428 Precondition Required` when absent): a possible later change.
- `If-None-Match`, `If-Unmodified-Since`, conditional `GET`/`304`, and `ETag` on list responses (`listStudies`,
  `listProjects`, ...).
- A single-resource `GET` for studies or for the engine credential: neither exists, and none is added (design.md §4).
- Editing `openspec/specs/**` or earlier changes; archiving.
