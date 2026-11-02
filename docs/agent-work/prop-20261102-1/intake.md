# Intake: P-20261102-1, record the merges of M0.8, M0.9 and M2.7 in the ROADMAP status

- Kind: docs, size S, owner-approved · Base: `task/6f22d9607be74586` at `5b4c68a6` ("Complete task
  6546de26cd624517"). It follows `98aada47` ("Keep the local integrations develop does not have yet").
- INTENT objective: **O7, Delivery flow** (`INTENT.md:168`). The Status column is the owner's progress view for the R1
  decision (R1 = M0–M2, `ROADMAP.md:20,204`).
- Rule this edit must follow: the factory changes only the Status column of `ROADMAP.md` and its dated slice-status
  paragraphs (`ROADMAP.md:1-2`, `AGENTS.md:164-165`). Milestone, deliverable and acceptance text change only through a
  CRP (`INTENT.md:221,234`, item 10).
- Planner limits: the repo tool refuses this role ("this role cannot use repository operations", so no `pr_get` and
  no `ci_status`), and there is no Bash, so `git log` was not read. Merge facts come from the commit subjects in the
  session's git status, from files in the tree, and from the change documents. The slice writer confirms every merge
  with check 1.

## 1. Objective

The M0 and M2 Status cells and their dated paragraphs record what #74, #75 and #78 delivered, with dates up to
2026-11-02. They also say exactly what still keeps M0.8, M0.9 and M2.7 open, and which owner decision blocks each
part, so the owner can decide R1 from `ROADMAP.md` alone.

## 2. Findings, checked at `5b4c68a6`

| # | Proposal claim | Verified state | Evidence |
|---|---|---|---|
| F1 | #75 and #78 are merged | **Confirmed as squash subjects in the base history.** | git status: `c1e7b9f5` "M0 infra close: … (M0.9 F5, F9) (#75)", `aa4c98d5` "M0.8: QACOBench classifies refusals by error code; frozen golden baseline for minizinc-csp 1.1.1 (#78)" |
| F2 | #74 (M2.7) is merged | **Not verified.** #74 is not among the five commits the session shows, and no repository text names PR 74 (Grep). The M2.7 part-1 files are in the tree (`frontend/src/shared/lib/identity.ts`, `components/CitationPanel/*`, `components/VerifyResult/*`, `test/digestHygiene.test.ts`). But the base also contains `98aada47`, which keeps local integrations that `develop` does not have yet, so a file in the tree does not prove the merge. | Glob; git status; `docs/agent-work/m27-names-not-digests/handoff.md:3,9` (pushed `44061e8d`; PR number not recorded) |
| F3 | "M2.7 merged (#74)" | **Overstated.** #74 is the **first of two** M2.7 changes. It adds identity labels, `CitationPanel`, `VerifyResult` and the digest hygiene test, and it leaves `pages/**` alone. The page sweep (F.5) comes in a second change after M2.6. `PENDING_CLEANUP` still lists 40 files, so the M2.7 acceptance (`ROADMAP.md:72`, "no digest-shaped text … outside the allowed components") is not met. | `openspec/changes/m27-names-not-digests/tasks.md:3,103,129-153`; `frontend/src/test/digestHygiene.test.ts:77-133`; `m27-names-not-digests/handoff.md:1` |
| F4 | "M0.8 code done (#78)" | **Wrong.** #78 delivered S0 (spec), S2 (`campaign.py` classifies refusals by code) and S3 (the frozen golden `bim-toolchain/golden/bim_baseline_1_1_1/`). `CHANGED_MANIFESTS` now appears only in specs and docs, not in code. **S1 is not built:** the `engine_incompatible` code is in neither `docs/ERRORS.md` nor `docs/openapi.json` (Grep, no match), tasks 1.1-1.4 are unticked, and S1 waits on **CRP-M08-1**. The 1.1.2 release waits on **CRP-M08-2**, and it also needs S1 (until S1, a refusal stops the campaign). | `docs/agent-work/m08-qacobench-baseline/plan.md:1` ("Not in scope: S1 (CRP-M08-1), 1.1.2 release (CRP-M08-2)"); `openspec/changes/m08-qacobench-baseline/tasks.md:3-4,14-19,37-38`; `docs/agent-work/roadmap-full/plan.md:305-308`; `docs/agent-work/m08-qacobench-baseline/intake.md:212-217`; Glob `bim-toolchain/golden/bim_baseline_1_1_1/*` (3 files) |
| F5 | "M0.9 done (#75) with its open follow-ups" | **Overstated.** #75 (`m0-infra-close`) closed F5 (Kubernetes notes) and F9 (nginx resolves the gateway at request time, plus the runbook). Kubernetes is gone: Glob `deploy/kubernetes/**` finds nothing, and `.github/workflows/` has no `kubernetes`/`kustomize` match. The M0.9 acceptance "`docker compose config` passes in CI for development, lab and production" (`ROADMAP.md:45`) is **not met for production**. CI renders the root file (`ci.yml:424-425`), and the lab tests render `compose.lab.json` and `compose.lab-process.json` (`ci.yml:214-217`, `lab/tests/test_lab_compose_config.py:15,57-78`). The production render job is S3, blocked on **CRP-M09-3**. S2 (F4 `prod` profile, F7 non-root engines) is blocked on **CRP-M09-2**. The pre-deployment nginx check 1b.7 has not been run. | `openspec/changes/m0-infra-close/tasks.md:8-13,85-95,121-160`; `docs/runbooks/production.md:913-927`; `docs/agent-work/m0-infra-close/handoff.md:1` |
| F6 | `ROADMAP.md:18,20,47-51,81-82` are stale | **Confirmed.** `:18` does not mention M0.8 or M0.9. `:20` and `:81-82` say "M2.6 and M2.7 in flight, not merged". `:47-51` is dated 2026-10-24 and ends "the other slices have no recorded progress". M2.6 is still not merged: `frontend/src/routes/areas/` and `routes/paths/` (outputs of its first slices A1/A2) do not exist. | `ROADMAP.md:18,20,47-51,75-82`; Glob; `docs/agent-work/m26-navigation/handoff.md:63-64` |
| F7 | (not in the proposal) P-20261027-2 was approved before these merges | **Its ROADMAP slice is not applied** in the parts this proposal touches. `:18` still lacks M0.2 (#56) and M0.9 (#60), and `AGENTS.md:43` still lists 4 CI jobs. That plan's S1 also owns `ROADMAP.md`, so the two must not run in parallel (Q1). Its M2 and M4 parts are already current (`ROADMAP.md:75-82` dated 2026-10-28, `:133-141`). | `docs/agent-work/prop-20261027-2/intake.md:40-54,76`; `AGENTS.md:43`; `ROADMAP.md:18` |
| F8 | (not in the proposal) changelog | `frontend/src/content/changelog.generated.json` stops at #66 (`:5-8`). Any commit makes it stale, so the PR needs a final `chore(changelog)` commit (lessons 2). | `changelog.generated.json:5-8`; `docs/lessons.md` item 2 |

`ROADMAP.md` matches no risk-area glob and is not an R11 path (`.agentic/project.yaml:105-139`).

## 3. Scope

In scope: `ROADMAP.md`, the Status cells `:18` (M0) and `:20` (M2), and the dated paragraphs `:47-51` (M0) and
`:75-82` (M2). The new text is dated 2026-11-02 and cites PR numbers and CRP ids only. A claim that check 1 does not
show is left out.

The draft content below is for the writer, who checks it against check 1 and §2.
- M0 cell: keep the existing notes, and add: "M0.8 partly (#78: refusals classified by code, frozen minizinc-csp 1.1.1
  baseline; the `engine_incompatible` code waits on CRP-M08-1, release 1.1.2 on CRP-M08-2); M0.9 partly (#75 [and #60
  if Q1 = fold]: Kubernetes removed, production overlay and runbook, nginx request-time resolver; production
  `compose config` in CI waits on CRP-M09-3, `prod` profile and non-root engines on CRP-M09-2)".
- M0 paragraph: re-date it "Slice status (2026-11-02)". Add M0.8 and M0.9 sentences with the same facts. Narrow "the
  other slices have no recorded progress" so that it no longer covers M0.8 or M0.9.
- M2 cell and paragraph: "M2.7 part 1 merged (#74: identity labels, `CitationPanel`, `VerifyResult`, digest hygiene
  test with a pending list of 40 page files); the page sweep follows M2.6". Keep "M2.6 in flight, not merged" unless
  check 1 shows an M2.6 squash. Re-date the paragraph to 2026-11-02 and keep the M2.1–M2.5 sentences as they are.
  If check 1 does not show #74, the writer leaves M2.7 as it is and reports that.

Non-goals:
- Milestone rows, deliverables and acceptance text (including `ROADMAP.md:44-45`), the header `:1-2`, and the
  offender snapshot `:84-100`. Changing any of them needs a CRP.
- The M4 and M9 paragraphs (already dated 2026-10-28), and `AGENTS.md` (P-20261027-2 S2).
- Answering or restating CRP-M08-1/2 or CRP-M09-2/3; code, tests, OpenSpec changes, archives, and `acceptance/**`.
- Saying "done" for M0.8, M0.9 or M2.7. None of their acceptance cells is met (F3-F5).

## 4. Slices

One capability, the owner's progress view, in one file, so there is one slice. No feature flag: documentation only,
nothing runs.

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | ROADMAP M0/M2 status at the merges of #74, #75, #78 | doc-steward (or implementer) · default model, low effort · ~15 turns | `ROADMAP.md` | this intake §2-§3; the files cited in F3-F5; `AGENTS.md:160-166`; `INTENT.md:221-235` | ~10-20 lines changed (~30 if Q1 = fold) | **low**: no risk-area glob, a Status-only edit, no behaviour | none, but it must not run in parallel with any other task that owns `ROADMAP.md` (Q1) |

Requirement ids: none (no behaviour, no OpenSpec requirement).

Proposed checks (none registered yet; argv arrays, `cwd: .`):
1. Evidence, never fails on content: `["git","log","--format=%h %cs %s","-n","60"]`. It must show the squashes of
   #74, #75 and #78 with their committer dates (and #56 and #60 if Q1 = fold). A missing PR is left out and reported.
2. G9 stand-in: `["git","diff","--check"]`.
3. BIM guard (registered as `bim-guard`, `.agentic/project.yaml:52`): `["python3","tools/check_bim_guard.py"]`.
   It scans every file (lessons 1).
4. Changelog (registered as `changelog`, `.agentic/project.yaml:83`):
   `["python3","tools/generate_changelog.py","--check"]`. It fails until the coordinator's final `chore(changelog)`
   commit; run it after that commit.
5. Optional evidence, always exits 0:
   `["bash","-c","git grep -n -e engine_incompatible -- docs/ERRORS.md docs/openapi.json || echo 'engine_incompatible: absent'; git ls-files -- deploy/kubernetes | wc -l"]`.
   It re-checks F4 and F5 at the writer's base.

## 5. Gates per slice (S1)

| Gate | S1 (`ROADMAP.md`) |
|---|---|
| G1 spec | n/a: docs only, no OpenSpec change |
| G2 EPIC | n/a |
| G3 red-before | n/a: no test added or changed |
| G4 acceptance frozen | yes, trivially: `acceptance/**` untouched |
| G5 green-after | partly: no code; CI stays green on the PR after the `chore(changelog)` commit (check 4) |
| G6 trace | n/a: no requirement |
| G7 contracts | n/a |
| G8 mutation | n/a |
| G9 quality | partly: no Markdown lint is registered; checks 2 and 3 |
| G10 secrets/ownership | yes: not R11, but milestones are owner-only (`INTENT.md:234`). The reviewer confirms that only `:18,20` and the two dated paragraphs changed |
| G11 review | yes: low panel `[reviewer]` (`.agentic/project.yaml:141-142`). The reviewer checks each claim against check 1 and F1-F5, and that nothing says "done" for M0.8, M0.9 or M2.7 |
| G12 lab/UI | n/a: no runtime or UI change |
| G13 review package | n/a with `how_to_review`: read the M0 cell, then the M0 paragraph, then the M2 cell and paragraph, each claim against check 1 and §2 |

## 6. Feature flags

None (one documentation slice, complete by itself).

## 7. Open questions

Needs a new CRP: **none**. The edit stays in the Status column and the dated paragraphs. It only cites CRPs that
already exist (CRP-M08-1, CRP-M08-2, CRP-M09-2, CRP-M09-3, `docs/agent-work/roadmap-full/plan.md:294-308`). Whether R1
may be cut with M0.8's release left out is already in that plan (`:219-221`, owner decision pending). This intake
does not raise it again.

For the coordinator:
- Q1: P-20261027-2 S1 also owns `ROADMAP.md`, and its M0 part (M0.2 #56, M0.9 #60) is not applied (F7). Options:
  (a) fold its M0 items into this S1 and close that slice (recommended: one owner of the file and one changelog
  cycle; its M2 and M4 parts are already current); (b) run them one after the other.
- Q2: the M0.9 wording. `openspec/changes/m0-infra-close/tasks.md:141-143` says the acceptance is met "for
  development only", but the lab tests already render the two lab files in CI (F5). Recommended: say "production
  `compose config` is not in CI yet (CRP-M09-3)". That is true either way.
- Q3: the proposal says "cite PR numbers only". The existing paragraphs also name change ids (`ROADMAP.md:75,79-80`).
  Recommended: PR numbers and CRP ids, no new change ids.
