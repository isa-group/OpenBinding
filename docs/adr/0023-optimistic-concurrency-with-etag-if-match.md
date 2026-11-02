# ADR-0023: Optimistic concurrency with a strong ETag and `If-Match`

- Status: Proposed (the owner accepts it, REVIEW.md R11)
- Date: 2026-10-28
- Deciders: owner (scope decisions of change `optimistic-concurrency`)

## Context

Two editors of the same shared resource (an organization, a project, a binding case, a study, a profile, an engine
credential) silently overwrite each other: the last writer wins and nobody is told. The API needs lost-update protection
without a schema change, without breaking clients that do not know it, and with the platform's two error shapes intact
(`docs/ERRORS.md`: platform JSON, and `application/problem+json` for the engine registry, ADR-0011). The change is
`openspec/changes/optimistic-concurrency`.

## Decision

- **Revision.** The revision of a resource is its row's `updated_at`, in UTC with microsecond precision. No column is
  added.
- **ETag.** A strong, opaque entity tag over `table:id:revision`: the first 32 hex digits of its SHA-256, quoted. Rows of
  different tables or ids never share a tag, and nothing about the row can be read from it. The single-resource `GET`
  and the `200` of each covered write carry it.
- **`If-Match` is opt-in.** Absent: nothing is checked and the request behaves as before (last writer wins). `*` matches
  when the resource exists. A list of strong tags matches when any one equals the current tag. Weak tags (`W/"…"`) are
  well formed but never match (strong comparison, RFC 9110 §13.1.1).
- **Errors.** A malformed value, or one longer than 2048 characters, is `400 invalid_if_match`; of repeated `If-Match`
  fields the first wins. A tag that does not match is `412 precondition_failed`, carrying the current `ETag` header, and
  nothing is applied (no field, audit event or side effect). Each family keeps its shape: platform JSON, and
  `application/problem+json` for `/v1/engine-registrations`. The body never echoes the tag.
- **Order of checks.** 401, 404 and 403 first (so a caller who may not read a resource never sees its tag), then
  `If-Match`, then the state-dependent 402/409/422 refusals. The framework's request-body 422 still runs before the
  handler.
- **Atomic claim.** When `If-Match` is present, the handler runs a guarded
  `UPDATE <table> SET updated_at = :new WHERE id = :id AND updated_at = :loaded` in the request's transaction (`*` drops
  the `updated_at` predicate). `:new` is `max(now, previous + 1 µs)`, a monotonic floor, so a guarded `200` always has a
  new tag, and the floor is kept through the final flush. No row claimed means a concurrent commit: `412` with the
  re-read tag, and the transaction is rolled back. If the row was deleted between the load and the claim the answer is
  `404 not_found`, because there is no current tag.
- **Single entry point.** `core/revision.py` (`etag_for`, `parse_if_match`, `precondition`, `guard`, `set_etag`, the
  OpenAPI `responses` fragment). Each handler calls it at the point the order above requires; there is no middleware,
  because a middleware would run before lookup and authorization.

### Covered operations

`updateOrganization`, `updateProject`, `updateBindingCase`, `updateStudy`, `updateOwnProfile`,
`updateNotificationPreferences` and the engine credential `PUT`.

### Out of scope

- **Collections** (`updateCollection`/`getCollection` edit `artifacts` rows): covered only once `artifacts.updated_at`
  exists, is `NOT NULL` and has `onupdate`. That needs a migration, which this change avoids. The same rule applies to
  any table added later, because `etag_for` fails on a NULL `updated_at`.
- The member `PUT` and the admin `PATCH` (the latter waits for the `admin.py` LIKE fix).
- `428 Precondition Required` (a mandatory `If-Match`), and the frontend handling of `412`.

## Consequences

- Good: clients that send `If-Match` are protected from lost updates; the rest are untouched. Rollback is reverting the
  code, since unknown request headers are ignored.
- Good: no migration, and the guarded `UPDATE` is atomic on SQLite (where the suite runs) and PostgreSQL alike.
- Bad: the OpenAPI document and its snapshot (`docs/openapi.json`, ADR-0013) change: an `If-Match` parameter, `400` and
  `412` on seven operations, and `ETag` on the `200`s and on the single-resource reads. Clients regenerate.
- Bad: profile and notification preferences share the caller's `users` row, so a write to either, or to the row by any
  other path, invalidates the other's tag. The result is a false `412`, never a lost update; a reload resolves it.
- Bad (SQLite only): the claim compares `updated_at` as SQLAlchemy formats it, with fractional seconds. A row whose value
  came from `CURRENT_TIMESTAMP` or raw SQL without them may answer `412` until an ORM write rewrites it (TEXT
  comparison). PostgreSQL compares typed timestamps and is unaffected.
- Bad: the engine credential route returns responses instead of raising, so it rolls back explicitly on a failed
  claim. That also discards earlier writes of the same request, such as `api_key.last_used_at`. Accepted as minor; a
  savepoint around the claim is a follow-up.
- Bad: a study has no single-resource `GET`, and the credential is never readable, so their first tag comes from a `200`
  or a `412`. A credential with no stored row has no current revision: any `If-Match` answers `412` without `ETag`.
- Bad: clients without `If-Match` keep last-writer-wins until a `428` follow-up.

### Placement exception

Constitution 6.5 says new backend code lives in a module of `docs/ARCHITECTURE.md` section 4, and that `core/*` is
legacy to be moved to the shared kernel. The owner's scope decision names `core/revision.py` explicitly, so the helper
stays there as an owner-approved exception. Moving it to `shared/`, with family-neutral exceptions
(`PreconditionFailed` and `InvalidIfMatch` mapped to each error family by an adapter), is a recorded follow-up for when
the first module adapter needs it.

### Confirmation

The acceptance and unit tests of the change (`tests/test_optimistic_*.py`, including the concurrent-claim race), the
OpenAPI snapshot check (`tools/dump_openapi.py --check`), and `openspec validate optimistic-concurrency --strict`.

## Alternatives considered

- **A version column.** Explicit and immune to false 412s, but a migration on every table. Revisit if false 412s prove
  noisy.
- **A revision field in the body.** Changes every request and response schema, and clients that ignore it get no
  protection signal in HTTP terms.
- **Weak ETags.** `If-Match` requires strong comparison, so weak tags would never match.
- **A content hash.** Needs the whole representation, including unreadable data such as the credential, and changes
  nothing a write could claim atomically.
- **`SELECT … FOR UPDATE` instead of the guarded `UPDATE`.** A no-op on SQLite, so the race test would prove nothing.
- **A readable tag (integer or ISO timestamp), or a middleware.** The first invites parsing and is equal across rows; the
  second runs before lookup and authorization.

## Evidence

`openspec/changes/optimistic-concurrency/{proposal,design,tasks}.md` and its delta spec,
`openbinding-gateway/src/openbinding_gateway/core/revision.py`, `docs/ERRORS.md` ("Conditional writes"), `docs/openapi.json`.
