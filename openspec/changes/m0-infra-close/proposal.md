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

- F5: `bim-toolchain/docs/SERVICE.md:742,751-755` still gives Kubernetes advice, although ADR-0021 and
  `req~lab-deployment-compose-only~1` say Docker Compose is the only deployment tool.
- F9 (round-2 finding R2-REV-002, accepted for now): `nginx/production/nginx.conf` resolves `gateway` once, when nginx
  starts. After the Docker daemon restarts the gateway (crash, out-of-memory kill), nginx keeps the old address and the
  public origin answers 502 until someone runs `$DC restart nginx` (`docs/runbooks/production.md:410-426`).
- F1: the M0.9 acceptance "passes in CI for development, lab and production" is met only for development
  (`.github/workflows/ci.yml:424-425`). This change specifies the CI requirement; the job itself waits for a token.
- F4 and F7: the `prod` profile of `docker-compose.yml`, and non-root users with `cap_drop` for the Java engines,
  `nginx` and `frontend-assets`. Both wait for owner decision CRP-M09-2.
- M0.5 4.2 and 4.3: the preview documentation moves from plan to in force once the factory's `labctl preview` exists
  (factory prerequisite F2 of `m05-pr-previews`).

## What Changes

- New requirement `req~lab-deployment-compose-config-in-ci~1`: every CI run renders `docker-compose.yml` (profile
  `dev`), the production definition with its two env files and every `compose.lab*.json` with
  `docker compose config --quiet`, and a failure fails `ci-required`.
- Production nginx resolves `gateway` at request time through Docker's embedded DNS, so a recreated gateway is reached
  within 10 s without restarting nginx. The raw request URI reaches the gateway unchanged apart from the `/api` prefix
  (design.md D1, D2).
- `bim-toolchain/docs/SERVICE.md` loses its Kubernetes notes. The advice that does not depend on Kubernetes stays,
  worded for Docker Compose (design.md D3).
- `README.md` points to the open infra items of the production runbook (design.md D4).
- The slices that wait for an owner or factory decision (S2, S3, S4) are listed in tasks.md and not built here.

## Impact

- Capability: `lab-deployment` only. One ADDED requirement. F9, F5 and the README pointer add no requirement: they
  fix a known defect and remove stale documentation (design.md D5).
- Repository, slice S1: `nginx/production/nginx.conf`; the resolve-once comment of
  `deploy/compose/production/compose.yaml:353`; in `openbinding-gateway/tests/test_compose_production.py`, the
  resolve-once comments and the runbook assertions that pin F9 as open (tasks.md S1);
  `docs/runbooks/production.md`; `bim-toolchain/docs/SERVICE.md`; `README.md`; a new static test
  `openbinding-gateway/tests/test_production_nginx.py`; the F5 and F9 lines of `openspec/changes/m09-compose-only/tasks.md`.
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
- Request-time resolution in the lab and development proxies (`frontend/nginx.lab.conf`, `nginx/local/nginx.conf`).
- Rendering `compose.pgtest.json` in CI (design.md §6, Q1).
- Editing `openspec/specs/**`, `docs/adr/**`, ROADMAP or INTENT; archiving.
