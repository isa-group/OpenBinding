## ADDED Requirements

### Requirement: Lab image builds
The lab Dockerfiles SHALL fetch SPACE only at commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` and use `@sha256:` bases, exact pins, no secret and a non-root user.

`req~lab-space-image-pinned-commit~1`

Evidence: lab/tests/test_space_lab_bootstrap.py: test_space_dockerfile_pins_commit_and_digests, test_space_dockerfile_has_no_secret_and_runs_non_root, test_tool_dockerfile_pins_digest_and_requirements, test_control_dockerfile_rules_refuse_violations

#### Scenario: SPACE image from the pinned commit
- **GIVEN** `lab/space/Dockerfile`
- **WHEN** the static checks read it
- **THEN** it fetches `https://github.com/SCORELabUS/space.git` at the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` and fails the build unless the checked-out `HEAD` equals that commit
- **AND** every `FROM` is `name:tag@sha256:<64 hex>`, the api stage uses `node:21.1-slim`, pnpm `10.9.0`, `pnpm install --frozen-lockfile` in the context `api/` and exposes port 3000
- **AND** the last `USER` is numeric and non-zero, and no `ARG` or `ENV` holds a secret

#### Scenario: Tool image
- **GIVEN** `lab/tools/Dockerfile` and its requirements file
- **WHEN** the static checks read them
- **THEN** its `FROM` is `python:3.12.8-slim-bookworm@sha256:<64 hex>`, every requirement is `name==version`, the last `USER` is numeric and non-zero, and no `ARG` or `ENV` holds a secret

#### Scenario: Violations refused
- **GIVEN** copies of the Dockerfiles with the ref `v1.7.1` or `main` instead of the commit, no `HEAD` check, a `FROM` without digest, an `ARG SPACE_ADMIN_PASSWORD`, `USER root`, `USER 0` or `USER node`, and a requirement `httpx>=0.27`
- **WHEN** the Dockerfile rules are applied to each copy
- **THEN** each copy is refused

### Requirement: SPACE bootstrap
WHEN SPACE is empty, the bootstrap SHALL create the organization, key, service and contracts.

`req~lab-space-bootstrap-creates~1`

Evidence: lab/tests/test_space_lab_bootstrap.py: test_it_creates_organization_key_service_and_contracts, test_the_service_comes_from_the_sphere_link_with_all_last, test_it_waits_for_the_first_synchronization, test_contracts_use_the_client_and_the_ids_of_the_seed, test_a_failed_synchronization_or_foreign_service_name_aborts

#### Scenario: Organization, key and service on an empty SPACE
- **GIVEN** a simulated SPACE with no organization and no service, and the admin `lab-space-admin`
- **WHEN** the bootstrap runs
- **THEN** it creates the organization `openbinding` owned by `lab-space-admin` and one api key of scope `MANAGEMENT` in it
- **AND** it creates the service `openbinding` with `source` `sphere`, `permanentUrl` `https://sphere.score.us.es/p/6ab0a323697330667ccce891` and `policy` `all_last`
- **AND** it runs the first synchronization and polls its status every 5 s, at most 60 times, until the status is `ready`

#### Scenario: Contracts for the synthetic users of the seed
- **GIVEN** the service `openbinding` with a `ready` synchronization, two active pricing versions `1.0.0` and `1.1.0`, and an archived version `2.0.0`
- **WHEN** the bootstrap creates contracts
- **THEN** it creates, through `space-python-client`, one contract on version `1.1.0` for each of `lab-admin`, `lab-owner`, `lab-orgadmin`, `lab-member`, `lab-viewer` and `lab-outsider`
- **AND** each contract's user id is the seed's id `uuid5(SEED_NAMESPACE, "user:<username>")`

#### Scenario: Failed synchronization or foreign service
- **GIVEN** a synchronization whose status becomes `failed` or is not `ready` after 60 polls, a service created from the link whose name is not `openbinding`, no active pricing version, or an existing service `openbinding` with another `source`, `permanentUrl` or `policy`
- **WHEN** the bootstrap runs
- **THEN** it exits with a non-zero status, names the failed item and creates no contract

### Requirement: Idempotent SPACE bootstrap
WHEN the bootstrap runs against a SPACE that already holds some of its items, the bootstrap SHALL create only the missing items and report each present one as `existing`, without re-running a synchronization that is already `ready`.

`req~lab-space-bootstrap-idempotent~1`

Evidence: lab/tests/test_space_lab_bootstrap.py: test_a_second_run_changes_nothing, test_a_partial_state_is_completed

#### Scenario: Second run
- **GIVEN** a simulated SPACE after a complete first run
- **WHEN** the bootstrap runs again
- **THEN** it sends no request that creates an organization, api key, service or contract, and no synchronization run request
- **AND** it reports the organization, the key, the service, the synchronization and the six contracts as `existing` and exits with status 0

#### Scenario: Partial state
- **GIVEN** a simulated SPACE with the organization, its `MANAGEMENT` key and the `ready` service `openbinding`, and contracts for `lab-admin` and `lab-owner` only
- **WHEN** the bootstrap runs
- **THEN** it creates exactly the four missing contracts, reuses the existing key and reports the other items as `existing`

### Requirement: Bootstrap secrets and SPHERE boundary
The bootstrap SHALL hold no SPHERE key, send no request to SPHERE, and never write the SPACE admin password or an api key to disk, output or an error, the `MANAGEMENT` key staying inside SPACE.

`req~lab-space-bootstrap-sphere-readonly~1`

Evidence: lab/tests/test_space_lab_bootstrap.py: test_the_tool_holds_no_sphere_key_and_never_writes_to_sphere, test_nothing_secret_is_printed_or_persisted

#### Scenario: No SPHERE key and no request to SPHERE
- **GIVEN** the bootstrap tool, its environment and a simulated run that records every request
- **WHEN** the bootstrap runs
- **THEN** it reads no `SPHERE_*` variable and every request goes to the host of `SPACE_URL`, none to `sphere.score.us.es`

#### Scenario: Secrets neither printed nor persisted
- **GIVEN** `SPACE_ADMIN_PASSWORD` set to a sample value and a simulated SPACE that returns sample api keys, in a successful run and in a run that fails at the service step
- **WHEN** the bootstrap runs
- **THEN** its standard output, standard error, exception texts and every file it writes contain neither the password nor any api key
- **AND** a later run reuses the organization's existing `MANAGEMENT` key instead of reading it from a file

### Requirement: No direct HTTP to SPACE or SPHERE
IF a module outside `lab/tools/**` and the gateway plans module calls SPACE's or SPHERE's HTTP API directly and is not a pinned known deviation, THEN the architecture test SHALL fail.

`req~lab-space-no-direct-http~1`

Evidence: lab/tests/test_no_direct_space_http.py: test_no_direct_http_to_space_or_sphere_outside_the_allowed_paths, test_known_deviations_are_pinned_and_still_needed, test_control_detects_a_direct_call

#### Scenario: Current tree
- **GIVEN** the repository sources
- **WHEN** the architecture test scans them
- **THEN** the only direct callers of SPACE's or SPHERE's HTTP API are under `lab/tools/**`, the gateway plans module, or the pinned deviations `openbinding-gateway/tools/_remote_common.py` and `openbinding-gateway/src/openbinding_gateway/sphere_client.py`
- **AND** the `lab/tools/**` exception is the one recorded in `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md`

#### Scenario: A pinned deviation no longer needed
- **GIVEN** a pinned deviation whose file no longer calls SPACE or SPHERE directly, or no longer exists
- **WHEN** the architecture test runs
- **THEN** it fails until the entry is removed from the pinned list

#### Scenario: A new direct caller
- **GIVEN** a sample module under `openbinding-gateway/src/openbinding_gateway/` that sends `httpx.get(f"{space_url}/api/v1/services")`
- **WHEN** the detection rule is applied to it
- **THEN** it is reported as a direct call
