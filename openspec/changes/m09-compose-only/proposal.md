# Change: m09-compose-only

## Why

ROADMAP M0.9 (`ROADMAP.md:45`): "`deploy/kubernetes/`, its CI step and its documentation removed; a
`deploy/compose/production` overlay (images pinned by digest, secrets as files, health checks, backups, limits) with
its runbook". Acceptance: "no Kubernetes file or step left; `docker compose config` passes in CI for development, lab
and production". It applies ADR-0021 (`docs/adr/0021-docker-compose-only.md`), decided by the owner on 2026-10-22:
Docker Compose is the only deployment tool, and its decision 3 lists the rules of the production definition. Owner
request own-033e9b12c03448b28e474e292072c32c (2026-10-24, "start everything of the ROADMAP that can start").

The Kubernetes files and CI step are already gone (intake F1, F2), but the living spec still requires that
`deploy/kubernetes` renders (`req~lab-deployment-kustomize-render~1`). Production today is the `prod` profile of
`docker-compose.yml`. Every image there is built, not pulled, so none is pinned by digest. No service has `restart`,
limits or log rotation. The database password defaults to `openbinding`. The gateway cannot read secrets from files
(intake F7-F10).

## What Changes

- The Kubernetes rendering requirement is removed, and a guard test keeps any Kubernetes or Kustomize manifest or
  `kubectl`/`kustomize` CI step from coming back (`openbinding-gateway/tests/test_no_kubernetes.py`).
- The gateway entrypoint gets a migration mode `OPENBINDING_MIGRATE` (`auto` by default, which keeps today's
  behaviour; `skip`; `only`) and reads seven secrets from `<NAME>_FILE` files. A conflict or a bad file stops the
  start with exit status 2, and the value is never printed.
- A standalone production definition `deploy/compose/production/compose.yaml` follows ADR-0021 decision 3:
  - images pinned by digest from `images.env`;
  - file secrets under `OPENBINDING_SECRETS_DIR`;
  - health checks and `restart: unless-stopped`;
  - a one-shot `migrate` service before the gateway;
  - memory and CPU limits and `json-file` log rotation;
  - a scheduled `pg-backup` service.
- A production runbook, `docs/runbooks/production.md`, names every service, secret file and image variable. It also
  covers volume snapshots, restore, rollback and secret rotation.
- Images built from this repository carry the marker `gap.invalid/<name>:0.0.0@sha256:0…` until an image registry
  exists, so the production file cannot start by accident with an unpublished image.

## Impact

- Capability: `lab-deployment` only. One REMOVED (`kustomize-render~1`), one MODIFIED (`migrate-on-start` ~1 → ~2)
  and eight ADDED requirements (design.md §6 maps each one to its slice).
- Repository:
  - `openbinding-gateway/docker-entrypoint.sh`;
  - `openbinding-gateway/tests/test_no_kubernetes.py` and `openbinding-gateway/tests/test_compose_production.py`
    (both new);
  - `deploy/compose/production/compose.yaml`, `images.env` and `ci.env` (new);
  - `docs/runbooks/production.md` (new);
  - `AGENTS.md:36` and the production lines of `README.md`.
- Every gateway start in every environment runs the changed entrypoint: development, the lab, previews and the
  QACOBench gateway image (`experimentation/qacobench/Gateway.Dockerfile`). The `auto` default and the opt-in
  `_FILE` variables keep their behaviour unchanged when no new variable is set.
- No HTTP API, OpenAPI document or database schema changes. Nothing is deployed to production by this change. The
  owner orders every production deployment (INTENT §9).
- Risks: design.md §5.

## Out of scope

- The CI job that runs `docker compose config` for development, every lab file and production (intake S5). Pushing a
  workflow change needs a token with Workflows: write (CRP-3), so it is a followup (design.md §8, tasks.md). Until
  then the M0.9 acceptance "passes in CI" is met only for development.
- Image publishing: a registry and a tag-triggered build-and-push workflow (CRP-4). Production cannot deploy before
  it exists.
- The M9.4 layout move of the lab files, `nginx/` and `up.sh` under `deploy/` (`ROADMAP.md:187`).
- Removing or renaming the `prod` profile of `docker-compose.yml` (a followup after CRP-2).
- File-secret support in the gateway `Settings` (`src/**`), and the Kubernetes notes in `bim-toolchain/docs/SERVICE.md`.
- A local SPACE or SPHERE in production (CRP-1, design.md §4).
- Running production, and editing the living spec, `.agentic/project.yaml` or ADR-0021 (owner steps, design.md §7).
