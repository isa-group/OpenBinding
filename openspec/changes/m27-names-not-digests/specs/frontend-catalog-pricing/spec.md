## MODIFIED Requirements

### Requirement: Engine catalogue shows exact identities
WHEN the engine catalogue lists engines, THE frontend SHALL show public revisions with their modes and exact identity (namespace, name and version, written as the engine label of `shared/lib/identity.ts`), without the digest.

`req~frontend-catalog-pricing-engine-catalogue~2`

Evidence: `frontend/src/pages/Engines/Engines.test.tsx::lists the public revisions as cards with their modes and exact identity`

#### Scenario: Two versions of one engine
- **GIVEN** `bim.builtin/random-search` versions 1.0.0 and 1.1.0 are public
- **WHEN** the catalogue renders
- **THEN** both appear as separate cards, each named by its namespace, name and version
- **AND** no card shows a digest
