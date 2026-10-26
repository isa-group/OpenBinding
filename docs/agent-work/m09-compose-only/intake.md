# Intake: m09-compose-only, ROADMAP M0.9 (Docker Compose only, ADR-0021)

- Kind: infrastructure, size M, risk high (deployment files and secret handling) · Base: `task/148c311616ef4980`
  at `99697d7e`
- Owner request: own-033e9b12c03448b28e474e292072c32c (2026-10-24, "start everything of the ROADMAP that can start").
- Milestone: `ROADMAP.md:45`. Deliverable: "`deploy/kubernetes/`, its CI step and its documentation removed; a
  `deploy/compose/production` overlay (images pinned by digest, secrets as files, health checks, backups, limits)
  with its runbook". Acceptance: "no Kubernetes file or step left; `docker compose config` passes in CI for
  development, lab and production".
- Rules it serves: ADR-0021 decision 1-4 (`docs/adr/0021-docker-compose-only.md:26-39`); constitution 6.9 and its
  open GAP "`docker compose config` of every environment in CI" (`constitution.md:76-80`).

## 1. Objective

Make Docker Compose the only, complete way to deploy, production included. Remove what is left of Kubernetes. Add a
production definition under `deploy/compose/production/` that follows ADR-0021 decision 3, with a runbook. Have CI run
`docker compose config` for development, every lab file and production.

## 2. Evidence checked against the code at `99697d7e`

| # | Fact | Evidence |
|---|---|---|
| F1 | **`deploy/kubernetes/` no longer exists.** No file under `deploy/`. | glob `deploy/**` is empty |
| F2 | **The CI step that rendered Kubernetes is gone.** No `kubectl`, `kustomize` or `kubernetes` in `.github/`. The only Compose validation is `docker compose config` of the development file, in job `test` | `.github/workflows/ci.yml:267-302` (`COMPOSE_PROFILES: dev,federated-example` at :270, `.env` prepared at :276-299) |
| F3 | The removal most likely landed with PR #27 ("Public origin of the demo, and Docker as the only deployment") and "Stop rendering the retired local SPACE Kubernetes overlay". These are changelog titles; git history was not read | `frontend/src/content/changelog.generated.json:30,34` |
| F4 | Kubernetes leftovers: the factory gate `kustomize` runs `kubectl kustomize deploy/kubernetes`, which fails on a missing path. `.agentic/**` is R11 (owner) | `.agentic/project.yaml:82,139` |
| F5 | Leftovers in the living spec: Purpose names `deploy/kubernetes` and its README. `req~lab-deployment-kustomize-render~1` and a TODO about a restore job are still there. `openspec/specs/**` is R11 and changes only through an archive | `openspec/specs/lab-deployment/spec.md:10-11,111-121,134`; `project.yaml:139` |
| F6 | Other leftovers: AGENTS.md says "`deploy/kubernetes/` is being removed". ADR-0021 cites the removed step "Render the base Kubernetes manifests" as evidence. The bim-toolchain service doc gives Kubernetes notes, and the bim-service settings ignore Kubernetes-injected variables (correct behaviour, kept) | `AGENTS.md:36`; `docs/adr/0021-docker-compose-only.md:54`; `bim-toolchain/docs/SERVICE.md:742,751-752`; `bim-toolchain/packages/bim-service/src/bim_service/settings.py:5` |
| F7 | Production today is the `prod` profile of `docker-compose.yml`: `gateway`, `worker`, `analysis-worker`, `frontend-prod`, `nginx`, four engines, `postgres`, `redis`. Everything is **built**, not pulled, so nothing is pinned by digest. No service has `restart`, limits or `logging`. Third-party images are tag-only (`postgres:16-alpine`, `redis:7.4-alpine`) | `docker-compose.yml:7-9,24-26,36-42,217-223,270-272,345-417,485-551`; grep `restart\|mem_limit\|cpus\|logging` finds nothing |
| F8 | Secrets are environment values. `POSTGRES_PASSWORD` defaults to `openbinding` and is inlined into `DATABASE_URL`. `GATEWAY_JWT_SECRET` is `${…:?}` (needed even to parse the file). `SPACE_API_KEY`, `SPHERE_API_KEY` and `SECRETS_FERNET_KEYS` come from the environment | `docker-compose.yml:13,50-51,62,72,81`; `.env.example:15-24` |
| F9 | The gateway has no secrets-from-files support: `Settings` has no `secrets_dir`, and only the BIM token is read from a file. `src/**` belongs to other leads | `openbinding-gateway/src/openbinding_gateway/core/settings.py:122-134,204` |
| F10 | `docker-entrypoint.sh` runs `alembic upgrade head` when `DATABASE_URL` is set, then `exec "$@"`. The gateway image uses it as its entrypoint. Workers bypass it (`entrypoint: []`) | `openbinding-gateway/docker-entrypoint.sh:12-17`; `openbinding-gateway/Dockerfile:71-72,117`; `docker-compose.yml:224` |
| F11 | The entrypoint is guarded by tests: no `chown/chmod/su/sudo/gosu/setpriv`, and the last code line is `exec "$@"`. A lab test asserts the text `alembic upgrade head`. The QACOBench gateway image copies the same script | `openbinding-gateway/tests/test_container_hardening.py:185-195`; `lab/tests/test_lab_compose.py:658-663`; `experimentation/qacobench/Gateway.Dockerfile:24-26` |
| F12 | The gateway refuses `APP_ENV=prod` without a JWT secret and without SPACE | `core/settings.py:440-455,497` |
| F13 | ADR-0021 decision 3 for production: digest-pinned images built by CI from a tag, secrets as files, a health check and `restart: unless-stopped` on every long-running service, one-shot migrations before the gateway, scheduled `pg_dump` plus volume snapshots, CPU and memory limits, log rotation | `docs/adr/0021-docker-compose-only.md:30-37` |
| F14 | No workflow builds or publishes images. `.github/workflows/` holds only `ci.yml` and `nightly.yml`, and neither pushes | glob `.github/**` |
| F15 | The lab files are standalone Compose projects, each with its own top-level `name`, not overlays of `docker-compose.yml`. None uses `${VAR:?}`. The lab validator forbids `secrets`, `deploy` and `extends`, so the production file can never run through `lab_compose` | `compose.lab.json:2`; `openspec/changes/m41-space-lab-profile/design.md:11`; grep `\$\{[A-Z_]+:?\?` in `compose.*.json` = 0; `lab/tests/test_lab_compose.py:28-32` |
| F16 | `test_no_local_space.py` scans every YAML/JSON under `deploy/**` and fails on a SPACE or SPHERE service, network or volume | `openbinding-gateway/tests/test_no_local_space.py:92-120` |
| F17 | Production SPACE is contradictory: INTENT lists "Hosting SPHERE or SPACE in production" as a non-goal. ARCHITECTURE runs "the same local profile until `space.score.us.es` runs the latest release". D5 covers only environments outside production | `INTENT.md:180,249`; `docs/ARCHITECTURE.md:494` |
| F18 | The target layout puts lab files under `deploy/compose/` and moves `nginx/` and `up.sh` to `deploy/`. That is the M9.4 move, not M0.9 | `docs/ARCHITECTURE.md:599,617-623`; `ROADMAP.md:187` |
| F19 | README documents production as `docker compose --profile prod up -d --build` | `README.md:117-128` |
| F20 | `deploy/**`, `docker-compose.yml`, `compose.*.json`, `nginx/**` and `.github/**` are R10 (high) | `.agentic/project.yaml:134-136` |
| F21 | CI may only use the allowed actions (checkout, setup-python, setup-uv, …). Lab tests check the workflow's hardening | `lab/tests/test_ci_gate_tooling.py:40-48,245-268` |
| F22 | Compose facts (lookup, medium confidence; verify in S3/S5). `config` does not stat secret `file:` paths. `--profile "*"` enables every profile (version unknown). `!reset` needs Compose ≥ 2.24.4. Repeated `--env-file` comes from compose PR #10284 (2023-02), first release unconfirmed | compose-go `loader/validate.go`; docs.docker.com/compose/how-tos/profiles; github.com/docker/compose/releases/tag/v2.24.4; github.com/docker/compose/pull/10284 |

The first acceptance half, "no Kubernetes file or step left", is already met for files and CI (F1, F2). What remains:
the factory gate (F4), the spec (F5) and the wording (F6).

## 3. Scope

In scope:

- Spec delta for `lab-deployment`: remove `kustomize-render~1`; modify `migrate-on-start`; add production and
  compose-config requirements.
- A guard test that no orchestrator manifest or step comes back. Rewording `AGENTS.md:36`.
- `docker-entrypoint.sh`: `<NAME>_FILE` secrets and a migration mode. Opt-in, so today's behaviour is unchanged.
- `deploy/compose/production/`: `compose.yaml`, `images.env`, `ci.env`, `RUNBOOK.md`, plus their static tests.
- A CI job that runs `docker compose config` for development, each lab file and production.

Non-goals: the M9.4 layout move (F18); image publishing (CRP-4); any `src/**` change; removing the `prod` profile from
`docker-compose.yml` (followup after CRP-2); running production (owner only, `INTENT.md:205,236`); `bim-toolchain/**`
docs (F6, followup).

## 4. Interface contract (fixed before the parallel slices)

S2 implements it; S3 and S4 rely on it.

- `OPENBINDING_MIGRATE`:
  - `auto` (default): today's behaviour, migrate when `DATABASE_URL` is set.
  - `skip`: never migrate.
  - `only`: migrate, then exit 0 without running the command (exit 2 if `DATABASE_URL` is empty).
  - Any other value: exit 2 with a message.
- `<NAME>_FILE`, for NAME in `DATABASE_URL`, `GATEWAY_JWT_SECRET`, `SPACE_API_KEY`, `SPHERE_API_KEY`,
  `SECRETS_FERNET_KEYS`, `FEDERATION_SECRET_KEY`, `BOOTSTRAP_ADMIN_PASSWORD`. When set, the file must be a readable
  regular file. Its content, without a trailing newline, is exported as NAME before migrating. If NAME is also
  non-empty, or the file is missing or unreadable, exit 2. The message names the variable and never prints the value.
- POSIX `sh`, `set -e`. The last code line stays `exec "$@"`. No privilege commands (F11).
- In production, the workers set `entrypoint: ["/usr/local/bin/docker-entrypoint.sh"]` and `OPENBINDING_MIGRATE=skip`.
  The gateway uses `skip`, and a one-shot `migrate` service uses `only`.
- Secret file names under `${OPENBINDING_SECRETS_DIR}`: `postgres_password`, `database_url`, `gateway_jwt_secret`,
  `space_api_key`, `sphere_api_key`, `secrets_fernet_keys`, `bootstrap_admin_password`.

## 5. Slices

Recommended: a feature flag is not needed. Nothing deploys the production file until the owner orders it, and the
entrypoint changes only act when the new variables are set. Every slice is complete and harmless alone.

| # | Slice | Role (model/effort) | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S0 | OpenSpec change `m09-compose-only`: proposal, design (§4 contract), tasks, delta `specs/lab-deployment/spec.md` (REMOVED `kustomize-render~1`; MODIFIED `migrate-on-start` to ~2 with the mode; ADDED `production-pinned-images`, `production-secret-files`, `production-health-restart`, `production-limits-logs`, `production-backups`, `compose-config-in-ci`; Purpose without Kubernetes) | specifier, default, about 30 turns | `openspec/changes/m09-compose-only/**` | F5, F13, this intake | ~180 | low (spec only) | coordinator grants the path (Q1) |
| S1 | Kubernetes leftovers and guard test | implementer, default, low effort, about 20 turns | `lab/tests/test_compose_only.py` (new), `AGENTS.md` | F1-F6, `.github/workflows/*.yml` | ~15 + test ~60 | low (no risk glob) | none |
| S2 | Entrypoint: secret files and migration mode (§4) | implementer, default, high effort, about 40 turns | `openbinding-gateway/docker-entrypoint.sh`, `openbinding-gateway/tests/test_entrypoint.py` (new) | F9-F12, `Dockerfile`, `Gateway.Dockerfile` | ~70 + test ~180 | **high**: runs at every gateway start in every environment and handles secrets | none (contract §4) |
| S3 | Production definition and its static test | implementer, default, high effort, about 50 turns | `deploy/compose/production/compose.yaml`, `deploy/compose/production/images.env`, `deploy/compose/production/ci.env`, `lab/tests/test_compose_production.py` (new) | F7-F17, F22, `docker-compose.yml`, `nginx/production/**`, `frontend/Dockerfile` (read only), `compose.lab.json` (limit values) | ~265 + test ~220 | **high**: R10 `deploy/**` (F20) | §4 contract; CRP-1, CRP-2 answered or defaults accepted |
| S4 | Production runbook and README pointer | doc-steward, default, medium effort, about 30 turns | `deploy/compose/production/RUNBOOK.md`, `README.md` (lines 117-128 only), `lab/tests/test_production_runbook.py` (new) | S3 files, §4, ADR-0021, `INTENT.md:205,236`, `docs/qa/PG_HARNESS.md` | ~220 + test ~60 | high by glob (`deploy/**`); documentation only | drafted in parallel; contract base must include S3 (its test reads `compose.yaml`) |
| S5 | CI job `compose-config` (development, lab, production) and its static test | implementer, default, medium effort, about 25 turns | `.github/workflows/ci.yml`, `lab/tests/test_ci_compose_config.py` (new) | F2, F15, F21, F22, S3 files | ~40 + test ~80 | **high**: R10 `.github/**`; **needs a token with Workflows: write** | S3 merged; CRP-3 (token) |

Parallel: S0, S1, S2 and S3 start together; their owned globs do not overlap. S4 can be drafted at the same time and
is finished on a base that includes S3. S5 comes last. Owner-only edits (CRP-3) are not a worker slice.

### Slice content (for the contracts)

- **S1.** The test asserts four things: no `deploy/kubernetes`; no `kustomization.y*ml` anywhere; no YAML with both
  `apiVersion:` and `kind:` outside `node_modules` and `.venv`; no `kubectl` or `kustomize` in `.github/workflows/*.yml`.
  It deliberately leaves out `.agentic/project.yaml` (R11, CRP-3). `AGENTS.md:36` becomes "`deploy/kubernetes/` was
  removed (ADR-0021); production lives in `deploy/compose/production/`". This is a regression guard on an
  already-true state, so G3 is n/a.
- **S2.** The test runs `sh docker-entrypoint.sh env` (or a printing command) through `subprocess`. It puts a fake
  `alembic` in a temporary `PATH` that records its calls, so no database is needed and the base never runs a real
  migration. It covers:
  - the three modes, and `auto` unchanged with and without `DATABASE_URL`;
  - `only` without `DATABASE_URL` (exit 2), and an invalid mode (exit 2);
  - each `_FILE` variable: trailing newline stripped, conflict, missing and unreadable file;
  - that no secret value appears in stdout or stderr on error.

  `test_container_hardening.py` and `test_lab_compose.py:663` must stay green.
- **S3.** `compose.yaml`, standalone, `name: openbinding-production` (CRP-2):
  - **Services:**
    - `postgres` (`POSTGRES_PASSWORD_FILE`), `redis`;
    - `migrate` (gateway image, `OPENBINDING_MIGRATE=only`, `restart: "no"`);
    - `gateway`, with `depends_on: migrate: service_completed_successfully`;
    - `worker`, `analysis-worker` (kept until M9.6);
    - the four engines;
    - `frontend-assets` (the `prod-assets` pattern of `docker-compose.yml:485-502`);
    - `nginx`, the only service that publishes ports (80/443);
    - `pg-backup`, a loop that runs `pg_dump -Fc` daily into `${OPENBINDING_BACKUP_DIR:?}` and deletes dumps older
      than `${BACKUP_RETENTION_DAYS:?}`. It reads the password from the secret file, using `$$` escapes.
  - **On every service:**
    - every image is `${…_IMAGE:?}` from `images.env`;
    - long-running services have a health check, `restart: unless-stopped`, `mem_limit`, `cpus` and the shared
      `x-logging` (`json-file`, `max-size` 10m, `max-file` 5).
  - **Secrets and environment:**
    - secrets are top-level `secrets:` with `file: ${OPENBINDING_SECRETS_DIR:?}/<name>`;
    - the JWT secret goes only to `gateway`;
    - there are no SPACE or SPHERE services (F16, CRP-1);
    - environment keys follow the `prod` services of `docker-compose.yml`, with `APP_ENV=prod`;
    - `FORWARDED_ALLOW_IPS` is the subnet of a named network with a fixed IPAM subnet.
  - **`images.env`:** every value is `name:tag@sha256:<64 hex>`.
    - Third-party images (postgres, redis, nginx base if pulled) get real digests, found through lookup and never
      guessed.
    - Images built from this repository use the marker `gap.invalid/<name>:0.0.0@sha256:<64 zeros>` until CRP-4,
      following the `SPACE_API_GAP_IMAGE` pattern (`test_no_local_space.py:19-21`).
  - **`ci.env`:** placeholders for the site variables (`PUBLIC_ORIGIN`, `OPENBINDING_SECRETS_DIR`,
    `OPENBINDING_BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `NGINX_SSL_DIR`, `SPACE_URL`). No secret values.
  - **The static test checks:**
    - the rules above;
    - every image reference is a `${…_IMAGE:?…}` and every `images.env` value matches the digest pattern;
    - no secret-named environment value is a literal or a `${…}`, only `<NAME>_FILE=/run/secrets/<name>`;
    - every secret source is under `${OPENBINDING_SECRETS_DIR`;
    - JWT scope, no published ports except nginx, and migrate ordering.
- **S4.** The runbook covers:
  - who orders a deployment (the owner);
  - host prerequisites: Compose version, CPU/RAM/disk (Q3);
  - secrets directory layout and modes (0400, owner uid);
  - `site.env` (never in Git);
  - first install;
  - deploying a release with `images.env` from the release PR, and the pre-flight that refuses `gap.invalid`;
  - verification: health, then `smoke_lab.py`-style checks against the public origin;
  - backups (schedule, retention, off-host copy);
  - volume snapshots of `pgdata` and `artifacts` (stop, `docker run --rm -v … tar`);
  - the restore drill;
  - rollback: previous `images.env`, plus a database restore when a migration is not backwards compatible;
  - rotation: the JWT secret (logs everyone out), Fernet keys (prepend a new key);
  - TLS renewal, `--scale worker=N`, log rotation;
  - what stays blocked (CRP-1, CRP-4).

  `README.md:117-128` points production to the runbook. The test asserts that the runbook names every service,
  secret file and `_IMAGE` variable of `compose.yaml`.
- **S5.** A new job `compose-config` in `ci.yml`: `timeout-minutes: 10`, checkout with `persist-credentials: false`,
  no new actions (F21). It runs:
  1. Development: the existing `.env` preparation (`ci.yml:276-299`) plus `docker compose config --quiet`.
  2. Lab: `docker compose -f <file> --profile "*" config --quiet` for each `compose.lab*.json` and
     `compose.pgtest.json`.
  3. Production: `docker compose -f deploy/compose/production/compose.yaml --env-file deploy/compose/production/images.env --env-file deploy/compose/production/ci.env config --quiet`.

  The step in job `test` stays (it guards the stack it starts). The static test asserts the job covers every lab
  file by glob and the production file, and stays hardened.

### Proposed checks (none registered for this change)

`cwd: openbinding-gateway` unless stated. `U` = `["uv", "sync", "--locked", "--extra", "test"]`. `P(x…)` =
`["uv", "run", "--locked", "--extra", "test", "pytest", "-q", x…]`. `R(x…)` = `["uv", "run", "--locked", "--extra",
"test", "ruff", "check", x…]`.

S0 (`cwd: .`): `["openspec", "validate", "m09-compose-only", "--strict"]` (gate G1; CLI 1.15.0 is in the worker);
`["git", "diff", "--check"]`.

S1: `U`; `P("../lab/tests/test_compose_only.py")`; `["uv", "run", "--locked", "--extra", "test", "pytest", "../lab/tests"]`
(the registered `lab-static`, `project.yaml:49`); `R("../lab/tests/test_compose_only.py")`.

S2:
1. `U`
2. red-before (G3): `{"argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "tests/test_entrypoint.py"], "type": "red_before", "expect_exit": [1], "expect_pattern": "_FILE", "overlay": ["openbinding-gateway/tests/test_entrypoint.py"]}`.
   On the base the script ignores `_FILE` and the mode, so the test fails by assertion. The fake `alembic` keeps it
   free of collection errors.
3. `P("tests/test_entrypoint.py", "tests/test_container_hardening.py", "tests/test_b3_migration.py", "../lab/tests/test_lab_compose.py")`
4. `["sh", "-n", "docker-entrypoint.sh"]`
5. `R("tests/test_entrypoint.py")`
6. G5: the registered `gateway-unit` (`project.yaml:44`), timeout about 1200 s.

S3:
1. `U`
2. red-before (G3): `{"argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "../lab/tests/test_compose_production.py"], "type": "red_before", "expect_exit": [1], "expect_pattern": "compose.yaml", "overlay": ["lab/tests/test_compose_production.py"]}`.
   The test body must `assert PRODUCTION.is_file(), "deploy/compose/production/compose.yaml"`, not fail in a fixture.
3. `P("../lab/tests/test_compose_production.py", "tests/test_no_local_space.py", "tests/test_compose_worker_secrets.py")`
4. `cwd: .`: `["docker", "compose", "-f", "deploy/compose/production/compose.yaml", "--env-file", "deploy/compose/production/images.env", "--env-file", "deploy/compose/production/ci.env", "config", "--quiet"]`
5. `R("../lab/tests/test_compose_production.py")`
6. `lab-static`

S4: `U`; `P("../lab/tests/test_production_runbook.py")`; `R("../lab/tests/test_production_runbook.py")`;
`cwd: .` `["git", "diff", "--check"]`.

S5:
1. `U`
2. red-before (G3) on `../lab/tests/test_ci_compose_config.py`, `expect_pattern` `compose-config`, overlay the new test.
3. `lab-static` (keeps `test_ci_gate_tooling.py` and `test_ci_triggers.py` green).
4. `cwd: .`: `["bash", "-c", "set -euo pipefail; for f in compose.lab*.json compose.pgtest.json; do docker compose -f \"$f\" --profile '*' config --quiet; done"]`
   This proves locally what CI will run. If `--profile '*'` is refused by the worker's Compose, drop it and record
   the version (F22).
5. S3 check 4.

## 6. Gates per slice

| Gate | S0 | S1 | S2 | S3 | S4 | S5 |
|---|---|---|---|---|---|---|
| G1 spec | **yes** (`openspec validate m09-compose-only --strict`) | via S0 | via S0 | via S0 | via S0 | via S0 |
| G2 EPIC | spec-auditor, threshold 2 | n/a | n/a | n/a | n/a | n/a |
| G3 red-before | n/a | n/a (guard of a true state, said in the contract) | **yes** | **yes** | n/a (test of a new doc; optional) | **yes** |
| G4 acceptance | trivially (no `acceptance/**`) | same | same | same | same | same |
| G5 green-after | n/a | checks 2-3 | checks 3, 6 | checks 3-4 | check 2 | checks 3-5 |
| G6 trace | requirement ids | `[utest->req~…]` tags on the new tests | same | same | same | same |
| G7 contracts | n/a: no API or schema change | n/a | n/a | n/a | n/a | n/a |
| G8 mutation | n/a (`todo: true`, `project.yaml:71-74`) | n/a | n/a | n/a | n/a | n/a |
| G9 quality | `git diff --check` | ruff | ruff, `sh -n` | ruff, `compose config` | ruff, `git diff --check` | ruff, `compose config` |
| G10 secrets/ownership | yes | yes | yes: no value echoed (test) | yes: no literal secret, `ci.env` holds placeholders only | yes: no real host names or keys | yes |
| G11 review | low panel | low panel `[reviewer]` | **high** panel (reviewer, test-reviewer, security-auditor, arch-reviewer) | **high** panel | high by glob; owner may lower it to `[reviewer]` | **high** panel |
| G12 lab/UI | n/a | n/a | lab smoke after merge: the lab sets no new variable, so `auto` must behave as before (`smoke_lab.py`) | n/a: the lab cannot run `secrets` (F15); `compose config` is the evidence; a full rehearsal is release work (R1) | n/a | the CI run on the PR is the evidence |
| G13 review package | `how_to_review` | `how_to_review` | `how_to_test`: API n/a, entrypoint runs shown by the test | `how_to_review` (read `compose.yaml` against ADR-0021 §3) | `how_to_review` | `how_to_review` + CI run link |

## 7. Owner decisions (CRP) and coordinator questions

- **CRP-1 SPACE in production** (F12, F16, F17). Options:
  - (a) remote SPACE only (`SPACE_URL`, key as a secret file). Production waits for M4.6 or uses the current
    `space.score.us.es`.
  - (b) a local SPACE in production. This needs an INTENT change (`INTENT.md:180`) and an exception in
    `test_no_local_space.py`.
  - (c) decide later; S3 ships (a), and the runbook marks plans blocked.

  Recommended: (a)/(c). Fix ARCHITECTURE:494 to match.
- **CRP-2 "overlay" meaning** (ADR-0021:28-29, F15). Options:
  - (a) a standalone `deploy/compose/production/compose.yaml`, like the lab files: no build, no dev services, and no
    `${GATEWAY_JWT_SECRET:?}` forced from the base (`docker-compose.yml:51`).
  - (b) `docker-compose.yml --profile prod` plus an override. The base's `:?` would need the secret in the
    environment; `build` would need `!reset` (Compose ≥ 2.24.4, F22); and the default password would stay in the
    base `DATABASE_URL`.

  Recommended: (a), with the `prod` profile of `docker-compose.yml` kept as "production-like local build" or removed
  in a followup.
- **CRP-3 owner-only edits and the workflow token:**
  - `.agentic/project.yaml:82`: remove `kustomize`.
  - `.agentic/project.yaml:81`: keep `compose-config` and add `compose-config-lab` and `compose-config-production`
    with the S5 check 4 and S3 check 4 argv.
  - `docs/adr/0021-docker-compose-only.md:54`: replace the removed step with the new CI job.
  - After the change, archive into `openspec/specs/lab-deployment/spec.md`.
  - **S5 changes `.github/workflows/ci.yml`. Pushing it needs a token with Workflows: write.** The pr-steward cannot
    push S5 without it.
- **CRP-4 image publishing** (F14, ADR-0021:31): the registry (e.g. `ghcr.io/isa-group/openbinding-*`), a
  tag-triggered build-and-push workflow with `packages: write` (also Workflows: write), and whether to sign images or
  produce an SBOM. This is not needed for the M0.9 acceptance, but production cannot deploy before it (the
  `gap.invalid` markers).
- Q1 (coordinator): `openspec/**` is reserved by other leads. S0 needs only `openspec/changes/m09-compose-only/**`,
  which is disjoint from every open change. Grant it, or schedule S0 after the reservation ends.
- Q2 (coordinator): `README.md` and `AGENTS.md` are not on the reserved list. Confirm that S4 and S1 may own them.
- Q3 (owner, facts for S3/S4): the production host's CPU, RAM and disk; its Docker Engine and Compose versions; the
  backup retention and off-host target; how TLS certificates are issued. S3 starts from the lab limits
  (`compose.lab.json` `mem_limit` values) and the runbook states them as starting values.
