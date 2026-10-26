# Design: m09-compose-only

Status: specified. No slice is built. Inputs:

- ROADMAP M0.9 and ADR-0021 decisions 1-4;
- the intake `docs/agent-work/m09-compose-only/intake.md` (facts F1-F22, §4 contract, slices S0-S5);
- the living spec `openspec/specs/lab-deployment/spec.md`.

## 1. Interface contract (fixed before the parallel slices)

S2 implements this contract. S3 and S4 rely on it. It is the contract of intake §4.

### 1.1 `OPENBINDING_MIGRATE` (gateway image entrypoint)

| Value | Behaviour | Exit |
|---|---|---|
| `auto`, unset or empty (default) | today's behaviour: `alembic upgrade head` when `DATABASE_URL` is non-empty, then `exec "$@"` | the command's |
| `skip` | never migrate, then `exec "$@"` | the command's |
| `only` | `alembic upgrade head`, then exit without running the command | 0, or the migration's non-zero status |
| `only` with an empty `DATABASE_URL` | message on stderr naming `OPENBINDING_MIGRATE`, nothing runs | 2 |
| any other value | message on stderr naming `OPENBINDING_MIGRATE`, nothing runs | 2 |

### 1.2 `<NAME>_FILE` secrets

- NAME is one of `DATABASE_URL`, `GATEWAY_JWT_SECRET`, `SPACE_API_KEY`, `SPHERE_API_KEY`, `SECRETS_FERNET_KEYS`,
  `FEDERATION_SECRET_KEY` and `BOOTSTRAP_ADMIN_PASSWORD`.
- When `<NAME>_FILE` is non-empty, the path must be a readable regular file. Its content, with trailing newlines
  removed, is exported as NAME before the migration step.
- If NAME is also non-empty, or the file is missing, not a regular file or unreadable, the entrypoint exits with
  status 2. The message names `<NAME>_FILE` and never prints the value, neither on error nor on success.
- The file variables are resolved before the mode is checked, so `only` can read `DATABASE_URL_FILE`.

### 1.3 Script constraints

- POSIX `sh`, `set -e`. The last code line stays `exec "$@"`. No `chown`, `chmod`, `su`, `sudo`, `gosu` or `setpriv`
  (`openbinding-gateway/tests/test_container_hardening.py:185-195`).
- The text `alembic upgrade head` stays in the script (`lab/tests/test_lab_compose.py:658-663`).

### 1.4 Use in production

- `migrate` runs the gateway image with `OPENBINDING_MIGRATE=only` and `restart: "no"`.
- `gateway` uses `skip` and depends on `migrate` with `condition: service_completed_successfully`.
- `worker` and `analysis-worker` set `entrypoint: ["/usr/local/bin/docker-entrypoint.sh"]` and
  `OPENBINDING_MIGRATE=skip`, so they also read `_FILE` secrets. Today they bypass the entrypoint with
  `entrypoint: []` (`docker-compose.yml:224`).

### 1.5 Secret files under `${OPENBINDING_SECRETS_DIR}`

`postgres_password`, `database_url`, `gateway_jwt_secret`, `space_api_key`, `sphere_api_key`, `secrets_fernet_keys`
and `bootstrap_admin_password`. `postgres` reads `POSTGRES_PASSWORD_FILE`, and `pg-backup` reads the same file. Only
`gateway` mounts `gateway_jwt_secret` (`req~lab-deployment-jwt-secret-scope~1`). `FEDERATION_SECRET_KEY` is a legacy
key read after `SECRETS_FERNET_KEYS`, so production has no secret file for it. The entrypoint still supports
`FEDERATION_SECRET_KEY_FILE` for other environments.

## 2. Production file layout (S3)

- `deploy/compose/production/compose.yaml`, standalone, `name: openbinding-production`.
- Services:
  - `postgres` and `redis`;
  - `migrate`;
  - `gateway`, `worker` and `analysis-worker`;
  - `engine-minizinc`, `engine-random-search`, `engine-many-heuristic` and `engine-evolutionary-heuristics`;
  - `frontend-assets` (the `frontend-prod` pattern of `docker-compose.yml:485-502`);
  - `nginx`, the only service that publishes ports (80 and 443);
  - `pg-backup`.
- A shared `x-logging` anchor (`json-file`, `max-size: 10m`, `max-file: "5"`).
- A named network with a fixed IPAM subnet. `FORWARDED_ALLOW_IPS` is that subnet.
- The environment keys follow the `prod` services of `docker-compose.yml`, with `APP_ENV=prod`.
- `deploy/compose/production/images.env`: one `<NAME>_IMAGE=<name>:<tag>@sha256:<64 hex>` per image.
  - Third-party images (postgres, redis, and the nginx base if it is pulled) get real digests found through a lookup,
    never guessed.
  - Images of this repository get `gap.invalid/<name>:0.0.0@sha256:<64 zeros>`. This follows the `gap.invalid`
    pattern of `openbinding-gateway/tests/test_no_local_space.py:19-21`.
- `deploy/compose/production/ci.env`: placeholders for the site variables (`PUBLIC_ORIGIN`, `OPENBINDING_SECRETS_DIR`,
  `OPENBINDING_BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `NGINX_SSL_DIR`, `SPACE_URL`). It holds no secret value. It lets
  `docker compose config` parse the file in CI, because Compose does not read secret `file:` paths when it renders the
  configuration (intake F22, medium confidence; S3 verifies it).
- `pg-backup` runs a shell loop: `pg_dump -Fc` into the mounted `${OPENBINDING_BACKUP_DIR:?}`, then deletes dumps older
  than `${BACKUP_RETENTION_DAYS:?}` days, then sleeps 86400 s. Shell variables are escaped as `$$` so that Compose
  does not interpolate them. The password comes from `/run/secrets/postgres_password`.
- Starting limits: the `mem_limit` values of `compose.lab.json`, recorded in the runbook as starting values until the
  owner gives the host size (Q3).

## 3. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Where secrets are read | the gateway entrypoint (`<NAME>_FILE`); the defaults keep today's behaviour | pydantic `secrets_dir` in `core/settings.py`: `src/**` belongs to other leads; possible later |
| Migrations | one-shot `migrate` service (`only`); gateway and workers `skip` | migrate in each gateway start: with `--scale` or a restart, several containers race on the same schema, and ADR-0021 asks for one-shot migrations |
| Workers and the entrypoint | workers opt into the entrypoint with `skip`, to get `_FILE` support | a second script for workers: two copies of the secret logic |
| Images of this repository | `gap.invalid/…@sha256:0…` markers until a registry exists (CRP-4) | tag-only references, or digests of local builds: neither is pinned to a published artifact |
| Production layout | standalone `compose.yaml` (assumption CRP-2, §4) | `docker-compose.yml --profile prod` plus an override (§4) |
| SPACE in production | remote only (`SPACE_URL`, key as a secret file); no SPACE or SPHERE service. The owner chose `local-space` for later; a follow-up change adds it (CRP-1, §4) | a local SPACE now: needs an INTENT change and an exception in `test_no_local_space.py`, which another change is rewriting |
| Test location | `openbinding-gateway/tests/test_no_kubernetes.py` and `openbinding-gateway/tests/test_compose_production.py` (the S0 contract fixes these paths). S2 creates `test_compose_production.py` with the entrypoint subprocess tests. S3 then extends it with the Compose static tests, and S4 with the runbook tests, in that order; the lead serializes the file (tasks.md, Order) | `lab/tests/…`, as the intake proposed: `lab/` is not among the OFT trace paths (`openspec/changes/m41-space-lab-profile/tasks.md`), so tags there would not be traced |
| Runbook location | `docs/runbooks/production.md` (the S0 contract fixes this path) | `deploy/compose/production/RUNBOOK.md`, as the intake proposed. ADR-0021 says "a runbook next to its overlay"; the README and `compose.yaml` header point to it |
| Feature flag | none | nothing deploys the production file without the owner's order, and the entrypoint changes act only when the new variables are set |
| CI `compose config` job | a followup, not a requirement of this change (§8) | a delta requirement now: it could not be met without the workflow token |

## 4. Assumptions pending the owner

- **CRP-1, SPACE in production.** The owner decided `local-space`: production eventually runs its own SPACE
  (`space-api`, `space-mongo`, `space-redis`, like `compose.lab-pricing.json`). This change still ships remote SPACE
  only, because `openbinding-gateway/tests/test_no_local_space.py` is being rewritten by another change.
  - The gateway gets `SPACE_URL` from the site environment and `SPACE_API_KEY` from the `space_api_key` secret file.
  - The production file has no SPACE or SPHERE service, network or volume. `req~lab-deployment-no-local-space~1` and
    its revision in `m41-space-lab-profile` already scan `deploy/**`.
  - A follow-up change must add `space-api`, `space-mongo` and `space-redis` with digest-pinned images, secret files,
    health checks, limits and backups of the SPACE volumes, and amend `req~lab-deployment-no-local-space` and
    `test_no_local_space.py`. It also needs a new revision of `production-secret-files`.
  - The SPACE API image has no verified digest or registry (the `gap.invalid/space-api:1.7.1` marker of the lab
    pricing profile).
  - `INTENT.md:180` lists hosting SPHERE or SPACE in production as a non-goal and conflicts with the owner decision.
    `docs/ARCHITECTURE.md:494` says the local profile runs until `space.score.us.es` serves the latest release. The
    owner reconciles `INTENT.md`; until then plans stay blocked on remote SPACE.
  - The runbook records this in its section `Local SPACE (owner decision local-space)`.
- **CRP-2, the meaning of "overlay".** This design assumes a standalone `deploy/compose/production/compose.yaml`, like
  the lab files (intake F15), not an override of `docker-compose.yml --profile prod`. An override would:
  - inherit `${GATEWAY_JWT_SECRET:?}` (`docker-compose.yml:51`), so the secret would have to be in the environment;
  - need `!reset` to drop `build` (Compose ≥ 2.24.4);
  - keep the default password inside the base `DATABASE_URL` (`docker-compose.yml:50`).

  If the owner chooses the override, the image and secret requirements keep their meaning, but S3 and its test change
  shape.
- **CRP-4, image registry.** Until it exists, the production file cannot deploy (markers). The runbook's pre-flight
  refuses `gap.invalid`.
- **Q3, host facts.** CPU, RAM, disk, the Docker Engine and Compose versions, the backup retention and off-host target,
  and TLS issuance. The runbook states the starting values and marks them for confirmation.

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| An entrypoint regression breaks every gateway start (development, lab, previews, QACOBench) | high | `auto` default unchanged; subprocess tests with a fake `alembic` in `PATH`; the existing hardening and lab tests stay green; a lab smoke after merge (the lab sets no new variable) |
| A secret value leaks into logs through the entrypoint | high | no `set -x`; messages name only the variable; a test asserts the value is absent from stdout and stderr in each path |
| A wrong third-party digest | medium | digests come from a lookup with sources, never guessed; `docker compose config` does not pull, so the runbook pre-flight pulls by digest before the first install |
| Compose features with unconfirmed versions (`--profile "*"`, repeated `--env-file`, F22) | medium | S3 runs `docker compose config` locally through a registered check; the fallbacks are in the intake |
| The production file drifts from `docker-compose.yml` `prod` | medium | the environment keys follow the `prod` services; removing the `prod` profile is a followup after CRP-2 |
| The `kustomize` factory gate fails on the missing path (`.agentic/project.yaml:82`) | low | the owner removes it (§7) |
| M0.9 acceptance "`docker compose config` passes in CI for development, lab and production" stays partly open | medium | the CI job is the S5 followup (§8), blocked on the CRP-3 token |

## 6. Requirements and the slice that delivers each

| Requirement | Slice |
|---|---|
| `kustomize-render~1` (REMOVED) | S0 (this delta); archive |
| `compose-only~1` | S1 |
| `migrate-on-start~2` (MODIFIED) | S2 |
| `entrypoint-secret-files~1` | S2 |
| `production-pinned-images~1` | S3 |
| `production-secret-files~1` | S3 (relies on S2) |
| `production-health-restart~1` | S3 (relies on S2) |
| `production-limits-logs~1` | S3 |
| `production-backups~1` | S3 service; S4 snapshot procedure |
| `production-runbook~1` | S4 (on a base that includes S3) |

The three slices S2, S3 and S4 share `openbinding-gateway/tests/test_compose_production.py`. S2 creates it, then S3 and
S4 extend it one after the other.

In the delta, `Needs:` and `Evidence:` of `entrypoint-secret-files~1`, `production-pinned-images~1` and
`production-backups~1` sit after their scenarios. OpenSpec strict validation warns when the text before the first
scenario exceeds 500 characters.

## 7. Archive-time edits (owner steps)

The delta format has no section for the Purpose or the TODO list of a capability, so the archive task makes these
edits in `openspec/specs/lab-deployment/spec.md`:

- **Purpose** (lines 8-11): drop "and the Kustomize manifests (`deploy/kubernetes`)" and "`deploy/kubernetes/README.md`".
  Add the production definition `deploy/compose/production/` and the runbook `docs/runbooks/production.md`.
- **TODO** (line 134): replace "Backup/restore runbooks (`deploy/kubernetes/restore-job.example.yaml`)" with nothing;
  `production-backups~1` and `production-runbook~1` cover it.
- **Out of scope** (line 125): "Production deployment procedure (owner-only, from `main` tags; not specified here)"
  becomes "Running a production deployment (owner-only, from `main` tags); its definition and runbook are specified
  here".

Other owner-only edits (R11), recorded for CRP-3:

- `.agentic/project.yaml:82`: remove the `kustomize` gate;
- `.agentic/project.yaml:81`: add the production and lab `compose config` checks;
- `docs/adr/0021-docker-compose-only.md:54`: replace the removed step with the new CI job once it exists.

## 8. Followup: `docker compose config` in CI (intake S5)

This is not a requirement of this change. A new job `compose-config` in `.github/workflows/ci.yml` would have:

- `timeout-minutes: 10`;
- checkout with `persist-credentials: false`;
- no new actions (`lab/tests/test_ci_gate_tooling.py`).

It runs:

1. Development: the existing `.env` preparation, then `docker compose config --quiet`.
2. Lab: `docker compose -f <file> --profile "*" config --quiet` for each `compose.lab*.json` and
   `compose.pgtest.json`.
3. Production:
   ```
   docker compose -f deploy/compose/production/compose.yaml \
     --env-file deploy/compose/production/images.env \
     --env-file deploy/compose/production/ci.env config --quiet
   ```

A static test, `lab/tests/test_ci_compose_config.py`, would check that the job covers every lab file and the
production file. Pushing a workflow change needs a token with Workflows: write (CRP-3). A later change adds the
requirement `compose-config-in-ci` with the job.

## 9. Failure and rollback

- Reverting S2 restores the old entrypoint. No environment sets the new variables before S3, so nothing else changes.
- The production file is never started by this change. Reverting S3 or S4 deletes new files only.
- Reverting S1 deletes one test and one line in `AGENTS.md`.

## 10. Open questions

- CRP-2, CRP-4 and Q3 (§4); CRP-3 for the workflow token and the R11 edits (§7, §8). CRP-1 is answered (`local-space`,
  shipped later by a follow-up change, §4).
