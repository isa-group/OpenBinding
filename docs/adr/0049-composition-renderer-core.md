# 0049. The composition renderer: a headless core, modes over gateway data, and no client semantics

- Status: accepted
- Date: 2026-11-16 (F2a, decisions D5, D6, D14 and overrides 2, 4, 5, 6, 7 and 8 of the F2 implementation plan; plan
  §2.9 and §3)

## Context

A composition is read in many places: its organization's list and detail, its public page, the comparison of two
versions, the evolution of its values, the editor, the run that derives it. Each must show the same values with the
same status, and none may compute what the gateway computes: values, validity, deltas, the size of the binding space
and the comparison of two bindings come from the toolchain through the gateway, and the frontend only formats them.
Renderer hints (sections, order, density) were asked for in the document (`presentation:`), which would make a
presentation choice part of sealed bytes.

## Decision

- **A headless core.** `entities/composition/` turns gateway answers into view-models: `viewModel.ts`
  (`CompositionViewModel`: identity, reader, version, value status, workflow, tasks, values, offering, the selection,
  located diagnostics, the candidate matrix and the modes the reader may use), `document.ts`, `values.ts`,
  `changes.ts` (the server diff, with `null` read as absent by side), `evolution.ts` and `versionRef.ts`. It only
  places gateway values: it never sums, subtracts, ranks or compares numbers.
- **Modes.** `widgets/composition-renderer` draws `catalog` (Overview), `architecture` and `workflow` (Overview),
  `comparison` (Versions), `calculator` and `configurator` (Analysis, for a member reading a linked version) and
  `showcase` (the public page). Each mode's sections are a preset in code (`presets.ts`); a screen narrows them with
  `hideSections`, `density` and, for the comparison, `onlyDifferences`. The editor is a feature
  (`features/composition-editor`), because a widget cannot import the draft store; it mounts the workflow graph and
  the candidate matrix itself. `operations` waits for F4.
- **Stored documents.** A version's document is read in stored mode, `GET …/versions/{version}?include=document`,
  never re-parsed with today's registry aliases (`/v1/compositions/parse` stays the editor's form-to-YAML round trip).
  Version lists come as light rows with `current_evaluation` and `analytics` for the charts, paged by date
  (`created_after`, `created_before`, `order=oldest`).
- **The matrix of the evaluated compilation.** A version's candidates come from the facts
  ([ADR 0048](0048-problem-facts-projection.md)) of the compilation its current evaluation used, so values and
  candidates never mix two compilations; when that compilation's semantic digest differs from the linked one, a drift
  banner says so.
- **No client semantics.** Values, validity and violations come from evaluations and `evaluate`; deltas from
  `neighborhood` (`componentDeltas`, `penaltyDelta`); the size of the binding space from the analysis; the comparison
  words (`better`, `worse`, `trade-off`, `equal`, `infeasible`) from the gateway, worded in
  `entities/binding/comparison.ts`. The configurator shows the evaluated values beside the version's, with no
  difference computed. There is no client digest, no client Pareto check and no client CSV export.
- **Three value statuses, always in words.** `ValueBadge` prints Verified (the current evaluation verified the
  binding), Declared (no problem linked) or Unverified (a linked version whose current evaluation is not the verified
  outcome); colour is never the only signal. The words live in one file, `widgets/value-badge/statusText.ts`.
- **Presentation hints are the renderer's.** Presets in code, props chosen by each screen, and per-viewer preferences
  in `localStorage` (chart axis and hidden series, matrix columns), read in `try/catch` with defaults. They never enter
  the document (`presentation:` stays `c2y_unknown_key`) nor the composition entity; the editor's mutation tests
  assert that every serialised payload holds only Composition2Yaml keys.
- **Reference plan cards until F3.** `PricingCard` draws a plan with pricing-renderer (loaded lazily) only when it is
  given Pricing2Yaml, and no F2 route supplies it, so live screens show the reference face: owner/name, pinned
  version, plan, add-ons and registry, without a link, because SPHERE addresses a pricing by ids a `from` does not
  carry. An offering is a reference line too; only a `url` offering is a link.
- **Deriving from a run or a binding.** `features/derive` (`DeriveCompositionDialog`) previews the derivation
  (`seal: false`) and seals the same request. The gateway has no preview without a composition, so a **new
  composition is created when the preview is asked for**; after that the dialog treats it as an existing one, and
  cancelling leaves it with no version. "Open as draft" hands the preview to the editor as a `#composition=` share
  fragment. When the editor's visual form rebinds a task of a version derived from a run, it drops the evidence's
  `run` and `point` and says so: the run's solution is no longer the binding, which the gateway would refuse
  (`c2y_run_binding_mismatch`), and the seal stamps the evidence of a binding chosen by hand.

## Consequences

- Every number on a composition screen can be traced to one gateway answer, and a toolchain release changes what
  screens show only through the gateway.
- A version sealed under an alias later removed from `SPHERE_REGISTRIES` still renders.
- Upstream plans are drawn when F3's pricing snapshots feed `PricingCard` the YAML; until then a plan card names its
  reference only.
- An abandoned derivation leaves an empty composition, which the list shows as one with no version yet.

Where: `frontend/src/entities/composition/`, `frontend/src/widgets/` (`composition-renderer`, `workflow-graph`,
`candidate-matrix`, `value-badge`, `problems-panel`, `provider-map`, `pricing-card`, `change-summary`,
`evolution-charts`), `frontend/src/features/` (`composition-editor`, `derive`, `fork`),
`modules/compositions/adapters/routes.py` (`include=document`, light rows, date filters).
