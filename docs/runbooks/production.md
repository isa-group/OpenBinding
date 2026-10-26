# Production runbook

How to install, deploy, verify, back up, restore, roll back and operate OpenBinding in production with Docker
Compose ([ADR-0021](../adr/0021-docker-compose-only.md)).

**Status: written against the contract of the production definition, which is built in parallel.** The files are
`deploy/compose/production/compose.yaml`, `images.env` and `ci.env`. A later task aligns the names below with the real
file. Where this runbook and `compose.yaml` disagree, `compose.yaml` wins and this runbook is the defect. Nothing here
has been run against a production host: the image registry, the production SPACE decision and the host facts are
still open (see [What stays blocked](#what-stays-blocked)).

## Contract used by this runbook

- Compose project name: `openbinding-production`.
- Services:
  - `postgres`, `redis`;
  - `migrate` (one-shot, `OPENBINDING_MIGRATE=only`);
  - `gateway`, `worker`, `analysis-worker`;
  - the four engines (`engine-minizinc`, `engine-random-search`, `engine-many-heuristic`,
    `engine-evolutionary-heuristics`);
  - `frontend-assets`;
  - `nginx`, the only service that publishes ports (80 and 443);
  - `pg-backup`, a daily `pg_dump -Fc` into `OPENBINDING_BACKUP_DIR`, keeping `BACKUP_RETENTION_DAYS` days.
- Secret files under `OPENBINDING_SECRETS_DIR`: `postgres_password`, `database_url`, `gateway_jwt_secret`,
  `space_api_key`, `sphere_api_key`, `secrets_fernet_keys`, `bootstrap_admin_password`.
- Image variables (`*_IMAGE`) come from `images.env` as `name:tag@sha256:digest`. A value of the form
  `gap.invalid/...@sha256:000...` means the image is not published yet.
- SPACE is remote only (`SPACE_URL`). There is no local SPACE or SPHERE service.

## Who may order a deployment

Only the owner orders a production deployment (`INTENT.md` §9 and §10; ADR-0021). Agents prepare the release pull
request and this runbook; they never run any command below against production. Anyone with host access follows these
steps only on the owner's written order that names the release.

## Host prerequisites

Starting values, **pending owner facts** (ROADMAP M0.9, question Q3). Replace them once the host is chosen.

| Item | Starting value | Status |
|---|---|---|
| Docker Engine and Compose plugin | Compose v2.24.4 or newer | pending owner fact (host versions unknown) |
| CPU | 4 cores | pending owner fact |
| RAM | 8 GiB | pending owner fact |
| Disk | 100 GiB, of which backups and snapshots are on a different volume | pending owner fact |
| Backup retention | 14 days (`BACKUP_RETENTION_DAYS`) | pending owner fact |
| Off-host backup target | none chosen | pending owner fact |
| TLS certificates | issuer not chosen | pending owner fact |

The per-service CPU and memory limits in `compose.yaml` start from the laboratory values and are tuned after the
first measured week.

```bash
docker version --format '{{.Server.Version}}'
docker compose version --short
```

## Secrets directory

Secrets are files outside the repository, mounted by Compose as `/run/secrets/<name>`. They are never written in the
Compose file, `images.env`, `site.env` or an image.

```text
/srv/openbinding/secrets/            (directory mode 0500, owned by the deployment user)
├── postgres_password                (0400)
├── database_url                     (0400)
├── gateway_jwt_secret               (0400)
├── space_api_key                    (0400)
├── sphere_api_key                   (0400)
├── secrets_fernet_keys              (0400)
└── bootstrap_admin_password         (0400)
```

The path is an example; the real one is `OPENBINDING_SECRETS_DIR` in `site.env`.

- `database_url` must use the same password as `postgres_password` and the host `postgres`.
- `secrets_fernet_keys` holds a comma-separated list of Fernet keys, newest first.
- The files are read by the container user through the bind mount, so the file owner must match the uid the service
  runs as. Check that uid in `compose.yaml` and do not widen the mode to make a mount work.
- A trailing newline in a secret file is tolerated: the entrypoint strips one.

```bash
install -d -m 0500 "$OPENBINDING_SECRETS_DIR"
umask 0277
printf '%s' "$(openssl rand -base64 32)" > "$OPENBINDING_SECRETS_DIR/postgres_password"
printf '%s' "$(openssl rand -base64 48)" > "$OPENBINDING_SECRETS_DIR/gateway_jwt_secret"
python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode(), end="")' \
  > "$OPENBINDING_SECRETS_DIR/secrets_fernet_keys"
# database_url, space_api_key, sphere_api_key, bootstrap_admin_password: write each the same way
ls -l "$OPENBINDING_SECRETS_DIR"
```

The SPACE and SPHERE keys have `MANAGEMENT` scope: treat them as high-risk and never reuse a development key
(`README.md`, "Development scope").

## site.env

`site.env` holds the per-host variables. It stays on the host and **never goes into Git**. `ci.env` in the repository
holds placeholders only, so that CI can render the file.

```bash
# /srv/openbinding/site.env  (mode 0600)
PUBLIC_ORIGIN=https://openbinding.example.org
OPENBINDING_SECRETS_DIR=/srv/openbinding/secrets
OPENBINDING_BACKUP_DIR=/srv/openbinding/backups
BACKUP_RETENTION_DAYS=14
NGINX_SSL_DIR=/srv/openbinding/tls
SPACE_URL=https://space.example.org
```

Use the names in `ci.env` as the list of required variables. `compose.yaml` uses `${VAR:?}` for them, so a missing
one stops `docker compose` with a message.

Every command below uses this prefix; define it once per shell:

```bash
cd deploy/compose/production
DC="docker compose -p openbinding-production -f compose.yaml --env-file images.env --env-file /srv/openbinding/site.env"
```

## First install

1. Prepare the host, the secrets directory, `site.env`, the backup directory and the TLS directory
   (`NGINX_SSL_DIR`, with the certificate and key that `nginx` expects).
2. Check out the release tag named in the owner's order, so `images.env` is the one of that release.
3. Run the [pre-flight](#pre-flight) and render the configuration:

   ```bash
   $DC config --quiet
   ```

4. Pull and start. `migrate` runs once and must exit 0 before `gateway` starts.

   ```bash
   $DC pull
   $DC up -d
   $DC ps -a
   ```

5. Create the first administrator from `bootstrap_admin_password` as described in the gateway documentation. The file
   stays in the secrets directory.
6. Run the [verification](#verification).

## Deploying a release

The release pull request carries the `images.env` of the release. Deploying is: pull the tag, pre-flight, pull
images, start.

### Pre-flight

The pre-flight refuses a release whose images are not published, and any value that is not pinned by digest.

```bash
cd deploy/compose/production
if grep -n 'gap\.invalid' images.env; then
  echo "refuse: images.env still has unpublished images (gap.invalid)" >&2
  exit 1
fi
if grep -vE '^\s*(#|$)|^[A-Z0-9_]+_IMAGE=[^@ ]+@sha256:[0-9a-f]{64}$' images.env; then
  echo "refuse: images.env has a value that is not name:tag@sha256:<64 hex>" >&2
  exit 1
fi
test -d "$OPENBINDING_SECRETS_DIR" && ls "$OPENBINDING_SECRETS_DIR"
$DC config --quiet
```

### Deploy

```bash
git fetch --tags && git checkout <release tag>
cp images.env "/srv/openbinding/releases/images.env.$(date +%Y%m%dT%H%M%S)"   # keep the previous one for rollback
$DC pull
$DC up -d
```

Take a backup first when the release adds a migration (see [Backups](#backups)). Compose recreates only the services
whose image or configuration changed; `migrate` runs again and applies the new revisions before `gateway` starts.

## Verification

1. All long-running services are healthy and `migrate` exited 0:

   ```bash
   $DC ps -a
   $DC logs migrate | tail -n 20
   ```

2. Only `nginx` publishes ports:

   ```bash
   $DC ps --format '{{.Service}} {{.Ports}}' | grep -E '0\.0\.0\.0|:::'
   ```

3. Public origin checks (from outside the host):

   ```bash
   curl -fsS -o /dev/null -w '%{http_code}\n' "$PUBLIC_ORIGIN/"
   curl -fsS "$PUBLIC_ORIGIN/api/health" 
   curl -fsS -o /dev/null -w '%{http_code}\n' "$PUBLIC_ORIGIN/docs"   # the OpenAPI page, per the nginx configuration
   curl -sS -o /dev/null -w '%{http_code}\n' "http://${PUBLIC_ORIGIN#https://}/"   # redirects to https
   ```

   The exact health and documentation paths are those of the gateway and `nginx/production`; adjust if they differ.
4. Run the `smoke_lab.py`-style checks against the public origin: sign in, list engines, open a problem. Record the
   result in the release pull request.

## Backups

`pg-backup` writes one custom-format dump per day into `OPENBINDING_BACKUP_DIR` and deletes dumps older than
`BACKUP_RETENTION_DAYS`.

```bash
$DC logs --tail 20 pg-backup
ls -lh "$OPENBINDING_BACKUP_DIR" | tail
```

- **Schedule:** daily, by the loop inside `pg-backup`. A manual dump before a risky release:

  ```bash
  $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" pg_dump -U openbinding -Fc openbinding' \
    > "$OPENBINDING_BACKUP_DIR/manual-$(date +%Y%m%dT%H%M%S).dump"
  ```

  The database user and name are those of `compose.yaml`.
- **Retention:** `BACKUP_RETENTION_DAYS` days on the host. This is not a backup strategy by itself.
- **Off-host copy:** copy the directory to another machine at least daily, for example with `rsync` over SSH or an
  object store client. The target is a pending owner fact. Without it, a lost disk loses the backups too.
- Check one dump per week with `pg_restore --list <dump>` and do the [restore drill](#restore-drill) every quarter.

## Volume snapshots

`pgdata` and `artifacts` are named volumes. Take a snapshot with the stack stopped, so files are consistent:

```bash
$DC stop gateway worker analysis-worker postgres
for v in pgdata artifacts; do
  docker run --rm -v "openbinding-production_${v}:/data:ro" -v "$OPENBINDING_BACKUP_DIR:/out" \
    alpine tar czf "/out/${v}-$(date +%Y%m%dT%H%M%S).tar.gz" -C /data .
done
$DC start postgres gateway worker analysis-worker
```

Use the digest-pinned image of your choice instead of `alpine` if the host policy requires it. Copy the archives
off-host like the dumps.

## Restore drill

Do this on a spare host or with a different project name, never over production data without the owner's order.

```bash
# 1. a clean project with only postgres
DCR="docker compose -p openbinding-restore -f compose.yaml --env-file images.env --env-file /srv/openbinding/site.env"
$DCR up -d postgres
# 2. restore the newest dump
newest=$(ls -1t "$OPENBINDING_BACKUP_DIR"/*.dump | head -n 1)
$DCR exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" \
  pg_restore -U openbinding -d openbinding --clean --if-exists --no-owner' < "$newest"
# 3. start the rest and check
$DCR up -d
```

Check that the row counts of the main tables match the source, that the gateway is healthy and that a known problem
opens. Record the date, the dump used, the time it took and the result below the table in the release notes. Remove
the drill with `$DCR down -v`.

## Rollback

1. Return to the previous images. The previous `images.env` is the one saved at deployment time or the one of the
   previous tag:

   ```bash
   cp /srv/openbinding/releases/images.env.<timestamp> images.env   # or: git checkout <previous tag> -- images.env
   $DC pull
   $DC up -d
   ```

2. If the release added a migration that the previous gateway cannot work with (not backwards compatible, for example
   a dropped or renamed column), restoring images is not enough. Stop the stack and restore the database from the
   dump taken before the deployment:

   ```bash
   $DC stop gateway worker analysis-worker
   $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" \
     pg_restore -U openbinding -d openbinding --clean --if-exists --no-owner' < "$OPENBINDING_BACKUP_DIR/<dump before the release>.dump"
   $DC up -d
   ```

   Data written after the dump is lost; tell the owner before doing this.
3. Run the [verification](#verification) and write the cause in the release pull request.

Migrations should follow expand then contract so that step 2 is rare (see the release rules).

## Rotation

Edit the file, keep mode 0400, then recreate the services that read it (`$DC up -d --force-recreate <service>`;
Compose does not detect a changed secret file).

- **JWT secret (`gateway_jwt_secret`):** replacing it invalidates every issued token, so **everyone is logged out**.
  Plan it outside working hours.

  ```bash
  printf '%s' "$(openssl rand -base64 48)" > "$OPENBINDING_SECRETS_DIR/gateway_jwt_secret"
  $DC up -d --force-recreate gateway
  ```

- **Fernet keys (`secrets_fernet_keys`):** prepend a new key and keep the old ones, so stored values still decrypt:

  ```bash
  new=$(python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode(), end="")')
  old=$(cat "$OPENBINDING_SECRETS_DIR/secrets_fernet_keys")
  printf '%s,%s' "$new" "$old" > "$OPENBINDING_SECRETS_DIR/secrets_fernet_keys"
  $DC up -d --force-recreate migrate gateway worker analysis-worker
  ```

  Remove an old key only after every stored value has been re-encrypted.
- **SPACE and SPHERE keys:** create the new key in the remote service, write the file, recreate `gateway`, then revoke
  the old key.
- **PostgreSQL password:** change it in the database (`ALTER ROLE`), then in `postgres_password` and `database_url`,
  then recreate every service that reads them.

## TLS renewal

`nginx` reads the certificate and key from `NGINX_SSL_DIR`. Renew with the issuer's client, write the new files in
place and reload without downtime:

```bash
$DC exec nginx nginx -t
$DC exec nginx nginx -s reload
echo | openssl s_client -connect "${PUBLIC_ORIGIN#https://}:443" -servername "${PUBLIC_ORIGIN#https://}" 2>/dev/null \
  | openssl x509 -noout -enddate
```

Renew at least 20 days before the end date. The issuer and its automation are a pending owner fact.

## Scaling workers

The host is one machine, so scaling is vertical first. Job workers scale horizontally on the same host:

```bash
$DC up -d --scale worker=3
$DC ps worker
```

`--scale` is lost on the next `up` without the flag; repeat it in every deployment. Check memory use with
`docker stats` first, because each replica has its own limit.

## Log rotation

Every long-running service uses the shared `json-file` logging options in `compose.yaml` (`max-size` 10m,
`max-file` 5), so a service keeps at most about 50 MiB of logs. The options apply when a container is created, so
recreate a service after changing them. Check:

```bash
docker inspect --format '{{.HostConfig.LogConfig}}' $($DC ps -q gateway)
docker system df
```

## What stays blocked

- **Image registry and publish workflow.** No workflow builds and pushes images, so every image built from this
  repository is still a `gap.invalid/...@sha256:000...` marker in `images.env`, and the pre-flight refuses it. Needs
  the owner's registry choice and a token that can write workflows (CRP-4).
- **Production SPACE.** `INTENT.md` lists hosting SPHERE or SPACE in production as a non-goal, and production uses a
  remote SPACE through `SPACE_URL`. Which SPACE (the current `space.score.us.es` or the latest release) is the
  owner's decision (CRP-1); plans stay blocked until then.
- **CI compose-config job.** The job that runs `docker compose config` for development, lab and production is written
  but cannot be pushed until a token with Workflows: write exists (CRP-3). Until then, run the render by hand in the
  pre-flight.
- **Host facts.** CPU, RAM, disk, Compose version, retention, off-host target and TLS issuer (Q3) are pending.
