## ADDED Requirements

### Requirement: Lab image builds
The lab Dockerfiles SHALL fetch SPACE only at the pinned commit, pin bases by digest and run non-root without secrets.

`req~lab-space-image-pinned-commit~1`

Evidence: lab/tests/test_space_lab_bootstrap.py::test_space_dockerfile_pins_commit_and_digests; ::test_space_dockerfile_has_no_secret_and_runs_non_root; ::test_tool_dockerfile_pins_digest_and_requirements; ::test_control_dockerfile_rules_refuse_violations

#### Scenario: SPACE image from the pinned commit
- **GIVEN** `lab/space/Dockerfile`
- **WHEN** the static checks read it
- **THEN** it fetches `https://github.com/SCORELabUS/space.git` at the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` with `git fetch`, never `git clone`, a tag, a branch or a ref
- **AND** it checks out `FETCH_HEAD` and fails the build unless `git rev-parse HEAD` equals the literal commit (not a variable, not neutralised by `||` or `;`)
- **AND** every `FROM` is `name:tag@sha256:<64 hex>`, the bases are `node:21.1` and `node:21.1-slim`, the final stage is `node:21.1-slim`, pnpm is installed as exactly `10.9.0`, every `pnpm install` has `--frozen-lockfile`, and port 3000 is exposed
- **AND** the last `USER` is a numeric non-zero `uid:gid`, and no `ARG` or `ENV` holds a secret

#### Scenario: Tool image
- **GIVEN** `lab/tools/Dockerfile` and `lab/tools/requirements.txt`
- **WHEN** the static checks read them
- **THEN** its `FROM` is `python:3.12.8-slim-bookworm@sha256:<64 hex>`, `pip install` reads only `requirements.txt`, the requirements file and `space_lab_bootstrap.py` are copied, the `ENTRYPOINT` runs the tool, the last `USER` is a numeric non-zero `uid:gid`, and no `ARG` or `ENV` holds a secret
- **AND** every requirement is `name==version` and `httpx` and `space-python-client` are among them

#### Scenario: Violations refused
- **GIVEN** copies of the Dockerfiles and requirements with the ref `v1.7.1` or `main` instead of the commit, `git clone`, a checkout of a tag, no `HEAD` check or a variable in it, a `FROM` without digest or with a short digest, an `ARG SPACE_ADMIN_PASSWORD`, `USER root`, `USER 0`, `USER node`, `USER 1000`, an unpinned pnpm or a `pnpm install` without `--frozen-lockfile`, and a requirement `httpx>=0.27`
- **WHEN** the Dockerfile rules are applied to each copy
- **THEN** each copy is refused, while a comment that mentions the tag is not

### Requirement: SPACE bootstrap
WHEN SPACE is empty, the bootstrap SHALL create the organization, key, service and contracts.

`req~lab-space-bootstrap-creates~1`

Evidence: lab/tests/test_space_lab_bootstrap.py::test_it_creates_organization_key_service_and_contracts; ::test_the_configuration_comes_from_the_environment; ::test_the_constants_and_the_synthetic_users_follow_the_seed

#### Scenario: Configuration and constants
- **GIVEN** the environment variables `SPACE_URL` (default `http://space-api:3000`), `SPACE_ADMIN_USER` (default `lab-space-admin`), `SPACE_ADMIN_PASSWORD` (required, non-empty) and `SPACE_BOOTSTRAP_PLAN` (default `FREE`)
- **WHEN** `Config.from_environ` reads them
- **THEN** it returns a frozen `Config` with `poll_attempts` 60 and `poll_seconds` 5, and raises `BootstrapError` when the password is missing or empty
- **AND** the usernames and `SEED_NAMESPACE` of the tool equal those of `openbinding-gateway/tools/seed_lab.py`
- Evidence: lab/tests/test_space_lab_bootstrap.py::test_the_configuration_comes_from_the_environment; ::test_the_constants_and_the_synthetic_users_follow_the_seed

#### Scenario: Organization, key and service on an empty SPACE
- **GIVEN** a simulated SPACE with no organization and no service, and the admin `lab-space-admin`
- **WHEN** the bootstrap runs
- **THEN** it creates the organization `openbinding` owned by `lab-space-admin` and one api key of scope `MANAGEMENT` in it
- **AND** it creates the service `openbinding` with `source` `sphere`, `permanentUrl` `https://sphere.score.us.es/p/6ab0a323697330667ccce891` and `policy` `all_last`
- **AND** it runs the first synchronization and polls its status every `poll_seconds` (5 s) at most `poll_attempts` (60) times, until the status is `ready`, and the run comes before the first poll
- **AND** it prints one JSON line `{"organization": "created", "apiKey": "created", "service": "created", "synchronization": "ready", "contracts": {<username>: "created"}}` and exits with status 0
- Evidence: lab/tests/test_space_lab_bootstrap.py::test_it_creates_organization_key_service_and_contracts; ::test_the_service_comes_from_the_sphere_link_with_all_last; ::test_it_waits_for_the_first_synchronization

#### Scenario: Contracts for the synthetic users of the seed
- **GIVEN** the service `openbinding` with a `ready` synchronization, active pricing versions `1.0.0`, `1.2.0` and `1.10.0` (or the map shape with `activePricings` and an archived `2.0.0`), and `SPACE_BOOTSTRAP_PLAN` `PRO`
- **WHEN** the bootstrap creates contracts
- **THEN** it creates, through `space-python-client`, one contract on the newest active version compared numerically (`1.10.0`), with plan `PRO` (default `FREE`) and no add-on, for each of `lab-admin`, `lab-owner`, `lab-orgadmin`, `lab-member`, `lab-viewer` and `lab-outsider`
- **AND** each contract's user id is the seed's id `uuid5(SEED_NAMESPACE, "user:<username>")` and its email `<username>@example.org`
- **AND** archived versions are ignored
- Evidence: lab/tests/test_space_lab_bootstrap.py::test_contracts_use_the_client_and_the_ids_of_the_seed; ::test_archived_pricings_are_ignored_in_the_map_shape

#### Scenario: Aborts
- **GIVEN** a synchronization whose status becomes `failed`, `blocked` or `degraded`, or is not `ready` after `poll_attempts` polls; a service created from the link whose name is not `openbinding`; no active pricing version; or an existing service `openbinding` with another `source`, `permanentUrl` or `policy`
- **WHEN** the bootstrap runs
- **THEN** it raises `BootstrapError` naming the failed item, creates no contract, and modifies and runs nothing for an existing foreign service; through `main` it exits with status 1
- Evidence: lab/tests/test_space_lab_bootstrap.py::test_a_failed_synchronization_or_foreign_service_name_aborts; ::test_a_synchronization_that_never_gets_ready_aborts_after_the_polls; ::test_a_created_service_with_a_foreign_name_aborts; ::test_no_active_pricing_version_aborts; ::test_an_existing_service_with_other_settings_aborts_unchanged

### Requirement: Idempotent SPACE bootstrap
WHEN SPACE already holds some bootstrap items, the bootstrap SHALL create only the missing ones and report present ones as `exists`.

`req~lab-space-bootstrap-idempotent~1`

Evidence: lab/tests/test_space_lab_bootstrap.py::test_a_second_run_changes_nothing; ::test_a_partial_state_is_completed

#### Scenario: Second run
- **GIVEN** a simulated SPACE after a complete first run
- **WHEN** the bootstrap runs again
- **THEN** it sends no request that creates an organization, api key, service or contract, and no synchronization run request
- **AND** it reports `{"organization": "exists", "apiKey": "exists", "service": "exists", "synchronization": "skipped", "contracts": {<username>: "exists"}}` as one JSON line and exits with status 0

#### Scenario: Partial state
- **GIVEN** a simulated SPACE with the organization, its `MANAGEMENT` key and the `ready` service `openbinding`, and contracts for `lab-admin` and `lab-owner` only
- **WHEN** the bootstrap runs
- **THEN** it creates exactly the four missing contracts, reuses the existing key and reports the other items as `exists` and the synchronization as `skipped`
- **AND** given only the organization, it reuses it (`exists`) and creates the key, the service and the six contracts

### Requirement: Bootstrap secrets and SPHERE boundary
The bootstrap SHALL hold no SPHERE key, send no request to SPHERE, and never write the admin password or an api key to disk, output or an error.

`req~lab-space-bootstrap-sphere-readonly~1`

Evidence: lab/tests/test_space_lab_bootstrap.py::test_the_tool_holds_no_sphere_key_and_never_writes_to_sphere; ::test_nothing_secret_is_printed_or_persisted

#### Scenario: No SPHERE key and no request to SPHERE
- **GIVEN** the bootstrap tool, its environment and a simulated run that records every request
- **WHEN** the bootstrap runs
- **THEN** it reads no `SPHERE_*` variable, never names `SPHERE_API_KEY`, opens no file for writing, and every request goes to the host of `SPACE_URL` with no SPHERE header

#### Scenario: Secrets neither printed nor persisted
- **GIVEN** `SPACE_ADMIN_PASSWORD` set to a sample value and a simulated SPACE that returns sample api keys, in a successful run and in a run that fails at the service step with an error body that echoes the key and the password
- **WHEN** the bootstrap runs, directly and through `main`
- **THEN** its standard output, standard error, logs, exception texts and causes, and the working directory contain neither the password nor any api key
- **AND** a successful `main` prints exactly one JSON line, a failing `main` prints nothing on standard output, one redacted line on standard error and exits with status 1

### Requirement: No direct HTTP to SPACE or SPHERE
IF a module outside the allowed paths calls SPACE or SPHERE over HTTP and is not pinned, THEN the architecture test SHALL fail.

`req~lab-space-no-direct-http~1`

Evidence: lab/tests/test_no_direct_space_http.py::test_no_direct_http_to_space_or_sphere_outside_the_allowed_paths; ::test_known_deviations_are_pinned_and_still_needed; ::test_the_lab_tools_exception_is_recorded_in_the_adr; ::test_control_detects_a_direct_call

#### Scenario: Current tree
- **GIVEN** the repository sources, test paths excluded
- **WHEN** the architecture test scans them
- **THEN** the only direct callers of SPACE's or SPHERE's HTTP API are under `lab/tools/**`, the gateway plans module, or the two pinned deviations `openbinding-gateway/tools/_remote_common.py` and `openbinding-gateway/src/openbinding_gateway/sphere_client.py`
- **AND** `remote_probe.py`, `remote_provision.py` and `seed_lab.py` are not direct callers, because they use httpx for transport types only
- **AND** the `lab/tools/**` exception is the one recorded in `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md`

#### Scenario: A pinned deviation no longer needed
- **GIVEN** a pinned deviation whose file no longer calls SPACE or SPHERE directly, or no longer exists
- **WHEN** the architecture test runs
- **THEN** it fails until the entry is removed from the pinned list

#### Scenario: A new direct caller
- **GIVEN** a sample module under `openbinding-gateway/src/openbinding_gateway/` that sends `httpx.get(f"{space_url}/api/v1/services")`
- **WHEN** the detection rule is applied to it
- **THEN** it is reported as a direct call
- **AND** a module that uses httpx only for annotations or `MockTransport`, or the official `space_client`, is not
- **AND** test paths (`tests`, `e2e`, `conftest.py`, `*.test.ts`, `*.spec.tsx`) are skipped
- Evidence: lab/tests/test_no_direct_space_http.py::test_control_detects_a_direct_call; ::test_control_skips_tests_and_mocks
