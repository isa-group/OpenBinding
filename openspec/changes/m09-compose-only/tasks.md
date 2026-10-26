# Tasks: m09-compose-only

Each slice is at most about 300 non-test diff lines, owns disjoint files and writes its tests first. Check commands
run from `openbinding-gateway/` unless stated. `U` = `["uv", "sync", "--locked", "--extra", "test"]`; `P(x…)` =
`["uv", "run", "--locked", "--extra", "test", "pytest", "-q", x…]`; `R(x…)` =
`["uv", "run", "--locked", "--extra", "test", "ruff", "check", x…]`.

Order:

- S0, S1 and S2 start together; their owned files do not overlap.
- `openbinding-gateway/tests/test_compose_production.py` is shared, so the lead serializes it:
  - S2 creates it with the entrypoint tests;
  - S3 extends it with the Compose static tests, on a base that includes S2;
  - S4 extends it with the runbook tests, on a base that includes S3.
- S3 may draft `deploy/compose/production/**` in parallel with S2, and S4 may draft the runbook in parallel. Each
  writes the shared test file only in its turn.
- The CI job (F1 below) waits for S3 and the CRP-3 token. The archive comes last.

## S0. Specification (this change)
- [x] 0.1 `proposal.md`, `design.md` (§1 interface contract, decisions, risks, owner assumptions), `tasks.md`.
- [x] 0.2 Delta `specs/lab-deployment/spec.md`: REMOVED `kustomize-render~1`; MODIFIED `migrate-on-start` ~1 → ~2;
  ADDED `compose-only~1`, `entrypoint-secret-files~1`, `production-pinned-images~1`, `production-secret-files~1`,
  `production-health-restart~1`, `production-network~1`, `production-limits-logs~1`, `production-backups~1`,
  `production-runbook~1`.
- Checks (`cwd: .`): `["openspec", "validate", "m09-compose-only", "--strict"]` (G1); `["git", "diff", "--check"]`.

## S1. Kubernetes leftovers and guard test
- [ ] 1.1 `openbinding-gateway/tests/test_no_kubernetes.py` (new), tagged `[utest->req~lab-deployment-compose-only~1]`:
  - no `deploy/kubernetes`;
  - no `kustomization.y*ml` anywhere outside `.git`, `node_modules` and `.venv`;
  - no YAML file with both an `apiVersion:` line and a `kind:` line outside `.git`, `node_modules`, `.venv` and, for
    manifests only, `openspec`, `docs`, `lab` and `.github`;
  - no `kubectl` or `kustomize` in `.github/workflows/*.yml` and `*.yaml`;
  - an in-memory control for each rule.

  It leaves out `.agentic/project.yaml` (owner, CRP-3).
- [ ] 1.2 `AGENTS.md:36`: "`deploy/kubernetes/` was removed (ADR-0021); production lives in
  `deploy/compose/production/`".
- Checks: `U`; `P("tests/test_no_kubernetes.py")`; `R("tests/test_no_kubernetes.py")`. G3 is n/a: this guards a
  state that is already true.

## S2. Entrypoint: migration mode and secret files (design.md §1)
- [ ] 2.1 Tests first: S2 creates `openbinding-gateway/tests/test_compose_production.py` with the entrypoint cases, tagged
  `[utest->req~lab-deployment-migrate-on-start~2]` and `[utest->req~lab-deployment-entrypoint-secret-files~1]`. They
  run `sh docker-entrypoint.sh <command>` through `subprocess`, with a fake `alembic` in a temporary `PATH` that
  records its calls, and cover:
  - the three modes, with `auto` unchanged with and without `DATABASE_URL`;
  - `only` without `DATABASE_URL`, and an invalid mode (exit 2);
  - each `_FILE` variable: trailing newline stripped, conflict, missing, directory and unreadable file;
  - no secret value in stdout or stderr.
- [ ] 2.2 `openbinding-gateway/docker-entrypoint.sh`: the §1 contract, POSIX `sh`, `set -e`, last code line
  `exec "$@"`, no privilege commands, `[impl->…]` tags as comments.
- Checks:
  - `U`;
  - red-before (G3) on the new tests (they fail by assertion on the base);
  - `P("tests/test_compose_production.py", "tests/test_container_hardening.py", "tests/test_b3_migration.py", "../lab/tests/test_lab_compose.py")`;
  - `["sh", "-n", "docker-entrypoint.sh"]`;
  - `R("tests/test_compose_production.py")`;
  - the registered `gateway-unit`.
- Risk high: every gateway start runs it. G12: a lab smoke after merge.

## S3. Production definition and its static test (design.md §2)
- [ ] 3.1 Tests first, on a base that includes S2: S3 extends `openbinding-gateway/tests/test_compose_production.py`
  with the static cases, one rule per requirement, applied to the real files and to mutated in-memory copies. They are tagged
  `[utest->req~lab-deployment-production-pinned-images~1]`, `…-production-secret-files~1`,
  `…-production-health-restart~1`, `…-production-network~1`, `…-production-limits-logs~1` and
  `…-production-backups~1`. The test body asserts
  `deploy/compose/production/compose.yaml` is a file (it does not fail in a fixture).
- [ ] 3.2 `deploy/compose/production/compose.yaml`: standalone, `name: openbinding-production`, with the services of
  design.md §2, top-level file secrets, `x-logging`, limits, health checks, `migrate` before `gateway`, and
  `pg-backup`. No SPACE or SPHERE service (CRP-1).
- [ ] 3.3 `deploy/compose/production/images.env`: real digests for third-party images (by lookup, never guessed),
  and `gap.invalid/<name>:0.0.0@sha256:<64 zeros>` for images of this repository (CRP-4).
- [ ] 3.4 `deploy/compose/production/ci.env`: placeholders for the site variables, no secret values.
- Checks:
  - `U`;
  - red-before (G3) on the static tests;
  - `P("tests/test_compose_production.py", "tests/test_no_local_space.py", "tests/test_compose_worker_secrets.py")`;
  - `cwd: .`: `["docker", "compose", "-f", "deploy/compose/production/compose.yaml", "--env-file", "deploy/compose/production/images.env", "--env-file", "deploy/compose/production/ci.env", "config", "--quiet"]`;
  - `R("tests/test_compose_production.py")`;
  - `lab-static`.
- S3 writes `tests/test_compose_production.py` only after S2 has merged. The lead serializes the file (see Order).

## S4. Production runbook and README pointer
- [ ] 4.1 Tests first, on a base that includes S3: S4 extends `openbinding-gateway/tests/test_compose_production.py`
  with the runbook cases, tagged
  `[utest->req~lab-deployment-production-runbook~1]` and `[utest->req~lab-deployment-production-backups~1]`. Every
  service, secret and `_IMAGE` variable of `compose.yaml` is named. The snapshot section names `pgdata`,
  `artifacts` and the restore drill.
- [ ] 4.2 `docs/runbooks/production.md`. It covers:
  - who orders a deployment (the owner);
  - host prerequisites (starting values, Q3);
  - the secrets directory layout and modes (0400, owner uid);
  - `site.env` (never in Git);
  - first install;
  - deploying a release with `images.env` from the release PR, with a pre-flight that refuses `gap.invalid`;
  - verification;
  - backups (schedule, retention, off-host copy);
  - volume snapshots of `pgdata` and `artifacts`;
  - the restore drill;
  - rollback;
  - rotation of the JWT secret and the Fernet keys;
  - TLS renewal, `--scale worker=N` and log rotation;
  - what stays blocked (CRP-1, CRP-4).
- [ ] 4.3 `README.md` production lines (117-128): point to the runbook.
- Checks: `U`; `P("tests/test_compose_production.py")`; `R("tests/test_compose_production.py")`; `cwd: .`
  `["git", "diff", "--check"]`.

## Followups outside this change
- [ ] F1 CI job `compose-config` (intake S5, design.md §8): `docker compose config` for development, each
  `compose.lab*.json` and `compose.pgtest.json`, and production, plus `lab/tests/test_ci_compose_config.py`. Needs a
  token with Workflows: write (CRP-3). A later change adds the requirement `compose-config-in-ci`. Until then the M0.9
  acceptance "`docker compose config` passes in CI for development, lab and production" is met only for development.
- [ ] F2 Owner (CRP-3, R11):
  - remove the `kustomize` gate (`.agentic/project.yaml:82`);
  - add the lab and production `compose config` checks (`:81`);
  - update the evidence line of ADR-0021 (`:54`).
- [ ] F3 Owner: answer CRP-2 (standalone file or override), CRP-4 (image registry and publish workflow) and Q3 (host
  facts). CRP-1 is answered: `local-space` (see F6).
- [ ] F6 Local SPACE in production (owner decision `local-space`). This change ships remote SPACE only. A follow-up
  change adds `space-api`, `space-mongo` and `space-redis` to `deploy/compose/production/compose.yaml` with
  digest-pinned images, secret files, health checks, limits and backups of the SPACE volumes, and amends
  `req~lab-deployment-no-local-space` and `openbinding-gateway/tests/test_no_local_space.py`. The SPACE API image has no
  verified digest or registry. The owner reconciles `INTENT.md:180` (hosting SPACE in production is listed as a
  non-goal). See the runbook section `Local SPACE (owner decision local-space)`.
- [ ] F4 After CRP-2: remove or rename the `prod` profile of `docker-compose.yml`.
- [ ] F5 `bim-toolchain/docs/SERVICE.md:742,751-752`: drop the Kubernetes notes.
- [ ] F7 Non-root user and `cap_drop` for the Java engines, `nginx` and `frontend-assets` (round-1 finding
  R1-SEC-003, accepted for now). Today they run as the user of their image with the default capabilities, and
  `compose.yaml` sets only `no-new-privileges`. A `user` and `cap_drop: [ALL]` depend on the writable paths and ports
  of each image and cannot be verified without Docker, so a follow-up change renders and tests them on a host with
  Docker. Recorded in the runbook section "What stays blocked".
- [ ] F8 Owner: extend the OFT trace paths so that the `[impl->…]` tags in `docker-entrypoint.sh` and
  `deploy/compose/production/compose.yaml`, and the `[utest->…]` tags in `openbinding-gateway/tests/`, are traced
  (the project configuration is owner-only).
- [ ] F9 Nginx resolver (round-2 finding R2-REV-002, accepted for now): `nginx.conf` resolves `gateway` once, when
  nginx starts, so after a restart of the gateway by the Docker daemon (crash, OOM) nginx keeps the old address until
  it is restarted. The runbook says to run `$DC restart nginx` then. A follow-up change makes nginx resolve the name
  at request time (`resolver 127.0.0.11` with a variable in `proxy_pass`), which needs the image configuration and a
  host with Docker to test.

## A. Archive (explicit archive task, after S1-S4)
- [ ] `["openspec", "archive", "m09-compose-only", "--yes"]`, then the Purpose, TODO and Out-of-scope edits of
  design.md §7 in `openspec/specs/lab-deployment/spec.md`, then `["openspec", "validate", "--all", "--strict"]`.
