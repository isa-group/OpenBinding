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
  group: ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.ref || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'push' }}
```

- The `pull_request` block stays byte-identical, so `test_ci_gate_tooling.py` keeps passing.
- `event_name` in the key: a `develop` push never cancels a manual run, and a PR run is never grouped with a
  `develop` run.
- Only push runs share a group (`refs/heads/develop`) and cancel in progress. PR and manual runs get a group of their
  own by `run_id`, so they behave exactly as before: never queued, never cancelled.
- Why not a branch-keyed group for every event: GitHub runs one workflow per group and queues the others, and it
  cancels a waiting run when a newer one is queued. A shared group would therefore queue PR and manual runs one at a
  time and cancel waiting ones, and same-named head branches of different PRs would collide.
- Consequences:
  - When two merges land close together, the superseded `develop` head gets a cancelled run, not a result, and it may
    show no checks at all.
  - A day is decided by its last completed `develop` run (O6 is per day).
  - The factory/O6 consumer should skip cancelled `develop` runs.
  - The later nightly dispatch gets its own group (by run id), so it is never queued behind manual runs.

## Changelog check

The `frontend` step `Check generated changelog` (`tools/generate_changelog.py --check`) gets
`if: github.event_name == 'pull_request'`. The changelog JSON is regenerated on the PR branch by a final
`chore(changelog)` commit, so it can never contain the squash title that lands on `develop`; a push run would always
be stale. It is the only step with an `event_name` condition; no job has a job-level `if`.

## Why no `schedule` here

GitHub runs scheduled workflows from the default branch (`main`), with `main`'s copy of `ci.yml` and `main`'s code.
A `schedule` in `ci.yml` would test `main`, and only after a release. The nightly run is a later change.

## Verification

- Static test `lab/tests/test_ci_triggers.py`, red on the base, green after; plus the full `lab/tests` suite.
- The PR's own CI run (an invalid workflow reports no checks); after the merge, the first push run on `develop`.
- No actionlint or YAML lint is registered.
