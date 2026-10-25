## ADDED Requirements

### Requirement: Nightly CI dispatch on develop
WHEN the nightly time is reached, THE nightly workflow SHALL dispatch the CI workflow on the head of `develop`, with `actions: write` as its only permission, no checkout, no third-party action and no secret.

`req~ci-develop-nightly~1`

Evidence: lab/tests/test_ci_nightly.py::test_nightly_triggers_only_on_a_schedule, ::test_nightly_has_one_off_hour_cron, ::test_nightly_permissions_are_actions_write_only, ::test_nightly_is_one_job_with_one_gh_step_and_no_actions_or_secrets and ::test_nightly_run_line_has_no_expression_and_no_checkout

#### Scenario: The schedule
- **GIVEN** `.github/workflows/nightly.yml`
- **WHEN** its `on:` block is parsed
- **THEN** it has exactly one `schedule` entry with the cron expression `17 3 * * *` (5 fields, minute neither 0 nor 30)
- **AND** the job has `timeout-minutes` 5

#### Scenario: The permissions and the step
- **GIVEN** `nightly.yml`
- **WHEN** it is parsed
- **THEN** the top-level `permissions` and the `permissions` of every job are exactly `actions: write`
- **AND** there is one job with one step, whose `run` is `gh workflow run ci.yml --ref develop` and whose `env` is exactly `GH_TOKEN: ${{ github.token }}` and `GH_REPO: ${{ github.repository }}` (no checkout, so `gh` needs the repository named)
- **AND** the workflow has no `uses` key, no checkout and no `secrets.` reference
- **AND** the `run` line has no `${{` expression

### Requirement: The nightly workflow dispatches ci.yml on develop only
THE nightly workflow SHALL dispatch `ci.yml` on `develop` only, and SHALL NOT trigger on any event other than `schedule`.

`req~ci-develop-nightly-develop-only~1`

Evidence: lab/tests/test_ci_nightly.py::test_nightly_triggers_only_on_a_schedule, ::test_nightly_dispatches_ci_on_develop_only and ::test_ci_can_be_dispatched_and_has_no_schedule

#### Scenario: The triggers
- **GIVEN** `nightly.yml`
- **WHEN** its `on:` block is parsed
- **THEN** the only trigger is `schedule`
- **AND** there is no `push`, `pull_request`, `pull_request_target` or `workflow_dispatch` trigger

#### Scenario: The dispatch target
- **GIVEN** the `run` line of `nightly.yml`
- **WHEN** it is read
- **THEN** it targets `ci.yml` with `--ref develop`, with no `main`, no `github.ref`, no inputs and no `-f` or `-F` flag
- **AND** `ci.yml` has a `workflow_dispatch` trigger, so it can be dispatched, and no `schedule` trigger
