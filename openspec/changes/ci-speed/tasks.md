# Tasks: ci-speed

`.github/workflows/ci.yml` is shared, so S3-S7 run in series. S2 and S5a can run in parallel. Workflow slices need a
token with Workflows write (CRP-4) and the high review panel (R10). Common checks (intake section 6): C0 `uv sync`,
C1 lab tests, C2 gateway CI-wiring tests, C3 YAML parse of `ci.yml`.

## S2 Change detection and aggregate scripts (implementer, medium)
- [x] 2.1 `tools/ci_changes.py --base --head --event`: areas `e2e`, `bim`, `engines`, `gateway`; prints
      `area=true|false`, appends to `$GITHUB_OUTPUT`; fail-safe rules (`req~ci-speed-change-detection~1`).
- [x] 2.2 `tools/ci_required.py` reads `NEEDS` (`req~ci-speed-required-aggregate~1`).
- [x] 2.3 `lab/tests/test_ci_changes.py`: changelog-only, unknown path, `ci.yml` change, `tools/ci_*.py` change, git
      error, push, dispatch; every `REPO_ROOT / "<dir>"` of `openbinding-gateway/tests` is in `gateway`; aggregator on
      failure, cancelled, failed `changes`, skipped-while-true.
- Files: `tools/ci_changes.py`, `tools/ci_required.py`, `lab/tests/test_ci_changes.py`. Checks: C0, red_before on
  the new test, C1, M7 area counts.

## S5a Shard script (implementer, low)
- [x] 5a.1 `tools/ci_shard.py --shard i/n [--root openbinding-gateway/tests] [--weights file]`, sorted output,
      balanced by file size in bytes; `--weights` takes measured durations when a file exists.
- [x] 5a.2 `lab/tests/test_ci_shard.py`: the shards partition the collected files
      (`req~ci-speed-gateway-unit-shards~1`).
- Files: `tools/ci_shard.py`, `lab/tests/test_ci_shard.py`. Checks: C0, red_before, C1.

## S3 `changes`, `ci-required`, timeouts (implementer + token, high)
- [x] 3.1 Job `changes` (`fetch-depth: 0`, `timeout-minutes: 5`) and job `ci-required` (`needs` all, `if: always()`).
- [x] 3.2 Job-level `if` on `bim-toolchain` (`bim`) and `engines` (`engines`).
- [x] 3.3 `timeout-minutes` 30 on `engines`, 45 on `test` and `frontend` (`req~ci-speed-job-timeouts~1`).
- [x] 3.4 Lab tests to `req~ci-develop-push~2`.
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_triggers.py`, `lab/tests/test_ci_gate_tooling.py`. Checks:
  C0, red_before, C1, C2, C3; GitHub: `ci-required` success, and a docs-only follow-up PR with `bim-toolchain` and
  `engines` skipped and `ci-required` success. Then the owner makes `ci-required` the only required check (CRP-1a).
- Depends on S2.

## S4 Playwright shards (implementer + token, high)
- [x] 4.1 Job `frontend-e2e` (`if` on `e2e`, `fail-fast: false`, matrix `shard: [1, 2, 3]`); mocked step leaves
      `frontend`; UI acceptance stays the last step of `frontend` (`req~ci-speed-e2e-shards~1`).
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py`. Checks: C0, C1, C3, the lab partition
  check of `--list --shard=i/3`, one timed shard run.
- Depends on S3 merged.

## S5 Gateway unit shards (implementer + token, high)
- [x] 5.1 Job `gateway-unit` (`if` on `gateway`, matrix `shard: [1, 2]`, native uv, `OPENBINDING_REPO_ROOT` set).
- [x] 5.2 Remove "Run unit tests" from `test`; keep integration, ICSOC, OpenAPI snapshot
      (`req~ci-speed-gateway-unit-shards~1`).
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py`,
  `openbinding-gateway/tests/test_ci_starts_a_job_consumer.py`. Checks: C0, C1, C2, C3, both shards in the lab
  (timeout 1800).
- Depends on S4 merged and S5a.

## S6 bim-toolchain per package (implementer + token, high)
- [x] 6.1 Matrix over `bim-core`, `bim-service`, `bim-client`; both `--deselect` options on `bim-service`; goldens
      in one job (`req~gate-tooling-bim-toolchain-tests~2`).
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_gate_tooling.py`. Checks: C0, C1, C3, B3.
- Depends on S5 merged.

## S7 PR concurrency (implementer + token, high)
- [x] 7.1 Concurrency group by pull request number, `cancel-in-progress` unless `workflow_dispatch`
      (`req~ci-develop-push-concurrency~2`).
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_triggers.py`. Checks: C0, C1, C3.
- Depends on S6 merged.

## S9 Docs (doc-steward, low)
- [x] 9.1 `TESTING.md` section 10: areas, `ci-required`, shards, concurrency, how to rerun a full CI by dispatch.
      `CONTRIBUTING.md` stays unchanged (CRP-9a).
- [ ] 9.2 The CI lines of `AGENTS.md`. Not done: AGENTS.md: follow-up, outside scope.
- GitHub evidence lines of S3 to S7 (`ci-required` success, docs-only follow-up PR, timed shard runs): not done;
  GitHub evidence: PR 64 run.
- Depends on S7.
