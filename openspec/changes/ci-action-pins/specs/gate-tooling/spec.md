## MODIFIED Requirements

### Requirement: Exact versions and no new actions
THE gate tooling jobs SHALL name an exact version for every package or file a step installs or downloads, setup actions taking at most a runtime major such as Node `22` or Java `21`, and THE workflows in `.github/workflows/` at the repository root SHALL reference no action other than `actions/checkout` (major `v4`), `actions/setup-python` (`v5`), `astral-sh/setup-uv` (`v6`), `actions/setup-java` (`v4`) and `actions/setup-node` (`v4`), each `uses:` naming the action at a 40-character lower-case hexadecimal commit SHA followed on the same line by the comment `# v<major>.<minor>.<patch>` of the release whose tag resolves to that commit, with that action's major and one SHA and comment per action across the workflows.

`req~gate-tooling-pinned-steps~2`

Evidence (planned, slice S1): lab/tests/test_ci_action_pins.py, and lab/tests/test_ci_gate_tooling.py::test_gate_jobs_pin_versions_and_add_no_actions comparing action names

#### Scenario: Pinned installs
- **GIVEN** jobs `openspec` and `trace`
- **WHEN** their `run` steps are read
- **THEN** every `npm install` names `<package>@<major>.<minor>.<patch>` and every download URL names `4.11.0`

#### Scenario: No new action
- **GIVEN** every `.yml` and `.yaml` file of `.github/workflows/` at the repository root
- **WHEN** every step-level and job-level `uses:` value is collected and cut at `@`
- **THEN** the set of action names equals `actions/checkout`, `actions/setup-python`, `astral-sh/setup-uv`, `actions/setup-java` and `actions/setup-node`, or is a subset of them

#### Scenario: A pinned step
- **GIVEN** `.github/workflows/ci.yml`
- **WHEN** each line holding a `uses:` key is read
- **THEN** its value matches `<owner>/<action>@` followed by exactly 40 characters of `0-9a-f`
- **AND** the line ends with a comment `# v<major>.<minor>.<patch>` whose major is the one listed above for that action, for example `# v4.4.0` after `actions/checkout@<sha>`

#### Scenario: A tag or a short SHA is refused
- **GIVEN** a workflow step `uses: actions/checkout@v4`, or `uses: actions/checkout@11d5960`, or a 40-character SHA written in upper case
- **WHEN** the pin rule checks it
- **THEN** it is refused

#### Scenario: A missing or wrong release comment is refused
- **GIVEN** a step `uses: actions/setup-node@<40-hex sha>` with no trailing comment, or with the comment `# v5.0.0`
- **WHEN** the pin rule checks it
- **THEN** it is refused, because the comment is absent or its major is not `v4`

#### Scenario: Two pins of one action are refused
- **GIVEN** two steps of the root workflows that use `actions/setup-node` at two different SHAs, or at one SHA with two different release comments
- **WHEN** the pin rule checks the workflows
- **THEN** it is refused

#### Scenario: The SHA is the commit of the release in the comment
- **GIVEN** a step `uses: <owner>/<action>@<sha> # v<x>.<y>.<z>`
- **WHEN** a reviewer resolves tag `v<x>.<y>.<z>` of `<owner>/<action>` on GitHub to its commit, dereferencing an annotated tag object
- **THEN** the commit equals `<sha>`

## ADDED Requirements

### Requirement: Checkout credentials only where remote git runs
THE CI workflow SHALL set `persist-credentials: false` under `with:` of the `actions/checkout` step of every job, except a job that is `gateway-unit` or `test` and also runs `git ls-remote` or `git fetch` against `origin` after its checkout.

`req~gate-tooling-checkout-credentials~1`

Evidence (planned, slice S2): lab/tests/test_ci_gate_tooling.py::test_workflow_is_hardened, extended to every job

#### Scenario: Jobs without remote git
- **GIVEN** `.github/workflows/ci.yml`
- **WHEN** the checkout steps of `changes`, `ci-required`, `bim-corpus`, `bim-toolchain`, `lab`, `openspec`, `trace`, `engines`, `frontend` and `frontend-e2e` are read
- **THEN** each one has `persist-credentials` set to the boolean `false`

#### Scenario: A new job
- **GIVEN** a pull request that adds a job `docs-lint` whose checkout has no `persist-credentials` key, with or without a `git fetch origin` step
- **WHEN** the lab static tests run
- **THEN** the credential test fails and names `docs-lint`

#### Scenario: The two jobs that fetch from origin
- **GIVEN** jobs `gateway-unit` and `test` of `ci.yml`
- **WHEN** their steps are read
- **THEN** each one has a `run` step with `git ls-remote` and `git fetch` against `origin`, so its checkout may keep the credential

#### Scenario: An excepted job stops fetching
- **GIVEN** a pull request that removes the `git ls-remote` and `git fetch` lines from job `test`
- **WHEN** the lab static tests run
- **THEN** the credential test fails and names `test`, so the exception is dropped and its checkout sets `persist-credentials: false`
