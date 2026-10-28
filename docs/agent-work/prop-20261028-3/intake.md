# Intake: P-20261028-3, stop hard-coding route and offender counts in `retiredScreens.test.tsx`

- Kind: dx, size S, owner-approved · Base: `task/33208afe625d4f85` at `889db282`
- INTENT objectives: **O5, Rendering**: "0 screens whose main content is raw JSON/YAML/XML or an API response
  (hygiene test plus ui-qa)" (`INTENT.md:166`). **O12, Surface**: "at most 45 routed screens" (`INTENT.md:173`).
  This work serves both only indirectly. It removes a shared file from the path of every slice that retires an
  offender (O5) or a screen (O12).
- Owner note: run it after PR 70 (m23-run-result) merges and before m25 S0, or add the file to S0's owned files,
  whichever blocks less.

## 1. Objective

`frontend/src/routes/retiredScreens.test.tsx` no longer pins the number of routed screens or `MAX_ALLOWED_OFFENDERS`,
and it no longer imports `MAX_ALLOWED_OFFENDERS`. Each count keeps one owner: the route registry test for screens and
the hygiene test for the allow-list ceiling. Slices that lower either count stop needing this file. All other
assertions in the file (retired ids absent, redirects, no screen files, no allow-list entries for retired screens)
stay as they are.

## 2. Evidence checked against the code at `889db282`

| # | Fact | Evidence |
|---|---|---|
| F1 | Four pins of the screen count at 69 | `frontend/src/routes/retiredScreens.test.tsx:110,190,246,275` (`expect(routeDefinitions).toHaveLength(69)`) |
| F2 | Two pins of the ceiling at 12, plus the import that S0 would break | `retiredScreens.test.tsx:140,276` (`expect(MAX_ALLOWED_OFFENDERS).toBe(12)`); import at `:8` |
| F3 | **The screen count already has an owner.** `routes.test.ts` pins 69 and carries the `utest` tags of all five screen-count requirements | `frontend/src/routes/routes.test.ts:58-66` |
| F4 | `retiredScreens.test.tsx` also carries two of those tags: composer and sponsorship screen count. Both requirements stay covered by `routes.test.ts:61-62` | `retiredScreens.test.tsx:241,270`; `openspec/changes/m24-retire-sponsorship/specs/frontend-workspace/spec.md:159-174` |
| F5 | **The ceiling already has an owner.** The hygiene test checks `MAX_ALLOWED_OFFENDERS` against the number of entries (`ceilingMismatch`) and pins 12 itself | `frontend/src/test/rawRenderingHygiene.test.ts:138,363-370` |
| F6 | The ceiling pin in the sponsorship block is no requirement: "`MAX_ALLOWED_OFFENDERS` stays 12 and needs no requirement" | `openspec/changes/m24-retire-sponsorship/design.md:48`, `tasks.md:58` |
| F7 | Outside the allow-list module, only two files use `MAX_ALLOWED_OFFENDERS`: the hygiene test and this file | repository grep (excluding `node_modules`): `rawRenderingHygiene.test.ts:3`, `retiredScreens.test.tsx:8` |
| F8 | m25 S0 replaces `MAX_ALLOWED_OFFENDERS` but does not own this file. `UNLISTED_FINDINGS` stays in `rawRenderingAllowList.ts` | `docs/agent-work/m25-render-rest/intake.md:66-69,73-75` |
| F9 | M2.3 plans to lower the ceiling to 10, 9 and then 8 in H1, J1 and W1. Their owned files leave this file out | `docs/agent-work/m23-run-result/handoff.md:41,48-49,55-57` |
| F10 | m26 A1 owns `frontend/src/routes/**` except `paths/**` and adds a budget test pinned at 69. Slice S owns `screenBudget.test.ts` | `docs/agent-work/m26-navigation/handoff.md:23,63,67` |
| F11 | No m25 or m26 change exists, and no m23 change for H1, J1 or W1. The only m23 changes are binding-table, evaluation-diff, objective-breakdown, qos-against-bounds, trade-off-chart and verdict-terminations | glob `openspec/changes/{m23,m25,m26}-*/proposal.md` |
| F12 | `frontend/src/routes/**` is in R1 (high), and the highest area touched sets the level. R0 ("tests only") covers only files outside the listed globs | `REVIEW.md:14,25,27`; `.agentic/project.yaml:106-108` |
| F13 | e2e also pins 69. The m26 plan gives those files to A3 | `frontend/e2e/qa-gallery.spec.ts:203`, `frontend/e2e/routes-smoke.spec.ts:90`; `m26-navigation/handoff.md:65` |

Proposal evidence I could not confirm: followup `c80f81011f1541dc` and the content of PR 70. The followup id appears
nowhere in the tree, and this role cannot read PRs (`repo pr_get` was refused). Both are cited only as the proposal
gives them.

## 3. Scope

In scope, one file: `frontend/src/routes/retiredScreens.test.tsx`.

1. Delete the four `expect(routeDefinitions).toHaveLength(N)` lines (F1). The value may no longer be 69 after PR 70
   or another slice merges. Delete whatever pin is there.
2. Delete the two `expect(MAX_ALLOWED_OFFENDERS).toBe(N)` lines (F2), and remove `MAX_ALLOWED_OFFENDERS` from the import
   at `:8`. `RAW_RENDERING_ALLOW_LIST` and `UNLISTED_FINDINGS` stay imported, because `:138-139` use them.
3. Remove the tags `[utest->req~frontend-retire-composer-screen-count~1]` (`:241`) and
   `[utest->req~frontend-retire-sponsorship-screen-count~1]` (`:270`), because those tests no longer count. Coverage
   stays at `routes.test.ts:61-62` (F3, F4).

**Deviation from the proposal's first slice.** The proposal suggests replacing the route pins with "the
route-registry count that m26 A1 adds", and the offender pins with `RAW_RENDERING_ALLOW_LIST.length`. I recommend
deleting the pins instead:
- The A1 budget test does not exist on this base (F11). Depending on it would tie this slice to A1's schedule, and
  `routeDefinitions.length` is already pinned in one place (F3).
- `expect(MAX_ALLOWED_OFFENDERS).toBe(RAW_RENDERING_ALLOW_LIST.length)` repeats `ceilingMismatch` (F5). It also keeps
  the import that S0 removes (F8), so S0 would still have to edit this file. That defeats the purpose.

Non-goals:
- `routes.test.ts:63-66`, which stays the single owner of the screen count (O12 tracking). A1 and S may later move it
  into `screenBudget.test.ts` (F10).
- `rawRenderingAllowList.ts` and `rawRenderingHygiene.test.ts`, which belong to M2.3 H1/J1/W1 and m25 S0.
- The e2e pins (F13), which belong to m26 A3.
- Any production code, OpenAPI, schema, `acceptance/**` or `openspec/specs/**`.
- The backlog items (`jobsApi.ir` AbortSignal, the solution clamp rerender test, `.job-figures` in `Jobs.css`).

## 4. Slices

One slice. No feature flag: the edit is a single file, test-only and complete on its own. It is reverted with one
revert commit. No interface contract is involved.

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | `retired-screens-no-counts`: drop the count pins and the ceiling import from `retiredScreens.test.tsx` | mechanical (or implementer), default model, low effort, about 15 turns | `frontend/src/routes/retiredScreens.test.tsx` | F3-F8, `routes.test.ts`, `rawRenderingHygiene.test.ts`, `rawRenderingAllowList.ts` | about 8-10 deleted lines and 1 changed import line | **high by area** (R1, F12); low in substance (test-only, no assertion on behaviour removed) | PR 70 merged into `develop`; no running slice holds `frontend/src/routes/**` (m26 A1, F10) |

An optional spec task S0 is listed in §7 Q2. If the coordinator wants an OpenSpec change, its owned files are
`openspec/changes/<id>/**` (proposal and tasks, with no requirement delta).

Order and ownership:
- **Recommended (option A): S1 runs as its own small PR** after PR 70 merges and before m25 S0. This blocks less
  than folding: it also removes the file from M2.3 H1, J1 and W1 (F9), not only from S0. It also keeps S0 out of
  R1.
- **Fallback (option B, owner-approved): add the file to S0's owned files** with the same three edits, if A1 holds
  `frontend/src/routes/**` when PR 70 merges. The cost: S0, now medium (`m25-render-rest/intake.md:65`), becomes
  high by area (R1). It also still needs the A1 lock.
- If A1 is running, the file is A1's while A1 runs (F10). S1 then waits for A1 to merge, or the coordinator puts the
  three edits into A1 (see §7 Q1).

### Proposed checks (none are registered for this proposal; `cwd` is the repository root)

1. FI: `["pnpm","--dir","frontend","install","--frozen-lockfile"]`
2. Red-before stand-in (G3). The slice adds no test, so a static check proves the pins are gone. It exits 1 on the
   base and 0 after:
   `{"argv":["bash","-c","if grep -nE 'routeDefinitions\\)\\.toHaveLength|MAX_ALLOWED_OFFENDERS' frontend/src/routes/retiredScreens.test.tsx; then exit 1; fi"],"type":"red_before","expect_exit":[1],"expect_pattern":"MAX_ALLOWED_OFFENDERS"}`.
   Register the same argv as a plain check for green-after.
3. Targeted: `["pnpm","--dir","frontend","exec","vitest","run","src/routes","src/test"]`
4. G5 (registered `frontend-unit`, `project.yaml:58`): `["pnpm","--dir","frontend","test"]`, timeout 1200
5. G9 lint: `["pnpm","--dir","frontend","lint"]`. An import left unused fails here.
6. G9 types and build (`typecheck-build`, `project.yaml:79`): `["pnpm","--dir","frontend","build"]`, timeout 900

## 5. Gates for S1

| Gate | S1 |
|---|---|
| G1 spec | n/a if no OpenSpec change (Q2). Otherwise run `openspec validate <id> --strict`, which is `todo: true` (`project.yaml:34`), so it is NOT EXECUTED locally; CI reports it |
| G2 EPIC | n/a (no requirement delta) |
| G3 red-before | check 2: static stand-in, exit 1 on the base |
| G4 acceptance frozen | trivially: no `acceptance/**` |
| G5 green-after | checks 2, 3 and 4, then PR CI |
| G6 trace | composer and sponsorship screen count stay covered by `routes.test.ts:61-62` (F3, F4); `oft-trace` is `todo: true` (`project.yaml:62`), so CI job `trace` is the evidence |
| G7 contracts | n/a: no API or schema |
| G8 mutation | n/a: `stryker-frontend` is `todo: true` (`project.yaml:73`) |
| G9 quality | checks 5 and 6 |
| G10 secrets/ownership | no R11 path; no secret |
| G11 review | high panel by area: reviewer, test-reviewer, security-auditor, arch-reviewer (`REVIEW.md:35`, F12). No ui-qa: nothing on screen changes. The panel needs to confirm that no behavioural assertion was removed |
| G12 lab/UI | n/a: no runtime or UI change |
| G13 review package | n/a with `how_to_review`: read the six deleted pins against F3 and F5, then the two removed tags against `routes.test.ts:58-66` |

## 6. Feature flags

None (single-slice, test-only).

## 7. Open questions

Needs a CRP: **none.** The owner approved the work and the ordering rule. The remaining questions are scheduling and
process calls for the coordinator.

For the coordinator:
- **Q1: where the edit lands.** A: own PR after PR 70 (recommended). B: in m25 S0's owned files (owner's fallback). If
  A1 holds `frontend/src/routes/**`, a third way is to put the edits in A1. The owner did not name that option, so
  use it only if A and B both wait on A1.
- **Q2: OpenSpec change or not.** No requirement changes, and every requirement keeps a test (F3, F4, F6).
  Recommended: a minimal change (proposal and tasks) only if the coordinator's flow needs one per PR. Whether
  `openspec validate --strict` accepts a change with no delta is not verified here.
- **Q3: risk level.** `REVIEW.md:14,27` makes this high (R1), while the proposal says low. Recommended: follow
  REVIEW.md and run the high panel. The diff is about 10 lines, so the cost is small. Only the owner can change
  `REVIEW.md`.
- **Q4: m25 S0 contract.** S0 should keep the export name `RAW_RENDERING_ALLOW_LIST` (or a drop-in), because
  `retiredScreens.test.tsx:138` still reads it. Otherwise S0 has to edit this file again.

## 8. Followups (outside this scope)

- The `Evidence:` line of `req~frontend-retire-sponsorship-screen-count~1` names `retiredScreens.test.tsx`
  (`openspec/changes/m24-retire-sponsorship/specs/frontend-workspace/spec.md:166`). After S1, only
  `routes.test.ts` holds that evidence. The m24 archive task should drop the stale path. The same applies to
  `m24-retire-sponsorship/design.md:86`.
- Followup `c80f81011f1541dc` (add the file to J and W) becomes unnecessary once S1 merges. The coordinator can close
  it.
