## ADDED Requirements

### Requirement: Compose config in CI
`req~lab-deployment-compose-config-in-ci~1`
WHEN the CI pipeline runs, the CI SHALL run `docker compose config --quiet` for `docker-compose.yml` with the profile `dev`, for `deploy/compose/production/compose.yaml` with every profile enabled and `--env-file deploy/compose/production/images.env --env-file deploy/compose/production/ci.env`, and for every `compose.lab*.json` at the repository root with every profile enabled, in a job whose failure on any of these files fails the required aggregate check `ci-required`.

Needs: impl, utest

#### Scenario: Current files render
- **GIVEN** the repository at the head of the slice that adds the job
- **WHEN** the CI pipeline runs on a pull request into `develop`
- **THEN** the job runs `docker compose config --quiet` for `docker-compose.yml` with `--profile dev`, for `deploy/compose/production/compose.yaml` with `--profile "*"` and both env files, and for each `compose.lab*.json` file at the repository root with `--profile "*"` (nine on 2026-10-28)
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

#### Scenario: Defect in a service of a profile
- **GIVEN** a change whose `compose.lab.json` gives the `seed` service, which belongs to the profile `seed` only, a `depends_on` entry for the undefined service `seeder`
- **WHEN** the CI pipeline runs
- **THEN** the render of `compose.lab.json` with `--profile "*"` exits with a non-zero status
- **AND** the job fails

#### Scenario: The job loses a file
- **GIVEN** a copy of `.github/workflows/ci.yml` whose job drops the production render, or drops `--profile dev`, or drops `--profile "*"` from the lab render, or whose job is missing from the `needs` of `ci-required`
- **WHEN** the lab unit tests check that copy
- **THEN** the static test fails and names what is missing

Evidence: `.github/workflows/ci.yml` (job `compose-config`, planned in slice S3, not yet built); `lab/tests/test_ci_compose_config.py` (planned in slice S3, not yet built)

### Requirement: Production proxy upstream
`req~lab-deployment-production-proxy-upstream~1`
WHEN the production proxy (the nginx of `deploy/compose/production` and of the `prod` profile of `docker-compose.yml`) receives a request for `openbinding.score.us.es` whose normalised path starts with `/api/`, `/static/` or `/avatars/`, the proxy SHALL handle it as follows: it resolves the name `gateway` through the Docker embedded DNS server at the time of the request, keeps a resolved address for at most 10 s and waits at most 5 s for a DNS answer; it forwards an `/api/` request to port 8000 of that address with the raw request URI as the client sent it minus the leading `/api` (percent-encoded characters, the query string, `//` and dot segments unchanged); it forwards a `/static/` or `/avatars/` request with the raw request URI unchanged; it answers HTTP 400 without forwarding when the raw request URI of a request with a normalised `/api/` path does not start with `/api/`; and it answers HTTP 502 when `gateway` does not resolve.

Needs: impl, utest

#### Scenario: Gateway recreated with a new address
- **GIVEN** the production proxy has forwarded `GET /api/health` to the gateway at address A
- **AND** the gateway container is replaced by one with the same name `gateway` at address B
- **WHEN** a client sends `GET /api/health` 11 s after the replacement, with no restart of the proxy
- **THEN** the request reaches the gateway at address B
- **AND** the response status is the gateway's, not 502

#### Scenario: Encoded path and query string pass unchanged
- **GIVEN** a running gateway
- **WHEN** a client sends `GET /api/v1/x%2Fy?a=1&b=%20`
- **THEN** the gateway receives the request target `/v1/x%2Fy?a=1&b=%20`

#### Scenario: Double slash and dot segments pass unchanged
- **GIVEN** a running gateway
- **WHEN** a client sends `GET /api//v1/jobs` and then `GET /api/v1/x/../jobs` without normalising them
- **THEN** the gateway receives the request targets `//v1/jobs` and `/v1/x/../jobs`

#### Scenario: Raw URI outside /api/
- **GIVEN** a running gateway
- **WHEN** a client sends `GET /%61pi/x`
- **THEN** the response status is 400
- **AND** the gateway receives no request

#### Scenario: Gateway name does not resolve
- **GIVEN** no container with the name `gateway` on the proxy's network
- **AND** the host's resolvers do not answer the name `gateway`
- **WHEN** a client sends `GET /api/health`
- **THEN** the response status is 502
- **AND** the response arrives no later than 6 s after the request

#### Scenario: Static and avatar paths pass the raw URI
- **GIVEN** a running gateway
- **WHEN** a client sends `GET /static/a%20b.css` and then `GET /avatars/u1.png?v=2`
- **THEN** the gateway receives the request targets `/static/a%20b.css` and `/avatars/u1.png?v=2`

Evidence: `nginx/production/nginx.conf` (`# [impl->req~lab-deployment-production-proxy-upstream~1]`); `openbinding-gateway/tests/test_production_nginx.py` (`[utest->req~lab-deployment-production-proxy-upstream~1]`, static checks of the configuration); the pre-deployment check of the runbook (design.md §3) for the scenarios that need a running nginx
