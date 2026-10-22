Status: PROPOSED for owner review (2026-10-22)

# ADR-0014: Render, never dump

- Status: Proposed
- Date: 2026-10-22
- Deciders: owner

## Context

The audit of the 86 screens at 912648c found 15 places where results, reports, manifests, metrics, logs or
definitions are shown as raw JSON or in `<pre>` blocks (`ROADMAP.md`, M2). SPHERE, the model for OpenBinding, never
presents raw Pricing2Yaml as its main view: pricings are matrices, cards and charts; the YAML appears only in the
editor's text mode or behind an explicit source panel. The owner requires the same for OpenBinding.

## Decision

Every domain object is rendered with the shared catalogue of `docs/ARCHITECTURE.md` §5.3. Raw sources are secondary
tabs (`SourceView`) or explicit downloads; logs are a collapsed, searchable `LogPanel` below the rendered result.
A hygiene test forbids rendering `JSON.stringify` output or `<pre>` outside those two components, with an allow-list
of today's offenders that may only shrink. ui-qa reviews screenshots in G12. Codified as constitution Article 15.

## Consequences

- Each data view needs a designed component; new APIs return fields a component can render, not opaque blobs.
- Exports (JSON, CSV, packages) remain available as downloads.
- The QA gallery becomes the visual regression record of the rule.

## Evidence

`INTENT.md` §4 and O5, `ROADMAP.md` M2, `frontend/src/hygiene.test.ts` (to extend).
