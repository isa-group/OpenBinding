# Intake: P-20261103-3, reject organization and project slugs that fixed frontend routes shadow

- Kind: security, size S, owner-approved with a condition: start only after PR 77 merges (final M2.6 route table).
  If the new 422 counts as a public-contract change under INTENT §11.1, open a CRP (owner note).
- Base: `task/ff408628ced74b9e` at `b8067258`.
- INTENT objective: **O8, Security**: "0 open high or critical findings at each release to `main`" (`INTENT.md:169`).
  Source: security-auditor followup 0f0f4b0e6f8946fe (quoted by the proposal, not re-read here).

## 1. Objective

The gateway refuses to create an organization or a project whose slug yields an address that the app cannot open,
or that opens a different screen. One list in the gateway holds the reserved slugs. A test keeps it in step with the
frontend route tables. A read-only report finds existing rows that already collide.

## 2. Evidence checked against the code at `b8067258`

| # | Fact | Evidence |
|---|---|---|
| F1 | Slugs are checked only against a pattern, with no reserved names. `OrganizationCreate.slug` and `ProjectCreate.slug` use `SLUG` | `openbinding-gateway/src/openbinding_gateway/models/platform.py:21,25-27,111-113` |
| F2 | Gateway source hits for "reserved" are unrelated: `routes/v1.py:1115` (idempotency key), `v1/remote.py:85` (IP address), `domain/binding_space.py:31` (comment) | grep `-i reserved` over `openbinding-gateway/src` |
| F3 | Organization addresses are flat, `/app/:org`. The org slug is globally unique | `frontend/src/routes/d3.tsx:21`; `db/platform_models.py:131` |
| F4 | Static first segments under `/app/` in the live tables: `account` (`d2.tsx:17-22`), `admin` (`d8.tsx:19-26`), `engines` (`d7.tsx:13-15`), `generator` (`d4.tsx:32`), `jobs` (`d5.tsx:16`), `language` (`d7.tsx:16`), `organizations` (`d3.tsx:20`), `system` (`d1.tsx:43`), `verifier` (`d6.tsx:28`) | grep of `live('…', '/app…'` in `frontend/src/routes/d*.tsx` |
| F5 | **The retired-redirect table adds `analysis`**: `/app/analysis` and `/app/analysis/workspace` redirect. The proposal's list does not include it | `frontend/src/routes/retiredRoutes.tsx:86-87` |
| F6 | Two kinds of shadowing. An exact `/app/<seg>` route hides the organization's overview: `account`, `admin`, `analysis`, `generator`, `jobs`, `verifier`. The other segments hide only some project addresses: in org `engines` the projects `new` and `registrations`, in `language` the project `extensions`, in `organizations` the project `new`, in `system` the project `states` | F4, F5 (a static segment outranks a dynamic one in React Router 7, `frontend/package.json:33`) |
| F7 | Static segments directly under `/app/:org/` shadow project slugs: `settings` (`d3.tsx:22-24`), `new-project` (`d3.tsx:25`), and **`library`** (retired redirect, `retiredRoutes.tsx:82-85`). Tests pin that `/app/acme/library` lands on the organization overview, so a project named `library` loses its overview (its sections still work) | `frontend/src/routes/retiredScreens.test.tsx:201,224`; `retiredRoutes.test.tsx:323`; `index.tsx:55-56` |
| F8 | No public route takes `:org` or `:project`. Only `/app/**` addresses carry these slugs | grep of `:org\|:project` in `d1.tsx`, `d2.tsx`, `d7.tsx`, `d8.tsx` (none); `d1.tsx:26-43` |
| F9 | **UUID-shaped slugs are also unreachable.** `SLUG` accepts strings such as a hyphenated UUID or 32 hex digits. `organization_by_ref` and `project_by_ref` parse any reference that `uuid.UUID()` accepts as an id, so that slug can never be found. The create-time conflict check then searches by id and misses an existing slug. Only the DB unique constraint remains (what it answers, likely 500, is not verified) | `collaboration.py:33-43,138-150`; `routes/organizations.py:183`; `db/platform_models.py:131,192` |
| F10 | **`ProjectView` inherits `ProjectCreate`**, and `_project_view` builds a `ProjectView` for every stored project. A validator on `ProjectCreate.slug` would also run on reads: any existing project with a reserved slug would fail to serialize (list and read) | `models/platform.py:126`; `routes/organizations.py:773-774,790-791` |
| F11 | Slugs cannot be changed through the API. `OrganizationUpdate` and `ProjectUpdate` have no `slug` field | `models/platform.py:33-45,119-123` |
| F12 | Creation paths: `POST /v1/organizations` (`createOrganization`) and `POST /v1/organizations/{org}/projects` (`createProject`). The seed tools create ORM rows directly with non-reserved slugs (`score-group`, `score-ai`, `score-edge`, `acme-corp`, `acme-cloud`, `lab-main`, `lab-other`, `bim-demo`) | `routes/organizations.py:172-216,794-816`; `tools/seed_dev.py:430-502,565-597`; `tools/seed_lab.py:90,104-107` |
| F13 | Error convention. A request Pydantic refuses yields 422 `validation_error`, with one diagnostic per error whose `code` is the Pydantic error type. A route-level `api_error(422, code, …)` yields its own top-level `code`. ERRORS.md reserves specific top-level codes for "a route refuses a value it understood" | `docs/ERRORS.md:36,49,96-104`; `main.py:209-217,231-239` |
| F14 | The frontend create forms show a generic text for any 422 that is not `invalid_sponsor` ("The gateway refused these values … Check the name and the address."). Their client-side pattern equals `SLUG` | `frontend/src/pages/Organization/OrgCreate.tsx:60-63`; `orgModel.ts:42`; `pages/Project/ProjectCreate.tsx:62-70` |
| F15 | The OpenAPI snapshot is generated by `tools/dump_openapi.py` and checked with `--check` (G7 `openapi-snapshot`). `docs/openapi.json` is a generated path, outside the size limit | `openbinding-gateway/tools/dump_openapi.py:9-13`; `.agentic/project.yaml:25-26,66` |
| F16 | Precedent for a gateway test that parses the frontend route tables: `live(...)` paths from `d[0-9].tsx` and paths from `retiredRoutes.tsx` | `openbinding-gateway/tests/test_b2_resolve_urls.py:40-73` |
| F17 | Any change under `frontend/` (except `e2e/` and `.md`) also runs the gateway CI area, so a gateway test that reads the route tables runs on every route change | `tools/ci_changes.py:43-47` |
| F18 | Precedent for a read-only DB report tool: it never commits, and on PostgreSQL its transaction is `READ ONLY` | `openbinding-gateway/tools/diagnose_snapshots.py:12-14` |
| F19 | Risk globs. `routes/organizations.py` and `frontend/src/routes/**` are R1 (high). `models/**` and `docs/openapi.json` are R3 (high if breaking). `openbinding-gateway/tools/**` and `docs/ERRORS.md` match no glob. Agents must not query production | `.agentic/project.yaml:106-114,174-176` |
| F20 | §11.1: "A breaking change to a public contract: `docs/openapi.json` …" needs a CRP. The factory's contract rule counts "narrowing accepted values" and new error codes as breaking | `INTENT.md:221-224`; factory skill openapi-contracts |
| F21 | M2.6 is planned to change the route tables. Wave 0 (A1) moves `d1..d8` into `routes/areas/<area>.tsx`, each with its own redirects. UR renames `/app/jobs` to `/app/runs` (D-M26-6). CD turns org-create and proj-create into dialogs. Verify moves to the public `/verify/...` | `docs/agent-work/m26-navigation/handoff.md:22-28,77,83`; `m26-navigation/intake.md:111,150,192` |
| F22 | Requirements on organizations and projects live in capability `collaboration-artifacts` | `openspec/specs/collaboration-artifacts/spec.md:6-11` |
| F23 | API acceptance tests run in process with `-c acceptance/api/pytest.ini` | `acceptance/api/pytest.ini:1-3`; `.github/workflows/ci.yml:222`; `TESTING.md:44` |

Not verified from this role: the content and state of PR 77. The repo tool is not available to the planner. The
proposal and the owner note say it carries the final M2.6 route table; F21 is the plan, not the merged result.

### Deviations from the proposal

1. **The reserved organization list is longer than the proposal's five.** From F4 to F6: `account`, `admin`,
   `analysis`, `engines`, `generator`, `jobs`, `language`, `organizations`, `system`, `verifier`. M2.6 also plans
   `runs` (F21). Project list (F7): `settings`, `new-project`, `library`.
2. **UUID-shaped slugs (F9)** fit the stated value ("nobody can create an organization or project that the app
   cannot open") but are not in the proposal. Including them narrows input further, so it goes into CRP-1, option 1b.
3. **The reservation cannot be a validator inherited by `ProjectView` (F10).** S2 separates the request model from the
   response model.
4. **"Enforced in `OrganizationCreate`/`ProjectCreate`" and "a stable error code" pull in different directions (F13).**
   A model validator gives top-level `validation_error` with diagnostic code `reserved_slug`. A route check gives a top-level
   `reserved_slug`, but it edits `routes/organizations.py` (R1, high). Q1 recommends the model validator.
5. **The parity test runs on the gateway side, not in the frontend** (F16, F17). It reuses the existing parser
   precedent, and it runs whenever a route file or the gateway list changes. Q3.

## 3. Scope

In scope:
- A reserved-slug module in the gateway with two lists (organization level and project level) and one UUID-shape rule.
  Each entry carries a one-line comment naming the route that reserves it.
- A parity test. Every static first segment under `/app/` in the live and redirect tables must be in the organization
  list. Every static segment directly under `/app/:org/` must be in the project list. Extra reserved entries are
  allowed, so the lists can run ahead of planned routes.
- A read-only report tool. It lists stored organizations and projects whose slug is reserved or UUID-shaped, showing
  id, slug, created date and counts only. It never writes.
- Enforcement on `createOrganization` and `createProject` with 422 (shape per Q1), plus the `docs/ERRORS.md` entry, the
  regenerated `docs/openapi.json` and tests. Stored rows keep reading and listing.

Non-goals:
- Moving organizations under a prefix such as `/app/o/:org` (that would be a route change for M2.6, alternative 1).
- Renaming or deleting existing rows. That is CRP-2, and any rename is a separate owner-approved task.
- Running the report against production (F19). The owner runs it (CRP-2).
- A DB constraint or migration: it would fail on colliding rows and is R6 (high).
- Changes to the frontend create forms (F14). They are a followup after M2.6 CD.
- The proposal's backlog items (ADR for routed screens, unreachable non-embedded branches, `m0-infra-close/tasks.md`).
- `acceptance/**`, `openspec/specs/**`.

## 4. Slices

Order: S1, then S2, one after the other. Both start only after PR 77 merges (owner note). S2 also waits for CRP-1,
and for CRP-2 if S1's report finds rows. No feature flag: S1 changes no behaviour (an unused module, a test and an
offline tool), and S2 is the only behavioural slice. Rolling S2 back means reverting it.

OpenSpec: one change, `reserved-slugs`, ADDED requirements in `collaboration-artifacts` (F22). Suggested ids:
`req~collaboration-artifacts-reserved-org-slugs~1`, `req~collaboration-artifacts-reserved-project-slugs~1`,
`req~collaboration-artifacts-uuid-shaped-slugs~1` (if CRP-1 picks 1b), `req~collaboration-artifacts-reserved-slugs-parity~1`,
`req~collaboration-artifacts-stored-slugs-readable~1`, `req~collaboration-artifacts-reserved-slug-report~1`.
A test-designer task writes `acceptance/api/test_reserved_slugs.py` from the change for S2.

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff (non-test) | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | `reserved-slugs-list`: the module with both lists and the UUID rule, the parity test against the post-PR-77 route tables, and the read-only report tool | implementer, default model, medium effort, about 40 turns | `openbinding-gateway/src/openbinding_gateway/models/slugs.py` (new), `openbinding-gateway/tests/test_reserved_slugs_parity.py` (new), `openbinding-gateway/tools/reserved_slug_report.py` (new), `openbinding-gateway/tests/test_reserved_slug_report.py` (new) | F3-F9, F16-F18, F21; the route files as PR 77 leaves them; `tests/test_b2_resolve_urls.py`; `tools/diagnose_snapshots.py` | about 110-150 lines | **medium**: `models/**` is R3 (F19), but nothing in the API changes. Panel: reviewer, test-reviewer. Focus: completeness of the lists, the parser following PR 77's file layout, the report being read-only | PR 77 merged; G1 of `reserved-slugs` |
| S2 | `reserved-slugs-enforce`: refuse reserved and (per CRP-1) UUID-shaped slugs on both create routes, keep stored rows readable, document the code | implementer, default model, medium effort, about 45 turns | `openbinding-gateway/src/openbinding_gateway/models/platform.py`, `openbinding-gateway/tests/test_reserved_slugs_api.py` (new), `docs/ERRORS.md`, `docs/openapi.json` (generated) | S1 module; F1, F10-F15, F20; `routes/organizations.py` (read only, unless Q1 picks B); frozen `acceptance/api/test_reserved_slugs.py` | about 50-90 lines + regenerated snapshot | **high**: R3 breaking narrowing (F19, F20), kind security. Panel: reviewer, test-reviewer, security-auditor, arch-reviewer | S1 merged; CRP-1 answered; CRP-2 answered if S1's report finds rows; T-S2 acceptance frozen |

S2 design constraints (from the evidence):
- `ProjectView` must not inherit the reservation (F10). Either it declares its own `slug` field, or both models share a
  base without the validator. A test proves that a stored project named `settings` still lists and reads with 200.
- Nothing about the refusal reveals whether another organization exists. The reservation is checked before the
  existence lookup (`organizations.py:183`). With Q1 option A that happens by construction.
- If Q2 is accepted, the lists appear in the request schemas only, as `not: {enum: [...]}` on `slug`. They must not
  appear in `OrganizationView`/`ProjectView`.

### Proposed checks (none are registered for this proposal)

`GW` = `openbinding-gateway`.

S1:
1. G3 red-before: `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","pytest","tests/test_reserved_slugs_parity.py","tests/test_reserved_slug_report.py"],"type":"red_before","expect_exit":[1,2]}`.
   It fails because the module and the tool are missing (exit 2 on a collection error).
2. Targeted green-after: the same argv as a plain check.
3. G5 `gateway-unit` (`project.yaml:44`): `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","pytest"]}`.
4. G9 `ruff-gateway` (`project.yaml:76`): `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","ruff","check","src","tests","tools/reserved_slug_report.py"]}`.
5. `bim-guard` (`project.yaml:52`; lesson 1): `{"cwd":".","argv":["python3","tools/check_bim_guard.py"]}`.
6. `changelog` (`project.yaml:83`; lesson 2): `{"cwd":".","argv":["python3","tools/generate_changelog.py","--check"]}`,
   only after the pr-steward's final `chore(changelog)` commit.

S2:
1. G3 red-before (acceptance, G4): `{"cwd":".","argv":["openbinding-gateway/.venv/bin/python","-m","pytest","-c","acceptance/api/pytest.ini","acceptance/api/test_reserved_slugs.py"],"type":"red_before","expect_exit":[1]}`.
   It needs the gateway venv synced first (check 3 does that).
2. G3 red-before (unit): `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","pytest","tests/test_reserved_slugs_api.py"],"type":"red_before","expect_exit":[1]}`.
3. Green-after: both argvs of checks 1-2 as plain checks. Run the unit one first, because `uv run` syncs the venv.
4. G7 `openapi-snapshot` (`project.yaml:66`): `{"cwd":"GW","argv":["uv","run","--locked","python","tools/dump_openapi.py","--check"]}`.
   The implementer regenerates with the same argv without `--check`, through a registered check.
5. G7 `openapi-contract-tests` (`project.yaml:67`): `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","pytest","tests/test_openapi_contract.py","tests/test_b4_problem_schema.py","tests/test_bim_consumer_contract.py"]}`.
6. G5 `gateway-unit`, G9 `ruff-gateway`, `bim-guard`, `changelog`: as for S1.

## 5. Gates per slice

| Gate | S1 | S2 |
|---|---|---|
| G1 spec | `openspec validate reserved-slugs --strict`. `todo: true` (`project.yaml:34`), so it is NOT EXECUTED locally; CI job `openspec` reports it | same change |
| G2 EPIC | spec-auditor on `reserved-slugs` | same change |
| G3 red-before | check 1 (module and tool missing) | checks 1-2 (201 today where 422 is expected) |
| G4 acceptance frozen | n/a (no visible behaviour; unit tests first) | `acceptance/api/test_reserved_slugs.py` by test-designer, frozen before S2 starts |
| G5 green-after | checks 2-3 | check 3 and `gateway-unit` |
| G6 trace | `[utest->req~…~1]` tags in both tests and `[impl->…]` in the module. `oft-trace` is `todo: true` (`project.yaml:62`); CI `trace` reports it | same, with tags on the validators |
| G7 contracts | n/a: no API change. The snapshot must stay unchanged (check 4 of S2 may run here as a guard) | checks 4-5. Breaking narrowing: CRP-1 records the owner's decision (F20) |
| G8 mutation | n/a: `mutmut-gateway` is `todo: true` (`project.yaml:72`) | same; state it in the MRP |
| G9 quality | checks 4, 6 | `ruff-gateway`, `changelog` |
| G10 secrets/ownership | the report prints ids, slugs, dates and counts only, no names or e-mails. Synthetic fixtures. No R11 path | no R11 path; `docs/openapi.json` regenerated, never hand-edited |
| G11 review | medium: reviewer, test-reviewer | high: reviewer, test-reviewer, security-auditor, arch-reviewer |
| G12 lab/UI | n/a: no runtime behaviour. The owner or ops may run the report in the lab (`DATABASE_URL` of the lab) | lab preview: `POST /v1/organizations` with `admin` gives 422, with a normal slug 201. The lab seed slugs (F12) are unaffected. No UI change, so no ui-qa |
| G13 review package | n/a with `how_to_review`: read the lists next to the route tables; run the report on a synthetic DB | `how_to_test`: verified API examples (org `admin` 422, project `settings` 422, UUID-shaped 422 if 1b, normal 201, stored reserved project still 200) |

## 6. Feature flags

None (§4). S1 is inert, and S2 is one slice whose rollback is a revert.

## 7. Open questions

Need a CRP (owner):
- **CRP-1: is the new 422 a breaking change under §11.1, and how is it shipped?** Evidence: F20. `docs/openapi.json`
  changes, and accepted values narrow. Planner's reading: **yes, it counts**, so the owner's condition to open a CRP
  applies.
  - A (recommended): ship it directly as a security fix, with no expand/contract. Document it in `docs/ERRORS.md`,
    the changelog and the release notes. A client that relied on creating such a slug got an address that opened the
    wrong screen (F6, F7), so no working use breaks. Condition: CRP-2 is settled.
  - B: expand/contract. First a release that accepts and warns (a response header or field), then the refusal. This
    takes two more slices and leaves the impersonation risk open for one release.
  - C: proposal alternative 2, warn only in the create form. The API stays open. Not recommended: the API is the
    contract, and the forms are being rebuilt by M2.6 CD.
  - Sub-question 1b: also refuse UUID-shaped slugs (F9)? Recommended yes: same value, same slice, a few lines.
  - The error shape is part of the answer (Q1 below). The recommendation is 422 `validation_error` with diagnostic
    `reserved_slug` (or `uuid_shaped_slug`) at pointer `/slug`.
- **CRP-2: what happens to existing rows that collide, and who checks production?** Evidence: F11 (no API rename) and
  F19 (agents must not query production).
  - A (recommended): the owner runs S1's read-only report on production and the lab. If it finds no rows, S2
    proceeds. Found rows are grandfathered (they stay readable and listable, F10) and their owners are told.
  - B: an owner-approved rename of colliding rows. That is a data change with link breakage, so a separate task with
    its own CRP.
  - C: block S2 until no colliding row is left.

For the coordinator (no CRP):
- **Q1: error shape.** A (recommended): a Pydantic custom error in the request models. The top-level code stays
  `validation_error` and the diagnostic code is `reserved_slug`. That keeps the change in `models/**` (R3), out of R1,
  and before any lookup. It also matches how a `SLUG` pattern failure is reported today (F13). B: an `api_error(422,
  "reserved_slug")` in `routes/organizations.py`. That makes the code top-level but puts the change in R1 (high) and
  makes S2 own that file.
- **Q2: publish the lists in OpenAPI** as `not: {enum: [...]}` on the request `slug` fields. Recommended: yes. Clients
  can pre-check, and the snapshot diff shows every future change to the list.
- **Q3: where the parity test lives.** Recommended: gateway pytest, following `test_b2_resolve_urls.py` (F16). It runs on
  every frontend route change (F17), and S1 then stays in one stack. The proposal's frontend vitest would need to read
  the Python list or `docs/openapi.json` across packages.
- **Q4: reserve the planned M2.6 segments now** (`runs`, F21) so that M2.6 slices UR and later do not fail the parity
  test on a gateway file they do not own. Recommended: yes, and never remove an entry when a route is retired (old
  addresses keep redirecting).
- **Q5: a coupling to tell M2.6.** After S1, an M2.6 slice that adds a new static segment under `/app/` or `/app/:org/`
  fails the parity test until the gateway list grows. The coordinator either adds `models/slugs.py` to that slice's
  scope or runs a one-line follow-up task.

## 8. Followups (outside this scope)

- After M2.6 CD, the create dialogs explain a reserved address instead of the generic 422 text (F14), and they
  optionally pre-check against the published list (Q2). Files: CD's `OrgCreate*`/`ProjectCreate*` (R9, medium).
- `organization_by_ref`'s create-time conflict check misses UUID-shaped slugs (F9). After S2 no new such slug can be
  created, but the DB-unique-violation path on create should answer 409, not an unhandled error. Unverified; a
  debugger task should confirm it.
- The proposal's backlog: the ADR for routed screens (D-M26-1, D-M26-6), the unreachable non-embedded branches, and
  `openspec/changes/m0-infra-close/tasks.md:141-143`.
