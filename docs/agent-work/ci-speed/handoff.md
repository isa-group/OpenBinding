# Handoff: ci-speed
- Status: waiting-review (intake done; owner decisions pending) · Updated: 2026-10-26T00:00:00Z
- Branch / head: task/38915e07f2c8456b / base 46068015 · PR: none

## Goal
Cut PR CI wall time and runner-minutes without losing coverage on `develop`, and make the lab find failures before
GitHub does (owner request `own-3c723859ce6c4fb1a14b385d5a9cd0b9`).

## State (with evidence)
- Intake written: `docs/agent-work/ci-speed/intake.md` (facts with file:line from `.github/workflows/ci.yml`,
  `.github/workflows/nightly.yml`, `.agentic/project.yaml`, the lab tests that pin the workflow, lab durations on record,
  and six lookups with sources).
- No workflow, code, spec or factory file was changed. No check was registered for this task, so none was run.
- Baseline (before): the owner's figures for the last 100 runs: median 16.6 min, max 28 min, about 52 runner-min per
  run, about 10 runs per merged PR; Playwright mocked 13.4 min, unit tests 11.8 + 2.2 min, bim-toolchain 9.1 min.

## Decisions
- Change detection is a repository script in a `changes` job, not `on.paths` and not a new action. Reasons:
  `paths`-skipped workflows leave required checks Pending (lookup L2); the lab tests allow only five actions
  (`lab/tests/test_ci_gate_tooling.py:40-46,245-248`).
- One aggregating required check, `ci-required`. Reason: a job skipped by `if` reports Success, but matrix and renamed
  jobs change check names (lookup L2). Needs CRP-1.
- Area rules fail safe. An unknown path, a change to `ci.yml` or to `tools/ci_*.py`, or any push or dispatch event
  runs every job. Reason: no loss of coverage on `develop` (`req~ci-develop-push~1`).
- The changelog JSON does not trigger the e2e shards. Reason: every PR changes it (`CONTRIBUTING.md:36-38`).
- The gateway area covers almost the whole repository. Reason: the gateway tests read `frontend/`, `docs/`,
  `.github/`, the compose files, `tools/` and more (intake 1.3).
- Gateway unit tests move first to native 2-shard jobs, then possibly to xdist. Reason: no lockfile change. Locking
  needs PyPI, which is listed under `forbidden_remote_calls` (`.agentic/project.yaml:176`). The bim-service B8 tests
  are timing-sensitive (`ci.yml:108-113`).
- No self-hosted runners: public repository (owner rule).

## Ruled out
- `dorny/paths-filter`, `actions/cache`, `docker/*` actions: refused by `test_ci_gate_tooling.py:245-248` today, and they
  add supply-chain risk (R10).
- Caching Playwright browsers: the Playwright docs advise against it, and OS dependencies cannot be cached (lookup L3).
- Docker `type=gha` cache from a plain `run:` step: it needs the runtime token exposed by an action (lookup L4). CRP-7
  recommends no.
- Splitting the gateway suite with xdist first: dependency and lockfile change (CRP-5b).

## Open questions and risks
- CRP-1 to CRP-9 (intake section 7): required checks, PR-only skipping, cancelling PR runs, the Workflows-write token,
  gateway parallelism, factory defaults (R11), Docker cache, bim-toolchain per package, drafts. Waiting on the owner
  via CRP.
- Precondition for S0: `openspec/specs/` has no `gate-tooling` capability. The requirements to revise live in the open
  changes `ci-develop-triggers`, `ci-develop-nightly` and `m03-gate-tooling`. These must be archived first, or S0 adds
  new requirements instead of MODIFIED ones. Waiting on the coordinator.
- Drift today between factory defaults and CI (intake 1.4): `bim-corpus` `--expected 82` against CI's 83; a
  different bim-toolchain test set; `pnpm test:e2e` also runs the `live` project; `node20` against Node 22. Until
  CRP-6 is settled, the lab can pass or fail differently from GitHub.
- Risk: a skipped job could have failed, which shows up only on the push run of `develop`. Mitigation: conservative
  areas, unknown path means run everything, a test that maps every `REPO_ROOT` read of the gateway tests to its area
  (S2), and the fast lane for a red `develop` (`CONTRIBUTING.md:58-60`).
- Risk: the full gateway suite already needs the maximum check timeout of 1800 s. If it grows, the lab gate splits it
  into two checks (`a-m` / `n-z`).
- The savings in intake section 5 are estimates. S1 (lab) and M1 to M7 (GitHub) replace them.

## Next three steps
1. Coordinator: send CRP-1 to CRP-9 to the owner (intake section 7). Plan the archive of `ci-develop-triggers`,
   `ci-develop-nightly` and `m03-gate-tooling` before S0.
2. Start S1 (lab baseline, checks B0 to B5 in intake section 6). Start S0 (spec `ci-speed`) once the archive is done.
   S2 and S5a (scripts plus lab tests, no token) can then run in parallel.
3. After CRP-1, CRP-2 and CRP-4: run S3, S4, S5, S6 and S7 in that order, one at a time (all own `ci.yml`). After each
   merge, record M1 to M5 over the next 30 PR runs. Factory items F1 to F4 (intake section 3) go to the coordinator.

## Evidence
- Tasks: 38915e07f2c8456b (this intake; no checks registered) · Head: 46068015 · CI: none run by this task.
- Lookups L1 to L6 with sources: intake section 8.
