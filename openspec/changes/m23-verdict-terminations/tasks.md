# Tasks: m23-verdict-terminations

Slice V1 of M2.3 (`docs/agent-work/m23-run-result/handoff.md`), one PR, in parallel with H1, B1, Q1, O1, T1 and E1.
Tests carry `[utest->req~frontend-rendering-verdict-terminations~1]` and the code carries `[impl->…]` (design.md §3).
Diff budget: about 5 non-test lines, well under 300. Owned files, exclusive while the slice runs:
`frontend/src/components/rendering/VerdictBadge.{tsx,css,test.tsx}`, `openspec/changes/m23-verdict-terminations/**`
and `docs/agent-work/m23-verdict-terminations/**`.

Checks the slice registers. Each is a `bash -c 'set -euo pipefail; cd frontend; …'` argv, in the forms of the handoff's
§Checks:
- FI: `pnpm install --frozen-lockfile`, first.
- V: `pnpm exec vitest run src/components/rendering/VerdictBadge.test.tsx src/test`.
- LINT: `pnpm exec eslint .`. TSC: `pnpm exec tsc -b`.
- RED (G3), `red_before`: FI, then the vitest run of `VerdictBadge.test.tsx`, overlaying only the test file.
  `expect_exit [1]`, `expect_pattern` `AssertionError|TestingLibraryElementError`, `reject_pattern`
  `Failed to resolve import|Cannot find module|Transform failed|SyntaxError`. No stub is needed, because the component
  exists: the new cases fail by assertion on the base (`INFEASIBLE` has no `.sr-only` element today).
- G1: `["openspec", "validate", "m23-verdict-terminations", "--strict"]`. It is not registered for the spec task, so it
  is NOT EXECUTED until the lab or CI runs it.

## V1.1 Spec
- [x] 1.1 proposal.md, design.md, this file and the `frontend-rendering` delta with the ADDED requirement
  `req~frontend-rendering-verdict-terminations~1` and its five scenarios.
- [ ] 1.2 G1, then G2 (epic review).

## V1.2 Tests first (after 1.2)
- [ ] 2.1 `VerdictBadge.test.tsx`, new cases only. The existing m21 cases stay as they are:
  - the two rows `INFEASIBLE` / `error` / `no combination meets the rules` and `UNKNOWN` / `default` / `no conclusion`:
    class, wrapper text, `.sr-only` text, no `aria-describedby`;
  - the four API terminations (`OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`) each have exactly one `.sr-only`
    element with a non-empty description, and the descriptions differ;
  - `INFEASIBLE` and `UNSAT` are both `badge-error`, with their two wrapper texts;
  - `INFEASIBLE` with one reason: the `Reasons` list after the badge, an outer `<div>`, no `<pre>`;
  - `infeasible`, `Unknown` and `toString` render `badge-default` with no `.sr-only` element.
- [ ] 2.2 Run RED (G3). The first three new cases fail by assertion on the base. The reasons case and the
  unknown-spellings case pass on the base too, because they pin behaviour that must not change.

## V1.3 Implementation (after V1.2)
- [ ] 3.1 `VerdictBadge.tsx`: add `INFEASIBLE` and `UNKNOWN` to `KNOWN` (design.md §1) and to the `verdict` union, and
  add the `[impl->req~frontend-rendering-verdict-terminations~1]` tag. `VerdictBadge.css` is unchanged.
- [ ] 3.2 Run FI, V, LINT and TSC.
- [ ] 3.3 `docs/agent-work/m23-verdict-terminations/review/how-to-test.md`: how to see the two badges. No screen renders
  the badge yet, so the guide uses the unit tests and the props of design.md §1.
- [ ] 3.4 Review sign-off (G11): reviewer and test-reviewer.
- Acceptance: every scenario of the requirement has a test; the m21 `VerdictBadge` cases still pass; V, LINT and TSC
  pass.

## Archive (later)
- [ ] After `m21-rendering-catalogue` is archived, archive this change with the other M2.3 changes in one explicit
  archive task: `["openspec", "archive", "m23-verdict-terminations", "--yes"]`, then
  `["openspec", "validate", "--all", "--strict"]`. Optionally fold this requirement into
  `req~frontend-rendering-verdict-badge~2` (design.md §3).

## Follow-ups outside this change
- J1 (owns `docs/qa/RENDERING_CATALOGUE.md` in its turn): line 110 says `INFEASIBLE` and `UNKNOWN` get no
  description "until M2.3 maps them". It must list the seven known verdicts instead.
- J1: the Jobs outcome label (`jobsModel.ts:47-55`) uses a warning tone for `INFEASIBLE`. When the badge replaces it,
  the run page uses `error` (design.md §2).
- Archive of m21: its design.md §7 risk and tasks.md follow-up about the unmapped terminations are resolved by this
  change.
