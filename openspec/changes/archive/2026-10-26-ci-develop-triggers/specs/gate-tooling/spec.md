## ADDED Requirements

### Requirement: CI runs on pushes to develop
WHEN a commit is pushed to `develop`, THE CI workflow SHALL run all its jobs on that commit.

`req~ci-develop-push~1`

Evidence: lab/tests/test_ci_triggers.py::test_ci_runs_on_push_to_develop and ::test_triggers_leave_permissions_and_pull_request_unchanged

#### Scenario: A push to develop
- **GIVEN** `.github/workflows/ci.yml`
- **WHEN** its `on:` block is parsed
- **THEN** it has a `push` trigger with `branches` `[develop]` and no `paths` filter
- **AND** no job has an `if:` condition that skips it on a `push` event

#### Scenario: Existing triggers and permissions stay
- **GIVEN** `ci.yml` with the new triggers
- **WHEN** it is parsed
- **THEN** the `pull_request` trigger still has `branches` `[main, develop]` and no `paths` filter
- **AND** the top-level `permissions` are exactly `contents: read`
- **AND** the `on:` block has no `schedule` trigger

### Requirement: A newer develop push cancels only the older push run
WHEN a newer push to `develop` starts CI, THE workflow SHALL cancel the older in-progress push run, and SHALL NOT cancel pull-request or manual runs.

`req~ci-develop-push-concurrency~1`

Evidence: lab/tests/test_ci_triggers.py::test_push_concurrency_cancels_only_push_runs

#### Scenario: The concurrency block
- **GIVEN** `ci.yml`
- **WHEN** its top-level `concurrency` block is read
- **THEN** `group` is `ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.ref || github.run_id }}`
- **AND** `cancel-in-progress` is `${{ github.event_name == 'push' }}`
- **AND** pull-request and manual runs get a group of their own by run id, so they are never queued or cancelled

#### Scenario: Two merges land close together
- **GIVEN** a push run on `develop` head A is in progress
- **WHEN** a push of head B to `develop` starts CI
- **THEN** the run on head A is cancelled and head B gets the result
- **AND** a pull-request run or a manual run in progress at that time keeps running

### Requirement: Manual CI run
WHEN a maintainer starts the CI workflow by hand, THE workflow SHALL run all its jobs on the chosen ref with `contents: read` permission only and no user-supplied input.

`req~ci-develop-dispatch~1`

Evidence: lab/tests/test_ci_triggers.py::test_ci_can_be_dispatched_manually (the trigger has no inputs and no job declares its own permissions)

#### Scenario: The dispatch trigger
- **GIVEN** `ci.yml`
- **WHEN** its `on:` block is parsed
- **THEN** it has a `workflow_dispatch` trigger with no `inputs`
- **AND** no job declares its own `permissions`, so the top-level `contents: read` applies

### Requirement: The changelog check runs on pull requests only
WHEN CI runs on a push or a manual dispatch, THE frontend job SHALL skip the generated-changelog check and SHALL run it on every pull request.

`req~ci-develop-changelog-pr-only~1`

Evidence: lab/tests/test_ci_triggers.py::test_changelog_check_runs_only_on_pull_requests

#### Scenario: The changelog step condition
- **GIVEN** `ci.yml`
- **WHEN** the `frontend` job is read
- **THEN** the step running `tools/generate_changelog.py --check` has `if: github.event_name == 'pull_request'`
- **AND** no other step has an `event_name` condition
