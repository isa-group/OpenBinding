# Design: optimistic-concurrency

Code read at `e41753ac`. Line numbers refer to that commit.

## 1. Owner decisions (approved; restated, not re-opened)

- The revision is the resource row's `updated_at`, normalized to UTC with microsecond precision. No column is added.
- The `ETag` is a strong, opaque entity tag derived from it. Every successful write bumps `updated_at`.
- The single-resource `GET` and the `PATCH`/`PUT` 200 responses of the covered operations carry `ETag`.
- `If-Match` handling: an absent header changes nothing. `*` matches when the resource exists. A list of strong tags
  matches when any one equals the current tag, and weak tags never match. Anything else is
  `400 invalid_if_match`. No match is `412 precondition_failed`, with the current `ETag`, and nothing is changed.
- Order of checks: 401, 404 and 403 come first, then `If-Match`, then the state-dependent 402/409/422 checks. The
  framework's request-body 422 runs before the handler.
- The precondition and the write happen in one transaction. A shared helper, `core/revision.py`, provides
  `etag_of(row)`, `parse_if_match`, the guarded claim and the 412 response plus its OpenAPI `responses` fragment.
- `docs/openapi.json` is regenerated. The frontend, a mandatory `If-Match` (428) and the admin `PATCH` are follow-ups.

## 2. Decisions

**D1. One helper, called from each handler; no middleware.** The check has to run *after* lookup and authorization
and *before* the state-dependent checks (§5). Only the handler knows where that point is, so a middleware or a
route-level dependency would run too early. `core/revision.py` exposes:

- `etag_of(value: datetime) -> str`: the quoted tag (D2). It accepts the row's `updated_at` and normalizes naive
  values (SQLite in tests) as UTC.
- `parse_if_match(raw: str | None) -> IfMatch | None`: `None` when the header is absent; `ANY` for `*`; otherwise a
  tuple of `(weak: bool, opaque: str)`. It raises `api_error(400, "invalid_if_match", …)` on a malformed value (D3).
- `async claim(session, model, row_id, expected: datetime, if_match) -> datetime`: the guarded write of D4. It
  returns the new revision, or raises the 412 of D7.
- `precondition_failed(current: datetime | None) -> HTTPException`, with the `ETag` header when `current` is set, and
  `CONDITIONAL_WRITE_RESPONSES`, the OpenAPI `responses={400, 412}` fragment, plus `IF_MATCH_PARAMETER`.

The handler reads the header through a declared `Header(None, alias="If-Match")` parameter. That keeps it in
OpenAPI, so `req~gateway-api-optimistic-concurrency-openapi~1` needs no post-processing of the document. The
`ETag` on a 200 is set through the `Response` parameter FastAPI injects. Responses that are already `JSONResponse`
(the engine-registry route) set it on the returned object.

**D2. Entity-tag encoding.** `"<integer microseconds since 1970-01-01T00:00:00Z>"`, for example
`"1792627200000000"`. It is stable, cheap and has no characters that need escaping. The spec calls it opaque: clients
must not parse it, and a later change may switch to a digest or a revision counter without breaking them. Considered
and rejected: an ISO-8601 string (contains `:` and `+`, and invites parsing) and a hash of the timestamp (no gain,
since the value is not secret: whoever may read the tag may read `updated_at`-equivalent data).

**D3. Parsing.** RFC 9110 grammar: `If-Match = "*" / #entity-tag`, `entity-tag = [ "W/" ] DQUOTE *etagc DQUOTE`.
Optional whitespace around commas is allowed, and empty list elements are ignored (§5.6.1.2). Refused with 400: `*`
mixed with tags, an unquoted or unterminated tag, two tags without a comma, a `DQUOTE` or control character inside a
tag, and a header with no tag at all (an empty value, or only commas). The last case is a choice: the grammar would
read it as an empty list that never matches, but such a value is a client bug, and 400 says so earlier than 412. When
FastAPI joins repeated `If-Match` fields, they are parsed as one comma-joined list, which is the RFC's combination
rule.

**D4. Atomic claim: a guarded `UPDATE`.**

```sql
UPDATE <table> SET updated_at = :new WHERE id = :id AND updated_at = :expected
```

The claim runs in the request's transaction, after the precondition is evaluated in memory against the row the
handler loaded, and before any field is written. `rowcount == 0` means somebody else committed first. The helper
re-reads `updated_at` and raises 412 with that tag. The request transaction is rolled back, so nothing is changed. After
a successful claim the handler applies its fields as today, and the row's `onupdate` stamps `updated_at` again on
flush (`db/platform_models.py:142-144` and the other `updated_at` columns). The tag returned is the one read back
after the final flush, so the 200 `ETag` always equals what the next `GET` returns.

- `:new = max(utcnow(), expected + 1 µs)` guarantees a new revision even if two writes fall in the same microsecond
  or the clock steps back (`req~gateway-api-optimistic-concurrency-revision-bump~1`). The final `onupdate` stamp must
  respect the same floor. The helper sets `updated_at` explicitly on the row instead of relying on `onupdate` alone.
- `If-Match: *` still claims, with `:expected` set to the value just read, so `*` concurrent with a tag-matching
  writer cannot both apply against the same revision.
- Considered: `SELECT … FOR UPDATE`. It is equivalent on PostgreSQL but a no-op on SQLite, where the suite runs, so
  the race test would not prove anything there. The guarded `UPDATE` is atomic on both. The binding-case revision
  route already uses `FOR UPDATE` (`routes/organizations.py:1019-1023`), and this change leaves that alone.
- Equality on `updated_at`: the comparison uses the value as loaded from the row, never a value re-parsed from the
  tag. That way the database's own representation, including SQLite's text form, is compared with itself.

Without `If-Match` the handler does not claim (`req~gateway-api-optimistic-concurrency-if-match-absent~1`). It
still sets `updated_at` explicitly before its flush, so a 200 that changed no field also stores a new revision. That
write is invisible to the client except through the new `ETag`.

**D5. Order per route.** The precondition step (parse, compare, claim) is inserted at one point in each handler:

| Operation | Before the precondition (unchanged) | Precondition inserted | After the precondition (unchanged) |
|---|---|---|---|
| `updateOrganization` | 401; `_required_org` 404; `require_role ADMIN` 403; when a new sponsor is named, `require_role OWNER` 403 | after the role checks (`organizations.py:251`, the OWNER check moved up beside it) | 422 `sponsor_must_be_caller`, 422 `ambiguous_parent`, cycle check, new-parent 404/403, 402 `sponsor_quota_exceeded`, the sponsorship transfer, audit |
| `updateProject` | 401; `require_project ADMIN` 404/403 | after `organizations.py:826` | 402 private-project capacity, fields, audit |
| `updateBindingCase` | 401; `require_project MEMBER`; `_case` 404 | after `organizations.py:1054` | fields, audit |
| `updateCollection` | 401; `_context MEMBER`; `_collection` 404 | after `studies.py:381` (pending §3) | fields, audit |
| `updateStudy` | 401; `_context MEMBER`; `_study` 404 and 403 `api_key_engine_forbidden` on the target | after `studies.py:557` | 422 `foreign_study_version`, `invalid_study_version`, version resolution, 403 on the selected version's engines, fields, audit |
| `updateOwnProfile` | 401 token; the empty-body read (D6); 401 `invalid_credentials` (current password) | after `users.py:159` | 409 `already_registered`, 422 `weak_password`, fields |
| `updateNotificationPreferences` | 401 | first statement | merge of preferences |
| engine credential `PUT` | 401; stateless body check 422 `invalid_credential`; 503 `accounts_unavailable`; registration lookup 404 (owner and API-key engine grant) | in `set_credential` after the 404 (`engine_registry.py:1190`) | 409 `immutable_published_registration`, 503 `credential_store_unavailable`, encryption, the registration reset |

Two placements need a reason:

- The `updateOrganization` OWNER check is an authorization check on the target. It moves above the precondition so
  that an ADMIN who is not an OWNER gets 403 before 412. Its 422 `sponsor_must_be_caller` stays below, because it
  depends on the stored sponsor.
- The current-password check of `updateOwnProfile` is a re-authentication of the caller, so it stays above the
  precondition. The caller owns the resource and can `GET` its tag anyway, so either order leaks nothing. Keeping
  authentication first matches §1.

The engine credential's `invalid_credential` body check depends on the request alone and already runs before the
lookup. It stays there, like the framework's request-body 422.

**D6. Empty profile update.** `PATCH /v1/users/me` with neither `email` nor `new_password` returns the profile
before the current-password check (`users.py:149-150`). That makes it a read. It evaluates `If-Match`, so a stale
tag is still 412 (that costs nothing and is consistent), but it neither claims nor stores a revision, and its 200
carries the current, unchanged `ETag`.

**D7. The 412 and 400 bodies.** Both are built with `api_error`, so each family keeps its documented shape
(`docs/ERRORS.md`, "The other statuses"). Platform routes answer
`{"detail": {"code", "error"}, "type", "title", "status", "code"}` as `application/json`. The engine-registry
route sits under `/v1/engine-registrations`, one of `_BIM_PATH_PREFIXES` (`main.py:179-191`), and answers the
`Problem` document as `application/problem+json` through `_registry_problem` / `RegistryProblem`. A
`RegistryProblem` therefore needs the `ETag` header passed through. The body carries no tag: the `ETag` header is
the only place, and the body never echoes the client's `If-Match`.

**D8. Credential without a stored row.** The credential `PUT` creates `v1_engine_credentials` on first use
(`engine_registry.py:1206-1212`). Without a row there is no current representation. With `If-Match`, whether `*` or
any list, the answer is 412 without `ETag` (`req~gateway-api-optimistic-concurrency-no-current-revision~1`).
Without it, the create works as today. Two concurrent first writes without `If-Match` are already serialized by the
table's unique `registration_id`. That stays as it is.

**D9. Profile and preferences share one revision.** Both live on the caller's `users` row (`db/models.py:86`,
`:98-100`), so they share one tag. A profile change invalidates a preferences tag and the reverse, and so does any
other write to that row (the admin user update, a plan cache refresh). The result is a false 412, never a lost
update. It is accepted, and the frontend follow-up handles 412 with a reload.

## 3. Open question: collections

`updateCollection` and `getCollection` load an `artifacts` row of kind `Collection`
(`routes/studies.py:105-115`, `:137-140`). The `artifacts` table has no `updated_at`: it is missing from both the
model (`db/artifact_models.py:18-31`) and the migration (`alembic/versions/b3c4d5e6f7a8_versioned_artifact_library.py:44-49`).
The `Collection` model of `db/platform_models.py:309` does have `updated_at`, but it is not the row these routes
edit. Under "no column is added" the collection has no revision. Options for the owner:

- **A.** Add `artifacts.updated_at` (nullable at first, back-filled from `created_at`, then `NOT NULL`) in slice 2,
  as an expand-only migration. The table's other users are unaffected.
- **B.** Drop `updateCollection` and `getCollection` from this change and cover them in a follow-up that owns the
  migration. Slice 2 then covers `updateStudy` only.

Recommendation: **B**. It keeps this change migration-free, as approved, and the follow-up can cover the other
artifact `PATCH`es together. The spec marks row 4 of the covered-operations table `[NEEDS CLARIFICATION]` until the
owner answers. Slice 2 starts with the study and adds the collection only under A.

## 4. Gaps accepted

- **Study**: there is no single-resource `GET` for a study (`listStudies` only, `studies.py:442`). A client gets a
  study tag only from a `PATCH` 200 or a 412. The frontend follow-up either adds a `getStudy` or reads the tag from a
  412. This change does not add a read.
- **Engine credential**: the secret is never readable, so there is no `GET`. The tag comes from the `PUT` 200 or the
  412.
- **Lists**: list responses carry no per-item tag. The body schema does not change.

## 5. OpenAPI

Each covered write declares the `If-Match` header parameter (`required: false`, with a description of `*`, the strong
comparison and the absent-header behaviour), a `400` (`invalid_if_match`), a `412` (`precondition_failed`, header
`ETag`), and the `ETag` header on `200`. Each covered single-resource read declares `ETag` on `200`. The engine
credential `PUT` has no `operation_id` today, and FastAPI derives one. Slice 3 keeps whatever id the snapshot
already has, so the regenerated `docs/openapi.json` renames nothing. The snapshot is regenerated once, in the last
slice (tasks.md), and `tools/dump_openapi.py --check` runs in every slice's checks.

## 6. Traceability

Code carries `[impl->req~gateway-api-optimistic-concurrency-…~1]` and tests carry `[utest->…]`. The helper tests in
`tests/test_optimistic_concurrency_revision.py` cover the parse, compare, claim and race requirements once. The route
tests cover the per-route behaviour.

## 7. Risks

- **False 412 from unrelated writes** to the same row (D9, and `onupdate` on any column). It is safe (no lost
  update), and a reload resolves it. If it proves noisy, a later change can introduce a dedicated revision column.
- **Microsecond collisions** are excluded by the `expected + 1 µs` floor (D4).
- **SQLite versus PostgreSQL timestamp round-trip**: naive values are read as UTC (D1), and the equality is on the
  loaded value (D4). The race test runs on the suite's database. If CI has a PostgreSQL job, the race test runs there
  too.
- **Ordering regressions**: the scenarios of `req~gateway-api-optimistic-concurrency-order-access~1` and `-order-state~1`
  pin one case per refusal class. The existing route tests must pass unedited.
- **Clients without `If-Match`** keep last-writer-wins. That is intended for now (proposal.md, Out of scope: 428).

## 8. Migration

None (expand-only option A of §3 excepted, if chosen). Rollback is reverting the code: clients that send `If-Match`
then get today's behaviour, because unknown request headers are ignored.
