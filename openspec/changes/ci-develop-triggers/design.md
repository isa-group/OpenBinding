# Design: ci-develop-triggers

## Triggers and concurrency

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

- The `pull_request` block stays byte-identical, so `test_ci_gate_tooling.py` keeps passing.
- `event_name` in the key: a `develop` push never cancels a manual run, and a PR run is never grouped with a
  `develop` run. `head_ref` is set only for PRs; otherwise `ref` (`refs/heads/develop`) is used.
- Only push runs cancel in progress, so PR runs behave as today.
- Consequence: when two merges land close together, the superseded `develop` head gets a cancelled run, not a
  result. O6 is per day, so the latest run of the day decides it.

## Why no `schedule` here

GitHub runs scheduled workflows from the default branch (`main`), with `main`'s copy of `ci.yml` and `main`'s code.
A `schedule` in `ci.yml` would test `main`, and only after a release. The nightly run is a later change.

## Verification

- Static test `lab/tests/test_ci_triggers.py`, red on the base, green after; plus the full `lab/tests` suite.
- The PR's own CI run (an invalid workflow reports no checks); after the merge, the first push run on `develop`.
- No actionlint or YAML lint is registered.
