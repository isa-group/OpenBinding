## ADDED Requirements

### Requirement: Compose config in CI
`req~lab-deployment-compose-config-in-ci~1`
WHEN the CI pipeline runs, the CI SHALL run `docker compose config --quiet` for `docker-compose.yml` with the profile `dev`, for `deploy/compose/production/compose.yaml` with `--env-file deploy/compose/production/images.env --env-file deploy/compose/production/ci.env`, and for every `compose.lab*.json` at the repository root, in a job whose failure on any of these files fails the required aggregate check `ci-required`.

Needs: impl, utest

#### Scenario: Current files render
- **GIVEN** the repository at the head of the slice that adds the job
- **WHEN** the CI pipeline runs on a pull request into `develop`
- **THEN** the job runs `docker compose config --quiet` for `docker-compose.yml` with `--profile dev`, for `deploy/compose/production/compose.yaml` with both env files, and for each `compose.lab*.json` file at the repository root (nine on 2026-10-28)
- **AND** each of these commands exits with status 0 and the job passes

#### Scenario: A new lab file is covered
- **GIVEN** a change that adds `compose.lab-gpu.json` at the repository root and leaves `.github/workflows/ci.yml` unchanged
- **WHEN** the CI pipeline runs
- **THEN** the job runs `docker compose config --quiet` for `compose.lab-gpu.json` as well

#### Scenario: Malformed production file
- **GIVEN** a change whose `deploy/compose/production/compose.yaml` gives the `gateway` service the unknown key `heathcheck`
- **WHEN** the CI pipeline runs
- **THEN** `docker compose config --quiet` for the production file exits with a non-zero status
- **AND** the job fails
- **AND** `ci-required` fails

#### Scenario: Production image variable missing
- **GIVEN** a change that removes the `GATEWAY_IMAGE` line from `deploy/compose/production/images.env`
- **WHEN** the CI pipeline runs
- **THEN** the production render exits with a non-zero status, because `compose.yaml` requires `${GATEWAY_IMAGE:?...}`
- **AND** the job fails

#### Scenario: Malformed lab file
- **GIVEN** a change that leaves `compose.lab-process.json` as invalid JSON
- **WHEN** the CI pipeline runs
- **THEN** the render of `compose.lab-process.json` exits with a non-zero status
- **AND** the job fails, even when every other file renders

#### Scenario: The job loses a file
- **GIVEN** a copy of `.github/workflows/ci.yml` whose job drops the production render, or drops `--profile dev`, or whose job is missing from the `needs` of `ci-required`
- **WHEN** the lab unit tests check that copy
- **THEN** the static test fails and names what is missing

Evidence: `.github/workflows/ci.yml` (job `compose-config`, planned in slice S3, not yet built); `lab/tests/test_ci_compose_config.py` (planned in slice S3, not yet built)
