# Intake: P-20261026-2, bring the ROADMAP M2 status up to date after PRs #51 and #53

- Kind: docs, size S, owner-approved · Base: `task/797b60020eb7492d` at `212b9662` (the squash of PR #53, on top of
  `5884331a` = PR #54)
- INTENT objective: **O12, Surface** (at most 45 routed screens, `INTENT.md:173`). M2.4 retirements are the slices
  of `ROADMAP.md:69`. The offenders also belong to **O5, Rendering** (`INTENT.md:166`).
- Rule this edit must follow: "the factory updates only the Status column of `ROADMAP.md`" (`AGENTS.md:164-165`,
  `ROADMAP.md:1-2`). Milestones change only through a CRP (`INTENT.md:234`, item 10).

## 1. Objective

Make `ROADMAP.md` show the real state of M2.4: slices 1 and 2 are merged and the next slice is the library catalogue
and project resources. Then the owner, the factory panel and later planners do not plan slice 2 again or wait on a
review that has already ended.

## 2. Findings, checked against the code at `212b9662`

| # | Claim | Verified state | Evidence |
|---|---|---|---|
| F1 | "`ROADMAP.md:20` and `:75-77` say slice 1 under review" | **Partly wrong.** Both places already say slice 1 is merged (PR #51). Only slice 2 is stale ("under review") | `ROADMAP.md:20` "slice 1 merged, PR #51; slice 2 under review"; `ROADMAP.md:75-76` "slice 1 (decision-space workspace) is merged (PR #51); slice 2 (report editor) is under review" |
| F2 | Slice 1 merged as PR #51 | Confirmed | commit `de85b82b` "retire the decision-space workspace (M2.4 slice 1, ADR-0020) (#51)" in the base history; CI of PR #51 green at `4d6191b1` (8/8 check runs, last one completed 2026-10-25T15:37:25Z, `ci_status`) |
| F3 | Slice 2 merged as PR #53 on 2026-10-25, CI green at `59d0ad22` | Confirmed: the commit is in the base and CI was green. The merge time (18:15:39) was **not** verified: the planner role cannot run `pr_get` | base head `212b9662` "retire the report editor (M2.4 slice 2, ADR-0020) (#53)"; CI of PR #53 green at `59d0ad22de95…` (8/8, last one completed 2026-10-25T18:14:41Z, `ci_status`) |
| F4 | Offenders 5 and 7 should be marked removed | Confirmed in the code. Both files are gone and neither is on the allow-list | no `frontend/src/**/{RepDetail,Inspector}*` (Glob); `frontend/src/pages/Analysis/` does not exist; `frontend/src/test/rawRenderingAllowList.ts:23` `MAX_ALLOWED_OFFENDERS = 13`, and the entries jump from 4 to 6 (`:62-77`) and from 6 to 8 (`:71-89`); `frontend/src/test/rawRenderingHygiene.test.ts:389-390` asserts that `RepDetail.tsx` is absent |
| F5 | The next slice is the library catalogue and project resources | Confirmed | `ROADMAP.md:77` gives the order; `openspec/changes/m24-retire-screens-2/tasks.md:79-86` lists S3 = library catalogue and project resources (offender 11), S4 = composer, S5 = sponsorship |
| F6 | Offender 11 is still open | Confirmed. It stays unmarked | `rawRenderingAllowList.ts:104-110` (`retiredBy: 'M2.4'`) |

The offender list is headed "Raw-rendering offenders at 912648c" (`ROADMAP.md:80`). It is a dated snapshot, outside
the Status column and the slice-status paragraph. See Q1.

## 3. Scope

In scope (one file): `ROADMAP.md`.

- `ROADMAP.md:20`, M2 Status cell: "M2.4 in progress, slices 1 and 2 merged (PR #51, PR #53, 2026-10-25); next:
  library catalogue and project resources". Keep the "M2.1 and M2.2 merged, PR #38" part.
- `ROADMAP.md:75-78`, slice-status paragraph: date it `2026-10-26`. Say slice 1 (decision-space workspace, PR #51)
  and slice 2 (report editor, PR #53) are merged on 2026-10-25, and that offenders 5 and 7 left the hygiene allow-list
  with their screens (offender 11 remains, slice 3). Name the remaining order: library catalogue and project resources,
  composer, sponsorship. Keep the sentence about the endpoints, the `Deprecation`/`Sunset` headers and the owner CRP,
  and keep "the other slices have no recorded progress".
- Offenders 5 and 7 (`ROADMAP.md:86,88`): see Q1. The default is the coordinator's choice; the proposal asks for the
  annotation.
- Dates come from `git log` (proposed check 1). Do not write a date the check does not show.

Non-goals:

- Milestone rows, deliverables or acceptance text (`ROADMAP.md:64-73`), and the header "Status: PROPOSED …"
  (`ROADMAP.md:1`). Changing these needs a CRP (`INTENT.md:234`).
- `INTENT.md` (the O5 "Today" cell `:166` and the O12 cell `:173`): this is an R11 owner-only file
  (`.agentic/project.yaml:137-139`).
- Any code, test, OpenSpec change or archive (`openspec/changes/m24-retire-screens*/` stay as they are), and the M0
  and M4 paragraphs.
- Slice 3 of M2.4, and the endpoints CRP.

## 4. Slices

One capability, so one slice. No feature flag: it is documentation only and nothing runs.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | ROADMAP M2 status after PRs #51 and #53 | doc-steward (or implementer), default model, low effort, about 10 turns | `ROADMAP.md` | `AGENTS.md:160-170`, `INTENT.md:166,173,221-235`, `frontend/src/test/rawRenderingAllowList.ts`, `openspec/changes/m24-retire-screens-2/tasks.md:79-101`, this intake | about 4-8 lines changed (more if Q1 = annotate) | **low**: `ROADMAP.md` is not in any risk-area glob (`.agentic/project.yaml:105-139`), it is a Status update only, and nothing changes behaviour | resolution of `crp-ob-set-base-develop-m24`, so S1 starts from the real `develop` (the proposal asks for this; the CRP is not recorded in the repository) |

Requirement ids: none (no behaviour, no OpenSpec requirement).

Proposed checks for S1 (none are registered; argv arrays, `cwd: .`):

1. Merge dates of PR #51 and #53 (a GitHub squash merge sets the committer date):
   `["git","log","--format=%h %cs %s","-n","10"]`. This is an evidence check and never fails on content.
2. G9 stand-in: `["git","diff","--check"]`.
3. Changelog (already in `.agentic/project.yaml:83` as `changelog`): `["python3","tools/generate_changelog.py","--check"]`.
   A `docs(...)` commit that touches `ROADMAP.md` enters the changelog (`tools/generate_changelog.py:19,27-31`), so
   this check fails until the coordinator's final `chore(changelog)` commit on the PR branch (`ci.yml:380-384`).
   Run it after that commit.

## 5. Gates for S1

| Gate | Applies | How |
|---|---|---|
| G1 spec | n/a | docs-only, no OpenSpec change; `openspec-validate` is `todo: true` (`project.yaml:34`) |
| G2 EPIC | n/a | no OpenSpec change |
| G3 red-before | n/a | no test is added or changed |
| G4 acceptance frozen | yes, trivially | `acceptance/**` is untouched |
| G5 green-after | partly | no code. CI must stay green on the PR, including "Check generated changelog" after the regeneration commit (check 3) |
| G6 trace | n/a | no requirement; `oft-trace` is `todo: true` (`project.yaml:62`) |
| G7 contracts | n/a | no API or schema |
| G8 mutation | n/a | no code |
| G9 quality | partly | no Markdown lint is registered; check 2 |
| G10 secrets/ownership | yes | `ROADMAP.md` is not R11 (`project.yaml:137-139`), but its milestones are owner-only (`INTENT.md:234`). The reviewer confirms that only the Status cell and the slice-status paragraph changed (plus the offender lines if Q1 = annotate) |
| G11 review | yes | low panel = `[reviewer]` (`project.yaml:141-142`). The reviewer checks each new fact against section 2 |
| G12 lab/UI | n/a | no runtime or UI change |
| G13 review package | n/a with a `how_to_review` | reading guide: the diff of `ROADMAP.md`, row M2 then the M2 slice-status paragraph, each against F2-F6 |

## 6. Feature flags

None (one slice, documentation only).

## 7. Open questions

Needs a CRP: none, if Q1 is answered with option (a) or (b) below. The edit stays in the factory's Status column and
dated-paragraph area (`AGENTS.md:165`; the paragraph has been updated by the factory before, `ROADMAP.md:47,75,129`).

For the coordinator (no owner decision unless noted):

- Q1: how to mark offenders 5 and 7. The list at `ROADMAP.md:80-96` is a snapshot "at 912648c" and is outside the
  Status column. Options:
  (a) leave the list unchanged and record the removal in the dated slice-status paragraph (recommended: it is the
  narrowest edit within `AGENTS.md:165`, and the snapshot stays a true historical record);
  (b) append "— removed with its screen (PR #51 / PR #53)" to lines 86 and 88, as the proposal asks;
  (c) if the coordinator reads (b) as more than a status update, send it to the owner as a CRP (`INTENT.md:234`).
  Note the mapping: offender 5 (`RepDetail.tsx`) is the report editor, so PR #53. Offender 7 (`Analysis/Inspector.tsx`)
  is the decision-space workspace, so PR #51. Check 1 and the reviewer must confirm this mapping; the planner inferred
  it from the screen names and did not read the PR diffs.
- Q2: the base. The proposal asks for S1 after `crp-ob-set-base-develop-m24`. That id does not appear anywhere in the
  repository (Grep). This worktree's base `212b9662` already contains PR #53 and PR #54. If the CRP confirms that
  `develop` is at `212b9662` or later, S1 can start from it.
- Q3: the merge time of PR #53 (18:15:39) comes only from the proposal. The roadmap needs only the date, which check 1
  gives.
