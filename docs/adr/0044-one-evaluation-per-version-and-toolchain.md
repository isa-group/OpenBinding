# 0044. One evaluation per version and toolchain; the offering is a reference with one source

- Status: accepted
- Date: 2026-11-15 (F1, decision D8 of the F1 implementation plan and design choice C2; owner decision of
  2026-11-15 on the offering)

## Context

The plan keeps evaluations for linked versions only, while the owner requires the offering version to be stored in
every evaluation, and margins (F4) exist for declared compositions too. The offering itself is the composition's
own pricing: optional, a reference only, with no version in the document and exactly one source. F1 validates its
shape but does not read it; reading, snapshots and margins are F3 and F4.

## Decision

- Every sealed version gets one evaluation at seal: a declared version one `basis = declared` evaluation, a linked
  version one `basis = bim` evaluation per toolchain that evaluates it (`UNIQUE(version_id, basis_key)`, the key
  being the toolchain's `compilerDigest` or `declared`). Re-evaluating with another toolchain adds a row, storing
  `verified`, `binding_invalid` or `semantics_changed`.
- `seal.insert_evaluation` is the one function that inserts evaluation rows; seals, deduplicated seals and
  re-evaluations all call it.
- `offering` has exactly one source: `{sphere}`, `{sphere, registry}` or `{url: https://…}`. Two sources, none, a
  wrong shape or a non-HTTPS URL are errors; an unconfigured registry is a warning (and an unreadable offering or
  invalid Pricing2Yaml will be, from F3). The offering never invalidates the binding. `from` is SPHERE only, with a
  mandatory `version` and no `contentHash`, and an unconfigured registry is an error there.
- Registries are deployment configuration (`SPHERE_REGISTRIES`, keyed by alias, with URL and key); a document names
  only the alias.
- F1 adds no offering version column: it could not fill one, rows are insert-only, `pricing_snapshots` does not
  exist yet, and a schema change only regenerates the single baseline. F3 adds `offering_version`,
  `offering_snapshot_id` and `offering_status` to `composition_evaluations`, filled in `insert_evaluation`. The
  offering source is denormalised now on `composition_versions.offering`.

## Consequences

- A new offering version never needs a new evaluation key: it is an F6 upstream event that ends at *reviewed*.
- F3 changes one function and no flow.

Where: `modules/compositions/application/seal.py`, `db/platform_models.py`, `composition/checks.py`,
`core/settings.py`.
