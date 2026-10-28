# Tasks: optimistic-concurrency

Slices S1–S3 each ship tests first (red on the base) and then the implementation of one area. S1 also creates the
shared helper. S4 regenerates the OpenAPI snapshot and S5 documents the errors. All of it ships as **one PR** into
`develop`, as sequential tasks. Tests carry `[utest->req~gateway-api-optimistic-concurrency-…~1]` and code carries
`[impl->…]` (design.md §6). Expected codes and headers in the tests are literals copied from
`specs/gateway-api/spec.md`, never imported from `core/revision.py`.

Per covered route, at least: a stale-tag test (412, current `ETag` in the header, stored resource and audit
unchanged), a right-tag test (200, new `ETag` different from the sent one), and a no-header test (the behaviour from
before this change). The helper tests cover `*`, the list and weak forms, the malformed values, the missing header and the
two-writer race once.

Checks to register (argv; `cwd` is the repository root unless noted):
1. G1: `["openspec","validate","optimistic-concurrency","--strict"]`.
2. G9: `["git","diff","--check"]`.
3. Slice tests (`openbinding-gateway`):
   `["uv","run","--locked","--extra","test","pytest","-q","-p","no:cacheprovider","tests/test_optimistic_concurrency_<area>.py"]`
   for `revision`, `organizations`, `studies` and `accounts`.
4. G5 `gateway-unit` (`openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest"]`.
5. G7 `openapi-snapshot` (`openbinding-gateway`): `["uv","run","--locked","python","tools/dump_openapi.py","--check"]`.
6. G7 contracts (`openbinding-gateway`): `["uv","run","--locked","--extra","test","pytest","tests/test_openapi_contract.py","tests/test_b4_problem_schema.py"]`.
7. G9 ruff (`openbinding-gateway`): `["uv","run","--locked","--extra","test","ruff","check","src","tests"]`.
8. G9 import contracts (`openbinding-gateway`): `["uv","run","--locked","--extra","test","--group","lint","lint-imports","--config",".importlinter"]`.

## S0. Specification (specifier)

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, `specs/gateway-api/spec.md` (18 ADDED requirements) and the
  `docs/ERRORS.md` section (S5 text drafted with the spec).
- [ ] 0.2 Owner answer to the collection question (design.md §3). Then remove the `[NEEDS CLARIFICATION]` marker
  from row 4 of the covered-operations table, or remove the row.
- [ ] 0.3 G1 (check 1) green; G2 EPIC review by the spec-auditor.

## S1. Helper and organizations (`routes/organizations.py`)

Owned: `openbinding-gateway/src/openbinding_gateway/core/revision.py` (new),
`openbinding-gateway/src/openbinding_gateway/routes/organizations.py`,
`openbinding-gateway/tests/test_optimistic_concurrency_revision.py` (new),
`openbinding-gateway/tests/test_optimistic_concurrency_organizations.py` (new).

- [ ] 1.1 Tests first: the helper (`-etag-format`, `-if-match-any`, `-if-match-list`, `-if-match-weak`,
  `-invalid-if-match`, `-atomic` with two sessions on one row, `-openapi` on the generated document for the
  organization operations), then routes 1–3 of the table (`-covered`, `-etag-on-read`, `-etag-on-write`,
  `-if-match-absent`, `-precondition-failed*`, `-order-access`, `-order-state` with `sponsor_must_be_caller`, and
  the sponsorship transfer not run on a 412). Red on the base.
- [ ] 1.2 `core/revision.py` (design.md D1–D4, D7). `etag_of`, `parse_if_match`, `claim`,
  `precondition_failed`, `IF_MATCH_PARAMETER`, `CONDITIONAL_WRITE_RESPONSES`.
- [ ] 1.3 `getOrganization`, `getProject` and `getBindingCase` send `ETag`. `updateOrganization`, `updateProject` and
  `updateBindingCase` take `If-Match` at the point of design.md D5 and send `ETag` on 200. The OWNER check of
  `updateOrganization` moves above the precondition (D5).
- [ ] 1.4 Checks 3 (`revision`, `organizations`), 4, 7, 8. Check 5 is expected to fail until S4. Do not
  regenerate the snapshot here.

## S2. Studies (`routes/studies.py`)

Owned: `openbinding-gateway/src/openbinding_gateway/routes/studies.py`,
`openbinding-gateway/tests/test_optimistic_concurrency_studies.py` (new). Collection rows only under option A of
design.md §3, and then also `openbinding-gateway/src/openbinding_gateway/db/artifact_models.py` and one new migration
under `openbinding-gateway/alembic/versions/`.

- [ ] 2.1 Tests first for `updateStudy` (stale, right, `{}` bumps, no header, 412 before
  `foreign_study_version`, 403 `api_key_engine_forbidden` before 412) and, under option A, for
  `getCollection`/`updateCollection`. Red on the base.
- [ ] 2.2 `updateStudy` (and, under A, `getCollection`/`updateCollection`) per design.md D5.
- [ ] 2.3 Checks 3 (`studies`), 4, 7, 8.

## S3. Accounts and engine credential (`routes/users.py`, `routes/notifications.py`, `routes/v1.py`)

Owned: `openbinding-gateway/src/openbinding_gateway/routes/users.py`,
`openbinding-gateway/src/openbinding_gateway/routes/notifications.py`,
`openbinding-gateway/src/openbinding_gateway/routes/v1.py`,
`openbinding-gateway/src/openbinding_gateway/services/engine_registry.py` (`set_credential` and the `RegistryProblem`
headers only), `openbinding-gateway/tests/test_optimistic_concurrency_accounts.py` (new).

- [ ] 3.1 Tests first: `getOwnProfile`/`updateOwnProfile` (stale tag with a new email: 412 and the old email still
  signs in; 412 before `already_registered`; the empty-body read keeps its tag, D6). `getNotificationPreferences`/
  `updateNotificationPreferences`, including the shared revision with the profile (D9). Credential `PUT`: stale,
  right, no stored credential with `*` (412 without `ETag`, D8), no header, 412 before
  `immutable_published_registration`, and the registration not reset on a 412. Red on the base.
- [ ] 3.2 Implementation per design.md D5–D9. The credential route keeps its current OpenAPI operation id.
- [ ] 3.3 Checks 3 (`accounts`), 4, 7, 8.

## S4. OpenAPI snapshot

Owned: `docs/openapi.json` (generated).

- [ ] 4.1 Regenerate with `tools/dump_openapi.py`. Every covered write declares `If-Match`, `400`, `412` (with
  `ETag`) and `ETag` on `200`. Every covered read declares `ETag` on `200` (design.md §5). No operation id
  changes.
- [ ] 4.2 Checks 5, 6, 4.

## S5. Error documentation

Owned: `docs/ERRORS.md`.

- [x] 5.1 Section "Conditional writes (`If-Match`)": `precondition_failed` (412, with the `ETag` header) and
  `invalid_if_match` (400), in the style of the existing entries. Drafted with S0. Update it only if S1–S3 change the
  wire shape.
- [ ] 5.2 Check 2.

## Review and archive

- [ ] Review panel (G11): reviewer, test-reviewer, arch-reviewer (new `core` module, order of checks in eight
  handlers), security-auditor (no tag disclosed before authorization). G13 against the preview:
  `curl -si -H "If-Match: \"0\"" -X PATCH …/projects/p1` returns 412 with `ETag`. The same call without the header
  returns 200.
- [ ] Archive in an explicit archive task after the merge:
  `["openspec","archive","optimistic-concurrency","--yes"]`, then `["openspec","validate","--all","--strict"]`.

## Follow-ups outside this change

- Frontend: send the loaded `ETag`, warn on 412 and offer a reload that keeps the typed text. It is a separate change
  because `frontend/src/pages/**` belongs to `m26-navigation`.
- `PATCH /v1/admin/users/{user_id}` (`adminUpdateUser`), after the `admin.py` LIKE fix merges.
- `PUT /v1/organizations/{org}/members/{member_id}`: the membership row has no `updated_at`. Covering it needs a
  revision source, which means a decision.
- Collections (and other artifact `PATCH`es) if the owner chooses option B of design.md §3.
- Mandatory `If-Match` (428) once the frontend and API clients send it.
