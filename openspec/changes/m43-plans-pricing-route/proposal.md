# Change: m43-plans-pricing-route

## Why

ROADMAP M4.3: "`GET /v1/plans/pricing` from SPHERE's public API (a recorded pricing in tests); removal of
`sphere_client.py`, `pricing_catalog.py`, deprecated pricing routes, release sweeps, local metering and sponsorship
capacity checks", with the acceptance "no SPHERE key in settings; architecture test forbids SPACE/SPHERE HTTP outside
`plans`; unit suites open no connection to SPACE or SPHERE". ADR-0015 §3 says "the gateway reads SPHERE only through its
public permanent-link API (no key) to serve the pricing to the browser", and §7 removes `sphere_client.py`,
`pricing_catalog.py`, the deprecated `/v1/pricing` proxy and `/v1/pricing/catalog`. `docs/ARCHITECTURE.md` §9.2
describes the route. The owner accepted the CRP `crp-ob-m4-plans-decisions` with "accept-all"
(own-7153cec8d5a447fa909601bc7ad8fe4d); its text is not in the repository (design.md §10).

Today the gateway reads SPHERE with a private key (`SPHERE_API_KEY`, `sphere_client.py`), shows the version pinned by
`SPACE_PRICING_VERSION` and serves it under three `/v1/pricing` routes. This change fixes the HTTP contract of the
route that replaces them, and the expand/contract plan that retires them.

## What Changes

- New public route `GET /v1/plans/pricing` (operation `getPlansPricing`, tag `Plans`): the latest public version of the
  OpenBinding pricing in SPHERE, with its permanent link, SPHERE version id and label, `sha256` digest, the YAML exactly
  as SPHERE serves it, the same document as JSON, and the version SPACE has active.
- Anonymous callers allowed; strong `ETag`, `Cache-Control: public, max-age=300` and `304` on `If-None-Match`; the
  public-read rate limit (`429 rate_limit_exceeded`).
- SPHERE is read without any credential, by GET only, at most once per 300 s; the YAML is verified against SPHERE's
  `contentHash` and bounded to 5 MiB.
- When SPHERE cannot be read or its answer fails verification: `503 pricing_unavailable` as
  `application/problem+json`, never a stale, bundled or invented pricing.
- Expand/contract for `GET /v1/pricing`, `/v1/pricing/catalog` and `/v1/pricing/current`: deprecation signals first,
  clients migrate, then the routes, `sphere_client.py`, `pricing_catalog.py` and the SPHERE key settings are removed
  (breaking step, owner approval required, design.md §8).

## Impact

- Capability `plans-pricing` (new): eighteen ADDED requirements (one of them, the deprecation signal of the expand phase, is dropped from the
  delta in slice S4 before the archive, design.md §8). It is a capability of its own, apart from M4.2's `plans`,
  because its obligations differ in kind: a public, keyless route that reads only SPHERE's public API and stays
  available with no SPACE dependency (SPACE's state only fills `spaceActiveVersion`), while `plans` covers
  authenticated entitlement decisions that depend on SPACE.
- Dependency on M4.2 (`m42-plans-module`): `spaceActiveVersion` is the value of its `PlanPort.active_version()`
  (the version of the last `pricing_actived` event for the service on the current event connection, held in memory;
  `None` in the cases of its `req~plans-active-version~1`), design.md §2 step 5. Slice S2 waits for that method.
- Capability `frontend-catalog-pricing`: REMOVED `req~frontend-catalog-pricing-read-only-source~1`. It is a gateway
  obligation on the routes this change retires, so it moves to `plans-pricing` with the same change; the frontend
  requirements of that capability stay with the frontend lead (two capabilities, justified here).
- HTTP API: one new operation and one new schema `PlansPricing` (compatible). The removal of three operations and of
  the schema `PricingCurrentView` is breaking (slice S4, owner approval). `docs/openapi.json` is NOT edited by this
  change; design.md §4 lists the exact additions for the implementation slice.
- Code areas (later slices): `openbinding-gateway/src/openbinding_gateway/modules/plans/**` (the SPHERE public reader
  and the route), `main.py` (router, problem media type of `/v1/plans` unless M4.2 S5 has added it), `core/settings.py`,
  `security/apikeys.py`, and in S4 the removal of `routes/pricing.py`, `models/pricing.py`, `pricing_catalog.py`,
  `sphere_client.py` and their tests. Prerequisite of S1, owned by the lab-tests change:
  `lab/tests/test_no_direct_space_http.py` `ALLOWED_PREFIXES` still lists `openbinding_gateway/plans/` and must list
  `openbinding_gateway/modules/plans/` (design.md §9).
- Tests use two fixture files at `openbinding-gateway/tests/fixtures/pricing/`, `manifest.json` and
  `openbinding-0.2.0.yml` (written by a parallel fixture task, not by this change; derived, not recorded live, and
  re-recorded keyless in S1, design.md §1), through an injected transport; no unit test reaches SPACE or SPHERE.
- Frontend (another lead, read only here): the Pricing page and the engine detail page read `/v1/pricing/catalog` and
  `/v1/pricing/current` today (`frontend/src/api/client.ts`); they move to `/v1/plans/pricing` before S4.
- Risks: SPHERE's manifest shape and the input of `contentHash` are verified only by a lookup and a derived fixture
  (design.md §11); the ROADMAP digest of 0.2.0 (`3db4ad99…`) differs from the repository file's (`4b9c7203…`), open
  for the coordinator (design.md §1, §11); SPACE's active version depends on `PlanPort.active_version()` of M4.2,
  whose event payload field is unverified until the M4.2 S8 suite (design.md §11).

## Out of scope

- The other M4.3 removals: release sweeps, local metering (`domain/usage_counters.py`) and the sponsorship capacity
  checks. They are separate M4.3 changes; they touch entitlements, not this route.
- The `plans` module itself, the entitlement map and SPACE evaluation (M4.2).
- The Pricing and Plan pages with `pricing-renderer` (M4.4) and the frontend migration of the callers.
- Serving a version other than SPHERE's latest public one, private versions, or any write to SPHERE or SPACE.
- The OpenAPI snapshot, source files, tests and the pricing fixture files (later slices and the parallel fixture task, tasks.md).
