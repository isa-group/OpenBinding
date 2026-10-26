# Tasks: m43-plans-pricing-route

Slices in build order, each at most ~300 diff lines, tests written before the code (test-designer first, then
implementer). Check commands run from the repository root; pytest checks are one argv `["uv", "run", "--directory",
"openbinding-gateway", "--locked", "--extra", "test", "pytest", "-q", …]`.

## S0. Specification (this change)
- [x] 0.1 `openspec/changes/m43-plans-pricing-route/` (proposal, design, tasks, delta specs `plans-pricing` with
  eighteen ADDED requirements and `frontend-catalog-pricing` with one REMOVED requirement).
- Acceptance: `openspec validate m43-plans-pricing-route --strict` passes.

## S1. Expand: the new route (gateway lead; compatible)
Depends on: the fixture files `manifest.json` and `openbinding-0.2.0.yml` at
`openbinding-gateway/tests/fixtures/pricing/` (parallel fixture task; derived, design.md §1); and, as a prerequisite
owned by the lab-tests change, `ALLOWED_PREFIXES` of `lab/tests/test_no_direct_space_http.py` aligned from
`openbinding-gateway/src/openbinding_gateway/plans/` to `openbinding-gateway/src/openbinding_gateway/modules/plans/`
(design.md §9). Owns:
`openbinding-gateway/src/openbinding_gateway/modules/plans/` (reader and route; coordinated with M4.2), `main.py`
(router, tag `Plans`, problem media type of `/v1/plans` if not already done by M4.2 S5), `core/settings.py`
(`SPHERE_PRICING_ID`), `security/apikeys.py`,
`routes/pricing.py` (deprecation headers only), `openbinding-gateway/tests/test_plans_pricing*.py`,
`openbinding-gateway/tests/conftest.py` (network guard), `tests/test_openapi_contract.py`,
`tests/test_api_key_route_table.py`, `docs/openapi.json`, `docs/ERRORS.md` (media type list, if not already done by
M4.2 S5).
- [ ] 1.0 Re-record `manifest.json` and `openbinding-0.2.0.yml` from SPHERE's public API without any credential (plain
  GETs, no key, no cookie) and compare them with the derived files; if the shape, the YAML bytes or `contentHash`
  differ, replace the fixture with the recorded bytes and ask the specifier for the revision of design.md §11 before 1.1.
- [ ] 1.1 Tests (test-designer): every scenario of the S1 requirements of design.md §12, tagged
  `[utest->req~plans-pricing-…~1]`, with `httpx.MockTransport` over the two fixture files, a fake clock and a fake plans
  port; red before the code.
- [ ] 1.2 SPHERE public reader in the plans module (design.md §2, §9): no credential, GET only, no redirect, bounds,
  verification, 300 s read, 30 s failure pause, single flight.
- [ ] 1.3 Route `GET /v1/plans/pricing`: body `PlansPricing`, `ETag`, `Cache-Control`, `304`, public-read rate limit in
  its own bucket, `503`/`429` as `application/problem+json` (design.md §3-§6). Add `/v1/plans` to the problem+json
  prefixes of `main.py` and of `docs/ERRORS.md` §"Media type", if not already done by M4.2 S5 (design.md §4.3).
- [ ] 1.4 Deprecation signals on the three old routes (`Deprecation`, `Link`; `deprecated: true` on `getPricingCatalog`
  and `getCurrentPricing`).
- [ ] 1.5 Regenerate `docs/openapi.json` with `openbinding-gateway/tools/dump_openapi.py`; add
  `("/v1/plans/pricing", "get")` to the public set of `tests/test_openapi_contract.py` and `/v1/plans/pricing` to
  `OPEN_V1_GET_PATHS`.
- [ ] 1.6 Network guard in `openbinding-gateway/tests/conftest.py` (`req~plans-pricing-no-network-in-tests~1`,
  design.md §9), with its control tests.
- Acceptance: the S1 tests pass; `dump_openapi.py --check` passes; the existing `/v1/pricing*` tests pass unchanged
  apart from the new headers; the OFT trace (G6) has no defect for the S1 requirements; no test opens a connection.

## S2. SPACE active version (gateway lead; after M4.2's `PlanPort.active_version()`)
Depends on: `PlanPort.active_version() -> str | None` of `m42-plans-module` (design.md §2 step 5).
- [ ] 2.1 `spaceActiveVersion` from `PlanPort.active_version()` (`req~plans-pricing-space-active-version~1`), with its
  tests; no other SPACE read.
- Acceptance: the three scenarios of that requirement pass with a fake plans port whose `active_version()` returns
  `0.2.0` or `None`. Folded into S1 when that method has merged before S1 starts.

## S3. Migrate the clients (frontend lead; another change)
- [ ] 3.1 Pricing page and engine detail read `GET /v1/plans/pricing` (`document`, `version`, `digest`, `yamlUrl`)
  instead of `/v1/pricing/catalog` and `/v1/pricing/current`; e2e mocks follow; the `frontend-catalog-pricing`
  requirements that name `/v1/pricing/*` are revised there.
- Acceptance: no source under `frontend/src` calls `/v1/pricing`.

## S4. Contract: remove the old routes (gateway lead; breaking, owner approval)
Preconditions: S3 merged; S1 shipped in a release; the owner's approval of the removal recorded (design.md §8, §10 D8).
- [ ] 4.1 Tests for `req~plans-pricing-deprecated-routes-retired~1` and `req~plans-pricing-no-sphere-key~1`.
- [ ] 4.2 Delete `routes/pricing.py`, `models/pricing.py`, `pricing_catalog.py`, `sphere_client.py`, the `/v1/pricing`
  override in `main.py`, the `/v1/pricing` branch of `security/apikeys.py`, the settings of design.md §7 and the tests
  of the removed code (`test_published_pricing.py` and the `/v1/pricing` cases of the other suites).
- [ ] 4.3 Regenerate `docs/openapi.json`; run `oasdiff breaking` when registered and quote it in the PR.
- [ ] 4.4 Drop `openbinding-gateway/src/openbinding_gateway/sphere_client.py` from the pinned deviations of
  `lab/tests/test_no_direct_space_http.py`; update `docs/ACCOUNTS_AND_PLANS.md` (settings table) and the CHANGELOG
  ("Removed").
- [ ] 4.5 Specifier: remove `req~plans-pricing-deprecated-routes-signal~1` from `specs/plans-pricing/spec.md` of this
  change (its code and tests are gone; design.md §8), then run G1 again; the change is archived after this slice.
- [ ] 4.6 Archive gate: a frontend requirement for the unavailable state of the Pricing page (what the page shows when
  `GET /v1/plans/pricing` answers `503 pricing_unavailable`) exists in `frontend-catalog-pricing`, written by the
  frontend lead, before this change is archived. The REMOVED `req~frontend-catalog-pricing-read-only-source~1` carried
  that obligation; without its replacement the archive leaves it uncovered.
- Acceptance: the S4 tests pass; the architecture test passes with one pinned deviation fewer; no SPHERE key in
  settings; the unit suites open no connection to SPACE or SPHERE.

## Follow-ups
- Coordinator: compare design.md §10 with the text of `crp-ob-m4-plans-decisions` and open a revision where they
  differ.
- Frontend lead: revise `req~frontend-catalog-pricing-live-document~2` (its evidence names
  `test_published_pricing.py`, deleted in S4) when migrating in S3.
- Frontend lead: write the frontend requirement for the Pricing page's unavailable state (task 4.6); it must exist
  before this change is archived.
- Lab-tests change: align `ALLOWED_PREFIXES` of `lab/tests/test_no_direct_space_http.py` with
  `openbinding_gateway/modules/plans/` (prerequisite of S1).
- Coordinator: settle the digest of 0.2.0, ROADMAP `3db4ad99…` against the repository file's `4b9c7203…`
  (design.md §1, §11).
- Retire the `pricing:read` API-key permission once no route uses it (design.md §8).
- M4.2: decide the fate of `SPACE_PRICING_VERSION`; this route no longer reads it.
- M4.2: confirm in its S8 suite which field of SPACE's pricing event payload carries the version that
  `PlanPort.active_version()` returns (UNVERIFIED, design.md §11).
- Doc-steward: `docs/ARCHITECTURE.md` §9.2 says the descriptor carries "the version SPACE has activated"; reword it as
  the version of the last SPACE pricing event the plans module received (`PlanPort.active_version()`), `null` before
  the first event and while SPACE is unavailable (design.md §2 step 5, §11).
- The other M4.3 removals (release sweeps, local metering, sponsorship capacity checks) are separate changes.
