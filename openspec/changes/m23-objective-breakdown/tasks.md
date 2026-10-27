# Tasks: m23-objective-breakdown

Slice O1 of M2.3, one PR, parallel with H1, B1, Q1, T1, E1 and V1 (pairwise disjoint files,
`docs/agent-work/m23-run-result/handoff.md`). Tests carry `[utest->req~frontend-rendering-objective-breakdown~1]`, code
`[impl->req~frontend-rendering-objective-breakdown~1]` (design.md §5). Diff budget: about 300 non-test lines or fewer
(constitution 14.1).

Owned files, exclusive while the slice runs: `frontend/src/components/rendering/ObjectiveBreakdown.tsx`,
`ObjectiveBreakdown.css`, `ObjectiveBreakdown.test.tsx`, `objectiveModel.ts`, `objectiveModel.test.ts`, and
`docs/agent-work/m23-objective-breakdown/**`.

Checks the slices register (handoff "Checks"):
- FI `["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile"]`, first;
- RED (gate G3, tests-first task): `{"argv":["bash","-c","set -euo pipefail; cd frontend; pnpm install --frozen-lockfile; pnpm exec vitest run src/components/rendering/ObjectiveBreakdown.test.tsx src/components/rendering/objectiveModel.test.ts"],"type":"red_before","expect_exit":[1],"expect_pattern":"AssertionError|TestingLibraryElementError","reject_pattern":"Failed to resolve import|Cannot find module|Transform failed|SyntaxError","overlay":[<the two test files>,"frontend/src/components/rendering/ObjectiveBreakdown.tsx","frontend/src/components/rendering/objectiveModel.ts"]}`;
- V `["bash","-c","set -euo pipefail; cd frontend; pnpm exec vitest run src/components/rendering/ObjectiveBreakdown.test.tsx src/components/rendering/objectiveModel.test.ts src/test"]`
  (the slice's tests and the hygiene test);
- LINT `["bash","-c","set -euo pipefail; cd frontend; pnpm exec eslint ."]` and TSC
  `["bash","-c","set -euo pipefail; cd frontend; pnpm exec tsc -b"]`;
- G1 `["openspec","validate","m23-objective-breakdown","--strict"]` once the lab has the CLI (until then CI runs
  `openspec validate --strict --all`).

## S0. Spec (this task)
- [x] 0.1 proposal.md, design.md (contract §2, fixtures §3), tasks.md and the `frontend-rendering` delta with
  `req~frontend-rendering-objective-breakdown~1`.
- [ ] 0.2 G1 and the epic review (G2).

## T. Tests first (with a stub)
- [ ] T.1 `objectiveModel.test.ts`: the model scenarios (with a problem, without one, a problem that names neither,
  objectives that are not canonical, tolerant components, scores and penalties), with the fixtures of design.md §3.
- [ ] T.2 `ObjectiveBreakdown.test.tsx`: the component scenarios (region and summary, weighted-sum table and total, list
  score, list of another length, weighted sum with a list score, missing values, total with a missing weighted loss,
  number format, no terms, text only, no hex colour in the CSS).
- [ ] T.3 Stub: `objectiveModel.ts` with the exported types of design.md §2 and `objectiveTermsOf` returning `null`;
  `ObjectiveBreakdown.tsx` with the final props rendering `null`; an empty `ObjectiveBreakdown.css`. RED fails by
  assertion only.

## I. Implementation
- [ ] I.1 `objectiveModel.ts`: `objectiveTermsOf` and its tolerant reading (design.md §2, model rules).
- [ ] I.2 `ObjectiveBreakdown.tsx` and `ObjectiveBreakdown.css`: the markup of design.md §2 inside `DataTable`, the
  `MetricCards` number format, the dash with `no value`, tokens only.
- [ ] I.3 Confirm the diff touches no screen, `api/` file, allow-list or `package.json`, and that the hygiene test still
  passes.
- [ ] I.4 `docs/agent-work/m23-objective-breakdown/review/how-to-test.md`: how to run the tests and what each scenario
  shows; the rendered component is first seen on a screen in J1, where ui-qa checks it at 1440×900 and 390×844.
- [ ] I.5 Review sign-off (G11): reviewer, test-reviewer and ui-qa (handoff "Review panels").
- Acceptance: FI, V, LINT and TSC pass; every scenario of the requirement has a test.

## Archive (later)
- [ ] After `m21-rendering-catalogue` is archived, in the one explicit archive task of the M2.3 changes:
  `["openspec", "archive", "m23-objective-breakdown", "--yes"]`, then `["openspec", "validate", "--all", "--strict"]`.

## Follow-ups outside this change
- J1: render `objectiveTermsOf(solution.objectives, problem)` per solution in `RunResult`, leaving the component out when
  it returns `null`; pass the compiled problem from `jobsApi.ir` (design.md §2); document the component in
  `docs/qa/RENDERING_CATALOGUE.md`.
- J1 ui-qa: confirm on a preview run that solutions carry canonical `objectives.components` (intake R-a).
- M2.5 and later: the study cell use of ARCHITECTURE §5.3.
