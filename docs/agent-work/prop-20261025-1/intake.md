# Intake: P-20261025-1, run CI on pushes to `develop` and on a nightly schedule

- Kind: reliability, size S, owner-approved, not auto-start (it edits `.github/`) · Base: `task/bb0801c0ace749f8` at `2bed6fbf`
- INTENT objective: **O6, platform reliability**. `INTENT.md:167` sets the target "`develop` CI green on ≥ 95 % of
  days; no flaky test older than 7 days" and says "not measured". `INTENT.md:209` lists "CI and nightly gate
  failures" as a signal the factory must watch.
- Proposal: P-20261025-1 (the proposal text the coordinator gave this task).

## 1. Objective

Give `develop` its own CI result: one run for each push to `develop`, and one run each night. Then O6 can be
measured per day, and timing-sensitive tests fail on `develop` before they block an unrelated PR.

## 2. Facts checked against the code at `2bed6fbf`

| Fact | Evidence |
|---|---|
| `ci.yml` triggers only on `pull_request` into `main` and `develop`. It has no `push`, `schedule`, `workflow_dispatch` or `concurrency` key | `.github/workflows/ci.yml:3-5` (grep for `concurrency\|schedule\|cron\|workflow_dispatch` over the repo finds no workflow hit) |
| Top-level permissions are `contents: read`, and no job reads a secret (the `test` job generates its own throwaway JWT secret and admin password) | `ci.yml:7-8,268-291` |
| The workflow has 8 jobs, each with its own `actions/checkout@v4` step | `ci.yml:22,79,126,166,193,229,266,345` |
| Nothing in the jobs is specific to PRs. The ICSOC step uses `git ls-remote origin`, and the changelog check uses `fetch-depth: 0`, so both also work on `push` | `ci.yml:299-306,345-347,372-373`; grep for `GITHUB_BASE_REF\|GITHUB_HEAD_REF\|github.event` finds no use in `ci.yml` |
| A static test parses `ci.yml` and requires a `pull_request` trigger with no `paths` filter. Adding other triggers keeps it green | `lab/tests/test_ci_gate_tooling.py:424-427`; requirement `req~gate-tooling-bim-toolchain-tests~1`, `openspec/changes/m03-gate-tooling/specs/gate-tooling/spec.md:195-208` |
| The same test file allows only five actions in `ci.yml` | `lab/tests/test_ci_gate_tooling.py:40-46,248` |
| G1 (`openspec-validate`) and G6 (`oft-trace`) stay `todo: true` "until a CI run into develop exits 0". Today no CI run into `develop` exists at all | `.agentic/project.yaml:34-36,62-64` |
| `.github/**` is risk area **R10, high**, and "the highest-risk area touched sets the PR risk level". `.github/` is also owner-reviewed through CODEOWNERS | `REVIEW.md:23,27`; `.agentic/project.yaml:134-136`; `.github/CODEOWNERS:16` |
| The integration branch is `develop`, and only the owner merges into `main` | `.agentic/project.yaml:12-13`; `INTENT.md:205` |
| The default branch of `isa-group/OpenBinding` is **`main`** | lookup, high confidence: `https://api.github.com/repos/isa-group/OpenBinding` (`default_branch`) |
| GitHub: "Scheduled workflows run on the latest commit on the default branch", using the default branch's copy of the workflow. Runs can be delayed at the start of each hour and dropped under high load. In a public repository they are disabled after 60 days with no repository activity | lookup, high confidence: `https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule` |
| GitHub: a `workflow_dispatch` event always creates a run, even when the GITHUB_TOKEN sends it. The token needs `actions: write` (medium confidence: the helper did not quote this point) | lookup: `https://docs.github.com/en/actions/concepts/security/github_token`, `https://docs.github.com/en/rest/actions/workflows` |
| `github.ref` is `refs/pull/<n>/merge` for `pull_request` and `refs/heads/develop` for a push to `develop`. `github.head_ref` is set only for PR events | lookup: `https://docs.github.com/en/actions/reference/workflows-and-actions/contexts` |

Two findings change the proposal:

1. **A `schedule` in `ci.yml` does not do what the proposal says.** On a schedule event GitHub uses `main`'s
   copy of `ci.yml` and checks out `main`, not `develop`. The schedule would only start working after a release to
   `main`, and even then it would test `main`. It would test `develop` only if every checkout were changed, and then
   `main`'s job definitions would run against `develop`'s code. The nightly design is therefore an owner decision
   (section 7, CRP-1).
2. **The risk is high, not low.** The proposal says low, but `.github/**` is R10 high (`REVIEW.md:23,27`).
   Under the rules the panel is `[reviewer, test-reviewer, security-auditor, arch-reviewer]`
   (`.agentic/project.yaml:145`), plus owner review through CODEOWNERS. Only the owner can lower that
   (`REVIEW.md:102-106`, CRP-2).

The proposal also expects the nightly run to surface "the two B8 tests". It will not: `ci.yml:100-110`
deselects both, and `test_ci_gate_tooling.py:411-440` pins that deselection. A nightly run does surface
gateway-suite races like the engine-cancel one (PR #42), because the `test` job runs the full gateway suite
(`ci.yml:316-331`).

## 3. Scope

In scope:

- `ci.yml` also runs on `push` to `develop`. It gets a `concurrency` group so that a newer push to `develop`
  cancels the older run, while PR runs and the nightly run each keep their own group.
- One result per night for `develop`, built the way CRP-1 decides.
- A static test in `lab/tests/` for each new trigger, written in the style of `test_ci_gate_tooling.py`, plus one
  requirement for each new trigger in an OpenSpec change. `REVIEW.md:87` blocks behaviour that has no requirement.

Non-goals:

- Changing any job, step, action version, timeout, permission of `ci.yml` jobs or the B8 deselection.
- Pinning actions to SHAs (that is a separate supply-chain item).
- Factory-side code that reads the `develop` runs to compute O6. That lives in the factory, not in this repository.
  A followup for the coordinator.
- `push` on `main`. Releases are PRs into `main` (`INTENT.md:205`), and those PRs already run CI.
- `bim-toolchain/.github/workflows/ci.yml`. It belongs to the future repository and does not run here
  (its header, lines 1-15).
- `acceptance/**`, `openspec/specs/**`, `.agentic/**` (including moving G1/G6 out of `todo`, which is R11), and
  `docs/qa/FLAKY_TESTS.md`.

## 4. Slices

Each slice has one capability. They run one after the other, not in parallel, because S2 needs S1's
`workflow_dispatch` trigger under option B.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | CI runs on every push to `develop`; a newer push cancels the older run | implementer, default model and effort, about 25 turns; test-designer first for the static test if the coordinator wants acceptance-style G3 | `.github/workflows/ci.yml` (only the `on:` block and a new top-level `concurrency:` block, lines 3-8 area), `lab/tests/test_ci_triggers.py` (new) | `lab/tests/test_ci_gate_tooling.py` (helpers and the pull_request assertion), `openspec/changes/m03-gate-tooling/**`, `REVIEW.md`, `.agentic/project.yaml` | about 10 lines of YAML + 50-70 lines of test | **high**: R10 `.github/**` (`REVIEW.md:23,27`). The content risk is small: it adds triggers only, permissions stay `contents: read`, and no secret is used | the OpenSpec change (requirement ids) |
| S2 | One CI result for `develop` every night | implementer, default, about 25 turns | depends on CRP-1. Option B (recommended): `.github/workflows/nightly.yml` (new), `lab/tests/test_ci_nightly.py` (new). Option A: `.github/workflows/ci.yml` (`on:` + 8 checkout steps) and `lab/tests/test_ci_nightly.py` | as S1, plus S1's merged `ci.yml` | B: about 25 lines of YAML + 40-60 lines of test. A: about 30 lines of YAML + 60 lines of test | **high**: R10. Option B adds a job with `permissions: actions: write`, so the security-auditor must check it | S1 merged into `develop`; CRP-1 answered |

S1 design, for the contract (the implementer may refine it):

```yaml
on:
  pull_request:
    branches: [ main, develop ]
  push:
    branches: [ develop ]
  workflow_dispatch:

concurrency:
  group: ci-${{ github.event_name }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'push' }}
```

- The `pull_request` block stays byte-identical, so `test_ci_gate_tooling.py:424-427` keeps passing.
- `workflow_dispatch` goes in S1 so the files of S1 and S2 stay disjoint under option B. It adds no permission,
  and it lets the owner re-run `develop` by hand after a red run. If CRP-1 picks A or C, S1 can leave it out
  (coordinator Q2).
- With `event_name` in the group key, a push to `develop` never cancels a nightly or manual run, and a PR run is
  never grouped with a `develop` run. Cancelling only push runs keeps today's PR behaviour (coordinator Q1).
- Consequence: when two merges land close together, the older `develop` head gets a *cancelled* run instead of a
  result. O6 is measured per day, so the latest run of the day decides the day. The factory event "no CI checks
  reported for this head" can still appear for a superseded head.

S2 option B design: `nightly.yml` on `schedule` (a cron at an off-hour minute, e.g. `17 3 * * *` UTC, to avoid
the start-of-hour delays), with `permissions: {actions: write}` and one step `gh workflow run ci.yml --ref
develop` (`GH_TOKEN: ${{ github.token }}`, no third-party action). Because the dispatch goes to `develop`, the run
uses `develop`'s own `ci.yml` on `develop`'s code. It needs no checkout. **It only starts firing once `nightly.yml`
reaches `main` through a release PR that the owner merges.**

Requirement ids (proposed for the coordinator's OpenSpec change; they extend capability `gate-tooling`, which
exists only as the unarchived change `openspec/changes/m03-gate-tooling`, and `openspec/specs/gate-tooling/` does
not exist):

- `req~ci-develop-push~1`: WHEN a commit is pushed to `develop`, THE CI workflow SHALL run all its jobs on that commit.
- `req~ci-develop-push-concurrency~1`: WHEN a newer push to `develop` starts CI, THE workflow SHALL cancel the
  older in-progress push run, and SHALL NOT cancel pull-request, scheduled or manual runs.
- `req~ci-develop-nightly~1`: WHEN the nightly time is reached, THE CI workflow SHALL run on the head of `develop`
  (the exact wording depends on CRP-1).

Proposed checks (argv arrays, `cwd: openbinding-gateway`, the same as `lab-static` at `.agentic/project.yaml:49`):

- S1 red-before (G3), on the base with only the new test applied:
  `["uv","run","--locked","--extra","test","pytest","../lab/tests/test_ci_triggers.py"]`. Expected: it fails on
  the missing `push` trigger and `concurrency` key.
- S1 green: the same argv, then the regression
  `["uv","run","--locked","--extra","test","pytest","../lab/tests/test_ci_gate_tooling.py"]`, then the full
  `lab-static` `["uv","run","--locked","--extra","test","pytest","../lab/tests"]`.
- S2: the same three argv arrays with `../lab/tests/test_ci_nightly.py`.
- No registered check proves that GitHub accepts the YAML. No actionlint is in `.agentic/project.yaml`. The proof
  is the PR's own CI run (an invalid workflow reports no checks) and, after the merge, the first `push` run on
  `develop`. pr-steward should report both runs.

## 5. Gates per slice

| Gate | S1 | S2 |
|---|---|---|
| G1 spec | yes, the OpenSpec change. `openspec-validate` is `todo: true` (`project.yaml:34-36`), so it is NOT EXECUTED in the runner. CI runs it report-only (`ci.yml:181-183`) | same |
| G2 EPIC | yes, spec-auditor on the change | same |
| G3 red-before | yes, `test_ci_triggers.py` fails on the base | yes, `test_ci_nightly.py` fails on the base |
| G4 acceptance frozen | trivially: `acceptance/**` is untouched (if test-designer writes an acceptance test instead, it is frozen after review) | same |
| G5 green-after | `lab-static` (`project.yaml:49`) | same |
| G6 trace | `[utest->req~ci-develop-push~1]` and `[utest->req~ci-develop-push-concurrency~1]` tags in the test. `oft-trace` is `todo: true` (`project.yaml:62-64`), so it is NOT EXECUTED. CI runs it report-only, but over paths that leave out `lab/tests` (`ci.yml:216`), so these tags are not traced there either | same, `req~ci-develop-nightly~1` |
| G7 contracts | n/a: no API or schema | n/a |
| G8 mutation | n/a: no production code. All entries are `todo: true` (`project.yaml:71-74`) | n/a |
| G9 quality | `ruff-gateway` does not cover `lab/tests`. No YAML lint is registered. The PR's CI run is the workflow-syntax evidence | same |
| G10 secrets/ownership | yes: no secret is added. `.github/` is owner-reviewed (CODEOWNERS:16). `gitleaks` is `todo: true` | yes: the security-auditor checks the `actions: write` scope (option B) |
| G11 review | high panel `[reviewer, test-reviewer, security-auditor, arch-reviewer]` (`project.yaml:145`) unless the owner lowers it (CRP-2); owner review through CODEOWNERS | same |
| G12 lab/UI | n/a: no runtime or UI change | n/a |
| G13 review package | n/a, with a `how_to_review`: the trigger diff, the static test output, and the link to the PR's own CI run. After the merge, the first `develop` push run | n/a, with a `how_to_review`. It must say that the nightly starts only after a release to `main` |

## 6. Feature flags

None. CI configuration is not a runtime feature, and S1 is useful on its own. Under option B, S2 is latent by
construction: `nightly.yml` does nothing until it reaches `main`, and that release acts as the switch. Under
option A no flag is needed either.

## 7. Open questions

Questions that need a CRP (owner):

- **CRP-1: how should the nightly `develop` result be built?** Evidence: section 2, finding 1.
  - A. `schedule` in `ci.yml`, with every checkout set to `develop` on schedule events. It edits 8 steps. `main`'s
    job definitions run against `develop`'s code, and it works only after a release.
  - B. (recommended) a small `nightly.yml` that dispatches `ci.yml` on `develop` with `actions: write`. `develop`'s
    workflow tests `develop`'s code. It works only after a release.
  - C. No nightly: S1 only. A day without a push to `develop` has no result, so O6 counts only days with merges.
  - D. A nightly run of `main` instead of `develop`. It measures the release branch, not O6 as written.
- **CRP-2: the risk level.** The proposal says low, but `REVIEW.md:23,27` makes any `.github/**` change high. Options:
  keep high with the full panel (the default), or have the owner lower S1 to medium/low with a recorded override
  (`REVIEW.md:102-106`).

For the coordinator (no owner decision needed):

- Q1: should PR runs also cancel their superseded runs (`cancel-in-progress: true` for everything)? That saves
  runner minutes, but it changes what pr-steward sees today. Recommended: push runs only, as in the proposal.
- Q2: should `workflow_dispatch` go in S1 (recommended under option B, so the file ownership stays disjoint) or in S2?
- Q3: which OpenSpec change should carry the three requirements? A new change `ci-develop-runs`, or a delta on the
  unarchived `m03-gate-tooling`. Recommended: a new change, so m03 does not grow.
- Followup (factory, outside the repository): once develop runs exist, compute the O6 daily metric from them. The
  owner may then consider moving G1/G6 out of `todo` (`project.yaml:36,64`, R11).
