# Tasks: m23-qos-against-bounds

Slice Q1 of M2.3 (`docs/agent-work/m23-run-result/handoff.md`), one PR, risk medium (R9; reading expression trees).
It runs in parallel with H1, B1, O1, T1, E1 and V1: the owned files are disjoint. Tests carry
`[utest->req~frontend-rendering-qos-against-bounds~1]`, code `[impl->…]` (design.md §7). Diff budget: ≤ 300 non-test
lines (estimate: model ~110, component ~90, stylesheet ~40).

Owned files, exclusive while the slice runs: `frontend/src/components/rendering/{QoSAgainstBounds.tsx,
QoSAgainstBounds.css,QoSAgainstBounds.test.tsx,qosBoundsModel.ts,qosBoundsModel.test.ts}`,
`openspec/changes/m23-qos-against-bounds/**` and `docs/agent-work/m23-qos-against-bounds/**`.

Checks (handoff "Checks"): FI `["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile"]` first;
V `["bash","-c","set -euo pipefail; cd frontend; pnpm exec vitest run src/components/rendering/qosBoundsModel.test.ts
src/components/rendering/QoSAgainstBounds.test.tsx src/test"]`; LINT `pnpm exec eslint .`; TSC `pnpm exec tsc -b`; G1
`["openspec","validate","m23-qos-against-bounds","--strict"]` (reported NOT EXECUTED while the lab has no CLI; CI runs
`openspec validate --strict --all`).

## Q1.1 Spec (this task)
- [x] 1.1 proposal.md, design.md (prop contract §2, derivation §3, notation §4, rendering §5) and the
  `frontend-rendering` delta with `req~frontend-rendering-qos-against-bounds~1`.
- [ ] 1.2 G1, then the epic review (G2).

## Q1.2 Tests first (after G1 and G2)
- [ ] 2.1 A stub of `qosBoundsModel.ts` (the final exported types of design.md §2 and `qosBoundsOf` returning
  `{ bounds: [], rules: [] }`) and of `QoSAgainstBounds.tsx` (the final props, rendering `null`), so the tests fail by
  assertion, not by import (intake §2.4).
- [ ] 2.2 `qosBoundsModel.test.ts`: the fixture `QOS` of the delta and the model scenarios (bounds and flipping, text
  rules, shapes that are not a bound, mixed and nested conjunctions, a rule with a condition, status from the gateway,
  no violations list, unmatched violations with message, penalty sum and fallback text, matching by resource and id,
  unexpected input, missing value).
- [ ] 2.3 `QoSAgainstBounds.test.tsx`: the rendering scenarios (region and label, the `Bounds` table with headers and
  cells, margin words and `at the limit`, missing value, the `Other rules` list, status words and badge variants with
  penalty, only one part, `No rules to check.`, the not-checked paragraph, number format, text-only rendering, no hex
  colour, no `pages/` import), querying by role and accessible name as the M2.1 tests do.
- [ ] 2.4 RED `{"argv":["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run
  src/components/rendering/qosBoundsModel.test.ts src/components/rendering/QoSAgainstBounds.test.tsx"],"type":
  "red_before","expect_exit":[1],"expect_pattern":"AssertionError|TestingLibraryElementError","reject_pattern":
  "Failed to resolve import|Cannot find module|Transform failed|SyntaxError","overlay":[the two tests, the two stubs]}`,
  gate G3.

## Q1.3 Implementation
- [ ] 3.1 `qosBoundsModel.ts`: `qosBoundsOf` with the rules of design.md §3 and the notation of §4.
- [ ] 3.2 `QoSAgainstBounds.tsx` and `QoSAgainstBounds.css`: design.md §5, reusing `components/ui` `Badge` and
  `DataTable`; tokens only.
- [ ] 3.3 `docs/agent-work/m23-qos-against-bounds/review/how-to-test.md`: how to run the two test files, and that the
  screenshots come with J1's preview (design.md §6).
- Acceptance: FI, V, LINT and TSC pass; the hygiene test in `src/test` still passes with `MAX_ALLOWED_OFFENDERS`
  unchanged; every scenario of the requirement has a test; no file outside the owned list changes.

## Q1.4 Review
- [ ] 4.1 reviewer and test-reviewer (G11); ui-qa at 1440×900 and 390×844 when J1's preview wires the component.

## Archive (later)
- [ ] After `m21-rendering-catalogue` is archived (intake R-f), with the other M2.3 changes, in an explicit archive task:
  `["openspec", "archive", "m23-qos-against-bounds", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- J1: call `qosBoundsOf(ir.spec.constraints, solution.features ?? solution.metrics, solution.violations, units)` with
  units from `ir.spec.application.features[*].unit` (design.md §2), render one `QoSAgainstBounds` per solution, and
  document the component in `docs/qa/RENDERING_CATALOGUE.md`.
- M9.3: one shared formula notation for `pages/Cases/bindingModel.ts` `describeExpression` and `qosBoundsModel.ts`
  (design.md §4, §6).
