# Production runbook

How to install, deploy, verify, back up, restore, roll back and operate OpenBinding in production with Docker
Compose ([ADR-0021](../adr/0021-docker-compose-only.md)).

**Status: written against `deploy/compose/production/compose.yaml`, `images.env` and `ci.env`, and never run on a
production host.** Where this runbook and `compose.yaml` disagree, `compose.yaml` wins and this runbook is the defect.
Docker was not available where the definition was written, so `docker compose config` still has to be run by a person
or by CI (see [Render check](#render-check)). The image registry, the SPACE decision and the host facts are open (see
[What stays blocked](#what-stays-blocked)).

## Who may order a deployment

Only the owner orders a production deployment (`INTENT.md` §9 and §10; ADR-0021). Agents prepare the release pull
request and this runbook; they never run any command below against production. Anyone with host access follows these
steps only on the owner's written order that names the release.

## What is deployed

One Compose project, `openbinding-production`, defined by `deploy/compose/production/compose.yaml`. It is standalone:
it does not extend `docker-compose.yml`, builds nothing and has no profiles.

| Service | Image variable (`images.env`) | Secret files | Notes |
|---|---|---|---|
| `postgres` | `POSTGRES_IMAGE` | `postgres_password` | volume `pgdata`; runs as uid 70 |
| `redis` | `REDIS_IMAGE` | none | volume `redisdata`; job queue and CAS store |
| `migrate` | `GATEWAY_IMAGE` | `database_url` | one-shot (`OPENBINDING_MIGRATE=only`), exits when the schema is current |
| `gateway` | `GATEWAY_IMAGE` | `database_url`, `gateway_jwt_secret`, `space_api_key`, `sphere_api_key`, `secrets_fernet_keys`, `bootstrap_admin_password` | starts after `migrate` completed; the only service with the JWT secret |
| `worker` | `GATEWAY_IMAGE` | `database_url`, `space_api_key`, `sphere_api_key`, `secrets_fernet_keys` | queue `default`, 4 threads |
| `analysis-worker` | `GATEWAY_IMAGE` | same as `worker` | queue `analysis`, 1 thread |
| `engine-minizinc` | `ENGINE_MINIZINC_IMAGE` | none | |
| `engine-random-search` | `ENGINE_RANDOM_SEARCH_IMAGE` | none | |
| `engine-many-heuristic` | `ENGINE_MANY_HEURISTIC_IMAGE` | none | |
| `engine-evolutionary-heuristics` | `ENGINE_EVOLUTIONARY_HEURISTICS_IMAGE` | none | |
| `frontend-assets` | `FRONTEND_ASSETS_IMAGE` | none | copies the built frontend into volume `frontend_dist` |
| `nginx` | `NGINX_IMAGE` | none | the only service that publishes ports (80 and 443); serves `/examples/` from `examples/` of the checkout |
| `pg-backup` | `POSTGRES_IMAGE` | `postgres_password` | daily `pg_dump -Fc` into `OPENBINDING_BACKUP_DIR`; runs as uid 70 |

Volumes: `pgdata`, `redisdata`, `artifacts`, `frontend_dist`. One network, `openbinding`, with the fixed subnet
`172.29.40.0/24`; the gateway believes `X-Forwarded-For` only from that subnet (`FORWARDED_ALLOW_IPS`).

Site variables, required by `compose.yaml` with `${VAR:?}` (no default): `PUBLIC_ORIGIN`, `OPENBINDING_SECRETS_DIR`,
`OPENBINDING_BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `NGINX_SSL_DIR` and `SPACE_URL`. `ci.env` holds placeholders for
them. Image variables, also required: the nine `*_IMAGE` names of the table.

Every service has `mem_limit`, `cpus`, `no-new-privileges` and rotated `json-file` logs; every service except
`migrate` has a health check and `restart: unless-stopped`.

### Images

`images.env` pins every image as `name:tag@sha256:digest`. The two third-party images carry their published digest. An
image built from this repository has the marker `gap.invalid/<name>:0.0.0@sha256:` followed by 64 zeros until a
registry exists; the release pull request replaces the markers with the published digests. A deployment never runs
with a marker: the [pre-flight](#pre-flight) refuses it.

## Host prerequisites

Starting values, **pending owner facts** (ROADMAP M0.9, question Q3). Replace them once the host is chosen.

| Item | Starting value | Status |
|---|---|---|
| Docker Engine and Compose plugin | Compose v2.24.4 or newer (several `--env-file` options) | pending owner fact (host versions unknown) |
| CPU | 4 cores | pending owner fact |
| RAM | 8 GiB | pending owner fact |
| Disk | 100 GiB, backups and snapshots on a different volume | pending owner fact |
| Backup retention | 14 days (`BACKUP_RETENTION_DAYS`) | pending owner fact |
| Off-host backup target | none chosen | pending owner fact |
| TLS certificates | issuer not chosen | pending owner fact |

The `mem_limit` and `cpus` values in `compose.yaml` are **starting values** above those of the laboratory
(`compose.lab.json`). They sum to about 7 GiB (6.5 GiB while the one-shot `migrate` is not running), so a smaller host
needs them lowered. Tune them after the first measured
week with `docker stats`.

```bash
docker version --format '{{.Server.Version}}'
docker compose version --short
```

## site.env

`site.env` holds the per-host variables. It stays on the host and **never goes into Git**. `ci.env` in the repository
holds placeholders only, so that CI can render the file. Write it first: the next sections use it.

```bash
# /srv/openbinding/site.env  (mode 0600)
PUBLIC_ORIGIN=https://openbinding.example.org
OPENBINDING_SECRETS_DIR=/srv/openbinding/secrets
OPENBINDING_BACKUP_DIR=/srv/openbinding/backups
BACKUP_RETENTION_DAYS=14
NGINX_SSL_DIR=/srv/openbinding/tls
SPACE_URL=https://space.example.org
# the first administrator, see "First install":
BOOTSTRAP_ADMIN_USERNAME=
BOOTSTRAP_ADMIN_EMAIL=
# only when SPHERE is enabled (it is off by default; without SPHERE_URL the service sees a placeholder):
# SPHERE_ENABLED=true
# SPHERE_URL=
# SPHERE_ORGANIZATION_ID=
```

`NGINX_SSL_DIR` holds `fullchain.pem` and `privkey.pem`. Create the backup directory for the backup service, which runs
as uid 70:

```bash
sudo install -d -m 0750 -o 70 -g 70 "$OPENBINDING_BACKUP_DIR"
```

Every command below uses these definitions. `site.env` must be **exported** (`set -a; . site.env; set +a`), because
the commands read its variables, and `--env-file` alone does not export them to the shell. Define them once per shell:

```bash
cd deploy/compose/production          # of the release checkout
set -a; . /srv/openbinding/site.env; set +a
DC="docker compose -f compose.yaml --env-file images.env --env-file /srv/openbinding/site.env"
```

`nginx` takes its server names from `nginx/production/nginx.conf` inside the image, not from `PUBLIC_ORIGIN`.
`PUBLIC_ORIGIN` feeds the gateway (`CORS_ALLOW_ORIGINS`, `PUBLIC_BASE_URL`, `FRONTEND_URL`). Both must name the same
host, or browsers are refused.

## Secrets directory

Secrets are files outside the repository, mounted by Compose as `/run/secrets/<name>`. They are never written in the
Compose file, `images.env`, `site.env` or an image. The services read them through `<NAME>_FILE` variables handled by
the image entrypoint (and `POSTGRES_PASSWORD_FILE` for PostgreSQL).

Compose bind-mounts each file with the owner and mode it has on the host, so the owner must be the uid the service runs
as: **uid 70** (the `postgres` user of the PostgreSQL image) for `postgres_password`, **uid 10001** (the gateway image
user) for every other file.

```text
/srv/openbinding/secrets/            (directory mode 0700, root)
├── postgres_password                (0400, owner uid 70)
├── database_url                     (0400, owner uid 10001)
├── gateway_jwt_secret               (0400, owner uid 10001)
├── space_api_key                    (0400, owner uid 10001)
├── sphere_api_key                   (0400, owner uid 10001)
├── secrets_fernet_keys              (0400, owner uid 10001)
└── bootstrap_admin_password         (0400, owner uid 10001)
```

The path is an example; the real one is `OPENBINDING_SECRETS_DIR` in `site.env`.

- `database_url` must carry the same password as `postgres_password` and the host `postgres`. Generate the password
  with `openssl rand -hex`, so it needs no URL escaping.
- Write every value **without a trailing newline** (`printf '%s'`), so that each file holds exactly the value. The
  entrypoint of the gateway image and the PostgreSQL image strip trailing newlines when they read a file, but do not
  rely on it for a file that another tool reads.
- `secrets_fernet_keys` holds a comma-separated list of Fernet keys, newest first.
- `space_api_key` is required: production runs with SPACE enabled and the gateway refuses to start without it. The
  SPHERE key (`sphere_api_key`) is mounted too; with `SPHERE_ENABLED=false` (the default) it may be an empty file. The
  file must exist in every case, because Compose does not start a service whose secret file is missing.
- The SPACE and SPHERE keys have `MANAGEMENT` scope: treat them as high-risk and never reuse a development key
  (`README.md`, "Development scope").

```bash
# run after the exports of the site.env section, so that OPENBINDING_SECRETS_DIR is set
sudo install -d -m 0700 "${OPENBINDING_SECRETS_DIR:?}"

put_secret() {   # put_secret <name> <owner uid>; the value comes on standard input
  : "${OPENBINDING_SECRETS_DIR:?}"
  f="$OPENBINDING_SECRETS_DIR/$1"
  sudo tee "$f" > /dev/null && sudo chown "$2:$2" "$f" && sudo chmod 0400 "$f"
}

password=$(openssl rand -hex 24)
printf '%s' "$password" | put_secret postgres_password 70
printf '%s' "postgresql+asyncpg://openbinding:${password}@postgres:5432/openbinding" | put_secret database_url 10001
printf '%s' "$(openssl rand -hex 32)" | put_secret gateway_jwt_secret 10001
printf '%s' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n')" | put_secret secrets_fernet_keys 10001
# the key issued by the remote SPACE service (and, if enabled, by SPHERE); an empty file when SPHERE is off:
printf '%s' '<space key>' | put_secret space_api_key 10001
printf '' | put_secret sphere_api_key 10001
printf '%s' '<password of the first administrator>' | put_secret bootstrap_admin_password 10001
unset password
sudo ls -ln "$OPENBINDING_SECRETS_DIR"
```

## Render check

Anyone can render the file without secrets or a host, with the placeholders of the repository. This does not read the
secret files and starts nothing:

```bash
docker compose -f deploy/compose/production/compose.yaml --env-file deploy/compose/production/images.env --env-file deploy/compose/production/ci.env config --quiet
```

On the host, render with the real site values: `$DC config --quiet`.

## First install

1. Prepare the host: [`site.env`](#siteenv) with the backup directory, then the
   [secrets directory](#secrets-directory), and the TLS directory.
2. Choose the first administrator. Set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_EMAIL` in `site.env` and put the
   password in the `bootstrap_admin_password` file. The gateway seeds that account once, when no administrator exists;
   afterwards the variables are harmless.
3. Check out the release tag named in the owner's order, so `images.env` is the one of that release.
4. Run the [pre-flight](#pre-flight).
5. Pull and start. `migrate` runs once and must exit 0 before `gateway` starts.

   ```bash
   $DC pull
   $DC up -d
   $DC ps -a
   ```

6. Run the [verification](#verification) and sign in as the administrator.

## Deploying a release

The release pull request carries the `images.env` of the release. Deploying is: save the current `images.env`, check
out the tag, run the pre-flight, pull the images, start.

```bash
# in deploy/compose/production, with the exports and $DC of the site.env section
sudo install -d -o "$USER" /srv/openbinding/releases
cp images.env "/srv/openbinding/releases/images.env.$(date +%Y%m%dT%H%M%S)"   # the images now running, for rollback
git fetch --tags && git checkout <release tag>
```

### Pre-flight

The pre-flight refuses a release whose images are not published and any value that is not pinned by digest. It reads
value lines only: the comments of `images.env` mention `gap.invalid` on purpose. It is a shell function, so a refusal
does not close your session.

```bash
preflight() {
  if grep -En '^[A-Z0-9_]+=gap\.invalid/' images.env; then
    echo "refuse: images.env still has unpublished images (gap.invalid)" >&2
    return 1
  fi
  if grep -vE '^[[:space:]]*(#|$)|^[A-Z0-9_]+_IMAGE=[^@[:space:]]+@sha256:[0-9a-f]{64}$' images.env; then
    echo "refuse: images.env has a line that is not NAME_IMAGE=name:tag@sha256:<64 hex>" >&2
    return 1
  fi
  sudo ls -ln "$OPENBINDING_SECRETS_DIR" && $DC config --quiet
}
preflight && echo "pre-flight passed"
```

### Pull and start

Take a database dump first when the release added a migration, that is when
`git diff --stat <previous tag> <release tag> -- openbinding-gateway/alembic/versions` is not empty: a rollback then
needs it. A manual dump has a name outside the retention pattern, so delete it by hand once the release is accepted.

```bash
$DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" pg_dump -U openbinding -Fc openbinding' \
  | sudo tee "$OPENBINDING_BACKUP_DIR/pre-release-$(date +%Y%m%dT%H%M%S).dump" > /dev/null
```

Then pull and start:

```bash
$DC pull
$DC up -d
```

Compose recreates only the services whose image or configuration changed; `migrate` runs again and applies the new
revisions before `gateway` starts.

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

3. Public origin checks, from outside the host:

   ```bash
   curl -fsS "$PUBLIC_ORIGIN/api/health/ready"
   curl -fsS -o /dev/null -w '%{http_code}\n' "$PUBLIC_ORIGIN/"
   curl -sSI "http://${PUBLIC_ORIGIN#https://}/" | head -n 1      # 301 to https
   ```

   `/api/health/ready` reaches `/health/ready` of the gateway through `nginx` and reports the database and Redis.
4. Run the `openbinding-gateway/tools/smoke_lab.py` checks against the public origin: sign in, list engines, open a
   problem. Record the result in the release pull request.

## Backups

`pg-backup` writes one custom-format dump per day into `OPENBINDING_BACKUP_DIR`, as
`openbinding-<UTC time>.dump`. It writes a `.partial` file and renames it when the dump is complete, removes stale
`.partial` files at the start of each round, and deletes dumps older than `BACKUP_RETENTION_DAYS` days. Its health check
is unhealthy when no dump is younger than 26 hours.

```bash
$DC logs --tail 20 pg-backup
sudo ls -lh "$OPENBINDING_BACKUP_DIR" | tail
```

- **Schedule:** daily, by the loop inside `pg-backup`, starting when the service starts. The manual dump before a
  release with a migration is in [Pull and start](#pull-and-start).
- **Retention:** `BACKUP_RETENTION_DAYS` days on the host. This is not a backup strategy by itself.
- **Off-host copy:** copy the directory to another machine at least daily, for example with `rsync` over SSH or an
  object store client. The target is a pending owner fact. Without it, a lost disk loses the backups too.
- Check one dump per week with `pg_restore --list <dump>` and do the [restore drill](#restore-drill) every quarter.

## Volume snapshots

`pgdata` and `artifacts` are named volumes. Take the snapshot with the writers stopped, so the files are consistent.
Stop `pg-backup` together with `postgres`: it would otherwise restart against a stopped database and fail its round.

```bash
$DC stop nginx gateway worker analysis-worker pg-backup postgres
image=$(sed -n 's/^POSTGRES_IMAGE=//p' images.env)          # any pinned image with tar
for v in pgdata artifacts; do
  docker run --rm --entrypoint tar -v "openbinding-production_${v}:/data:ro" -v "$OPENBINDING_BACKUP_DIR:/out" \
    "$image" czf "/out/${v}-$(date +%Y%m%dT%H%M%S).tar.gz" -C /data .
done
$DC up -d
```

Copy the archives off-host like the dumps. A snapshot is restored into a fresh volume with the reverse `tar xzf`, as
part of the [restore drill](#restore-drill) or of a disaster recovery ordered by the owner.

## Restore drill

Do this on a **spare host**, never on the production host: the project uses a fixed subnet (`172.29.40.0/24`), fixed
ports 80 and 443 and one backup directory, and `down -v` deletes volumes. On the spare host use a checkout of the same
release, its own `site.env` and secrets (the drill needs `postgres_password` and `database_url` to agree), and a copy
of the newest dump in its `OPENBINDING_BACKUP_DIR`.

```bash
# 1. only postgres
$DC up -d postgres
# 2. restore the newest dump
newest=$(sudo sh -c 'ls -1t "$1"/openbinding-*.dump | head -n 1' sh "$OPENBINDING_BACKUP_DIR")
sudo cat "$newest" | $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" \
  pg_restore -U openbinding -d openbinding --clean --if-exists --no-owner'
# 3. start the rest: migrate brings the schema to the release, then check
$DC up -d
$DC ps -a
$DC exec -T gateway curl -fsS http://localhost:8000/health/ready
```

Check that the row counts of the main tables match the source, that the gateway is healthy and that a known problem
opens. Record the date, the dump used, the time it took and the result in the release notes. Remove the drill with
`$DC down -v`.

## Rollback

First decide whether the release added a migration: `git diff --stat <previous tag> <release tag> --
openbinding-gateway/alembic/versions`. An older `migrate` cannot find a revision that only the newer release has, so
the order differs.

**The release added a migration.** Restoring images is not enough, and starting the older images against the newer
schema fails. You must restore the database first, from the dump taken before the deployment, and only then bring back
the old images. Data written after that dump is lost; tell the owner before doing this.

The restore goes into a new, empty database: `pg_restore --clean` would not drop the tables that only the new schema
has, and would leave a half-restored database. Every client must be stopped first, or `DROP DATABASE` is refused, and
the restore stops at its first error.

```bash
$DC stop nginx gateway worker analysis-worker pg-backup
$DC exec -T postgres psql -U openbinding -d postgres -c 'DROP DATABASE openbinding' -c 'CREATE DATABASE openbinding'
sudo cat "$OPENBINDING_BACKUP_DIR/<dump before the release>.dump" | $DC exec -T postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/postgres_password)" pg_restore -U openbinding -d openbinding --no-owner --exit-on-error'
cp /srv/openbinding/releases/images.env.<timestamp> images.env       # or: git checkout <previous tag> -- images.env
$DC pull
$DC up -d
```

**The release did not add a migration.** Return to the previous images; the database stays as it is.

```bash
cp /srv/openbinding/releases/images.env.<timestamp> images.env       # or: git checkout <previous tag> -- images.env
$DC pull
$DC up -d
```

Then run the [verification](#verification) and write the cause in the release pull request. Migrations should follow
expand then contract, so that the first case is rare (see the release rules).

## Rotation

The files are owned by uid 70 or 10001, so every command uses `sudo` (`put_secret` of the
[secrets directory](#secrets-directory) does). Keep mode 0400, then recreate the services that read the file
(`$DC up -d --force-recreate <service>`): Compose does not detect a changed secret file.

- **JWT secret (`gateway_jwt_secret`):** replacing it invalidates every issued token, so **everyone is logged out**.
  Plan it outside working hours.

  ```bash
  printf '%s' "$(openssl rand -hex 32)" | put_secret gateway_jwt_secret 10001
  $DC up -d --force-recreate gateway
  ```

- **Fernet keys (`secrets_fernet_keys`):** prepend a new key and keep the old ones, so stored values still decrypt:

  ```bash
  new=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n')
  old=$(sudo cat "$OPENBINDING_SECRETS_DIR/secrets_fernet_keys")
  printf '%s,%s' "$new" "$old" | put_secret secrets_fernet_keys 10001
  $DC up -d --force-recreate gateway worker analysis-worker
  ```

  Remove an old key only after every stored value has been re-encrypted.
- **SPACE and SPHERE keys (`space_api_key`, `sphere_api_key`):** create the new key in the remote service, write the
  file with `put_secret`, recreate `gateway worker analysis-worker`, then revoke the old key.
- **PostgreSQL password (`postgres_password`, `database_url`):** change it in the database (`ALTER ROLE`), then write
  both files with `put_secret` (owners 70 and 10001) and recreate `migrate gateway worker analysis-worker pg-backup`.
  `postgres` itself reads the file only when it first initialises the data directory.

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

Every service uses the shared `json-file` logging options in `compose.yaml` (`max-size` 10m, `max-file` 5), so a
service keeps at most about 50 MiB of logs. The options apply when a container is created, so recreate a service after
changing them. Check:

```bash
docker inspect --format '{{.HostConfig.LogConfig}}' $($DC ps -q gateway)
docker system df
```

## Local SPACE (owner decision local-space)

The owner decided that production eventually runs its own SPACE (`space-api`, `space-mongo`, `space-redis`, like the
laboratory pricing profile `compose.lab-pricing.json`). **This definition ships remote SPACE only**: the gateway and
the workers reach SPACE through `SPACE_URL` and the `space_api_key` file, and `compose.yaml` has no SPACE or SPHERE
service, network or volume. The reason is that `openbinding-gateway/tests/test_no_local_space.py` (requirement
`req~lab-deployment-no-local-space`) forbids them under `deploy/**`, and another change is rewriting that test.

The follow-up change has to:

- add `space-api`, `space-mongo` and `space-redis` with digest-pinned images, secret files, health checks and limits;
- back up the SPACE volumes, like `pgdata` and `artifacts`;
- amend `req~lab-deployment-no-local-space` and `openbinding-gateway/tests/test_no_local_space.py`.

Open points: the SPACE API image has no verified digest or registry (the laboratory profile uses the marker
`gap.invalid/space-api:1.7.1`), and `INTENT.md:180` lists hosting SPACE in production as a non-goal, which conflicts with
the owner decision. The owner reconciles `INTENT.md`. Until then plans stay blocked on a remote SPACE.

## What stays blocked

- **Image registry and publish workflow.** No workflow builds and pushes images, so every image built from this
  repository is still a `gap.invalid/...@sha256:000...` marker in `images.env`, and the pre-flight refuses it. Needs
  the owner's registry choice and a token that can write workflows (CRP-4).
- **Production SPACE.** Production uses a remote SPACE through `SPACE_URL`; which one is the owner's decision. The
  owner chose a local SPACE for production, which this definition does not ship: see
  [Local SPACE (owner decision local-space)](#local-space-owner-decision-local-space). Plans stay blocked until then.
- **CI compose-config job.** The job that runs `docker compose config` for development, lab and production is written
  but cannot be pushed until a token with Workflows: write exists (CRP-3). Until then, run the
  [render check](#render-check) by hand.
- **Not yet rendered.** No worker has a Docker binary, so `compose.yaml` was checked by static tests only. Run the
  render check once on a machine with Docker before the first install.
- **Host facts.** CPU, RAM, disk, Compose version, retention, off-host target and TLS issuer (Q3) are pending.
