# Intake: P-20261025-2, remove the frozen-clock lease race in `test_remote_cancel.py`

- Kind: maintenance (flaky test), size S, auto-approved · Base: `task/9e84f479839b454a` at `f2e18c6f`
- INTENT objective: **O6, platform reliability** (`INTENT.md`). It stops spurious red runs on gateway PRs.
- Owner request / proposal: P-20261025-2. Earlier reports of the same followup: debugger task `c560d374322a4d9b`,
  reviewer task `969d1bcd074042b6`, and `docs/agent-work/flaky-engine-cancel/report.md:72-78` (PR #42).

## 1. Objective

Make `lose_the_worker` write the lease with the same clock the reconciler sweep reads. Then a test that
freezes time can never see a "lapsed" lease that looks live because setup was slow.

## 2. The race, checked against the code at `f2e18c6f`

| Step | Clock used | Evidence |
|---|---|---|
| `frozen` fixture replaces `jobs.clock.utcnow` with a clock fixed at fixture setup, `T0` | frozen | `openbinding-gateway/tests/test_remote_cancel.py:158-162` |
| `lose_and_sweep` = `lose_the_worker` then `reconciler.sweep_abandoned` | n/a | `test_remote_cancel.py:179-182` |
| `lose_the_worker` sets `lease_until = utcnow() - 1 s`, with `utcnow` imported from `db.models` (so it is the real clock and the patch does not reach it) | **real** | `tests/analysis_b3_b4_b6/_helpers.py:22,111-116`; `db/models.py:48-50` |
| `sweep_abandoned` takes `now = clock.read_now(session)`, which on SQLite is `jobs.clock.utcnow()` (the frozen one) | frozen | `src/openbinding_gateway/jobs/reconciler.py:245`; `jobs/clock.py:27-29,71-80` |
| A lease counts as live while `lease_until > now`, and then the job is skipped (`continue`) | n/a | `reconciler.py:266-268` |

When real time minus `T0` is more than 1 s at the moment `lose_the_worker` runs, the job is not requeued, no attempt
is marked lost, and the assertions that come after it fail. The six `test_remote_cancel.py` tests that combine
`frozen` with `lose_and_sweep` are the ones that start at lines 678, 701, 719, 756, 781 and 797 (their
`lose_and_sweep` calls are at :684, :707, :727, :763, :787 and :804).

`jobs/clock.py:11-13` documents `jobs.clock.utcnow` as "the one thing a test replaces to freeze or move time".
So the helper should read that clock. A wider margin would only hide the race.

Other callers of the shared helper (verified by grep):

- `tests/analysis_b3_b4_b6/test_analysis_b3_lease_loss.py:93,113`: these do not freeze the clock. Without the patch
  `jobs.clock.utcnow()` returns `db.models.utcnow()` (`clock.py:27-29`), so their behaviour does not change.
- `tests/test_engine_cancel_contract.py:31,37,168-183`: PR #42 added a workaround in `lost_attempt`
  (`frozen.now = max(frozen.now, utcnow())`). Its comment at :176-178 and the regression docstring at :259-261 say
  that `lose_the_worker` uses the real clock. After the fix the workaround is redundant: the lease
  becomes `frozen.now - 1 s`, which has already lapsed for a sweep at `frozen.now`, and moving `frozen.now` forward
  keeps it lapsed. It stays correct, but the comments become wrong.
- Not affected: `tests/test_job_leases.py:73-78` has a separate `lose_the_worker` of its own. Its callers (:514,
  :522) do not freeze the clock. No PostgreSQL test calls the shared helper (grep over `openbinding-gateway/`).

## 3. Scope

In scope:

- `_helpers.py`: `lose_the_worker` takes its time from `jobs.clock.utcnow()`. The helper must look up
  `clock.utcnow` when it is called (`from openbinding_gateway.jobs import clock`, then `clock.utcnow()`).
  `from ...jobs.clock import utcnow` would bind the function at import time and miss the monkeypatch.
  The docstring says that the lease follows the controlled clock.
- `test_remote_cancel.py`: one regression test. It moves the frozen clock back (`frozen.advance(-5)`, as
  `test_engine_cancel_contract.py:264` does) between `claim_and_record` and `lose_and_sweep`, then asserts that
  the lost attempt is marked and cancelled. It fails on the base commit and passes after the fix (G3).
- `test_engine_cancel_contract.py`: remove the PR #42 workaround so `lost_attempt` always calls
  `lose_and_sweep`, and fix the comments and the docstring that describe the real-clock stamp. The regression test
  at :256-272 stays and now covers the helper fix directly. (A smaller option is to change only the comments.
  That is the coordinator's choice, see section 7.)

Non-goals:

- Production code (`src/**`), contracts, OpenAPI, schemas, dependencies, `.agentic/`, `.github/`, `acceptance/**`,
  `openspec/specs/**`.
- `tests/test_job_leases.py`'s own `lose_the_worker` (no frozen caller, so no race).
- Making `a_job`'s `created_at` (`_helpers.py:103`) follow the controlled clock. The RUNNING branch with a lease
  (`reconciler.py:266-272`) never reads `created_at`.
- A wall-clock `sleep` after fixture setup, as the proposal suggests. Moving the frozen clock back gives the same
  distance between the two clocks, deterministically and without adding wall time (decision D2).

## 4. Slices

One capability and one slice. No feature flag: test-only, nothing user-visible, a single slice.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | The lease of a lost worker follows the controlled clock | debugger (or implementer), default model and effort, about 30 turns | `openbinding-gateway/tests/analysis_b3_b4_b6/_helpers.py`, `openbinding-gateway/tests/test_remote_cancel.py`, `openbinding-gateway/tests/test_engine_cancel_contract.py` | `openbinding-gateway/src/openbinding_gateway/jobs/{clock,reconciler,leases}.py`, `db/models.py`, `tests/analysis_b3_b4_b6/test_analysis_b3_lease_loss.py`, `docs/agent-work/flaky-engine-cancel/report.md` | about 30-50 lines (all under `tests/`) | **low**: test files only, none in a risk-area glob (`.agentic/project.yaml:105-139`; R5 covers `src/.../jobs/**`, not tests) | none |

Requirement ids: none. The change adds no behaviour and no test here carries an OFT tag (grep for `utest->` /
`impl->` in the three files and `analysis_b3_b4_b6/` finds nothing).

Proposed checks for S1 (argv arrays, `cwd: openbinding-gateway`):

1. red-before, on the base commit with only the new regression test applied:
   `["uv","run","--locked","--extra","test","pytest","tests/test_remote_cancel.py","-k","<new test name>"]`
   (expected: 1 failed, with an assertion on the attempt state or the deletes)
2. targeted green:
   `["uv","run","--locked","--extra","test","pytest","tests/test_remote_cancel.py","tests/test_engine_cancel_contract.py","tests/analysis_b3_b4_b6"]`
3. lint: `["uv","run","--locked","--extra","test","ruff","check","src","tests"]` (G9 `ruff-gateway`,
   `.agentic/project.yaml:76`)
4. full suite: `["uv","run","--locked","--extra","test","pytest"]` (G5 `gateway-unit`, `project.yaml:44`).
   An earlier handoff says it timed out in the sandbox (`docs/agent-work/panel-27-followups/handoff.md:3`); if that
   happens, CI is the evidence.

`gateway-postgres` (`project.yaml:46`) does not apply: its `when_paths` cover `src/.../{jobs,db,repositories}/**`
only.

## 5. Gates for S1

| Gate | Applies | How |
|---|---|---|
| G1 spec | only if the coordinator opens an OpenSpec change | `openspec validate --strict`. Marked `todo: true` (`project.yaml:34-36`), so NOT EXECUTED in the runner; CI runs it report-only |
| G2 EPIC | only with an OpenSpec change | spec-auditor; a maintenance change with no requirements is mostly not applicable |
| G3 red-before | yes | check 1: the new regression test fails on the base |
| G4 acceptance frozen | yes, trivially | `acceptance/**` is untouched |
| G5 green-after | yes | checks 2 and 4 |
| G6 trace | n/a | no requirement; `oft-trace` is `todo: true` (`project.yaml:62-64`) |
| G7 contracts | n/a | no API or schema change |
| G8 mutation | n/a | no production code; all G8 entries are `todo: true` (`project.yaml:71-74`) |
| G9 quality | yes | check 3 |
| G10 secrets/ownership | yes | the owned files are outside the forbidden paths and R11 (`project.yaml:87-90,137-139`); `gitleaks` is `todo: true` |
| G11 review | yes | low panel = `[reviewer]` (`project.yaml:141-142`) |
| G12 lab/UI | n/a | no runtime or UI change |
| G13 review package | n/a, with a `how_to_review` | test-only PR. The reading guide covers the clock table in section 2, the helper diff, and the red-before/green output |

## 6. Feature flags

None (one slice, test-only).

## 7. Open questions

Questions that need a CRP: **none**. The proposal's auto-start conditions hold: no public API, schema, dependency,
risk-area, `.agentic/`, `.github/`, constitution or INTENT change.

For the coordinator (no owner decision needed):

- Q1: should S1 remove the PR #42 workaround in `test_engine_cancel_contract.py:173-182` (recommended), or only fix
  its comments? Both keep that file's tests green. Removing it leaves one mechanism instead of two.
- Q2: should this test-only maintenance fix get an OpenSpec change (G1/G2), or go as a plain task contract?
  Living specs are not touched either way.
