# frontend-catalog-pricing Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/baseline` @ 9b5be00 — reverse-engineered, spec-anchored.

## Purpose

Public catalogue and plan surfaces of the web client: the pricing page (`/pricing`, rendering the published SPHERE
pricing read through `GET /v1/pricing/*`), the home-page plan strip (`src/content/plans.ts`), the engine catalogue
(`/engines`, `/engines/:namespace/:name/:version`) and the language pages (`/language`, `/examples`). Pricing is
administered in the remote SPHERE and SPACE consoles; OpenBinding only displays it.

## Requirements

### Requirement: Live pricing document
WHEN the pricing page loads, THE frontend SHALL render the live catalog and release returned by the gateway (version, date, currency, fingerprint), label a pre-1.0 pricing as a development copy, and not use the deprecated YAML document.

`req~frontend-catalog-pricing-live-document~1`

Evidence: `frontend/src/pages/Pricing/Pricing.test.tsx::reads the live catalog and release, not the deprecated pricing document`; `frontend/src/pages/Pricing/Pricing.test.tsx::labels the release: version, date, currency, fingerprint and the development copy`; `openbinding-gateway/tests/test_published_pricing.py::test_the_catalog_is_the_published_document_as_json`

#### Scenario: Pricing 0.1.0
- **GIVEN** a published pricing with version `0.1.0`
- **WHEN** a visitor opens `/pricing`
- **THEN** the page shows version, date, currency and fingerprint and marks it as a development copy

### Requirement: No prices and no checkout
THE frontend SHALL show no monetary price and no checkout: paid plans read "Contact us", free plans read "Free", and the call to action is to sign up or sign in with CAS.

`req~frontend-catalog-pricing-no-checkout~1`

Evidence: `frontend/src/pages/Pricing/Pricing.test.tsx::offers no price and no checkout`; `frontend/src/pages/Pricing/pricingModel.test.ts::turns any numeric price into an agreement instead of showing it`

#### Scenario: Plan with a numeric price
- **GIVEN** a pricing document where plan `Pro` has price 49
- **WHEN** the page renders
- **THEN** `Pro` shows "Contact us" and no amount

### Requirement: Pricing changes need no code change
WHEN plans, limits, features or add-ons change in the published document, THE frontend SHALL reflect them without a code change, reading unknown limits by their type, and SHALL contain no OpenBinding-specific mapping layer.

`req~frontend-catalog-pricing-document-driven~1`

Evidence: `frontend/src/pricingManifest.test.ts::reflects plan, limit, feature and add-on changes without code changes`; `frontend/src/pricingManifest.test.ts::contains no OpenBinding mapping layer`; `frontend/src/pages/Pricing/pricingModel.test.ts::reads a limit that no table knows by its type`

#### Scenario: New limit in the document
- **GIVEN** a new limit `maxStudies` added in SPHERE
- **WHEN** the page renders the new release
- **THEN** the limit is shown with its value without a frontend release

### Requirement: Read-only pricing source
THE gateway SHALL only issue GET requests to SPHERE, serve only the configured published version, and answer 503 `pricing_unavailable` when SPHERE or the configured version is unavailable.

`req~frontend-catalog-pricing-read-only-source~1`

Evidence: `openbinding-gateway/tests/test_published_pricing.py::test_only_get_requests_ever_reach_sphere`; `openbinding-gateway/tests/test_published_pricing.py::test_a_private_version_is_never_shown`; `openbinding-gateway/tests/test_published_pricing.py::test_the_sphere_client_has_no_write_operations`

#### Scenario: SPHERE down
- **GIVEN** SPHERE does not answer
- **WHEN** the frontend requests `GET /v1/pricing/current`
- **THEN** the gateway answers 503 `pricing_unavailable` and the page shows an unavailable state

### Requirement: Home plan strip follows the document version
THE frontend SHALL name the pricing version the home-page plan summaries were copied from and list exactly the plans of that document.

`req~frontend-catalog-pricing-plan-strip~1`

Evidence: `frontend/src/content/plans.test.ts::name the version of the pricing document they were copied from`; `frontend/src/content/plans.test.ts::are exactly the plans of the document`

#### Scenario: Plan renamed in SPHERE
- **GIVEN** a new pricing version where `Advanced` is renamed
- **WHEN** `PRICING_VERSION` is bumped without updating the strip
- **THEN** the plans test fails

### Requirement: Engine catalogue shows exact identities
WHEN the engine catalogue lists engines, THE frontend SHALL show public revisions with their modes and exact identity (namespace, name, version, digest).

`req~frontend-catalog-pricing-engine-catalogue~1`

Evidence: `frontend/src/pages/Engines/Engines.test.tsx::lists the public revisions as cards with their modes and exact identity`

#### Scenario: Two versions of one engine
- **GIVEN** `bim.builtin/random-search` versions 1.0.0 and 1.1.0 are public
- **WHEN** the catalogue renders
- **THEN** both appear as separate cards with their digests

## Out of scope

- Plan enforcement (`auth-roles-entitlements`); SPACE/SPHERE administration.
- The `pricings/` directory (third-party FaaS pricings analysed by experiments, not OpenBinding plans).

## TODO

- Language pages (`/language`, `/language/schemas/:kind`, `/examples`) and engine detail with plan ceilings (`planCeilings.test.ts`).
- SPACE React client token flow (`SpaceProviderWrapper`) while SPACE is on hold.
- Note: `/v1/engines` requires authentication (`engine-registry`), so the public `/engines` screen depends on `/v1/explore/engines`; confirm intended visibility.
