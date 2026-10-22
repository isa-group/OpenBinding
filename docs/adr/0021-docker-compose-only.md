Status: PROPOSED for owner review (2026-10-22)

# ADR-0021: Docker Compose deploys every environment

- Status: Proposed; decided by the owner on 2026-10-22
- Date: 2026-10-22
- Deciders: owner

## Context

The repository keeps Kustomize manifests in `deploy/kubernetes/`. CI renders them with `kubectl kustomize`. They sit
beside the Compose files that every environment actually uses:

- `docker-compose.yml` for development, with production-like `gateway`, `worker`, `frontend-prod` and `nginx`
  services;
- `compose.lab*.json` for the NiPoGi lab and its previews;
- `compose.pgtest.json` for the PostgreSQL concurrency tests;
- the QACOBench harness.

No environment runs on Kubernetes. The manifests drift, cost a CI step and documentation, and suggest an operating
model the group does not have. On 2026-10-22 the owner decided that only Docker deployments matter and that Docker
Compose is the first option for deploying everything, production included.

## Decision

1. Docker Compose is the only deployment tool. Development, the lab, PR previews, the develop preview and production
   are all Compose projects.
2. Every environment uses one base definition plus an overlay: `docker-compose.yml` for development, and
   `deploy/compose/` for the lab profiles and the `production` overlay.
3. The production overlay follows these rules:
   - images are pinned by digest and built by CI from a tag;
   - secrets are mounted as files, never written in the Compose file or the image;
   - every long-running service has a health check and `restart: unless-stopped`;
   - migrations run one-shot before the gateway starts;
   - PostgreSQL is backed up by a scheduled `pg_dump` service plus volume snapshots;
   - each service has memory and CPU limits;
   - logs rotate.
4. `deploy/kubernetes/`, its CI step and its documentation are removed. Bringing back an orchestrator needs a new
   ADR.

## Consequences

- One host per environment, so scaling is vertical. Workers scale with `docker compose up --scale`. Rolling updates
  and multi-host failover are out of scope (INTENT §8).
- CI validates every environment with `docker compose config` and the lab static checks (`lab/tests/`)
  (constitution 6.9).
- Production gets a runbook next to its overlay. The owner orders every production deployment (INTENT §9).

## Evidence

- `INTENT.md` §8 and §9
- `docs/ARCHITECTURE.md` §12 and §13
- `ROADMAP.md` M0.9
- `docker-compose.yml`, `compose.lab*.json`, `.github/workflows/ci.yml` (step "Render the base Kubernetes manifests")
