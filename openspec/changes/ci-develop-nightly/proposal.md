# Change: ci-develop-nightly

## Why

INTENT O6, platform reliability (`INTENT.md:167`): "`develop` CI green on ≥ 95 % of days", today "not measured".
The change `ci-develop-triggers` makes CI run on every push to `develop`, but a day without a merge has no result.
GitHub runs `schedule` from the default branch `main`, so a `schedule` in `ci.yml` would test `main`. The owner chose
a separate `nightly.yml` that dispatches `ci.yml` on `develop` (proposal P-20261025-1, slice S2, option B).

## What Changes

- A new workflow `.github/workflows/nightly.yml`: trigger `schedule` with one cron entry (`17 3 * * *`, UTC), one job
  with one step `gh workflow run ci.yml --ref develop`. The step env is `GH_TOKEN` (the workflow token) and `GH_REPO`
  (there is no checkout, so `gh` needs the repository named).
- Permissions: `actions: write` only, at the top level and on the job. No checkout, no third-party action, no secret.
- A static test, `lab/tests/test_ci_nightly.py` (new).

## Impact

- Capability: `gate-tooling` (still the unarchived change `m03-gate-tooling`), 2 ADDED requirements.
- Files: `.github/workflows/nightly.yml` (new), `lab/tests/test_ci_nightly.py` (new).
- Risk: high by path (R10 `.github/**`, `REVIEW.md:23,27`). Small in content: the one permission is `actions: write`,
  which the security-auditor must check.
- Latency: the nightly starts only after `nightly.yml` reaches `main` through a release PR that the owner merges
  (design.md).

## Out of scope

- `ci.yml` is unchanged; it already has `workflow_dispatch` from `ci-develop-triggers`.
- Pinning actions to SHAs (the workflow uses no action).
- The factory-side code that reads the `develop` runs to compute O6.
- `push` on `main`; moving G1/G6 out of `todo` (R11, owner).
