# Design: ci-develop-nightly

## The workflow

```yaml
on:
  schedule:
    - cron: '17 3 * * *'

permissions:
  actions: write

jobs:
  dispatch-ci:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: write
    steps:
      - name: Dispatch CI on develop
        run: gh workflow run ci.yml --ref develop
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
```

- The dispatch goes to `ref: develop`, so the run uses `develop`'s own `ci.yml` on `develop`'s code. The nightly
  workflow itself runs from `main`'s copy but never checks out code, so `main`'s content is not tested by mistake.
- `actions: write` is the permission a token needs to create a `workflow_dispatch` event. It grants no `contents`
  access, and because a `permissions` block lists every scope, all other scopes are `none`.
- The minute 17 avoids the start-of-hour delays of scheduled runs.
- No `${{ }}` expression is in the `run` line, so there is no injection surface. The only expression sets `GH_TOKEN`
  to the token GitHub issues to the run, and the repository name. `GH_REPO` is needed because without a checkout
  `gh` finds no git remote to take the repository from.
- No third-party action, no checkout and no secret. The `gh` CLI is preinstalled on `ubuntu-latest`.
- The trigger is `schedule` only: no `push`, `pull_request`, `pull_request_target` or `workflow_dispatch`. The target
  is fixed to `ci.yml` and `develop`, with no inputs.

## Latency and limits

- **It starts only after `nightly.yml` reaches `main`.** GitHub runs schedules from the default branch, so the file is
  inert on `develop` until the owner merges a release PR.
- Scheduled runs can be delayed, especially at the start of each hour, and can be dropped under high load.
- In a public repository, schedules are disabled after 60 days without repository activity.
- The dispatched run is a `workflow_dispatch` run of `ci.yml`. It is in its own concurrency group by run id
  (`ci-develop-triggers`), so it is never cancelled by a push to `develop` and never queued behind manual runs.
- A dispatch made with the workflow token creates a run (GitHub documents this exception to the rule that token events
  do not start workflows).

## Verification

- Static test `lab/tests/test_ci_nightly.py`, red on the base (no file), green after; plus the full `lab/tests`
  suite and `test_ci_gate_tooling.py`.
- No actionlint is registered. After the release PR merges, the first scheduled run and the dispatched `ci.yml` run are
  the proof that GitHub accepts the workflow.
