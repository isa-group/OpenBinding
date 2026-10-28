## ADDED Requirements

### Requirement: Covered operations and their revision
THE gateway SHALL give every resource edited by a covered write operation (the covered-operations table of this requirement) a revision equal to the `updated_at` value of the row the table names, normalized to UTC with microsecond precision.

`req~gateway-api-optimistic-concurrency-covered~1`

Needs: impl, utest

#### Scenario: Revision of an organization
- **GIVEN** organization `isa-demo` whose row has `updated_at` 2026-10-22T00:00:00.000000Z
- **WHEN** an ADMIN of `isa-demo` sends `GET /v1/organizations/isa-demo` twice without any write in between
- **THEN** both responses carry the same `ETag`

#### Scenario: Profile and preferences share the user's revision
- **GIVEN** a signed-in user who reads `ETag` A from `GET /v1/users/me`
- **WHEN** the user sends `GET /v1/notifications/preferences`
- **THEN** that response carries `ETag` A

#### Scenario: Operations outside the table
- **GIVEN** an OWNER of `isa-demo`
- **WHEN** the owner sends `PUT /v1/organizations/isa-demo/members/{member_id}` with `If-Match: "0"`
- **THEN** the gateway processes it as before this change, without a precondition check and without an `ETag` response header

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`

The covered-operations table:

| # | Covered write | Single-resource read | Revision row |
|---|---|---|---|
| 1 | `PATCH /v1/organizations/{org}` (`updateOrganization`) | `GET /v1/organizations/{org}` (`getOrganization`) | `organizations` |
| 2 | `PATCH /v1/organizations/{org}/projects/{project}` (`updateProject`) | `GET /v1/organizations/{org}/projects/{project}` (`getProject`) | `projects` |
| 3 | `PATCH /v1/organizations/{org}/projects/{project}/cases/{case}` (`updateBindingCase`) | `GET /v1/organizations/{org}/projects/{project}/cases/{case}` (`getBindingCase`) | `binding_cases` |
| 4 | `PATCH /v1/organizations/{org}/projects/{project}/studies/{study}` (`updateStudy`) | none | `studies` |
| 5 | `PATCH /v1/users/me` (`updateOwnProfile`) | `GET /v1/users/me` (`getOwnProfile`) | `users` (the caller) |
| 6 | `PUT /v1/notifications/preferences` (`updateNotificationPreferences`) | `GET /v1/notifications/preferences` (`getNotificationPreferences`) | `users` (the caller) |
| 7 | `PUT /v1/engine-registrations/{name}/credential` | none | `v1_engine_credentials` of the registration |

`PATCH /v1/admin/users/{user_id}`, `PUT /v1/organizations/{org}/members/{member_id}` and `updateCollection`/`getCollection` are not covered (proposal.md, Out of scope). The collection is an `artifacts` row without `updated_at`; a later change owns that migration and covers all artifact `PATCH`es (design.md §3).

### Requirement: Strong opaque entity tag
THE gateway SHALL derive the `ETag` of a covered resource from its table, its row id and its revision, as a strong entity tag (a double-quoted string without the `W/` prefix) that is identical for equal revisions of the same row and different for different revisions or different rows.

`req~gateway-api-optimistic-concurrency-etag-format~1`

Needs: impl, utest

#### Scenario: Format
- **GIVEN** a row with revision 2026-10-22T00:00:00.000001Z
- **WHEN** the gateway derives its entity tag
- **THEN** the tag is a quoted string of 32 hexadecimal digits, does not start with `W/`, and contains no `"` inside

#### Scenario: Microsecond precision
- **GIVEN** one row at revisions 2026-10-22T00:00:00.000001Z and 2026-10-22T00:00:00.000002Z, and the same row twice at the first revision
- **WHEN** the gateway derives the entity tags
- **THEN** the two tags of the equal revisions are equal
- **AND** the tags of the two different revisions differ

#### Scenario: Different rows
- **GIVEN** two rows (of one table or of two tables) with the same revision
- **WHEN** the gateway derives their entity tags
- **THEN** the two tags differ

#### Scenario: Time zone normalized
- **GIVEN** a naive revision 2026-10-22T00:00:00.000000 and the aware equivalents 2026-10-22T02:00:00.000000+02:00 and 2026-10-22T00:00:00.000000Z, all of one row
- **WHEN** the gateway derives their entity tags
- **THEN** the three tags are equal

Evidence: `openbinding-gateway/tests/test_optimistic_revision.py`

The tag is opaque to clients (design.md D2): it reveals neither the timestamp nor the id. Clients compare tags only by equality and send them back unchanged.

### Requirement: Entity tag on single-resource reads
WHEN a single-resource read of the covered-operations table answers 200, THE gateway SHALL include the header `ETag` with the entity tag of the resource's current revision.

`req~gateway-api-optimistic-concurrency-etag-on-read~1`

Needs: impl, utest

#### Scenario: Project read
- **GIVEN** project `p1` of organization `isa-demo` and a MEMBER of `isa-demo`
- **WHEN** the member sends `GET /v1/organizations/isa-demo/projects/p1`
- **THEN** the gateway answers 200
- **AND** the response carries an `ETag` header that is a strong entity tag

#### Scenario: Refused read
- **GIVEN** a signed-in user who is not a member of private organization `isa-demo`
- **WHEN** the user sends `GET /v1/organizations/isa-demo`
- **THEN** the gateway answers 403 or 404 as before this change
- **AND** the response carries no `ETag` header

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`

### Requirement: Entity tag on successful writes
WHEN a covered write operation answers 200, THE gateway SHALL include the header `ETag` with the entity tag of the revision that the request stored.

`req~gateway-api-optimistic-concurrency-etag-on-write~1`

Needs: impl, utest

#### Scenario: Case renamed
- **GIVEN** case `c1` of project `p1` in `isa-demo` and a MEMBER of `isa-demo`
- **WHEN** the member sends `PATCH /v1/organizations/isa-demo/projects/p1/cases/c1` with `{"name": "Renamed"}` and no `If-Match`
- **THEN** the gateway answers 200
- **AND** the response `ETag` equals the `ETag` of a following `GET /v1/organizations/isa-demo/projects/p1/cases/c1`

#### Scenario: Engine credential replaced
- **GIVEN** a private engine registration owned by the caller
- **WHEN** the caller sends `PUT /v1/engine-registrations/{name}/credential?namespace=…&version=…&digest=…` with `{"secret": "s3cret"}`
- **THEN** the gateway answers 200 with the registration summary
- **AND** the response carries an `ETag` header that is a strong entity tag

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`

### Requirement: Every successful write stores a new revision
WHEN a covered write operation carries an `If-Match` header and answers 200, THE gateway SHALL have stored a revision of the resource that differs from the revision the resource had before the request, even if the request changed no field. WHEN it carries no `If-Match` header, THE gateway SHALL change the revision only if the request changed a stored column.

`req~gateway-api-optimistic-concurrency-revision-bump~1`

Needs: impl, utest

#### Scenario: Guarded write that changes no field
- **GIVEN** study `s1` of project `p1` in `isa-demo` with `ETag` A, and a MEMBER of `isa-demo`
- **WHEN** the member sends `PATCH /v1/organizations/isa-demo/projects/p1/studies/s1` with `{}` and `If-Match: A`
- **THEN** the gateway answers 200
- **AND** the response `ETag` differs from A

#### Scenario: Unguarded write that changes a field
- **GIVEN** project `p1` with `ETag` A and an ADMIN of `isa-demo`
- **WHEN** the admin sends `PATCH /v1/organizations/isa-demo/projects/p1` with `{"name": "Renamed"}` and no `If-Match`
- **THEN** the gateway answers 200
- **AND** the response `ETag` differs from A

#### Scenario: Unguarded write that changes nothing
- **GIVEN** case `c1` with `ETag` A and a MEMBER of `isa-demo`
- **WHEN** the member sends `PATCH /v1/organizations/isa-demo/projects/p1/cases/c1` with `{}` and no `If-Match`
- **THEN** the gateway answers 200
- **AND** the response `ETag` is A

#### Scenario: Empty profile update is not a write
- **GIVEN** a signed-in user whose `GET /v1/users/me` carries `ETag` A
- **WHEN** the user sends `PATCH /v1/users/me` with neither `email` nor `new_password`
- **THEN** the gateway answers 200 with the profile, as before this change
- **AND** the response `ETag` is A

Evidence: `openbinding-gateway/tests/test_optimistic_revision.py`; `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`

When `If-Match` is present the guard stores `updated_at = max(now, previous + 1 µs)` with `UPDATE … WHERE id = :id AND updated_at = :read_value` in the edit transaction (design.md D4), so a guarded 200 always carries a new tag. Without `If-Match` nothing is claimed and `updated_at` moves only when a column changes. A `PATCH /v1/users/me` without `email` and without `new_password` writes nothing and stays a read (design.md D6).

### Requirement: No precondition without If-Match
WHEN a covered write operation receives a request without an `If-Match` header, THE gateway SHALL process it with the status codes, bodies, stored changes and audit events it produced before this change.

`req~gateway-api-optimistic-concurrency-if-match-absent~1`

Needs: impl, utest

#### Scenario: Concurrent edit without the header
- **GIVEN** project `p1` whose `ETag` A was read by two ADMINs of `isa-demo`
- **WHEN** the first sends `PATCH /v1/organizations/isa-demo/projects/p1` with `{"name": "First"}` and the second then sends `{"name": "Second"}`, both without `If-Match`
- **THEN** both answers are 200
- **AND** the stored name is `Second`

#### Scenario: Existing tests unedited
- **GIVEN** this change's diff
- **WHEN** the gateway suite runs
- **THEN** the existing tests of the covered operations pass without being edited by the diff

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; the gateway suite (G5)

Clients that omit `If-Match` keep today's last-writer-wins behaviour and get no lost-update protection. A later change may make the header mandatory with `428 Precondition Required` (proposal.md, Out of scope).

### Requirement: If-Match wildcard
WHEN a covered write operation receives `If-Match: *` and the resource has a current revision, THE gateway SHALL evaluate the precondition as met.

`req~gateway-api-optimistic-concurrency-if-match-any~1`

Needs: impl, utest

#### Scenario: Wildcard on an existing case
- **GIVEN** case `c1` of project `p1` in `isa-demo` and a MEMBER of `isa-demo`
- **WHEN** the member sends `PATCH /v1/organizations/isa-demo/projects/p1/cases/c1` with `{"description": "x"}` and `If-Match: *`
- **THEN** the gateway answers 200
- **AND** the stored description is `x`

#### Scenario: Wildcard and a concurrent bump
- **GIVEN** case `c1` read by the member, then edited by another writer before the member's claim
- **WHEN** the member sends the same request with `If-Match: *`
- **THEN** the gateway answers 200, because the claim of `*` does not compare `updated_at` and only a vanished row fails it

Evidence: `openbinding-gateway/tests/test_optimistic_revision.py`; `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`

RFC 9110 §13.1.1: `*` matches any current representation of the target resource.

### Requirement: If-Match entity-tag list
WHEN a covered write operation receives an `If-Match` header that is a comma-separated list of entity tags, THE gateway SHALL evaluate the precondition as met if and only if at least one listed tag equals the resource's current `ETag` by strong comparison.

`req~gateway-api-optimistic-concurrency-if-match-list~1`

Needs: impl, utest

#### Scenario: Current tag in a list
- **GIVEN** organization `isa-demo` with `ETag` A and an ADMIN of `isa-demo`
- **WHEN** the admin sends `PATCH /v1/organizations/isa-demo` with `{"name": "ISA"}` and `If-Match: "stale", A`
- **THEN** the gateway answers 200
- **AND** the response `ETag` differs from A

#### Scenario: Optional whitespace
- **GIVEN** organization `isa-demo` with `ETag` A
- **WHEN** an ADMIN sends `PATCH /v1/organizations/isa-demo` with `If-Match: "stale" ,A ` (spaces around the comma and after the last tag)
- **THEN** the precondition is met

Evidence: `openbinding-gateway/tests/test_optimistic_revision.py`; `openbinding-gateway/tests/test_optimistic_organizations.py`

### Requirement: Weak tags never match
IF an `If-Match` entity tag of a request to a covered write operation is a weak tag (prefix `W/`), THEN THE gateway SHALL treat that tag as not matching, whatever its opaque value.

`req~gateway-api-optimistic-concurrency-if-match-weak~1`

Needs: impl, utest

#### Scenario: Weak form of the current tag
- **GIVEN** project `p1` with `ETag` `"0123456789abcdef0123456789abcdef"` and an ADMIN of `isa-demo`
- **WHEN** the admin sends `PATCH /v1/organizations/isa-demo/projects/p1` with `{"name": "x"}` and `If-Match: W/"0123456789abcdef0123456789abcdef"`
- **THEN** the gateway answers 412 with `code` `precondition_failed`
- **AND** the stored name is unchanged

Evidence: `openbinding-gateway/tests/test_optimistic_revision.py`; `openbinding-gateway/tests/test_optimistic_organizations.py`

RFC 9110 §13.1.1: `If-Match` uses the strong comparison function.

### Requirement: Malformed If-Match refused
IF a request to a covered write operation carries an `If-Match` header that is neither `*` nor a comma-separated list of entity tags, THEN THE gateway SHALL answer 400 with error code `invalid_if_match` and change nothing.

`req~gateway-api-optimistic-concurrency-invalid-if-match~1`

Needs: impl, utest

#### Scenario: Unquoted tag
- **GIVEN** case `c1` of project `p1` in `isa-demo` and a MEMBER of `isa-demo`
- **WHEN** the member sends `PATCH /v1/organizations/isa-demo/projects/p1/cases/c1` with `{"name": "x"}` and `If-Match: 1792627200000000`
- **THEN** the gateway answers 400
- **AND** the body `code` is `invalid_if_match`
- **AND** the stored name is unchanged and no `binding_case.updated` audit event is added

#### Scenario: Other malformed values
- **GIVEN** the same case and member
- **WHEN** the member sends the same request with each of the `If-Match` values: an empty value, `,`, `"a", *`, `"a`, `"a" "b"` and `W/a`
- **THEN** every answer is 400 with `code` `invalid_if_match`

#### Scenario: Empty list elements accepted
- **GIVEN** the same case with `ETag` A
- **WHEN** the member sends the same request with `If-Match: , A,`
- **THEN** the precondition is met and the gateway answers 200

Evidence: `openbinding-gateway/tests/test_optimistic_revision.py`; `openbinding-gateway/tests/test_optimistic_organizations.py`

Empty list elements are ignored (RFC 9110 §5.6.1.2). A header that holds no entity tag at all (an empty value, or only commas) is refused as malformed rather than read as an empty list (design.md D3).

### Requirement: Failed precondition refused
IF the `If-Match` precondition of a request to a covered write operation is not met, THEN THE gateway SHALL answer 412 with error code `precondition_failed` in the error body of `docs/ERRORS.md` for the route's family.

`req~gateway-api-optimistic-concurrency-precondition-failed~1`

Needs: impl, utest

#### Scenario: Stale tag on a platform route
- **GIVEN** project `p1` in `isa-demo`, read with `ETag` A, then renamed by another ADMIN
- **WHEN** an ADMIN of `isa-demo` sends `PATCH /v1/organizations/isa-demo/projects/p1` with `{"name": "x"}` and `If-Match: A`
- **THEN** the gateway answers 412 with media type `application/json`
- **AND** the body has `status` 412, `code` `precondition_failed`, `title` `precondition_failed` and `detail.code` `precondition_failed`

#### Scenario: Stale tag on the engine credential
- **GIVEN** a private engine registration of the caller whose credential has `ETag` A, then replaced again
- **WHEN** the caller sends `PUT /v1/engine-registrations/{name}/credential?…` with `{"secret": "new"}` and `If-Match: A`
- **THEN** the gateway answers 412 with media type `application/problem+json`
- **AND** the body has `status` 412, `code` `precondition_failed` and `title` `precondition_failed`

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`

Each covered write has its own stale-tag test: 412, the current `ETag` in the header, the stored resource unchanged (tasks.md).

### Requirement: Current entity tag on a failed precondition
WHEN the gateway answers 412 `precondition_failed` for a resource that has a current revision, THE gateway SHALL include the header `ETag` with the entity tag of that current revision.

`req~gateway-api-optimistic-concurrency-precondition-failed-etag~1`

Needs: impl, utest

#### Scenario: Stale study tag
- **GIVEN** study `s1` whose `ETag` was A and is now B after another member's `PATCH`
- **WHEN** a MEMBER sends `PATCH /v1/organizations/isa-demo/projects/p1/studies/s1` with `{"name": "x"}` and `If-Match: A`
- **THEN** the gateway answers 412
- **AND** the response `ETag` is B

Evidence: `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`

### Requirement: Nothing changes on a failed precondition
IF the gateway answers 412 `precondition_failed` to a request to a covered write operation, THEN THE gateway SHALL leave the stored resource, its revision, the audit log and every other stored state exactly as they were before the request.

`req~gateway-api-optimistic-concurrency-precondition-failed-unchanged~1`

Needs: impl, utest

#### Scenario: Organization with a sponsor change
- **GIVEN** organization `isa-demo` with `ETag` A, then renamed, and its OWNER who is not the billing sponsor
- **WHEN** the owner sends `PATCH /v1/organizations/isa-demo` with `{"name": "x", "billing_sponsor_user_id": "<owner id>"}` and `If-Match: A`
- **THEN** the gateway answers 412
- **AND** the stored name, parent and `billing_sponsor_user_id` are unchanged, no `organization.updated` audit event is added, and the sponsorship is not transferred

#### Scenario: Engine credential
- **GIVEN** a private, active engine registration of the caller whose credential `ETag` is stale
- **WHEN** the caller sends `PUT /v1/engine-registrations/{name}/credential?…` with a new secret and the stale tag
- **THEN** the gateway answers 412
- **AND** the stored encrypted secret, `is_active`, `publication_status` and verification report of the registration are unchanged

#### Scenario: Profile
- **GIVEN** a user whose `ETag` is stale
- **WHEN** the user sends `PATCH /v1/users/me` with the correct `current_password`, a new `email` and the stale tag
- **THEN** the gateway answers 412
- **AND** signing in with the old email still works and with the new email does not

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`

### Requirement: Resource without a current revision
IF a request to a covered write operation carries an `If-Match` header and the resource it edits has no current revision, THEN THE gateway SHALL answer 412 with error code `precondition_failed` and without an `ETag` header.

`req~gateway-api-optimistic-concurrency-no-current-revision~1`

Needs: impl, utest

#### Scenario: First credential with a wildcard
- **GIVEN** a private engine registration of the caller that has no stored credential yet
- **WHEN** the caller sends `PUT /v1/engine-registrations/{name}/credential?…` with `{"secret": "s"}` and `If-Match: *`
- **THEN** the gateway answers 412 with `code` `precondition_failed`
- **AND** the response has no `ETag` header and no credential is stored

#### Scenario: First credential without the header
- **GIVEN** the same registration without a credential
- **WHEN** the caller sends the same request without `If-Match`
- **THEN** the gateway answers 200 as before this change, and the response carries an `ETag`

Evidence: `openbinding-gateway/tests/test_optimistic_credential.py`

RFC 9110 §13.1.1: `If-Match: *` is false when the target resource has no current representation.

### Requirement: Access checks before the precondition
IF a request to a covered write operation would be refused with 401 (authentication), 404 (the target resource or its parents not found or not visible) or 403 (authorization on the target resource, including the OWNER check and the authorization on a new parent of `updateOrganization`), THEN THE gateway SHALL answer that refusal whatever the request's `If-Match` header holds, malformed or not.

`req~gateway-api-optimistic-concurrency-order-access~1`

Needs: impl, utest

#### Scenario: Viewer with a stale tag
- **GIVEN** project `p1` with a stale `ETag` A and a VIEWER of `isa-demo`
- **WHEN** the viewer sends `PATCH /v1/organizations/isa-demo/projects/p1` with `{"name": "x"}` and `If-Match: A`
- **THEN** the gateway answers 403 as before this change
- **AND** the response has no `ETag` header

#### Scenario: Unknown case with a malformed header
- **GIVEN** a MEMBER of `isa-demo`
- **WHEN** the member sends `PATCH /v1/organizations/isa-demo/projects/p1/cases/missing` with `If-Match: nope`
- **THEN** the gateway answers 404 with `code` `not_found`

#### Scenario: No credentials
- **GIVEN** no `Authorization` header and no API key
- **WHEN** a client sends `PUT /v1/notifications/preferences` with `If-Match: "x"`
- **THEN** the gateway answers 401

#### Scenario: Admin who is not the owner names a sponsor
- **GIVEN** organization `isa-demo` with a stale `ETag` A and an ADMIN who is not an OWNER
- **WHEN** the admin sends `PATCH /v1/organizations/isa-demo` with a `billing_sponsor_user_id` other than the stored one and `If-Match: A`
- **THEN** the gateway answers 403, not 412

#### Scenario: New parent not authorized or not found
- **GIVEN** organization `isa-demo` with a stale `ETag` A, its ADMIN, and a `parent_id` that does not exist or on which the admin has no ADMIN role
- **WHEN** the admin sends `PATCH /v1/organizations/isa-demo` with that `parent_id` and `If-Match: A`
- **THEN** the gateway answers 404 for the unknown parent and 403 for the unauthorized one, not 412

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`

A caller that may not read or edit the resource never learns its `ETag` from a 412. The per-route order is in design.md D5.

### Requirement: Precondition before state-dependent checks
WHILE the `If-Match` precondition of a request to a covered write operation is not met, THE gateway SHALL answer 412 `precondition_failed` instead of any 402, 409 or 422 refusal that depends on stored state.

`req~gateway-api-optimistic-concurrency-order-state~1`

Needs: impl, utest

#### Scenario: Stale tag and a refused sponsor
- **GIVEN** organization `isa-demo` with a stale `ETag` A and its OWNER
- **WHEN** the owner sends `PATCH /v1/organizations/isa-demo` with `billing_sponsor_user_id` of another user and `If-Match: A`
- **THEN** the gateway answers 412, not 422 `sponsor_must_be_caller`

#### Scenario: Stale tag and an ambiguous or cyclic parent
- **GIVEN** organization `isa-demo` with a stale `ETag` A, its ADMIN, and a request that both names `parent_id` and sets `move_to_root`, or moves the organization under its own descendant
- **WHEN** the admin sends that `PATCH` with `If-Match: A`
- **THEN** the gateway answers 412, not 422 `ambiguous_parent` or the acyclic-move refusal

#### Scenario: Stale tag and an email in use
- **GIVEN** a user with a stale `ETag` A and another account using `taken@example.org`
- **WHEN** the user sends `PATCH /v1/users/me` with the correct `current_password`, `{"email": "taken@example.org"}` and `If-Match: A`
- **THEN** the gateway answers 412, not 409 `already_registered`

#### Scenario: Stale tag on a published registration
- **GIVEN** a published engine registration of the caller with a stored credential and a stale `ETag` A
- **WHEN** the caller sends `PUT /v1/engine-registrations/{name}/credential?…` with a secret and `If-Match: A`
- **THEN** the gateway answers 412, not 409 `immutable_published_registration`

#### Scenario: Request body refused first
- **GIVEN** case `c1` with a stale `ETag` A
- **WHEN** a MEMBER sends `PATCH /v1/organizations/isa-demo/projects/p1/cases/c1` with `{"name": 5}` and `If-Match: A`
- **THEN** the gateway answers 422 `validation_error`, because the request body is validated before the handler runs

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`

### Requirement: Atomic precondition and write
WHEN two requests to the same covered write operation carry `If-Match` with the same current `ETag` and are processed concurrently, THE gateway SHALL apply exactly one of them and answer the other with 412 `precondition_failed`.

`req~gateway-api-optimistic-concurrency-atomic~1`

Needs: impl, utest

#### Scenario: Two writers, one tag
- **GIVEN** a covered resource with `ETag` A and two sessions that both start a write with `If-Match: A` before either commits
- **WHEN** both run to completion
- **THEN** one answers 200 and the other answers 412
- **AND** the stored resource holds the fields of the 200 request only

#### Scenario: A writer that commits between the read and the claim
- **GIVEN** project `p1` with `ETag` A and an ADMIN whose request has read the row
- **WHEN** another writer commits an edit before the ADMIN's claim runs
- **THEN** the ADMIN's `UPDATE … WHERE id = :id AND updated_at = :read_value` matches no row
- **AND** the gateway answers 412 with the new `ETag` and applies nothing

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`

### Requirement: Conditional requests declared in OpenAPI
THE gateway's OpenAPI document SHALL declare, on every covered write operation, an optional `If-Match` header parameter, a 400 response and a 412 response, each 412 response and each 200 response with an `ETag` response header, and an `ETag` response header on the 200 response of every single-resource read of the covered-operations table.

`req~gateway-api-optimistic-concurrency-openapi~1`

Needs: impl, utest

#### Scenario: Write operation
- **GIVEN** the OpenAPI document the application generates
- **WHEN** the test reads `updateProject`
- **THEN** its parameters include `If-Match` `in: header` with `required: false`
- **AND** its responses include `400`, `412` and `200`, and the `412` and `200` responses declare the header `ETag`

#### Scenario: Read operation
- **GIVEN** the same document
- **WHEN** the test reads `getOrganization`
- **THEN** its `200` response declares the header `ETag`

#### Scenario: Snapshot fresh
- **GIVEN** the committed `docs/openapi.json`
- **WHEN** `python tools/dump_openapi.py --check` runs
- **THEN** it passes

Evidence: `openbinding-gateway/tests/test_optimistic_organizations.py`; `openbinding-gateway/tests/test_optimistic_studies.py`; `openbinding-gateway/tests/test_optimistic_accounts.py`; `openbinding-gateway/tests/test_optimistic_credential.py`; `openbinding-gateway/tools/dump_openapi.py`; `docs/openapi.json`
