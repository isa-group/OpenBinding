# Change: ci-develop-triggers

## Why

INTENT O6, platform reliability (`INTENT.md:167`): "`develop` CI green on ≥ 95 % of days; no flaky test older than
7 days", today "not measured". `ci.yml` runs only on pull requests into `main` and `develop`, so `develop` has no CI
result of its own. G1 and G6 also stay `todo: true` "until a CI run into develop exits 0"
(`.agentic/project.yaml:34-36,62-64`), and no such run exists yet.

## What Changes

- The `on:` block of `.github/workflows/ci.yml` gets `push` to `develop` and `workflow_dispatch`.
- A new top-level `concurrency` block: a newer push to `develop` cancels the older push run only.
- Nothing else in `ci.yml` changes: jobs, steps, actions, timeouts, permissions and the `pull_request` trigger stay.

## Impact

- Capability: `gate-tooling` (still the unarchived change `m03-gate-tooling`), 3 ADDED requirements.
- Files: `.github/workflows/ci.yml`, `lab/tests/test_ci_triggers.py` (new).
- Risk: high by path (R10 `.github/**`, `REVIEW.md:23,27`). Small in content: triggers only, no secret, permissions
  stay `contents: read`.

## Out of scope

- The nightly `develop` run: a separate later change, a `nightly.yml` that dispatches `ci.yml` on `develop`, because
  GitHub runs `schedule` from the default branch `main` (design.md).
- Pinning actions to SHAs; `push` on `main`.
- Moving G1/G6 out of `todo` (R11, owner); the factory-side O6 metric.
