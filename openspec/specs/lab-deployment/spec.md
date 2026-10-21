# lab-deployment Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/baseline` @ 9b5be00 — reverse-engineered, spec-anchored.

## Purpose

How OpenBinding is packaged and run: the Compose stack (`docker-compose.yml`, profiles `dev`, `prod`, `db-tools`,
`federated-example`, `benchmark`), the NiPoGi lab demo profiles (`compose.lab*.json`, reached through an SSH tunnel at
`127.0.0.1:18100`), the PostgreSQL test harness (`compose.pgtest.json`), images, and the Kustomize manifests
(`deploy/kubernetes`). Docs: `docs/DEMO.md`, `docs/qa/PROCESS_DEPLOYMENT.md`, `deploy/kubernetes/README.md`.

## Requirements

### Requirement: Single loopback port in the lab
THE lab profile SHALL publish exactly one host port, bound to `127.0.0.1:18100`, and no other service SHALL publish or expose a host port.

`req~lab-deployment-single-loopback-port~1`

Evidence: `lab/tests/test_lab_compose.py::test_single_published_port_on_loopback`; `lab/tests/test_lab_compose.py::test_no_expose_of_published_ports_on_other_services`

#### Scenario: A debug port added to the gateway
- **GIVEN** a change that publishes `8000:8000` for the gateway in `compose.lab.json`
- **WHEN** the lab static checks run
- **THEN** they fail

### Requirement: Memory budget of the lab
THE lab profile SHALL set a memory limit on every service, keep the sum within the documented lab ceiling, and cap Java heaps below their container limits.

`req~lab-deployment-memory-budget~1`

Evidence: `lab/tests/test_lab_compose.py::test_every_service_has_a_mem_limit`; `lab/tests/test_lab_compose.py::test_memory_sum_is_within_the_lab_ceiling_and_is_the_documented_one`; `lab/tests/test_lab_compose.py::test_java_engines_cap_the_heap_below_the_container_limit`

#### Scenario: Raising bim-service memory
- **GIVEN** a change raising `bim-service` above its documented 256 MiB
- **WHEN** the lab static checks run
- **THEN** they fail until the documented budget is updated in the same change

### Requirement: No literal secrets in deployment files
THE Compose and lab files SHALL reference secrets only through variables without defaults, never as literals, and SHALL give the JWT signing secret only to the services that sign sessions (not to Dramatiq workers).

`req~lab-deployment-secret-references~1`

Evidence: `lab/tests/test_lab_compose.py::test_secret_variables_are_never_literal`; `lab/tests/test_lab_compose.py::test_references_are_demo_or_private_and_never_have_defaults`; `openbinding-gateway/tests/test_compose_worker_secrets.py::test_dramatiq_services_do_not_get_jwt_secret`

#### Scenario: Default value for a key
- **GIVEN** `${SPACE_API_KEY:-dev-key}` in a compose file
- **WHEN** the static checks run
- **THEN** they fail

### Requirement: Unprivileged containers
THE images and services SHALL run as numeric non-root users with fixed ids, pinned base images and a pinned `uv`, without requesting extra privileges.

`req~lab-deployment-unprivileged-containers~1`

Evidence: `openbinding-gateway/tests/test_container_hardening.py::test_the_image_ends_on_a_numeric_non_root_user`; `openbinding-gateway/tests/test_container_hardening.py::test_no_service_asks_for_root_or_extra_privileges`; `openbinding-gateway/tests/test_container_hardening.py::test_uv_is_pinned_to_a_release_and_nothing_uses_latest`

#### Scenario: Image ends as root
- **GIVEN** a Dockerfile change that removes the final `USER 10001`
- **WHEN** the unit suite runs
- **THEN** the hardening test fails

### Requirement: No local SPACE
THE deployment files SHALL contain no SPACE service, network or volume; SPACE and SPHERE SHALL be reached only as remote services configured by environment.

`req~lab-deployment-no-local-space~1`

Evidence: `openbinding-gateway/tests/test_no_local_space.py::test_no_space_services_or_profile`; `lab/tests/test_lab_compose.py::test_no_space_services`

#### Scenario: Adding a SPACE container
- **GIVEN** a change that adds a `space` service to `docker-compose.yml`
- **WHEN** the unit suite runs
- **THEN** it fails

### Requirement: Database migrations at start
WHEN the gateway container starts with a `DATABASE_URL`, THE container SHALL apply `alembic upgrade head` before serving, as the unprivileged image user.

`req~lab-deployment-migrate-on-start~1`

Evidence: `openbinding-gateway/docker-entrypoint.sh`; `openbinding-gateway/tests/test_container_hardening.py::test_the_entrypoint_needs_no_privileges`; `openbinding-gateway/tests/test_b3_migration.py`

#### Scenario: New migration deployed
- **GIVEN** an image with a new Alembic revision
- **WHEN** the gateway container starts against an older schema
- **THEN** the schema is upgraded before the first request is served

### Requirement: Kubernetes manifests render
THE Kustomize manifests under `deploy/kubernetes` SHALL render without errors in CI.

`req~lab-deployment-kustomize-render~1`

Evidence: `.github/workflows/ci.yml`; `deploy/kubernetes/kustomization.yaml`; GAP: CI also renders deploy/kubernetes/overlays/with-space, which was deleted in 9b81112 and no longer exists in the tree, so that CI step fails as written

#### Scenario: Broken patch
- **GIVEN** a change to `deploy/kubernetes/base/gateway.yaml` with an invalid field path
- **WHEN** CI runs `kubectl kustomize deploy/kubernetes`
- **THEN** the job fails

## Out of scope

- Production deployment procedure (owner-only, from `main` tags; not specified here).
- The factory's own runtime on NiPoGi.

## TODO

- Remove the `with-space` render step from CI (the overlay was removed with the local SPACE stack) or restore the overlay — owner decision.
- Adminer binds to loopback only (`127.0.0.1:8082`): add as a requirement with a test.
- Process-mode profiles N1/N2 of `bim-service` (`compose.lab-process*.json`) and their probes.
- Backup/restore runbooks (`deploy/kubernetes/restore-job.example.yaml`).
- The pre-cutover PostgreSQL volume cannot be migrated (README): decide whether that is acceptable before the first release.
