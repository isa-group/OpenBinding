# Change: ci-speed

## Why

Owner request `own-3c723859ce6c4fb1a14b385d5a9cd0b9` (2026-10-26): reduce PR CI time and discover failures in the
lab, not on GitHub.

Baseline (owner's figures, last 100 PR runs of `ci.yml`): median 16.6 min, max 28 min, about 52 runner-minutes per
run, about 10 runs per merged PR. Three steps dominate: the mocked Playwright project 13.4 min (`frontend`), the
gateway unit tests 11.8 min plus 2.2 min to build and start services (`test`), and the bim-toolchain package tests
9.1 min (`bim-toolchain`). Every other step takes under 1.5 min. Facts and sources:
`docs/agent-work/ci-speed/intake.md`.

## What Changes

- A `changes` job decides per area (`e2e`, `bim`, `engines`, `gateway`) which heavy jobs a pull request needs;
  pushes to `develop`, manual runs and the nightly dispatch still run every job (CRP-2a).
- A single aggregate job, `ci-required`, becomes the only required check (CRP-1a); it fails on a failed, cancelled or
  wrongly skipped job.
- The mocked Playwright project runs in three shard jobs; the gateway unit tests run natively in two shard jobs
  (CRP-5a); the bim-toolchain tests run as one job per package (CRP-8a).
- A new commit on a pull request cancels the older run of that pull request; manual runs are never cancelled
  (CRP-3a).
- Every job has a `timeout-minutes` (today `engines`, `test` and `frontend` have none).

## Impact

- Capability: `gate-tooling` only. Modified: `req~ci-develop-push~2`, `req~ci-develop-push-concurrency~2`,
  `req~gate-tooling-bim-toolchain-tests~2`. Added: `req~ci-speed-change-detection~1`,
  `req~ci-speed-required-aggregate~1`, `req~ci-speed-e2e-shards~1`, `req~ci-speed-gateway-unit-shards~1`,
  `req~ci-speed-job-timeouts~1`.
- Code: `.github/workflows/ci.yml` (R10, needs a token with Workflows write, CRP-4), new `tools/ci_changes.py`,
  `tools/ci_required.py`, `tools/ci_shard.py`, the lab tests that pin the workflow (`lab/tests/test_ci_triggers.py`,
  `lab/tests/test_ci_gate_tooling.py`), `openbinding-gateway/tests/test_ci_starts_a_job_consumer.py`, and docs
  (`TESTING.md`, `AGENTS.md`).
- No API, schema, image, dependency or lockfile change. `nightly.yml` is unchanged.
- Owner action outside the repository: branch protection of `develop` and `main` requires `ci-required` only (CRP-1a).
- Risks: an area rule that is too narrow skips a job a change needs (mitigated by fail-safe rules, full runs on
  every push to `develop`, and a test that every repository path read by the gateway tests lies in the `gateway`
  area); a shard list that drops a test file (mitigated by the partition requirements).

## Out of scope

- Factory defaults in `.agentic/project.yaml` (slice S8, owner-only R11, CRP-6) and the lab baseline (slice S1).
- Draft pull requests: no workflow change (CRP-9a); the factory pushes once the lab gate is green.
- Docker layer cache (CRP-7a), pytest-xdist (CRP-5b), Playwright browser cache, `on.paths` filters, new third-party
  actions and self-hosted runners (design.md, ruled out).
- The other gate-tooling requirements (OpenSpec, trace, import-linter, ESLint boundaries, acceptance runners, nightly,
  goldens) keep their current text.
