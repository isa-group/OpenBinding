# Change: m0-infra-close

## Why

ROADMAP M0.9 (`ROADMAP.md:45`): "Docker Compose only (ADR-0021) ... a `deploy/compose/production` overlay (images
pinned by digest, secrets as files, health checks, backups, limits) with its runbook", accepted when "no Kubernetes
file or step left; `docker compose config` passes in CI for development, lab and production". ROADMAP M0.5
(`ROADMAP.md:41`): "PR previews". INTENT §9 hard constraint (`INTENT.md:201`): "Docker Compose deploys every
environment: development, laboratory, previews and production". The owner request names the objective as a
reproducible lab deployment. INTENT has no objective worded that way: its "reproducibility" objectives O3 and O4
(`INTENT.md:164-165`) are about experiments. So this change anchors it on that §9 constraint: every deployment
definition in the repository renders in CI, and the proxy in front of the gateway keeps working when Compose replaces
the gateway container.

M0.9 shipped with change `m09-compose-only`, which left nine follow-ups open (`m09-compose-only/tasks.md`, F1 to F9).
M0.5 (`m05-pr-previews`) has two open documentation tasks, 4.2 and 4.3. This change closes that infra tail in slices:

- F5: before S1, `bim-toolchain/docs/SERVICE.md:742,751-755` gave Kubernetes advice, although ADR-0021 and
  `req~lab-deployment-compose-only~1` say Docker Compose is the only deployment tool.
- F9 (round-2 finding R2-REV-002, accepted for now): before S1, `nginx/production/nginx.conf` resolved `gateway` once,
  when nginx started. After the Docker daemon restarts the gateway (crash, out-of-memory kill), nginx kept the old
  address and the public origin answered 502 until someone ran `$DC restart nginx` (`docs/runbooks/production.md:410-426`).
- F1: the M0.9 acceptance "passes in CI for development, lab and production" is met only for development
  (`.github/workflows/ci.yml:424-425`). This change specifies the CI requirement; the job itself waits for a token.
- F4 and F7: the `prod` profile of `docker-compose.yml`, and non-root users with `cap_drop` for the Java engines,
  `nginx` and `frontend-assets`. Both wait for owner decision CRP-M09-2.
- M0.5 4.2 and 4.3: the preview documentation moves from plan to in force once the factory's `labctl preview` exists
  (factory prerequisite F2 of `m05-pr-previews`).

## What Changes

- New requirement `req~lab-deployment-compose-config-in-ci~1`: every CI run renders `docker-compose.yml` (profile
  `dev`), the production definition with its two env files and every `compose.lab*.json` (both with every
  profile enabled) with `docker compose config --quiet`, and a failure fails `ci-required`.
- New requirement `req~lab-deployment-production-proxy-upstream~1`: production nginx resolves `gateway` at request
  time through Docker's embedded DNS (cache of at most 10 s, resolver timeout of 5 s, 502 when the name does not
  resolve), so a recreated gateway is reached within 10 s without restarting nginx. The raw request URI reaches the
  gateway unchanged apart from the `/api` prefix, and an `/api/` request whose raw URI does not start with `/api/`
  gets 400 (design.md D1, D2).
- `bim-toolchain/docs/SERVICE.md` loses its Kubernetes notes. The advice that does not depend on Kubernetes stays,
  with no orchestrator named (design.md D3).
- `README.md` says that the project deploys with Docker Compose only and links `bim-toolchain/docs/SERVICE.md`
  (design.md D4).
- The production runbook says that nginx follows the gateway address at request time. Its restart steps stay as a
  precaution. F5 and F9 close completely in this change.
- The slices that wait for an owner or factory decision (S2, S3, S4) are listed in tasks.md and not built here.

## Impact

- Capability: `lab-deployment` only. Two ADDED requirements: the CI render (F1) and the production proxy behaviour
  (F9). F5 and the README pointer add no requirement: they remove stale documentation (design.md D5).
- Behaviour change for clients of the public origin: `/api/` requests reach the gateway with `//` and dot segments
  no longer normalised and percent escapes kept in the raw path (design.md §4, R2).
- Repository, slice S1 (built): `nginx/production/nginx.conf`, `bim-toolchain/docs/SERVICE.md`, `README.md`.
- Repository, slice S1b: `docs/runbooks/production.md`; the resolve-once comment of
  `deploy/compose/production/compose.yaml:353-354` (comment only); the phrases of
  `openbinding-gateway/tests/test_compose_production.py` that F9 made stale; a new static test
  `openbinding-gateway/tests/test_production_nginx.py`; the F5 and F9 lines of `openspec/changes/m09-compose-only/tasks.md`.
- Repository, R1 fix round: `resolver_timeout 5s` and the `[impl->…]` tag in `nginx/production/nginx.conf`, the
  `[utest->…]` tag in `test_production_nginx.py`, the runbook and `compose.yaml` comment corrections, and this
  change's documents (tasks.md R1).
- Repository, slice S3 (blocked): `.github/workflows/ci.yml` (new job `compose-config`) and
  `lab/tests/test_ci_compose_config.py`.
- The production nginx image (`nginx/production/Dockerfile`, image variable `NGINX_IMAGE`) and the `prod` profile of
  `docker-compose.yml` both copy `nginx/production/nginx.conf`, so both change behaviour in S1.
- No HTTP API, OpenAPI document or database schema changes. Nothing is deployed to production by this change; the
  owner orders every production deployment (INTENT §9).
- Risks: design.md §4.

## Out of scope

- Building S2, S3 and S4: they are blocked on CRP-M09-2, CRP-M09-3 (a token with Workflows: write) and factory F2 of
  `m05-pr-previews` (tasks.md).
- The owner-only follow-ups of `m09-compose-only`: F2 (`.agentic/project.yaml` gates and the ADR-0021 evidence line),
  F3 (CRP-4 and Q3), F6 (local SPACE in production) and F8 (OFT trace paths).
- The D1 and D2 behaviour for the lab and development proxies (`frontend/nginx.lab.conf`, `nginx/local/nginx.conf`):
  a follow-up (design.md §4, R6).
- Dropping `restart: true` of `nginx` on `gateway` (design.md §6, Q2).
- Rendering `compose.pgtest.json` in CI (design.md §6, Q1).
- Editing `openspec/specs/**`, `docs/adr/**`, ROADMAP or INTENT; archiving.
