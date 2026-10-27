# Intake: P-20261027-2, bring the ROADMAP slice status and the AGENTS.md CI job list up to date

- Kind: docs, size S, owner-approved · Base: `task/eabed036351747bb` at `5a47e475` (the squash of PR #66, M2.4
  slice 5)
- INTENT objective: **O7, Delivery flow** (`INTENT.md:168`). The roadmap's Status column is the owner's progress
  view, and the factory keeps it current (`ROADMAP.md:1-2`, `AGENTS.md:164-165`).
- Rule this edit must follow: the factory changes only the Status column of `ROADMAP.md` and its dated slice-status
  paragraphs. Milestone, deliverable and acceptance text change only through a CRP (`INTENT.md:221,234`, item 10).
- Planner limits: `pr_get` is refused for this role ("this role cannot use repository operations"), but `ci_status`
  works. No Bash, so `git log` was not read. Facts about merges come from the commit subjects in the session's git
  status, `frontend/src/content/changelog.generated.json`, files in the tree and `ci_status`. The S1 writer confirms
  each merge and its date with check 1.

## 1. Objective

The roadmap stops calling merged work open or under review. The M0, M2 and M4 Status cells and their dated paragraphs
name each merged slice with its PR, and they say what is still open. `AGENTS.md` lists the CI jobs that
`.github/workflows/ci.yml` actually has, so agents stop reproducing a job set that no longer exists.

## 2. Findings, checked at `5a47e475`

| # | Proposal claim | Verified state | Evidence |
|---|---|---|---|
| F1 | M0.5 S1a/S2 "in open PR #41, not yet merged" (`ROADMAP.md:50`) | **Confirmed stale.** #41 is merged. All the repository slices of M0.5 are now merged: S1b+S3 (#34), S4 (#39) and S1a+S2 (#41). The factory-side items F1 and F2 and the M0.5 acceptance (a preview per PR head, expired after 7 idle days, `ROADMAP.md:41`) are not recorded as verified in the repository | commit `3395c79d` "…(M0.5 S1a+S2) (#41)" (git status); `changelog.generated.json:9,29,33`; `ROADMAP.md:49-50`; `openspec/changes/m05-pr-previews/tasks.md:52-53,140-144` (F1/F2 unchecked). CRP `crp-ob-m05-f1-validator` is not in the repository (Grep, no match) |
| F2 | M2.4 slice 3 "under review" (`ROADMAP.md:20,77`) | **Wrong.** Both places already say slice 3 is merged (#55). The stale item is **slice 5**: `ROADMAP.md:20` and `:77-78` say it is "under review", but its squash `5a47e475` "…(M2.4 slice 5, ADR-0020) (#66)" is the base head. Slice 5 was written into the roadmap before its merge (`docs/agent-work/m24-retire-sponsorship/handoff.md:2`, "ROADMAP status … integrated") | `ROADMAP.md:20` "slices 1 to 4 merged, PR #51, #53, #55 and #65; slice 5 under review"; `ROADMAP.md:76-78`; git status head `5a47e475` |
| F3 | M4 shows only "M4.1 partly, PR #36"; M4.5 "has merged" (#63) | **Partly right.** The M4 cell and paragraph are stale (`ROADMAP.md:22,134-135`): they miss #40 ("SPACE image from the pinned v1.7.1 commit and lab bootstrap (M4.1 part 2…)") and #63. But #63 is not the M4.5 deliverable. It is slice **A2** of the M4 plan, the compose wiring of the M4.1 profile. Its own proposal says "the gateways are not wired to this SPACE yet", and lab/preview wiring is out of its scope. M4.5 (D1, D2) is not built. The #63 content is in the tree, but the planner did not read the merge commit (`c941a212` comes from the proposal only) | `changelog.generated.json:24` (#40); `docs/agent-work/m4-plans-slices/handoff.md:39,60-61,70-76`; `openspec/changes/m45-lab-pricing-wiring/proposal.md:9-11,34,39-43`; `compose.lab-pricing.json:39-41,75-87`; `docs/qa/PRICING_PROFILE.md:48` "Memory sum: 1088 MiB"; `ci_status` PR 63: head `b133118b`, 8/8 success, last completed 2026-10-26T18:01:51Z |
| F4 | M0.9 has "no recorded progress" (`ROADMAP.md:51`) | **Confirmed stale, and it is partly done.** The change `m09-compose-only` went through PR #60 (the proposal does not name it). `deploy/kubernetes/` is gone. `deploy/compose/production/{compose.yaml,images.env,ci.env}` and `docs/runbooks/production.md` exist. The M0.9 acceptance "`docker compose config` passes in CI for development, lab and production" (`ROADMAP.md:45`) is **still open**: CI runs only the root `docker compose config` (`ci.yml:424-425`), and the change's own design leaves the lab/production CI job as a followup that waits on a workflow token (CRP-3) | Glob `deploy/**`; `AGENTS.md:36`; `docs/agent-work/m09-compose-only/review/round1.md:1` "PR #60"; `openspec/changes/m09-compose-only/design.md:97,139,183-185`; `ci_status` PR 60: head `3e2cb7a5`, 8/8 success. Merge not read |
| F5 | M0.2: handoff reports `--strict --all` = 26 passed with PR 56; merge unverified | **Consistent with a merge, but the merge commit was not read.** The lead's summary records the CI proof `Totals: 26 passed, 0 failed (26 items)` on the PR 56 merge ref, CLI 1.14.3. The change folder `openspec/changes/m02-openspec-strict/` is absent, as the summary says. The CI step is still report-only, so a green `openspec` job proves nothing by itself | `docs/agent-work/m02-openspec-strict/summary.md:33,38-43`; `handoff.md:2`; Glob `openspec/changes/m02*` (none); `ci.yml:254-256` `continue-on-error: true`; `ci_status` PR 56: head `baa39f20`, 8/8 success, last completed 2026-10-26T13:05:16Z |
| F6 | `AGENTS.md:43` lists `bim-corpus, engines, test, frontend`; `ci.yml:48` has 12 jobs | **Confirmed.** The jobs are `changes, ci-required, bim-corpus, bim-toolchain, lab, openspec, trace, engines, gateway-unit, test, frontend, frontend-e2e`. Two other lines are also stale: `AGENTS.md:89` puts `pnpm test:e2e` under "CI job `frontend`", but the mocked e2e runs in the three `frontend-e2e` shards (`ci.yml:517-551`); `AGENTS.md:50` implies that the unit suite runs in `test`, but it runs in the two `gateway-unit` shards (`ci.yml:335-385`). `TESTING.md:114-126` is already current and can be the reference | `ci.yml:22,47-48,67,129,191,233,260,297,335,387,468,517`; `AGENTS.md:43,50,89-94`; `TESTING.md:84,114-126` |
| F7 | Followups e192dde96ab64393, a5d6cf17b3c742e4, 7715557568464f81 ask for an AGENTS.md owner | **Not verifiable in the repository** (Grep: no match). One related record does exist: ci-speed planned slice S9 for "`AGENTS.md` (CI lines)" and then deferred `AGENTS.md:43` | `docs/agent-work/ci-speed/intake.md:222`; `docs/agent-work/ci-speed/handoff.md:7` |
| F8 | (not in the proposal) M0.2 acceptance text says "today 16 specs fail" | Stale, but the text is in the **Acceptance** column, not Status. The living specs pass. See Q1 | `ROADMAP.md:38`; `summary.md:9-10,47` |

Neither `ROADMAP.md` nor `AGENTS.md` matches a risk-area glob (`.agentic/project.yaml:105-139`). Neither is an R11
path (`:137-139`).

## 3. Scope

In scope: `ROADMAP.md` (Status cells and dated slice-status paragraphs only) and `AGENTS.md` §3 (CI job names only).

- `ROADMAP.md:18`, M0 cell: add M0.2 done (PR #56, if check 1 shows it). Say M0.5's repository slices are merged
  (PR #34, #39, #41) and its live acceptance is not recorded. Add M0.9 partly (PR #60: Kubernetes removed, production
  overlay and runbook; CI `compose config` for lab and production open). Keep M0.3 done, M0.1 unverified, and the
  CI-trigger and flaky-register notes.
- `ROADMAP.md:47-51`, M0 paragraph: re-date it to 2026-10-27 with the same facts and a PR per claim. Change "the other
  slices have no recorded progress" so that it no longer covers M0.2, M0.9 or (if Q4 = record) M0.8's plan.
- `ROADMAP.md:20`, M2 cell, and `:75-79`, M2 paragraph: slice 5 is merged (PR #66), so all five M2.4 screen
  retirements are merged. Keep the sentence that the endpoints with `Deprecation`/`Sunset` headers are a separate step
  waiting on an owner CRP, which means M2.4 is still "in progress", not done.
- `ROADMAP.md:22`, M4 cell, and `:130-135`, M4 paragraph: M4.1 partly merged (PR #36, PR #40, PR #63, the compose
  wiring); the key placement and the live bring-up are not recorded; M4.5 not started (see Q2). Keep the M4.0 evidence
  as it is.
- `AGENTS.md:43`: list the 12 jobs and point to `TESTING.md` §10 for what each one runs. With Q3 = yes, also fix
  `:89` ("CI jobs `frontend` and `frontend-e2e`") and add "(CI jobs `gateway-unit` and `test`)" near `:50`.
- Every date and merge comes from check 1. A claim that check 1 does not show is left out.

Non-goals:

- Milestone rows, deliverables, acceptance text (including `ROADMAP.md:38`, see Q1) and the header `ROADMAP.md:1-2`:
  changing them needs a CRP (`INTENT.md:234`).
- The offender snapshot "at 912648c" (`ROADMAP.md:81-97`).
- `INTENT.md` "Today" cells, `.agentic/project.yaml` (R11; see followups), `TESTING.md` (already current),
  `CONTRIBUTING.md`.
- `AGENTS.md` outside the CI job names. This excludes "Known red CI steps at 912648c" (`AGENTS.md:107-109`) and the
  `corepack enable` lines.
- Any code, test, OpenSpec change or archive. Any claim about the factory-side M0.5 items or the lab state.

## 4. Slices

Two capabilities: the owner's progress view, and the agents' operating guide. The two slices own disjoint files and do
not depend on each other, so they can run in parallel. The coordinator may ship them in one PR with one
`chore(changelog)` commit, as the proposal asks, or as two PRs. No feature flag: this is documentation only and
nothing runs.

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | ROADMAP status for M0, M2 and M4 at `5a47e475` | doc-steward (or implementer) · default model, low effort · ~15 turns | `ROADMAP.md` | this intake §2 (F1-F5, F8), the files cited there, `AGENTS.md:160-166`, `INTENT.md:221-235` | ~20-30 lines changed | **low**: no risk-area glob, a Status-only edit, no behaviour | none |
| S2 | AGENTS.md CI job list | doc-steward (or implementer) · default model, low effort · ~8 turns | `AGENTS.md` | `.github/workflows/ci.yml`, `TESTING.md:114-126`, this intake F6 | ~3-6 lines changed | **low**: no risk-area glob and not R11; the text only describes CI, it does not change it | none |

Requirement ids: none (no behaviour, no OpenSpec requirement).

Proposed checks (none are registered; argv arrays, `cwd: .`):

1. (S1) Evidence, never fails on content: `["git","log","--format=%h %cs %s","-n","60"]`. It must show the squashes of
   #40, #41, #55, #56, #60, #63, #65 and #66 with their committer dates (a GitHub squash merge sets the committer
   date to the merge time). If #56, #60 or #63 is missing, S1 leaves that claim out and reports it.
2. (S2) Evidence: `["grep","-nE","^  [a-z][a-z0-9-]*:$",".github/workflows/ci.yml"]`. Every name except `push`
   (line 6, under `on:`) is a job.
3. (S1, S2) G9 stand-in: `["git","diff","--check"]`.
4. Changelog (already registered in `.agentic/project.yaml:83` as `changelog`):
   `["python3","tools/generate_changelog.py","--check"]`. Every Conventional Commit since the baseline enters the
   JSON (`tools/generate_changelog.py:87-100`), so this check fails until the coordinator's final `chore(changelog)`
   commit (CI step `ci.yml:502-504`, pull requests only). Run it after that commit.
5. (S1, optional, only if the runner has `openspec-cli`): `["openspec","validate","--strict","--all"]`. It confirms
   that M0.2 still holds at the base. Without it, S1 cites `summary.md:38-41` and says the check was not run at this
   base.

## 5. Gates per slice

| Gate | S1 (`ROADMAP.md`) | S2 (`AGENTS.md`) |
|---|---|---|
| G1 spec | n/a: docs-only, no OpenSpec change (`openspec-validate` is `todo: true`, `project.yaml:34`) | n/a, same reason |
| G2 EPIC | n/a | n/a |
| G3 red-before | n/a: no test added or changed | n/a |
| G4 acceptance frozen | yes, trivially: `acceptance/**` untouched | yes, trivially |
| G5 green-after | partly: no code; CI stays green on the PR, including "Check generated changelog" after the regeneration commit (check 4) | partly, same |
| G6 trace | n/a: no requirement (`oft-trace` is `todo: true`, `project.yaml:62`) | n/a |
| G7 contracts | n/a | n/a |
| G8 mutation | n/a | n/a |
| G9 quality | partly: no Markdown lint is registered; check 3 | partly: check 3 |
| G10 secrets/ownership | yes: not R11, but milestones are owner-only (`INTENT.md:234`). The reviewer confirms that only Status cells (`:18,20,22`) and dated paragraphs (`:47-51,75-79,130-135`) changed | yes: not R11. The reviewer confirms that only CI job names changed and that the owner-only list `AGENTS.md:164-165` is untouched |
| G11 review | yes: low panel `[reviewer]` (`project.yaml:141-142`). The reviewer checks each new fact against check 1 and §2 | yes: `[reviewer]`. The reviewer checks the list against check 2 |
| G12 lab/UI | n/a: no runtime or UI change | n/a |
| G13 review package | n/a with `how_to_review`: read the diff row by row (M0, M2, M4 cells, then the three paragraphs), each claim against check 1 and F1-F5 | n/a with `how_to_review`: the `AGENTS.md:43` diff against `ci.yml` job keys |

## 6. Feature flags

None (documentation only; each slice is complete by itself).

## 7. Open questions

Needs a CRP: **none** for the planned edits. They stay in the Status column and the dated paragraphs, which the
factory has updated before (`ROADMAP.md:47,75,130`). A CRP is needed only if the coordinator picks option (b) of Q1.

For the coordinator:

- Q1: `ROADMAP.md:38` says "today 16 specs fail on requirement text length" in the M0.2 **Acceptance** cell. That is
  stale (`summary.md:9-10,47`). Options: (a) leave the cell and say in the dated M0 paragraph that the parenthetical
  is out of date (recommended: it stays within `AGENTS.md:165`); (b) send the owner a CRP to delete the
  parenthetical.
- Q2: how to record #63. Its subject and change id say "M4.5", but it delivers slice A2, the M4.1 profile wiring
  (`m4-plans-slices/handoff.md:39,70-76`; `m45-lab-pricing-wiring/proposal.md:34`). Options: (a) list it under M4.1
  and add "M4.5 not started; #63's subject names it but delivers the M4.1 profile wiring" (recommended: matches the
  roadmap deliverables at `ROADMAP.md:123,127`); (b) "M4.5 started (#63)". Option (b) would tell the owner that lab
  and previews are moving to the local SPACE, and they are not.
- Q3: should S2 also fix `AGENTS.md:89` (e2e in `frontend-e2e`) and `:50` (unit suite in `gateway-unit`)? Recommended:
  yes. Both are CI job names and add about 2 lines.
- Q4: M0.8 has a plan only (`docs/agent-work/m08-qacobench-baseline/handoff.md:2,13`, CRP-1/CRP-2 pending). Should
  the M0 paragraph mention "planned, waiting on CRPs"? Recommended: no. A plan is not progress on a deliverable, and
  the proposal does not ask for it.
- Q5: should M0.5's Status say "repository slices merged; live acceptance not recorded" (recommended), or leave
  "in progress" with no detail? The planner cannot see the factory's F1/F2 state.
