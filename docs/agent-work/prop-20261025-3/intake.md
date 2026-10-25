# Intake: P-20261025-3, turn `docs/qa/FLAKY_TESTS.md` into a dated flaky-test register

- Kind: docs, size S, owner-approved · Base: `task/3b3fc6c20c364d57` at `2bed6fbf`
- INTENT objective: **O6, platform reliability**. The target is "no flaky test older than 7 days" and its status is
  "not measured" (`INTENT.md:167`). INTENT names this file as the place to watch (`INTENT.md:209`).
- Rule this register must satisfy: "Flaky tests are quarantined only through `docs/qa/FLAKY_TESTS.md` with an owner
  and a deadline" (`TESTING.md:112`). The factory threshold is `flaky_quarantine_days: 7`, still marked
  "OPEN QUESTION" in `.agentic/project.yaml:102`.

## 1. Objective

Make the O6 flaky-test target measurable from one file. Each known flaky, quarantined (deselected) or recently fixed
test gets a dated row, so anyone can work out its age.

## 2. Inventory, checked against the code at `2bed6fbf`

| # | Test | Status at base | Evidence |
|---|---|---|---|
| E1 | `frontend/src/pages/Library/LibArtifact.test.tsx` · "starts a draft from a sealed version, keeping its content and links" | fixed (test waits for the selected tab) | `docs/qa/FLAKY_TESTS.md:3-34`. The file has no date and no PR for it |
| E2 | `bim-toolchain/packages/bim-service/tests/analysis/test_analysis_b8_evidence.py::test_the_throughput_cost_of_a_short_switch_interval` | deselected in the `bim-toolchain` CI job, because it is a timing ratio that depends on the runner's CPU (47.6 % against a 50 % bound) | `.github/workflows/ci.yml:100-110`; the test is at `test_analysis_b8_evidence.py:128`; why it was deselected and when to remove the deselect: `openspec/changes/m03-gate-tooling/design.md:248` |
| E3 | `.../test_analysis_b8_probe.py::test_healthz_stays_fast_while_cpu_bound_operations_fill_the_pool[thread]` | deselected in the same job: a strict xfail (open defect) that XPASSes on the runner | `ci.yml:100-110`; `test_analysis_b8_probe.py:213-214,232,263`; `design.md:248` |
| E4 | `.../test_analysis_b8_probe.py::test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load` | fixed in PR #43 (`f2e18c6f`): compared with a same-run baseline, `<= 1.5x`, skipped when the default median is `< 0.02 s` | `test_analysis_b8_probe.py:140,201-202`; `docs/agent-work/flaky-b8-probe/report.md:1-79` |
| E5 | `bim-toolchain/packages/bim-service/tests/test_execution_in_the_pool.py::test_healthz_stays_responsive_under_cpu_load_with_the_configured_interval` | fixed in PR #43, the same way (it had the same absolute bound) | `test_execution_in_the_pool.py:506,561-562`; `flaky-b8-probe/report.md:8-10,32-34` |
| E6 | `openbinding-gateway/tests/test_engine_cancel_contract.py::test_the_credential_of_another_tenant_cannot_stop_the_job_and_the_404_is_not_retried` | fixed in PR #42 (`716f8d13`), with regression test `test_a_slow_setup_behind_the_frozen_clock_still_gets_its_lost_attempt_cancelled` | `test_engine_cancel_contract.py:228,244-247`; `docs/agent-work/flaky-engine-cancel/report.md:1-70`; first recorded at `openspec/changes/m03-gate-tooling/design.md:249` |
| E7 | The six `frozen` + `lose_and_sweep` tests in `openbinding-gateway/tests/test_remote_cancel.py` (the "P2 race") | **already fixed** by PR #45 (`9273978d`). The proposal says "until it is fixed", and it has been fixed since. `lose_the_worker` reads `clock.utcnow()` | `tests/analysis_b3_b4_b6/_helpers.py:111-117`; regression test `test_remote_cancel.py:701`; `docs/agent-work/prop-20261025-2/report.md:1-26` |

Grep for `flaky|quarantin|intermittent` over the repository finds nothing else (the other hits are a Playwright stats
field in `frontend/e2e/live/summary.mjs:87`, a mock method named `flaky` in `bim-core/tests/test_neighborhood.py:291`,
and rules in `REVIEW.md:91`). The `--deselect` entries in `ci.yml:110` are the only ones, as `ci.yml:103` says.

Not in the inventory: E7 has no recorded CI failure in the repository (P-20261025-2 treated it as a latent race). The
register should say that rather than invent a first failure.

## 3. Scope

In scope (one file): `docs/qa/FLAKY_TESTS.md`.

- Add a heading block with a "Last reviewed: YYYY-MM-DD" line and one paragraph on how age is computed: an
  `open` or `deselected` entry is older than 7 days when today minus "First seen" is more than 7 (O6 target,
  `INTENT.md:167`).
- Add a register table, one row per entry E1-E7 (E7 can be one row for the six tests, and its ID can name the six
  test functions in the detail section). Columns: ID · test (path::name) · first seen (date) · status
  (`fixed` / `deselected` / `open`) · fixed or deselected by (PR and short SHA) · owner · deadline (required when
  the status is `deselected` or `open`, `TESTING.md:112`) · evidence (path or report).
- Definition of "first seen": the date of the earliest record **in the repository** (commit date of the report,
  design note or CI change that first names it). Earlier CI history is not available to the writer. The register
  says this in one line.
- Keep the existing E1 analysis (lines 3-34) as its detail section under the table, with its text unchanged. Add short
  detail sections for E2-E7 that link the reports above instead of copying them.
- E4/E5: note that the coordinator chose the `0.02 s` skip threshold and the owner still has to confirm it
  (`flaky-b8-probe/report.md:65-67`). Copy that as a fact; do not decide it.

Non-goals:

- Any code, test, CI or config change. In particular: removing the `--deselect` options (`ci.yml:110`), changing
  thresholds, or adding a CI job that checks the register's ages.
- `INTENT.md`, `TESTING.md`, `.agentic/**` (R11, `project.yaml:137-139`), `acceptance/**`, `openspec/specs/**`.
- The backlog items (ROADMAP M0.1 at `ROADMAP.md:47`; `PG_STAGE_AND_LICENSES.md:133` after PR #41) and the items
  the proposal skipped (PR #41 / M0.5).

## 4. Slices

One capability, so one slice. No feature flag: it is documentation only, nothing runs, and there is only one slice.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | Dated flaky-test register | doc-steward (or implementer), default model, low effort, about 20 turns | `docs/qa/FLAKY_TESTS.md` | `.github/workflows/ci.yml`, `TESTING.md`, `INTENT.md`, `.agentic/project.yaml`, the tests and reports cited in section 2, `openspec/changes/m03-gate-tooling/design.md` | about 60-120 lines added, 0-5 changed | **low**: one doc file, not in any risk-area glob (`project.yaml:105-139`); no behaviour | CRP-1 answer for the owner and deadline cells of E2/E3 (see section 7) |

Requirement ids: none (no behaviour, no OpenSpec requirement).

Proposed checks for S1 (none are registered yet; argv arrays, `cwd: .`). They are read-only and give the writer the
dates it would otherwise have to guess:

1. Dates of the existing entry and its fix:
   `["git","log","--format=%h %cs %s","--","docs/qa/FLAKY_TESTS.md","frontend/src/pages/Library/LibArtifact.test.tsx"]`
2. When the two deselects entered CI: `["git","log","--format=%h %cs %s","-S--deselect","--",".github/workflows/ci.yml"]`
3. When E4-E7 were first recorded:
   `["git","log","--diff-filter=A","--name-only","--format=%h %cs %s","--","openspec/changes/m03-gate-tooling/design.md","docs/agent-work/flaky-engine-cancel/report.md","docs/agent-work/flaky-b8-probe/report.md","docs/agent-work/prop-20261025-2/intake.md"]`
4. Merge dates of PR #42/#43/#45: `["git","log","--format=%h %cs %s","-n","10"]`
5. G9 stand-in: `["git","diff","--check"]`

Register 1-4 as evidence checks (they print dates and never fail on content). If a date cannot be read, the writer
puts `unknown (no record)` in the cell. It does not estimate one.

## 5. Gates for S1

| Gate | Applies | How |
|---|---|---|
| G1 spec | n/a unless the coordinator opens an OpenSpec change | docs-only; `openspec-validate` is `todo: true` (`project.yaml:34`) |
| G2 EPIC | n/a | no OpenSpec change |
| G3 red-before | n/a | no test is added or changed |
| G4 acceptance frozen | yes, trivially | `acceptance/**` is untouched |
| G5 green-after | n/a | no code; none of the G5 checks covers `docs/qa/**` (`project.yaml:43-60`) |
| G6 trace | n/a | no requirement; `oft-trace` is `todo: true` (`project.yaml:62`) |
| G7 contracts | n/a | no API or schema |
| G8 mutation | n/a | no code |
| G9 quality | partly | no Markdown lint is registered; proposed check 5 (`git diff --check`) |
| G10 secrets/ownership | yes | `docs/qa/FLAKY_TESTS.md` is outside the forbidden paths and R11 (`project.yaml:89-90,137-139`) |
| G11 review | yes | low panel = `[reviewer]` (`project.yaml:141-142`). The reviewer checks every row against the evidence in section 2 |
| G12 lab/UI | n/a | no runtime or UI change |
| G13 review package | n/a with a `how_to_review` | reading guide: the register table, then each detail section against its cited path |

## 6. Feature flags

None (one slice, documentation only).

## 7. Open questions

Needs a CRP:

- **CRP-1: owner and deadline of the two deselected B8 tests (E2, E3), and whether they count toward O6.**
  `TESTING.md:112` requires an owner and a deadline for every quarantine. The deselects have neither, and the removal
  condition is open-ended ("when the toolchain makes its B8 timing tests robust", `design.md:248`). If they count as
  flaky, O6's 7-day target fails as soon as the register is dated. Options:
  (a) quarantine: owner `@javiercavlop` or a named role, deadline = first seen + 7 days, counted in O6;
  (b) classify them as "environment-dependent measurement, deselected in this repo's CI only" (they still run in the
  toolchain's own CI, `ci.yml:102-103`), with an owner and a review date, not counted in O6;
  (c) quarantine with a longer deadline that the owner sets (e.g. 30 days), counted in O6;
  (d) open a fix task for the B8 timing tests now and use its target date as the deadline.
  Recommended: (b), because the tests measure the runner, not correctness (`ci.yml:100-102`). S1 can be written
  first, with these two cells set to `pending CRP-1`. Then the PR knowingly leaves a `TESTING.md:112` gap until the
  answer is in.

For the coordinator (no owner decision):

- Q1: should E7 be one row for the six tests or six rows? Recommended: one row, with the six functions in its detail
  section. They share one cause and one fix.
- Q2: should the threshold mismatch go to the owner as a followup? `project.yaml:102` cites "INTENT O4" for the
  7-day quarantine, while the target is in O6 (`INTENT.md:167`). It is outside this scope (R11).
