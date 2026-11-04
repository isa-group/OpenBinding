# Intake: P-20261104-2, refresh the flaky-test register before the 2026-11-24 E2/E3 review

- Kind: maintenance, size S, risk low, auto-approved (proposal auto-start rule).
- Base: `task/2bc86c5d6dc64a72` at `42173d76`.
- INTENT objective: **O6, Platform reliability**: "`develop` CI green on ≥ 95 % of days; no flaky test older than
  7 days" (`INTENT.md:167`). Quarantine rule: "only through `docs/qa/FLAKY_TESTS.md` with an owner and a deadline"
  (`TESTING.md:112`).
- Sources: followups "Fill First seen dates of E1-E7" from tasks `6384c8d487b24e66` and `2d613b5d722a4468`, as the
  proposal quotes them. Only `2d613b5d722a4468` is visible here, as commit `f96db981` "Complete task 2d613b5d722a4468".
  No file in the worktree names `6384c8d487b24e66` (grep).

## 1. Objective

`docs/qa/FLAKY_TESTS.md` gets correct "First seen" dates, PR references and file:line evidence. With them, the
owner's E2/E3 review on 2026-11-24 rests on checked facts, and the 7-day rule can be applied to every row it covers.

## 2. Evidence checked at `42173d76`

| # | Fact | Evidence |
|---|---|---|
| F1 | E1-E7 read `unknown (no record)` under "First seen". E8 and E9 carry 2026-10-25 | `docs/qa/FLAKY_TESTS.md:18-26` |
| F2 | The file says nothing can be aged until the dates come from git, and that it was written without `git`. Its PR numbers and SHAs for E4-E7 were not checked against the history | `FLAKY_TESTS.md:31-32,34-36` |
| F3 | Definition: "First seen" is the date of the earliest record in this repository (a committed document with a date). An entry is older than 7 days only if its status is `open` or `deselected` | `FLAKY_TESTS.md:9-12` |
| F4 | **The ages are computed by a tool.** `flaky_age` splits each table row on `\|`. It needs an `E<n>` id in cell 1 and reads "First seen" from cell 3 and Status from cell 4. It ages only a Status that starts with `open` or `deselected`, and only ids outside `--not-counted` (default `E2,E3`). The date must be `YYYY-MM-DD` at the very start of the cell, otherwise the row counts as unknown | `tools/flow_metrics.py:26-27,139-156` |
| F5 | **So the proposal overstates what is unmeasurable today.** E1 and E4-E9 have Status `fixed…`, and E2/E3 are not counted (owner decision `crp-flaky-b8-classification`). The tool therefore reports no older, no within and no unknown entry today. Filling E1 and E4-E7 completes the record but does not change the O6 figure. The dates that matter for O6 are E2/E3's: they are aged once the review of 2026-11-24 or `--not-counted ""` puts them back in the count | F1, F4; `FLAKY_TESTS.md:28-31`; `lab/tests/test_flow_metrics_o6.py:104-108` |
| F6 | The tool's unit tests read a fixture, not the real register. Editing the register cannot break them | `lab/tests/test_flow_metrics_o6.py:95,105` |
| F7 | The E2/E3 deselects are now at `ci.yml:162-180`: the comment at 162-167 (it says "Nothing else is deselected" at 165) and the step with both `--deselect` options at 175-180. Lines 100-110 are now gateway corpus and diagram steps. These are the only `deselect` hits in `.github/workflows` | `.github/workflows/ci.yml:100-110,162-180`; grep |
| F8 | Stale `ci.yml` references in the register: rows E2/E3 (`ci.yml:100-110`) and the E2/E3 details (`ci.yml:100-110` and "as `ci.yml:103` says") | `FLAKY_TESTS.md:19-20,42` |
| F9 | **Not in the proposal:** `openspec/changes/m03-gate-tooling/design.md` no longer exists. The change was archived to `openspec/changes/archive/2026-10-26-m03-gate-tooling/design.md`. Its lines 248 (B8 deselects) and 249 (the E6 failure) still hold the cited text | `FLAKY_TESTS.md:19-20,23,45,58`; archive `design.md:248-249` |
| F10 | **Not in the proposal:** E6's line references drifted. The E6 test is defined at line 233 (the register says 228), and the regression test at 249 (the register says 244 and 244-247). Lines 244-246 now hold the E6 test's assertions | `FLAKY_TESTS.md:23,60`; `openbinding-gateway/tests/test_engine_cancel_contract.py:233,244-246,249` |
| F11 | Still correct: E2 `test_analysis_b8_evidence.py:128`; E3 `test_analysis_b8_probe.py:213-214,232`; E4 `test_analysis_b8_probe.py:140,201-202`; E5 `test_execution_in_the_pool.py:506,561-562`; E7 `_helpers.py:111-117` and `test_remote_cancel.py:701`. E3's `:263` was not checked | the files cited, at those lines |
| F12 | Both E8/E9 fixes are in the base: `stuck_neighborhood` (E8) and `worker_preload`/`slow_workers` with the new mechanism test (E9). The register still reads "pending PR" and "pending CI" | `openbinding-gateway/tests/test_process_probe.py:252,300,468,530-539`; `FLAKY_TESTS.md:25-26,84,91,160` |
| F13 | "Last reviewed: 2026-10-25" | `FLAKY_TESTS.md:3` |
| F14 | Risk areas: `docs/qa/**` matches no glob, so it is R0. `.github/**` is R10, read only here. `FLAKY_TESTS.md` belongs to no running change: the flow-metrics change rules out editing it, and its S3 only reads it | `.agentic/project.yaml:105-139`; `openspec/changes/flow-metrics/proposal.md:30`; `docs/agent-work/prop-20261102-3/intake.md:105` |
| F15 | No registered check reads git history. The ones in `project.yaml` are test, lint, build and contract runs. `bim-guard` scans every file, docs included (lesson 1) | `.agentic/project.yaml:43-96`; `docs/lessons.md` lesson 1 |

Not verified in this role: git history and dates (no git access, no registered check), PR numbers and SHAs (no repo
tool), and develop CI runs. These are exactly the facts the slice has to establish.

## 3. Scope

In scope (one file, `docs/qa/FLAKY_TESTS.md`):
- "First seen" for E1-E7: the date of the earliest commit that adds a record of the flaky behaviour (rule in §7 Q1),
  written as `YYYY-MM-DD (commit <sha>, <path>)` (F4). If git has no such record, keep `unknown (no record)` and say
  what was searched.
- E8/E9: replace "pending PR" with the merged PR number and squash commit. Set Status from the first develop push run
  after the merge: `fixed` if the test passed, `open` (with First seen kept) if it failed again.
- References: `ci.yml:100-110` → `ci.yml:162-180` (F7, F8). `ci.yml:103` → `ci.yml:165`. The archived `design.md`
  path (F9). E6 lines (F10). Re-check each reference in the file and record any other drift found.
- Check E4-E7's PR numbers and SHAs against the history, then rewrite "Verification limits" (`:34-36`) to say what was
  checked and how. Rewrite the sentence at `:31-32` to match F5.
- "Last reviewed" set to the day the slice is written.

Non-goals:
- Test, workflow or tool changes. That includes removing the deselects and the B8 timing work (`ci.yml`, R10).
- Re-deciding E2/E3's classification or their 2026-11-24 review (owner, `crp-flaky-b8-classification`).
- `tools/flow_metrics.py`, `docs/qa/FLOW_METRICS.md` (prop-20261102-3), `INTENT.md` "Today" cells (R11).
- The E9 probe follow-up, where one 503 is taken as proof (`FLAKY_TESTS.md:152-153`).
- `acceptance/**`, `openspec/specs/**`.

## 4. Slices

One slice. No feature flag: this is a single docs-only slice, and rolling it back means reverting it. No OpenSpec
delta: behaviour does not change (Q4).

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | `flaky-register-refresh`: dates, E8/E9 status and PRs, references, "Last reviewed" | doc-steward, default model, low effort, about 25 turns; `repo` read ops `ci_status`/`ci_log` | `docs/qa/FLAKY_TESTS.md` | F1-F15; `tools/flow_metrics.py:139-156`; `.github/workflows/ci.yml`; the archived m03 `design.md`; `docs/agent-work/{flaky-b8-probe,flaky-engine-cancel,prop-20261025-2,prop-20261025-3}/**`; the test files of F10-F12 | about 25-50 lines changed | **low**: R0 docs (F14). No code, test, workflow or contract change. The register's format feeds `flow_metrics.py`, guarded by check 2. Panel: reviewer | registered checks of §4.1; coordinator answers Q1-Q3 |

### 4.1 Proposed checks (none are registered for this proposal)

All are read-only. Git checks print `%h %cI %s` (commit date in ISO form with its offset), so the steward can turn it into
a UTC day. Each argv is a single command with no pipe (factory:qa-checks).

0. `bim-guard` (`project.yaml:52`; lesson 1): `{"cwd":".","argv":["python3","tools/check_bim_guard.py"]}`.
1. Register parse at the review date: `{"cwd":".","argv":["python3","-I","-c","import sys,datetime; sys.path.insert(0,'tools'); import flow_metrics as f; t=open('docs/qa/FLAKY_TESTS.md',encoding='utf-8').read(); d=datetime.date(2026,11,24); print(f.flaky_age(t,d,{'E2','E3'})); print(f.flaky_age(t,d,set()))"]}`.
   Run it before and after. After the edit, the second printed dict must list E2/E3 under `older` or `within`, not
   `unknown`. In the first dict, `older`, `within` and `unknown` must stay empty unless an entry really became `open`
   (E8/E9, §3).
2. History of the register: `{"cwd":".","argv":["git","log","--follow","--reverse","--format=%h %cI %s","--","docs/qa/FLAKY_TESTS.md"]}`.
3-9. Earliest record per entry, one check each:
   `{"cwd":".","argv":["git","log","--reverse","--format=%h %cI %s","--name-only","-S","<term>","--","docs","openspec/changes",".github/workflows/ci.yml"]}`.
   Terms: E1 `starts a draft from a sealed version`; E2 `test_the_throughput_cost_of_a_short_switch_interval`; E3
   `test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool`; E4
   `test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load`; E5
   `test_healthz_stays_responsive_under_cpu_load_with_the_configured_interval`; E6
   `test_the_credential_of_another_tenant_cannot_stop_the_job`; E7 `P2 race`.
10. Fix commits of E4-E9 (the history of the files they changed): `{"cwd":".","argv":["git","log","--reverse","--format=%h %cI %s","--name-only","--","openbinding-gateway/tests/test_process_probe.py","openbinding-gateway/tests/test_engine_cancel_contract.py","openbinding-gateway/tests/analysis_b3_b4_b6/_helpers.py","bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_probe.py","bim-toolchain/packages/bim-service/tests/test_execution_in_the_pool.py"]}`.
    It uses no regex on purpose: alternation in `-G` depends on git's regex flavour.
11. Refs available for develop: `{"cwd":".","argv":["git","log","-n","80","--format=%h %cI %s","origin/develop"]}`.
    If `origin/develop` is not fetched in the worktree, the check fails with git's "unknown revision" error. The answer
    to Q2 then applies.

PR numbers and develop CI: `repo` `ci_status` with `args.sha` of the squash commit, and `ci_log` for the job of a red
run (the contract allows these to every role). Indices 0-11 match the gate's limit (`qa_run` 0..11).

## 5. Gates for S1

| Gate | S1 |
|---|---|
| G1 spec | n/a: docs-only, no delta spec (Q4). If the coordinator still opens a change, `openspec validate --strict` is `todo: true` (`project.yaml:34`), NOT EXECUTED locally, and CI `openspec` reports it |
| G2 EPIC | n/a without a change; with one, a spec-auditor on its proposal |
| G3 red-before | n/a: no test. Check 1 run before the edit serves as the baseline |
| G4 acceptance frozen | n/a: no visible behaviour |
| G5 green-after | check 1 after the edit (the format still parses, E2/E3 dated) and check 0 |
| G6 trace | n/a: no requirement and no code (`oft-trace` is `todo: true`, `project.yaml:62`) |
| G7 contracts | n/a: no API or schema |
| G8 mutation | n/a: no code |
| G9 quality | `changelog` check (`project.yaml:83`), run by the pr-steward after its final `chore(changelog)` commit (lesson 2) |
| G10 secrets/ownership | no R11 path and no `.github/**` write. Cite only SHAs, PR numbers, dates, job names and test names. No log excerpts with tokens, no personal data beyond the role "the project owner" already in the file |
| G11 review | low: reviewer. Focus: every date traces to a cited commit, every file:line resolves, and the column order and date prefix match F4 |
| G12 lab/UI | n/a: no runtime behaviour |
| G13 review package | n/a with `how_to_review`: read the register diff next to the git-log check outputs and check 1 before and after |

## 6. Feature flags

None (§4).

## 7. Open questions

No CRP is needed. Nothing here touches a public contract, R11, a threshold or an owner decision: E2/E3 keep their
classification and review date.

For the coordinator:
- **Q1: rule for "First seen" from git.** Recommended: keep the file's definition (F3). The date is the commit date, in
  UTC, of the earliest commit whose diff adds a record of the test failing or being flaky. That can be a report, a
  design table, the register, or the `ci.yml` deselect comment for E2/E3. The commit that adds the test itself does
  not count. A CI date found only through `ci_status` may replace it only if it is earlier and the steward cites the
  run. Alternative: count CI failures only. Not recommended, since for E7 the file says no CI failure is recorded
  (`FLAKY_TESTS.md:67`).
- **Q2: which history is authoritative for SHAs.** The register cites develop squash SHAs (`f2e18c6f`, `716f8d13`,
  `9273978d`, `5cf72550`). The worktree's own log holds supervisor commits named "Complete task <id>" (`42173d76`,
  `f96db981`). Recommended: cite develop SHAs when check 11 resolves `origin/develop`. Otherwise cite local SHAs, say so
  in "Verification limits", and get E8/E9's PR numbers from the pr-steward (`pr_get`/`pr_list` may not be open to a
  doc-steward).
- **Q3: register the checks of §4.1**, or equivalent ones. Without git checks, the slice ends where the previous
  update did (F2, F15).
- **Q4: no OpenSpec change.** Recommended: run it as a doc-steward task contract only, as the proposal suggests.

## 8. Followups (outside this scope)

- The proposal's claim that "no entry can be aged" holds only for E2/E3, and only once they are counted again (F5).
  When the 2026-11-24 review is prepared, run `flow_metrics.py` with `--not-counted ""` to show their age.
- E9 probe: the ladder takes one 503 as proof, without a margin (`FLAKY_TESTS.md:152-153`). It is already recorded
  there as a follow-up.
- A light rule for reviews: references into `openspec/changes/<id>/` break when the change is archived (F9). A
  doc-steward spec-drift audit could grep `docs/qa/` for `openspec/changes/` paths that no longer exist.
