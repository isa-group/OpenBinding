# Intake: P-20261102-3, measure O6 (develop CI green days) and O7 (median change size, ready-to-merge lag)

- Kind: dx, size S, owner-approved · Base: `task/48bc1923a4fd4541` at `5b4c68a6`
- INTENT objectives: **O6, Platform reliability**: "`develop` CI green on ≥ 95 % of days; no flaky test older than
  7 days", today "not measured" (`INTENT.md:167`). **O7, Delivery flow**: "median change ≤ 300 diff lines, merged into
  `develop` the day it is ready; every UI/runtime change previewed", today "not measured" (`INTENT.md:168`).

## 1. Objective

A read-only, stdlib-only command-line tool, `tools/flow_metrics.py`, reads the CI runs on `develop` and the PRs merged
into `develop` over a date window from the GitHub REST API. It writes `docs/qa/FLOW_METRICS.md`, a dated page with:
- O6: green days / days with runs, and the flaky-register entries older than 7 days (from `docs/qa/FLAKY_TESTS.md`);
- O7: median diff lines per merged PR and median hours from ready-for-review to merge, plus the share merged the same
  day.

## 2. Evidence checked against the code at `5b4c68a6`

| # | Fact | Evidence |
|---|---|---|
| F1 | O6 and O7 are "not measured" | `INTENT.md:167-168` |
| F2 | CI runs on pushes to `develop` and on `workflow_dispatch`. Older push runs on the same ref are cancelled | `.github/workflows/ci.yml:3-8,12-14` |
| F3 | **The nightly fires only once `nightly.yml` is on `main`** ("it starts after the owner merges a release PR"). It dispatches `ci.yml` on `develop` as a `workflow_dispatch` run. Whether `main` has the file yet is not verifiable from this worktree | `.github/workflows/nightly.yml:3-8,14-16,29` |
| F4 | `github.token` is used only inside the nightly workflow. No tool in `tools/`, `lab/` or `.github/` reads a GitHub token or calls `api.github.com` | `nightly.yml:31`; grep of `GITHUB_TOKEN\|GH_TOKEN\|api.github.com` over those trees |
| F5 | No green-day or diff-size measurement exists. The only size figure is the PR template's manual field "~N diff lines (excluding tests/generated)" | `.github/pull_request_template.md:8`; grep over `tools/`, `.github/`, `docs/qa/`, `lab/` |
| F6 | **The size limit excludes tests as well as generated files**: `change_size_limit_lines: 300 # excluding tests and generated files`. The generated paths are listed | `.agentic/project.yaml:14,25-30` |
| F7 | No register entry can be aged yet: "Until the 'First seen' dates are filled from git history, no entry can be aged". E1-E7 read "unknown (no record)"; only E8 and E9 have dates, and both are fixed | `docs/qa/FLAKY_TESTS.md:16-26,31-32` |
| F8 | E2 and E3 (deselected) are not counted toward O6, by the owner's decision `crp-flaky-b8-classification` | `FLAKY_TESTS.md:28-31` |
| F9 | Tests, seeds and the lab use synthetic data only | `INTENT.md:197`; `.agentic/project.yaml:174-175`; `REVIEW.md:54` (no network in unit tests) |
| F10 | Tests of root `tools/*.py` live in `lab/tests/` and run the script with `sys.executable` | `lab/tests/test_ci_shard.py:1-19`; `lab/tests/test_ci_changes.py` |
| F11 | `lab/tests` runs in CI job `lab` and through the registered gate `lab-static` | `ci.yml:191-217`; `.agentic/project.yaml:49` |
| F12 | A changed `tools/` file runs the gateway area, and a `tools/ci_*.py` name runs every area. A name containing `bim` also runs the bim area | `tools/ci_changes.py:58-59,78` |
| F13 | `tools/`, `lab/tests/` and `docs/qa/` match no risk glob, so they are R0 (low). `.github/**` is R10 (high) | `REVIEW.md:14-25,27` |
| F14 | The architecture test flags `urllib.request` only when the file also names a SPACE or SPHERE target, so a GitHub-only client passes | `lab/tests/test_no_direct_space_http.py:1-7,42-55` |
| F15 | The repository is `isa-group/OpenBinding` | `.agentic/project.yaml:11` |
| F16 | Requirements for CI tooling live in capability `gate-tooling` | `openspec/specs/gate-tooling/spec.md`; `openspec/changes/archive/2026-10-26-ci-develop-nightly/specs/gate-tooling/spec.md` |

External facts (lookup, GitHub REST documentation; not checked against a live response):
- The PR object has no ready-for-review time, only `draft`, `created_at`, `updated_at`, `closed_at` and `merged_at`.
  The time is the `ready_for_review` event of `GET /repos/{o}/{r}/issues/{n}/events` (also in `.../timeline`).
  Sources: docs.github.com/en/rest/using-the-rest-api/issue-event-types, /en/rest/issues/events, /en/rest/pulls/pulls.
  Confidence: high.
- `GET /repos/{o}/{r}/actions/workflows/{id}/runs` accepts `branch`, `event`, `status`, `created` (date range) and
  `per_page` (max 100), and returns at most 1,000 results per filtered search. Unauthenticated requests: 60 per hour per
  IP; `GITHUB_TOKEN` in Actions: 1,000 per hour per repository. Sources: docs.github.com/en/rest/actions/workflow-runs,
  /en/rest/using-the-rest-api/rate-limits-for-the-rest-api. Confidence: medium.

### Deviations from the proposal

1. **"Recorded API responses" become synthetic, API-shaped fixtures** (F9). Real responses carry real logins and
   would be data in Git. Fixtures keep only the fields the tool reads, with synthetic logins and SHAs.
2. **"The existing CI token" exists only inside a workflow run** (F4). This proposal adds no workflow (`.github/**` is
   R10, high, F13), so the token or network source of the first real run is CRP-1.
3. **"Excluding generated files" also excludes tests** in the project's own definition (F6). The tool reports both
   figures (CRP-3).
4. **"Nightly since P-20261025-1" is not established** (F3). Until the nightly fires, days with runs are days with
   pushes. The page reports run counts per event so the owner sees this.

## 3. Scope

In scope:
- `tools/flow_metrics.py`: a command-line tool (stdlib only, Python 3.11) with read-only `GET` calls to
  `https://api.github.com` only. It follows `Link` pagination only to that host and takes the token from `GH_TOKEN` or
  `GITHUB_TOKEN` when set. It never prints the token or writes it to the page. Arguments: `--repo` (default
  `isa-group/OpenBinding`), `--since`/`--until` (UTC dates; default the 30 days ending yesterday), `--flaky`
  (default `docs/qa/FLAKY_TESTS.md`), `--not-counted` (register ids left out of O6, see Q4), `--output`.
- O6 green days: `ci.yml` runs on `develop` with event `push` or `workflow_dispatch`, grouped by UTC day of
  `created_at`. Cancelled and skipped runs are ignored. A day is green when its last completed, not-cancelled run
  concluded `success` (CRP-2). The page shows green days / days with runs, the percentage, days without runs, and run
  counts per event.
- O6 flaky age: rows of the register table whose Status starts with `open` or `deselected`, minus `--not-counted`.
  Each row is classified as older than 7 days, within 7 days, or "unknown date" (F7). The page lists the ids per
  class.
- O7 size: per PR merged into `develop` in the window, additions plus deletions from `GET .../pulls/{n}/files`. Two
  figures: excluding the `generated_paths` of `project.yaml:25-30`, and excluding those plus test paths (F6, CRP-3).
  The medians and the share of PRs at or under 300 lines are reported.
- O7 lag: ready time = the last `ready_for_review` event before `merged_at`, or `created_at` for a PR that was never a
  draft. The page shows the median hours to merge and the share merged on the same UTC day.
- `docs/qa/FLOW_METRICS.md`: the dated page with window, repository, base SHA, the figures and a short "how to
  regenerate" line. It holds PR numbers and counts only, with no logins and no raw responses.
- Unit tests in `lab/tests/` on synthetic fixtures, with no network: the HTTP layer is injected or monkeypatched.

Non-goals:
- Any workflow, schedule or CI step that runs the tool (`.github/**`, R10). That is a separate proposal if CRP-1 picks
  it.
- O7's third clause, "every UI/runtime change previewed" (not in the proposal).
- Editing `INTENT.md` "Today" cells (R11, the owner's) or `docs/qa/FLAKY_TESTS.md`, including filling the "First
  seen" dates (F7).
- Runtime code, OpenAPI, schemas, `acceptance/**`, `openspec/specs/**`, new dependencies.
- The backlog items of the proposal (`ZipPeekDialog`, live e2e specs, the O3 tolerance) and anything owned by
  m26-navigation.

## 4. Slices

Order: S1 → S2 → S3, one after the other (S1 and S2 edit the same file, so they cannot run in parallel). No feature
flag: the tool runs only when invoked, nothing in CI or at runtime calls it, and the page appears only in S3. A merged
S1 is complete on its own: its page prints O7 as "not measured yet". The OpenSpec change adds requirements to
capability `gate-tooling` (F16). Suggested ids: `req~flow-metrics-green-days~1`, `req~flow-metrics-flaky-age~1`,
`req~flow-metrics-change-size~1`, `req~flow-metrics-ready-lag~1`, `req~flow-metrics-page~1`,
`req~flow-metrics-read-only~1` (GET only, pinned host, token never output).

| # | Slice | Role · model/effort · turns | Owned files | Read-only context | Est. diff (non-test) | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | `flow-metrics-o6`: HTTP client (GET, pagination, token), O6 green days and flaky age, page renderer with an O6 section | implementer, default model, medium effort, about 40 turns | `tools/flow_metrics.py`, `lab/tests/test_flow_metrics_o6.py`, `lab/tests/fixtures/flow_metrics/o6/**` | F2-F4, F7-F12, F14; `ci.yml`, `nightly.yml`, `FLAKY_TESTS.md`, `lab/tests/test_ci_shard.py` | about 180-220 lines | **low** (R0, F13). Review focus: token handling and host pinning | OpenSpec change of S1 validated (G1); CRP-2 answered or default accepted |
| S2 | `flow-metrics-o7`: merged PRs, files, events, both size medians, ready lag, O7 section | implementer, default model, medium effort, about 40 turns | `tools/flow_metrics.py` (after S1 merges), `lab/tests/test_flow_metrics_o7.py`, `lab/tests/fixtures/flow_metrics/o7/**` | S1 code; F6; `project.yaml:14,25-30`; the PR-object and events facts in §2 | about 130-170 lines | **low** (R0) | S1 merged; CRP-3 answered or default accepted |
| S3 | `flow-metrics-first-page`: run the tool once over the agreed window and commit `docs/qa/FLOW_METRICS.md` | per CRP-1: doc-steward committing the owner's run (A), or implementer with a registered network check (B); about 15 turns | `docs/qa/FLOW_METRICS.md` | S1-S2 code; `FLAKY_TESTS.md` | about 40-70 lines (one generated page) | **low** (R0, docs) | S2 merged; CRP-1 answered |

Name rules for S1 (F12): the tool must not be named `ci_*.py` (that would run every CI area) and must not contain
`bim` in its name.

### Proposed checks (none are registered for this proposal)

`cwd` is given per check. `GW` = `openbinding-gateway`.

S1 (for S2, replace `o6` with `o7`):
1. G3 red-before: `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","pytest","../lab/tests/test_flow_metrics_o6.py"],"type":"red_before","expect_exit":[1]}`.
   For S1 it fails because the tool is missing. For S2 it fails on the O7 assertions against S1's tool.
2. Targeted green-after: the same argv as a plain check.
3. G5 `lab-static` (`project.yaml:49`): `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","pytest","../lab/tests"]}`.
   It also runs `test_no_direct_space_http.py` (F14).
4. Stdlib-only proof: `{"cwd":".","argv":["python3","-I","tools/flow_metrics.py","--help"]}`, outside the gateway venv.
5. G9 lint: `{"cwd":"GW","argv":["uv","run","--locked","--extra","test","ruff","check","../tools/flow_metrics.py","../lab/tests/test_flow_metrics_o6.py"]}`.
   Whether the gateway's ruff config applies to `../` paths is not verified here. If it does not, the check still
   lints with ruff's defaults.
6. `bim-guard` (`project.yaml:52`; lesson 1): `{"cwd":".","argv":["python3","tools/check_bim_guard.py"]}`.
7. `changelog` (`project.yaml:83`; lesson 2): `{"cwd":".","argv":["python3","tools/generate_changelog.py","--check"]}`.
   Run it only after the pr-steward's final `chore(changelog)` commit.

S3: checks 6 and 7. If CRP-1 picks B, add the registered network run,
`{"cwd":".","argv":["python3","-I","tools/flow_metrics.py","--since","<date>","--until","<date>","--output","docs/qa/FLOW_METRICS.md"]}`.
It needs a read-only token in the check environment.

## 5. Gates per slice

| Gate | S1 | S2 | S3 |
|---|---|---|---|
| G1 spec | `openspec validate <id> --strict`. It is `todo: true` (`project.yaml:34`), so it is NOT EXECUTED locally; CI job `openspec` reports it | same | n/a (no requirement change) |
| G2 EPIC | spec-auditor on the change | same change | n/a |
| G3 red-before | check 1 | check 1 (O7 tests fail against S1) | n/a (generated docs) |
| G4 acceptance frozen | no `acceptance/**` | same | same |
| G5 green-after | checks 2-4, then PR CI (`lab` job) | same | n/a |
| G6 trace | `[utest->req~flow-metrics-…~1]` tags in the tests. `oft-trace` is `todo: true` (`project.yaml:62`), and the CI `trace` paths leave out `lab/tests` and `tools` (`ci.yml:289`), so the tags are not traced. State that in the MRP | same | n/a |
| G7 contracts | n/a: no API or schema. The GitHub API is consumed, not exposed | same | n/a |
| G8 mutation | n/a: no mutation tool for root `tools/` (`project.yaml:71-74`) | same | n/a |
| G9 quality | checks 4-5, 7 | same | check 7 |
| G10 secrets/ownership | token only from the environment and never echoed. Synthetic fixtures (F9). No R11 path | same | the page holds counts and PR numbers only, with no logins or tokens |
| G11 review | low: reviewer (`REVIEW.md:33`). Focus: GET only, host pinned on pagination, token never in output, no network in tests | low: reviewer. Focus: medians, the ready-time rule, generated and test globs | low: reviewer. The figures should match the linked runs and PR list |
| G12 lab/UI | n/a: no runtime or UI | n/a | n/a |
| G13 review package | n/a with `how_to_review`: read `--help`, then the test table of synthetic days against the green-day rule | n/a with `how_to_review` | n/a with `how_to_review`: the page next to the Actions run list filtered on `develop` for the same window |

## 6. Feature flags

None. The tool runs only when invoked (§4).

## 7. Open questions

Need a CRP (owner):
- **CRP-1: who runs the tool for real, and with which token.** Evidence: F3, F4, rate limits in §2.
  A (recommended): the owner or the pr-steward runs it with a read-only fine-grained token and opens the page by a
  normal PR. B: a registered lab check with network access and a token, which is a policy and capacity change.
  C: a scheduled workflow that publishes the page as an artifact, which is R10 (high) and a new proposal.
  D: unauthenticated runs (60 requests per hour). That is likely too few: one request per PR for files plus one for
  events, so about two per PR plus the run pages.
- **CRP-2: what a "green day" is.** Evidence: F2, F3. Recommended default: UTC days. The runs are `ci.yml` on
  `develop` (push and `workflow_dispatch`), with cancelled and skipped runs ignored. A day is green when its last
  completed run concluded `success`. Days without runs are left out of the denominator and shown apart. Alternatives:
  every run of the day green; or carry the previous day's state into a day without runs.
- **CRP-3: which size counts for O7.** Evidence: F6 against the proposal's "excluding generated files". Recommended:
  show both, with the `project.yaml:14` definition (tests and generated excluded) as the headline. Test globs:
  `**/tests/**`, `**/test_*.py`, `**/*.test.{ts,tsx}`, `**/*.spec.ts`, `frontend/e2e/**`, `acceptance/**`.
  Also open: whether `docs/agent-work/**` (handoffs, intakes) counts toward size.

For the coordinator (no CRP):
- **Q4: how E2 and E3 are left out of O6 (F8).** Recommended: the `--not-counted E2,E3` argument, with the page citing
  `crp-flaky-b8-classification`. The other options, hard-coding the ids or adding a column to `FLAKY_TESTS.md`, put an
  owner decision into code or widen the scope.
- **Q5: default window.** Recommended: 30 days ending yesterday (UTC). INTENT gives no window.
- **Q6: one OpenSpec change for S1-S2, or one each.** Recommended: one change, `flow-metrics`, with all six
  requirements, and S1 and S2 as its tasks.

## 8. Followups (outside this scope)

- Fill the "First seen" dates of E1-E7 from git history (`FLAKY_TESTS.md:31-32`). Until then the flaky half of O6
  reports "unknown date" for those ids.
- After S3, the owner may update the "Today" cells of `INTENT.md:167-168` (R11).
- If CRP-1 picks C, a separate proposal for a workflow (R10, high).
