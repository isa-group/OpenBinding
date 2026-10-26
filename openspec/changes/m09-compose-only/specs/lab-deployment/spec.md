## REMOVED Requirements

### Requirement: Kubernetes manifests render
**Reason**: ADR-0021 retired Kubernetes. Docker Compose is the only deployment tool, and `deploy/kubernetes/` and its
CI step "Render the base Kubernetes manifests" are already gone from the repository.
**Migration**: none for users; no environment ran on Kubernetes. `req~lab-deployment-compose-only~1` replaces the
rendering requirement with a guard that no Kubernetes or Kustomize manifest or CI step comes back. The factory gate
`kustomize` (`.agentic/project.yaml:82`) is removed by the owner (design.md §7).

## MODIFIED Requirements

### Requirement: Database migrations at start
`req~lab-deployment-migrate-on-start~2`
WHEN the gateway image entrypoint starts, the entrypoint SHALL act on `OPENBINDING_MIGRATE`, running as the unprivileged image user: with `auto` or the variable unset or empty, it applies `alembic upgrade head` if `DATABASE_URL` is non-empty and then runs the command; with `skip`, it runs the command without migrating; with `only`, it applies `alembic upgrade head` and exits with status 0 without running the command; with `only` and an empty `DATABASE_URL`, or with any other value, it exits with status 2 and a message on stderr that names `OPENBINDING_MIGRATE`, without migrating or running the command.

Needs: impl, utest

Evidence: `openbinding-gateway/docker-entrypoint.sh`; `openbinding-gateway/tests/test_compose_production.py`; `openbinding-gateway/tests/test_container_hardening.py::test_the_entrypoint_needs_no_privileges`; `openbinding-gateway/tests/test_b3_migration.py`

#### Scenario: New migration deployed
- **GIVEN** an image with a new Alembic revision and `OPENBINDING_MIGRATE` unset
- **WHEN** the gateway container starts against an older schema with a non-empty `DATABASE_URL`
- **THEN** the schema is upgraded before the first request is served

#### Scenario: Default mode without a database
- **GIVEN** `OPENBINDING_MIGRATE=auto` and an empty `DATABASE_URL`
- **WHEN** the entrypoint runs the command `env`
- **THEN** `alembic` is not called
- **AND** the command runs and the exit status is the command's

#### Scenario: Skip mode
- **GIVEN** `OPENBINDING_MIGRATE=skip` and `DATABASE_URL=postgresql+asyncpg://u:p@postgres:5432/openbinding`
- **WHEN** the entrypoint runs the command `env`
- **THEN** `alembic` is not called
- **AND** the command runs

#### Scenario: Only mode
- **GIVEN** `OPENBINDING_MIGRATE=only` and a non-empty `DATABASE_URL`
- **WHEN** the entrypoint runs with the command `env`
- **THEN** `alembic upgrade head` is called once
- **AND** the command does not run and the exit status is 0

#### Scenario: Only mode without a database
- **GIVEN** `OPENBINDING_MIGRATE=only` and an empty `DATABASE_URL`
- **WHEN** the entrypoint starts
- **THEN** the exit status is 2, `alembic` is not called and the command does not run

#### Scenario: Unknown mode
- **GIVEN** `OPENBINDING_MIGRATE=always`
- **WHEN** the entrypoint starts
- **THEN** the exit status is 2 and stderr names `OPENBINDING_MIGRATE`
- **AND** `alembic` is not called and the command does not run

## ADDED Requirements

### Requirement: Docker Compose is the only deployment tool
`req~lab-deployment-compose-only~1`
The repository SHALL contain no `deploy/kubernetes` directory, no `kustomization.yaml` or `kustomization.yml` file, no YAML document that declares both `apiVersion` and `kind` (outside `node_modules` and `.venv` directories), and no `kubectl` or `kustomize` invocation in `.github/workflows/*.yml`.

Needs: impl, utest

Evidence: `openbinding-gateway/tests/test_no_kubernetes.py`

#### Scenario: Current tree
- **GIVEN** the repository at the head of this change
- **WHEN** the unit suite runs
- **THEN** the guard test passes

#### Scenario: A Kustomize file comes back
- **GIVEN** a change that adds `deploy/kubernetes/kustomization.yaml`
- **WHEN** the unit suite runs
- **THEN** the guard test fails and names the file

#### Scenario: A Kubernetes manifest elsewhere
- **GIVEN** a change that adds `ops/gateway.yaml` with `apiVersion: apps/v1` and `kind: Deployment`
- **WHEN** the unit suite runs
- **THEN** the guard test fails and names the file

#### Scenario: A CI step renders manifests
- **GIVEN** a change that adds a step running `kubectl kustomize deploy/kubernetes` to `.github/workflows/ci.yml`
- **WHEN** the unit suite runs
- **THEN** the guard test fails and names the workflow file

### Requirement: Secrets from files in the gateway entrypoint
`req~lab-deployment-entrypoint-secret-files~1`
WHERE `<NAME>_FILE` is set for NAME in `DATABASE_URL`, `GATEWAY_JWT_SECRET`, `SPACE_API_KEY`, `SPHERE_API_KEY`, `SECRETS_FERNET_KEYS`, `FEDERATION_SECRET_KEY` or `BOOTSTRAP_ADMIN_PASSWORD`, the gateway entrypoint SHALL export the file content, trailing newlines removed, as NAME before migrating, or exit 2 naming only `<NAME>_FILE`, never the value, if NAME is also set or the file is not a readable regular file.

#### Scenario: Secret read from a file
- **GIVEN** `GATEWAY_JWT_SECRET` unset and `GATEWAY_JWT_SECRET_FILE` pointing to a readable file containing `s3cr3t-value-0123456789abcdef0123\n`
- **WHEN** the entrypoint runs the command `env`
- **THEN** the command sees `GATEWAY_JWT_SECRET=s3cr3t-value-0123456789abcdef0123` without the newline

#### Scenario: Database URL read before migrating
- **GIVEN** `OPENBINDING_MIGRATE=only`, `DATABASE_URL` unset and `DATABASE_URL_FILE` pointing to a file containing `postgresql+asyncpg://u:p@postgres:5432/openbinding`
- **WHEN** the entrypoint starts
- **THEN** `alembic upgrade head` is called with `DATABASE_URL` set to that value
- **AND** the exit status is 0

#### Scenario: Value and file both set
- **GIVEN** `SPACE_API_KEY=abc` and `SPACE_API_KEY_FILE` pointing to a readable file
- **WHEN** the entrypoint starts
- **THEN** the exit status is 2, stderr names `SPACE_API_KEY_FILE`, `alembic` is not called and the command does not run

#### Scenario: Missing file
- **GIVEN** `SECRETS_FERNET_KEYS_FILE=/run/secrets/does-not-exist`
- **WHEN** the entrypoint starts
- **THEN** the exit status is 2 and stderr names `SECRETS_FERNET_KEYS_FILE`

#### Scenario: Unreadable file
- **GIVEN** `BOOTSTRAP_ADMIN_PASSWORD_FILE` pointing to a file with mode 0000 owned by another user, or to a directory
- **WHEN** the entrypoint starts
- **THEN** the exit status is 2 and stderr names `BOOTSTRAP_ADMIN_PASSWORD_FILE`

#### Scenario: Secret never printed
- **GIVEN** each failure above, and a successful start, with a secret file containing `do-not-print-7f3a`
- **WHEN** the entrypoint runs a command that prints nothing
- **THEN** neither stdout nor stderr contains `do-not-print-7f3a`

#### Scenario: No file variable set
- **GIVEN** no `<NAME>_FILE` variable set
- **WHEN** the entrypoint starts
- **THEN** the environment the command sees is the one the entrypoint received

Needs: impl, utest

Evidence: `openbinding-gateway/docker-entrypoint.sh`; `openbinding-gateway/tests/test_compose_production.py`

### Requirement: Production images pinned by digest
`req~lab-deployment-production-pinned-images~1`
The production Compose file SHALL take every service image, with no `build` key, from a required `${<NAME>_IMAGE:?...}` variable whose `images.env` value is `<name>:<tag>@sha256:<64 lowercase hex>`: the published digest for a third-party image, and the marker `gap.invalid/<name>:0.0.0@sha256:<64 zeros>` for an image of this repository until an image registry exists.

#### Scenario: Pinned file set
- **GIVEN** `compose.yaml` and `images.env` of this change
- **WHEN** the unit suite runs
- **THEN** every service `image` is a `${<NAME>_IMAGE:?...}` reference defined in `images.env`
- **AND** every value matches `<name>:<tag>@sha256:<64 lowercase hex>`

#### Scenario: Tag-only or short digest
- **GIVEN** a copy of `images.env` with `POSTGRES_IMAGE=postgres:16-alpine`, or with a digest of 63 hex characters
- **WHEN** the image rule is applied
- **THEN** it fails and names `POSTGRES_IMAGE`

#### Scenario: Literal image or build in the Compose file
- **GIVEN** a copy of `compose.yaml` whose `redis` service has `image: redis:7.4-alpine`, or whose `gateway` service has a `build` key
- **WHEN** the image rule is applied
- **THEN** it fails and names the service

#### Scenario: Marker for an image of this repository
- **GIVEN** `GATEWAY_IMAGE=gap.invalid/openbinding-gateway:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000`
- **WHEN** the image rule is applied
- **THEN** it passes

#### Scenario: Marker on a third-party image
- **GIVEN** a copy of `images.env` whose `POSTGRES_IMAGE` is a `gap.invalid/...` marker
- **WHEN** the image rule is applied
- **THEN** it fails, because a third-party image carries its published digest

Needs: impl, utest

Evidence: `deploy/compose/production/compose.yaml`; `deploy/compose/production/images.env`; `openbinding-gateway/tests/test_compose_production.py`

### Requirement: Production secrets as files
`req~lab-deployment-production-secret-files~1`
The production Compose file SHALL pass every secret only as a top-level file secret under `${OPENBINDING_SECRETS_DIR:?...}`, mounted in the service and named by `<NAME>_FILE=/run/secrets/<name>`, with no secret literal or secret variable reference in any environment, and with `gateway_jwt_secret` mounted only in `gateway`.

Needs: impl, utest

Evidence: `deploy/compose/production/compose.yaml`; `openbinding-gateway/tests/test_compose_production.py`

#### Scenario: Conforming secrets
- **GIVEN** `compose.yaml` of this change
- **WHEN** the unit suite runs
- **THEN** the top-level secrets are `postgres_password`, `database_url`, `gateway_jwt_secret`, `space_api_key`, `sphere_api_key`, `secrets_fernet_keys` and `bootstrap_admin_password`, each with a `file:` under `${OPENBINDING_SECRETS_DIR:?`
- **AND** the secret rule passes

#### Scenario: Secret as an environment value
- **GIVEN** a copy of `compose.yaml` whose `gateway` environment has `GATEWAY_JWT_SECRET=${GATEWAY_JWT_SECRET:?}`, or whose `postgres` environment has `POSTGRES_PASSWORD=openbinding`
- **WHEN** the secret rule is applied
- **THEN** it fails and names the service and the variable

#### Scenario: Password inside a URL
- **GIVEN** a copy of `compose.yaml` with `DATABASE_URL=postgresql+asyncpg://openbinding:openbinding@postgres:5432/openbinding` on `worker`
- **WHEN** the secret rule is applied
- **THEN** it fails

#### Scenario: Secret file outside the secrets directory
- **GIVEN** a copy of `compose.yaml` whose `database_url` secret has `file: ./secrets/database_url`
- **WHEN** the secret rule is applied
- **THEN** it fails and names `database_url`

#### Scenario: JWT secret on a worker
- **GIVEN** a copy of `compose.yaml` whose `worker` service lists `gateway_jwt_secret` in its `secrets`
- **WHEN** the secret rule is applied
- **THEN** it fails and names `worker`

### Requirement: Production health checks, restart and start order
`req~lab-deployment-production-health-restart~1`
The production Compose file SHALL give every service other than the one-shot `migrate` a health check that is not disabled and `restart: unless-stopped`, give `migrate` the gateway image, `OPENBINDING_MIGRATE=only` and `restart: "no"`, and make `gateway` depend on `migrate` with `condition: service_completed_successfully`.

Needs: impl, utest

Evidence: `deploy/compose/production/compose.yaml`; `openbinding-gateway/tests/test_compose_production.py`

#### Scenario: Conforming services
- **GIVEN** `compose.yaml` of this change
- **WHEN** the unit suite runs
- **THEN** `postgres`, `redis`, `gateway`, `worker`, `analysis-worker`, the four engines, `frontend-assets`, `nginx` and `pg-backup` each have a health check and `restart: unless-stopped`
- **AND** `gateway` waits for `migrate` with `service_completed_successfully`

#### Scenario: Missing or disabled health check
- **GIVEN** a copy of `compose.yaml` whose `redis` has no health check, or a health check with test `["NONE"]` or `disable: true`
- **WHEN** the rule is applied
- **THEN** it fails and names `redis`

#### Scenario: Wrong restart policy
- **GIVEN** a copy of `compose.yaml` whose `worker` has `restart: always`, or no `restart` key
- **WHEN** the rule is applied
- **THEN** it fails and names `worker`

#### Scenario: Gateway does not wait for migrations
- **GIVEN** a copy of `compose.yaml` whose `gateway` depends on `migrate` with `service_started`, or whose `migrate` sets `OPENBINDING_MIGRATE=auto`
- **WHEN** the rule is applied
- **THEN** it fails

### Requirement: Production resource limits and log rotation
`req~lab-deployment-production-limits-logs~1`
The production Compose file SHALL set on every service a `mem_limit`, a `cpus` value greater than 0 and the logging driver `json-file` with the options `max-size: 10m` and `max-file: "5"`.

Needs: impl, utest

Evidence: `deploy/compose/production/compose.yaml`; `openbinding-gateway/tests/test_compose_production.py`

#### Scenario: Conforming limits
- **GIVEN** `compose.yaml` of this change
- **WHEN** the unit suite runs
- **THEN** every service, `migrate` included, has `mem_limit`, `cpus` greater than 0 and `json-file` logging with `max-size` `10m` and `max-file` `5`

#### Scenario: A service without limits
- **GIVEN** a copy of `compose.yaml` whose `engine-minizinc` has no `mem_limit`, or `cpus: 0`
- **WHEN** the rule is applied
- **THEN** it fails and names `engine-minizinc`

#### Scenario: Logs without rotation
- **GIVEN** a copy of `compose.yaml` whose `nginx` uses the `json-file` driver without `max-size`, or the `local` driver
- **WHEN** the rule is applied
- **THEN** it fails and names `nginx`

### Requirement: Production backups
`req~lab-deployment-production-backups~1`
The production deployment SHALL back up its data with a `pg-backup` service in `compose.yaml` that writes a `pg_dump -Fc` at least every 24 hours into `${OPENBINDING_BACKUP_DIR:?...}` and deletes dumps older than `${BACKUP_RETENTION_DAYS:?...}` days, and with a snapshot procedure for the `pgdata` and `artifacts` volumes in `docs/runbooks/production.md`.

#### Scenario: Scheduled dump with retention
- **GIVEN** `compose.yaml` of this change
- **WHEN** the unit suite reads the `pg-backup` service
- **THEN** its command runs `pg_dump -Fc` in a loop that waits at most 86400 seconds between dumps
- **AND** it deletes dumps older than `BACKUP_RETENTION_DAYS` days in the directory mounted from `${OPENBINDING_BACKUP_DIR:?`
- **AND** it mounts the `postgres_password` secret and sets no password in its environment

#### Scenario: Backup directory with a default
- **GIVEN** a copy of `compose.yaml` whose `pg-backup` mounts `${OPENBINDING_BACKUP_DIR:-./backups}`
- **WHEN** the backup rule is applied
- **THEN** it fails, because the backup directory has no default

#### Scenario: Snapshot procedure documented
- **GIVEN** `docs/runbooks/production.md`
- **WHEN** the unit suite reads it
- **THEN** it has a volume snapshot section that names `pgdata` and `artifacts` and the restore drill

Needs: impl, utest

Evidence: `deploy/compose/production/compose.yaml`; `docs/runbooks/production.md`; `openbinding-gateway/tests/test_compose_production.py`

### Requirement: Production runbook
`req~lab-deployment-production-runbook~1`
The production runbook `docs/runbooks/production.md` SHALL name every service, every top-level secret and every `_IMAGE` variable of `deploy/compose/production/compose.yaml`.

Needs: impl, utest

Evidence: `docs/runbooks/production.md`; `deploy/compose/production/compose.yaml`; `openbinding-gateway/tests/test_compose_production.py`

#### Scenario: Runbook complete
- **GIVEN** `compose.yaml` and `docs/runbooks/production.md` of this change
- **WHEN** the unit suite runs
- **THEN** each service name, secret name and `_IMAGE` variable of `compose.yaml` appears in the runbook

#### Scenario: A new service without documentation
- **GIVEN** a change that adds a service `engine-quantum` with `ENGINE_QUANTUM_IMAGE` to `compose.yaml` and leaves the runbook unchanged
- **WHEN** the unit suite runs
- **THEN** the runbook test fails and names `engine-quantum` and `ENGINE_QUANTUM_IMAGE`
