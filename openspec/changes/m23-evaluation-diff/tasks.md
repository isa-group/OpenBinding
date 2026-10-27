# Tasks: m23-evaluation-diff

Slice E1 of M2.3, one PR. Tests carry `[utest->req~frontend-rendering-evaluation-diff~1]`, code `[impl->…]`
(design.md §7). Diff budget: about 300 non-test lines or fewer (constitution 14.1); the plan expects about 150. The
contract is design.md §3, the rules §4 and §5, the markup §6.

Owned files, exclusive while the slice runs (all new, under `frontend/src/components/rendering/`):
`EvaluationDiff.tsx`, `EvaluationDiff.css`, `EvaluationDiff.test.tsx`, `evaluationDiffModel.ts`,
`evaluationDiffModel.test.ts`; plus `docs/agent-work/m23-evaluation-diff/**`.

Checks (argv of the plan, `docs/agent-work/m23-run-result/handoff.md` "Checks"):
- G1: `["openspec","validate","m23-evaluation-diff","--strict"]`, reported NOT EXECUTED while the lab has no CLI; then G2
  (epic review).
- FI: `["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile"]`, first in every frontend task.
- RED (G3): `["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run src/components/rendering/EvaluationDiff.test.tsx src/components/rendering/evaluationDiffModel.test.ts"]`,
  type `red_before`, `expect_exit` `[1]`, `expect_pattern` `AssertionError|TestingLibraryElementError`,
  `reject_pattern` `Failed to resolve import|Cannot find module|Transform failed|SyntaxError`, overlay the two test
  files and the two stub modules.
- V: `["bash","-c","set -euo pipefail; cd frontend; pnpm exec vitest run src/components/rendering/EvaluationDiff.test.tsx src/components/rendering/evaluationDiffModel.test.ts src/test"]`
  (the component tests and the hygiene tests).
- LINT: `["bash","-c","set -euo pipefail; cd frontend; pnpm exec eslint ."]`; TSC:
  `["bash","-c","set -euo pipefail; cd frontend; pnpm exec tsc -b"]`.

Order: S0, then S1, then S2, then S3. No dependency on the other M2.3 slices; J1 depends on this slice's merge.

## S0. Specification
- [x] 0.1 proposal.md, design.md, this file and the `frontend-rendering` delta with
  `req~frontend-rendering-evaluation-diff~1`.
- [ ] 0.2 G1 through a registered check, then G2.

## S1. Tests first (red with a stub)
- [ ] 1.1 `evaluationDiffModel.test.ts`: the model scenarios: `no-claim`, agreement within `TOLERANCE`, feature,
  termination, score and score-list rows, `not stated` / `not evaluated` / `not a number` kinds, row order, unequal
  solution counts (`paired` false, only the `Solutions` row), `features ?? metrics` and `score ?? objectives.score`,
  malformed claim, `constructor` and `__proto__` keys, purity on deeply frozen inputs, `shortText` at 500, 600 and with a
  surrogate pair at the cut.
- [ ] 1.2 `EvaluationDiff.test.tsx`: the rendering scenarios: region name and `label`, the three summary lines and their
  singulars, the `Differences` table headers and cells, number format and the six-decimal fallback, the pairing
  sentence, engine text as text in `bdi` (no `img`, `b` or `a`), direction controls, shortening, `Engine notes`,
  `Why the gateway changed the result`, the row and note caps with their "more" lines, no `<pre>`, no hex colour in the
  CSS.
- [ ] 1.3 Stubs with the final exports and types of design.md §3: `evaluationDiffModel.ts` returning a `no-claim` view
  with no rows, and `EvaluationDiff.tsx` rendering `null`; an empty `EvaluationDiff.css`.
- [ ] 1.4 FI, then RED with the tests and the stubs overlaid (G3).

## S2. Implementation
- [ ] 2.1 `evaluationDiffModel.ts`: `evaluationDiffOf` and `shortText` as design.md §4 and §5, with own-key lookups
  only and no object written with an engine key.
- [ ] 2.2 `EvaluationDiff.tsx`: the markup of design.md §6 with the `components/ui` `DataTable`; every engine string
  through one `<bdi>` text path; the caps.
- [ ] 2.3 `EvaluationDiff.css`: tokens only, no hex colour, `overflow-wrap: anywhere`.
- [ ] 2.4 FI, V, LINT and TSC pass; confirm the hygiene test needs no allow-list entry.

## S3. Guide and review
- [ ] 3.1 `docs/agent-work/m23-evaluation-diff/review/how-to-test.md`: how to run the tests and what each scenario group
  shows; that no screen mounts the component before J1.
- [ ] 3.2 Review (G11): reviewer, test-reviewer and security-auditor (design.md §5). ui-qa at 1440×900 and 390×844 has
  no routed screen before J1; the coordinator decides whether ui-qa runs in J1 for this component or on a test harness.
- [ ] 3.3 Archive later, in the explicit archive task of M2.3 after `m21-rendering-catalogue`:
  `["openspec","archive","m23-evaluation-diff","--yes"]`, then `["openspec","validate","--all","--strict"]`.

## Follow-ups outside this change
- J1: map the job result to `evaluated`, pass `report.remote.divergence.notes` as `notes` when it is an array of
  strings, keep the report's full text in a `SourceView`, and add `EvaluationDiff` to `RENDERING_CATALOGUE.md`.
- Owner, CRP-M23-1: whether `GET /v1/jobs/{id}/report` exposes `engineClaimed` and `downgrades` (C1); J2 then passes
  them, with `downgrades[].solution` as the 0-based position in the claimed solutions (design.md §3).
- C1 and J2 review: confirm the gateway keeps the engine's solution order, since pairing is by position (design.md §8).
