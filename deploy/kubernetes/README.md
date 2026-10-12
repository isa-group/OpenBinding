# OpenBinding on Kubernetes

These manifests are a production-oriented, plain Kustomize deployment. They do
not install an ingress controller, certificate manager, storage class or
monitoring stack. OpenBinding remains portable and does not require Helm.

## Images and configuration

Build from the repository root so the gateway image contains the exact BIM
schemas and examples served by that revision:

```bash
docker build -f openbinding-gateway/Dockerfile -t registry.example/openbinding/gateway:0.1.0 .
docker build -f frontend/Dockerfile -t registry.example/openbinding/frontend:0.1.0 frontend
```

Build each engine from the same contexts used in `docker-compose.yml`, publish
all images, and replace every `openbinding/*:latest` reference (prefer immutable
digests in production).

Copy `base/secret.example.yaml` outside Git, generate independent random
values, and apply it. Set the deployment URLs in `base/config.yaml`; replace the
Ingress host and TLS secret. `SPHERE_ORGANIZATION_ID` must identify the single
SPHERE organization named `OpenBinding`. `SPACE_API_KEY` needs the MANAGEMENT
scope and is created in the remote SPACE console.

Validate and inspect before applying:

```bash
kubectl kustomize deploy/kubernetes >/tmp/openbinding.yaml
kubectl apply --server-side --dry-run=server -f /tmp/openbinding.yaml
kubectl apply -f /path/to/private/openbinding-secrets.yaml
kubectl apply -k deploy/kubernetes
kubectl -n openbinding rollout status deployment/gateway
kubectl -n openbinding rollout status deployment/worker
kubectl -n openbinding rollout status deployment/frontend
```

SPACE (`https://space.score.us.es`) and SPHERE are remote services; nothing of
them is deployed in the cluster. `SPACE_ENABLED=false` until configured. Both
are called server-to-server with their API key and are administered in their
native UIs.

## Operational model

- PostgreSQL is the source of truth; Redis carries durable Dramatiq messages
  and one-use CAS state. Redis AOF is enabled.
- Gateway and worker share the content-addressed artifact PVC. The base uses
  one replica and `ReadWriteOnce`; choose a storage class supporting
  `ReadWriteMany` before scaling them across nodes.
- The worker initializes PostgreSQL and the SPACE gate before consuming. It
  exits instead of acknowledging work when either mandatory dependency cannot
  initialize.
- `/health/live` proves process liveness. `/health/ready` verifies PostgreSQL
  and, when Dramatiq is selected, Redis. SPHERE/SPACE availability is reported
  separately in the pricing control room and does not make public reads fail.
- The namespace enforces the restricted Pod Security Standard and starts from
  default-deny network policy. HTTPS is mandatory for federated engines.
- Adminer/pgAdmin is intentionally absent. Emergency database inspection is a
  loopback-only `db-tools` Compose profile, never a production service.

## Backup and restore

The `postgres-backup` CronJob writes compressed custom-format dumps at 02:17
UTC and retains 30 days on the `backups` PVC. A PVC is not an off-site backup:
replicate encrypted dumps to separately administered storage and test restores
on a schedule.

Restore is intentionally manual and destructive:

1. Verify the dump checksum and copy it onto the `backups` PVC.
2. Announce maintenance, stop ingress traffic, and scale `gateway` and `worker`
   to zero.
3. Copy `restore-job.example.yaml`, set `BACKUP_FILE`, and apply it.
4. Inspect the Job logs and run `alembic current` from the gateway image.
5. Scale the gateway to one, verify `/health/ready`, then start the worker and
   reconcile abandoned jobs from the administration API.
6. Run a BIM corpus smoke test before reopening ingress.

Never restore over a live database. Preserve the pre-restore volume snapshot
until the application and audit export have been checked.

## Upgrades and rollback

Run the new image once in staging, apply its Alembic migration, verify the
OpenAPI snapshot and BIM corpus, then update image digests. Because the gateway
entrypoint applies migrations, the base deliberately uses one gateway replica
and `Recreate`. For larger installations, run migration as a controlled release
Job and override the entrypoint before scaling horizontally.

Rollback application images only when the database migration is backward
compatible. Pricing rollback is separate: select a previously public SPHERE
release in the control room, redeploy/reactivate it in SPACE, and move LIVE.
Existing contracts stay on their version until renewal.

## Incident checks

```bash
kubectl -n openbinding get pods,pvc,job
kubectl -n openbinding logs deployment/gateway --since=30m
kubectl -n openbinding logs deployment/worker --since=30m
kubectl -n openbinding get events --sort-by=.lastTimestamp
kubectl -n openbinding create job --from=cronjob/postgres-backup backup-manual
```

Export the audit ledger before purging anything. Use the admin maintenance
preview first, reconcile abandoned jobs, and revoke a compromised API key
instead of editing database rows directly.
