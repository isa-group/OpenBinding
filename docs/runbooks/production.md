# Production runbook

How to install, deploy, verify, back up, restore, roll back and operate OpenBinding in production with Docker
Compose ([ADR-0021](../adr/0021-docker-compose-only.md)).

**Status: written against `deploy/compose/production/compose.yaml`, `images.env` and `ci.env`, and never run on a
production host.** Where this runbook and `compose.yaml` disagree, `compose.yaml` wins and this runbook is the defect.
Docker was not available where the definition was written, so `docker compose config` still has to be run by a person
or by CI (see [Render check](#render-check)), and none of the commands below has been executed. The image registry, the
non-root hardening and the host facts are open (see [What stays blocked](#what-stays-blocked)).

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

`nginx` resolves the address of `gateway` once, when it starts, so it would keep the old address after the gateway is
recreated. `nginx` therefore depends on `gateway` with `restart: true` (Compose 2.17 or newer): Compose restarts it
when it recreates the gateway. A command that recreates only the gateway may not trigger it, so every step below that
recreates the gateway is followed by `$DC restart nginx`. The workers wait for a healthy `gateway` but do not restart
with it: they have no gateway address, and a restart would only cut running jobs. `restart: true` does not follow a
restart by the Docker daemon (a crash or an out-of-memory kill of the gateway): see
[502 after a gateway restart](#502-after-a-gateway-restart).

### Images

`images.env` pins every image as `name:tag@sha256:digest`. The two third-party images carry their published digest. An
image built from this repository has the marker `gap.invalid/<name>:0.0.0@sha256:` followed by 64 zeros until a
registry exists; the release pull request replaces the markers with the published digests. A deployment never runs
with a marker: the [pre-flight](#pre-flight) refuses it. `site.env` never defines an image: the pre-flight refuses a
`*_IMAGE` variable there, and checks the images that Compose renders.

## Host prerequisites

Starting values, **pending owner facts** (ROADMAP M0.9, question Q3). Replace them once the host is chosen.

| Item | Starting value | Status |
|---|---|---|
| Docker Engine and Compose plugin | **rootful Docker Engine** (no `userns-remap`, not rootless); Compose v2.24.4 or newer (several `--env-file` options; `depends_on` `restart` needs 2.17) | pending owner fact (host versions unknown) |
| Git | any recent version, to check out release tags | pending owner fact |
| CPU | 4 cores | pending owner fact |
| RAM | 8 GiB | pending owner fact |
| Disk | 100 GiB, backups and snapshots on a different volume | pending owner fact |
| Backup retention | 14 days (`BACKUP_RETENTION_DAYS`) | pending owner fact |
| Off-host backup target | none chosen | pending owner fact |
| TLS certificates | issuer not chosen | pending owner fact |

The uids used below (70 and 10001) are host uids only on a rootful Docker Engine without user-namespace remapping.
With `userns-remap` or rootless Docker the owners of the secret files and of the backup directory are shifted and these
steps would give the services unreadable files.

The `mem_limit` and `cpus` values in `compose.yaml` are **starting values** above those of the laboratory
(`compose.lab.json`). They sum to about 7 GiB (6.5 GiB while the one-shot `migrate` is not running), so a smaller host
needs them lowered. Tune them after the first measured
week with `docker stats`.

```bash
docker version --format '{{.Server.Version}}'
docker compose version --short
```

## site.env

`site.env` holds the per-host variables. It is owned by the operator user that runs the commands of this runbook
(mode 0600), so they read and edit it without `sudo`. It stays on the host and **never goes into Git**. `ci.env` in the repository
holds placeholders only, so that CI can render the file. Write it first: the next sections use it.

```bash
# /srv/openbinding/site.env  (mode 0600)
PUBLIC_ORIGIN=https://openbinding.example.org
OPENBINDING_SECRETS_DIR=/srv/openbinding/secrets
OPENBINDING_BACKUP_DIR=/srv/openbinding/backups
BACKUP_RETENTION_DAYS=14
NGINX_SSL_DIR=/srv/openbinding/tls
SPACE_URL=https://space.score.us.es
# the first administrator, see "First install":
BOOTSTRAP_ADMIN_USERNAME=
BOOTSTRAP_ADMIN_EMAIL=
# only when SPHERE is enabled (it is off by default; without SPHERE_URL the service sees a placeholder):
# SPHERE_ENABLED=true
# SPHERE_URL=
# SPHERE_ORGANIZATION_ID=
```

`SPACE_URL` **must be an `https://` URL**: the gateway sends the SPACE API key to it. The [pre-flight](#pre-flight)
refuses anything else. `site.env` never defines an `*_IMAGE` variable.

`NGINX_SSL_DIR` holds `fullchain.pem` and `privkey.pem`. The directory is root's (mode 0750) and the private key is
readable by root only (the `nginx` master process reads it as root):

```bash
sudo install -d -m 0750 -o root -g root "$NGINX_SSL_DIR"
sudo install -m 0644 -o root -g root fullchain.pem "$NGINX_SSL_DIR/fullchain.pem"
sudo install -m 0600 -o root -g root privkey.pem "$NGINX_SSL_DIR/privkey.pem"
```

Create the backup directory for the backup service, which runs as uid 70:

```bash
sudo install -d -m 0750 -o 70 -g 70 "$OPENBINDING_BACKUP_DIR"
```

Every command below uses these definitions. `site.env` must be **exported** (`set -a; . site.env; set +a`), because
the commands read its variables, and `--env-file` alone does not export them to the shell. Define them once per shell:

```bash
cd deploy/compose/production          # of the release checkout
SITE_ENV=/srv/openbinding/site.env
set -a; . "$SITE_ENV"; set +a
DC="docker compose -f compose.yaml --env-file images.env --env-file $SITE_ENV"
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
user) for every other file. These are host uids on a rootful Docker Engine only (see
[Host prerequisites](#host-prerequisites)).

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
- **A secret value is never typed into a command line**, because the shell history and the process list would keep it.
  Values that a person provides are read from the terminal with `IFS= read -rs v` and piped to `put_secret`.
  `set +o history` keeps those commands out of the history of the shell (or start each with a space when
  `HISTCONTROL=ignorespace` is set).

`put_secret` refuses an empty value (unless told `allow-empty`), writes the file next to its target with mode 0600 and
moves it into place only when complete, and keeps the previous file as `<name>.prev` until the change is verified. When
it cannot keep the previous file it stops before replacing anything, so after a successful replace a `.prev` exists
whenever there was a file to replace.

**The block after the function is for a fresh host only.** It generates a new value for every secret, including a new
`postgres_password`, which PostgreSQL reads only when it first initialises an empty data directory. Run on a host that
already has a database, it would give the services passwords that the database rejects. Never run it again after the
first install: change a secret with the [rotation](#rotation) steps.

```bash
# run after the exports of the site.env section, so that OPENBINDING_SECRETS_DIR is set
sudo install -d -m 0700 "${OPENBINDING_SECRETS_DIR:?}"

put_secret() {   # put_secret <name> <owner uid> [allow-empty]; the value comes on standard input
  : "${OPENBINDING_SECRETS_DIR:?}"
  local f="$OPENBINDING_SECRETS_DIR/$1"
  (umask 077; sudo tee "$f.new" > /dev/null) || return 1
  if [ "${3:-}" != allow-empty ] && ! sudo test -s "$f.new"; then
    sudo rm -f "$f.new"; echo "refuse: empty value for $1" >&2; return 1
  fi
  sudo chown "$2:$2" "$f.new" && sudo chmod 0400 "$f.new" || { sudo rm -f "$f.new"; return 1; }
  if sudo test -f "$f"; then
    sudo cp -p "$f" "$f.prev" || { sudo rm -f "$f.new"; echo "refuse: cannot keep $1.prev" >&2; return 1; }
  fi
  sudo mv -f "$f.new" "$f"
}

# FRESH HOST ONLY: never run the rest of this block on a host that has a database (see the text above)
password=$(openssl rand -hex 24)
printf '%s' "$password" | put_secret postgres_password 70
printf '%s' "postgresql+asyncpg://openbinding:${password}@postgres:5432/openbinding" | put_secret database_url 10001
printf '%s' "$(openssl rand -hex 32)" | put_secret gateway_jwt_secret 10001
printf '%s' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n')" | put_secret secrets_fernet_keys 10001
unset password

set +o history          # keep what follows out of the shell history
# the key issued by the remote SPACE service (and, if enabled, by SPHERE); an empty file when SPHERE is off:
printf 'SPACE key: ' >&2; IFS= read -rs v; echo >&2; printf '%s' "$v" | put_secret space_api_key 10001; unset v
printf '' | put_secret sphere_api_key 10001 allow-empty
printf 'First administrator password: ' >&2; IFS= read -rs v; echo >&2; printf '%s' "$v" | put_secret bootstrap_admin_password 10001; unset v
set -o history
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

1. Prepare the host: [`site.env`](#siteenv) with the TLS and backup directories, then the
   [secrets directory](#secrets-directory).
2. Choose the first administrator. Set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_EMAIL` in `site.env` and put the
   password in the `bootstrap_admin_password` file. The gateway seeds that account once, when no administrator exists;
   step 7 clears the three values afterwards, so that no initial account stays described on the host.
3. Check out the release tag named in the owner's order, so `images.env` is the one of that release.
4. Run the [pre-flight](#pre-flight).
5. Pull and start. `migrate` runs once and must exit 0 before `gateway` starts.

   ```bash
   $DC pull
   $DC up -d
   $DC ps -a
   ```

6. Run the [verification](#verification) and sign in as the administrator.
7. After the first sign-in, empty the password file and the two bootstrap variables of `site.env`, so that neither the
   initial password nor the initial account stays on the host, and recreate the gateway (the account exists). The
   variables are also unset in the shell, because a variable that is exported there wins over `--env-file`. The
   commands are chained, so an edit of `site.env` that fails stops before the gateway is recreated:

   ```bash
   printf '' | put_secret bootstrap_admin_password 10001 allow-empty
   sudo sed -i -e 's/^BOOTSTRAP_ADMIN_USERNAME=.*/BOOTSTRAP_ADMIN_USERNAME=/' \
     -e 's/^BOOTSTRAP_ADMIN_EMAIL=.*/BOOTSTRAP_ADMIN_EMAIL=/' "$SITE_ENV" \
     && unset BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_EMAIL \
     && $DC up -d --force-recreate gateway \
     && $DC restart nginx
   sudo rm -f -- "$OPENBINDING_SECRETS_DIR/bootstrap_admin_password.prev"   # the copy that holds the initial password
   ```

## Deploying a release

The release pull request carries the `images.env` of the release. Deploying is: note the release now running, check
out the tag, run the pre-flight, dump the database when needed, pull the images, start. The whole tree of the checkout
is the release (`compose.yaml`, `images.env` and this runbook), so a rollback checks out the previous tag.

```bash
# in deploy/compose/production, with the exports and $DC of the site.env section
sudo install -d -o "$USER" /srv/openbinding/releases
git describe --tags --always | tee "/srv/openbinding/releases/previous-$(date +%Y%m%dT%H%M%S)"   # the release now running
git fetch --tags && git checkout <release tag>
```

### Pre-flight

The pre-flight refuses a checkout with local changes or whose `HEAD` is not exactly a release tag, a release whose
images are not published and any value that is not pinned by digest. It reads value lines only: the comments of
`images.env` mention `gap.invalid` on purpose. It also checks the images that Compose renders (`config --images`), so an
image set anywhere else is caught, and refuses an image in `site.env`, a `SPACE_URL` that is not https and a
`BACKUP_RETENTION_DAYS` that is not a whole number of at least 1 (a leading zero would be read as octal by the backup
script). It is a shell function, so a refusal does not close your session.

```bash
preflight() {
  if [ -n "$(git status --porcelain)" ]; then
    echo "refuse: the checkout has local changes; the checkout must be exactly the release tag" >&2
    return 1
  fi
  if ! git describe --exact-match --tags HEAD > /dev/null 2>&1; then
    echo "refuse: HEAD is not exactly a release tag; check out the tag of the release" >&2
    return 1
  fi
  if grep -En '^[A-Z0-9_]+=gap\.invalid/' images.env; then
    echo "refuse: images.env still has unpublished images (gap.invalid)" >&2
    return 1
  fi
  if grep -vE '^[[:space:]]*(#|$)|^[A-Z0-9_]+_IMAGE=[^@[:space:]]+@sha256:[0-9a-f]{64}$' images.env; then
    echo "refuse: images.env has a line that is not NAME_IMAGE=name:tag@sha256:<64 hex>" >&2
    return 1
  fi
  if grep -En '^[[:space:]]*(export[[:space:]]+)?[A-Za-z0-9_]*_IMAGE=' "$SITE_ENV"; then
    echo "refuse: site.env defines an image; images come from images.env only" >&2
    return 1
  fi
  case "$SPACE_URL" in
    https://*) ;;
    *) echo "refuse: SPACE_URL must be an https:// URL" >&2; return 1 ;;
  esac
  case "${BACKUP_RETENTION_DAYS:-}" in
    '' | *[!0-9]* | 0*) echo "refuse: BACKUP_RETENTION_DAYS must be a whole number of days, at least 1, without a leading zero" >&2; return 1 ;;
  esac
  local images
  images=$($DC config --images) || return 1
  if printf '%s\n' "$images" | grep -Ev '@sha256:[0-9a-f]{64}$'; then
    echo "refuse: a rendered image is not pinned by digest" >&2
    return 1
  fi
  if printf '%s\n' "$images" | grep -F 'gap.invalid'; then
    echo "refuse: a rendered image is an unpublished marker (gap.invalid)" >&2
    return 1
  fi
  sudo ls -lnd "$OPENBINDING_SECRETS_DIR" "$NGINX_SSL_DIR" \
    && sudo ls -ln "$OPENBINDING_SECRETS_DIR" "$NGINX_SSL_DIR" \
    && $DC config --quiet
}
preflight && echo "pre-flight passed"
```

Read the `ls -ln` output: the secrets directory is mode 0700 root with the files of the
[layout](#secrets-directory), and `NGINX_SSL_DIR` is mode 0750 root with `privkey.pem` at 0600 root.

### Pull and start

Take a database dump first when the release added a migration, that is when
`git diff --stat <previous tag> <release tag> -- openbinding-gateway/alembic/versions` is not empty: a rollback then
needs it. The dump is created with mode 0600, a failed `pg_dump` is detected (`pipefail`), and the dump is checked with
`pg_restore --list` before anything is deployed. **When `predump` returns non-zero, do not deploy.** A manual dump has a
name outside the retention pattern, so delete it by hand once the release is accepted.

```bash
predump() {
  local dump="$OPENBINDING_BACKUP_DIR/pre-release-$(date +%Y%m%dT%H%M%S).dump"
  (
    set -o pipefail; umask 077
    $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" pg_dump -U openbinding -Fc openbinding' \
      | sudo tee "$dump" > /dev/null
  ) || { echo "refuse: pg_dump failed; do not deploy" >&2; return 1; }
  sudo cat "$dump" | $DC exec -T postgres pg_restore --list > /dev/null \
    || { echo "refuse: pg_restore cannot read $dump; do not deploy" >&2; return 1; }
  echo "dump verified: $dump"
}
predump
```

Then pull and start:

```bash
$DC pull
$DC up -d
$DC restart nginx
```

Compose recreates only the services whose image or configuration changed; `migrate` runs again and applies the new
revisions before `gateway` starts. `nginx` is restarted with the gateway (`restart: true`); the explicit restart makes
sure of it.

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

### 502 after a gateway restart

`nginx` resolves the address of `gateway` once, when it starts. `restart: true` makes Compose restart it when Compose
recreates the gateway, but not when the Docker daemon restarts the gateway by its restart policy (a crash or an
out-of-memory kill). The gateway then has a new address, `nginx` still uses the old one, and the public origin answers
`502 Bad Gateway` while `$DC ps` shows every service healthy. Restart `nginx`:

```bash
$DC ps gateway                     # when it started: a recent start time points to a restart by the daemon
$DC restart nginx
curl -fsS "$PUBLIC_ORIGIN/api/health/ready"
```

Look for the cause of the gateway restart in `$DC logs --tail 100 gateway` and in `docker inspect --format
'{{.State.OOMKilled}}' $($DC ps -q gateway)` before closing the incident. Making `nginx` resolve the name on every
request is a follow-up (F9 in the tasks of the change `m09-compose-only`).

## Backups

`pg-backup` writes one custom-format dump per day into `OPENBINDING_BACKUP_DIR`, as
`openbinding-<UTC time>.dump`, with mode 0600. It writes a `.partial` file and renames it when the dump is complete,
removes stale `.partial` files at the start of each round, and deletes dumps older than `BACKUP_RETENTION_DAYS` days.
Its health check is unhealthy when no dump is younger than 26 hours.

```bash
$DC logs --tail 20 pg-backup
sudo ls -lh "$OPENBINDING_BACKUP_DIR" | tail
```

- **Schedule:** daily, by the loop inside `pg-backup`, starting when the service starts. The manual dump before a
  release with a migration is in [Pull and start](#pull-and-start).
- **Retention:** `BACKUP_RETENTION_DAYS` days on the host. This is not a backup strategy by itself.
- **Off-host copy:** copy the directory to another machine at least daily. The copy must be **encrypted in transit and
  at rest**: for example `rsync` over SSH to a host with an encrypted disk, or encrypt each file before it leaves the
  host. A dump holds every user's data and the stored engine credentials. The target is a pending owner fact. Without
  it, a lost disk loses the backups too.
- Check one dump per week with `pg_restore --list <dump>` and do the [restore drill](#restore-drill) every quarter.

## Volume snapshots

`pgdata` and `artifacts` are named volumes. Take the snapshot with the writers stopped, so the files are consistent.
Stop `pg-backup` together with `postgres`: it would otherwise restart against a stopped database and fail its round.
The archives are created with `umask 077` (mode 0600), and are copied off-host like the dumps (encrypted in transit and
at rest).

```bash
$DC stop nginx gateway worker analysis-worker pg-backup postgres
image=$(sed -n 's/^POSTGRES_IMAGE=//p' images.env)          # any pinned image with tar
for vol in pgdata artifacts; do
  docker run --rm --entrypoint sh -v "openbinding-production_${vol}:/data:ro" -v "$OPENBINDING_BACKUP_DIR:/out" \
    "$image" -c 'umask 077; tar czf "/out/$0" -C /data .' "${vol}-$(date +%Y%m%dT%H%M%S).tar.gz"
done
$DC up -d
```

A snapshot is restored into a fresh volume with the reverse `tar xzf`, as part of the [restore drill](#restore-drill)
or of a disaster recovery ordered by the owner.

## Restore drill

Do this on a **spare host**, never on the production host: the project uses a fixed subnet (`172.29.40.0/24`), fixed
ports 80 and 443 and one backup directory, and removing the drill deletes its volumes. On the spare host use a checkout
of the same release, its own `site.env` and secrets (the drill needs `postgres_password` and `database_url` to agree),
and a copy of the newest dump in its `OPENBINDING_BACKUP_DIR`, brought over an encrypted channel.

**The drill never uses a production SPACE key.** Its restored gateway and workers run with the restored data. Give the
spare host a throwaway SPACE account and key, or leave `SPACE_URL` at an address that nothing answers (for example
`https://space.invalid`, which still passes the https check) and put a placeholder in `space_api_key`; never copy the
production `space_api_key` or `sphere_api_key` to it.

The drill refuses to run unless `DRILL_HOST=yes` is in the environment of that host (set it in `/etc/environment` of the
spare host only, never on production), and prints the host name first. It restores with the same flags as the
[rollback](#rollback), so a restore that would fail in an emergency fails here first. The clean-up is `drill_down`,
which makes the same check before it removes the volumes; no command that removes volumes is typed by hand.

```bash
drill() {
  echo "host: $(hostname)"
  if [ "${DRILL_HOST:-}" != yes ]; then
    echo "abort: DRILL_HOST=yes is not set on this host; this is not a drill host" >&2
    return 1
  fi
  # 1. only postgres, up and healthy
  $DC up -d --wait postgres || return 1
  # 2. restore the newest dump
  local newest
  newest=$(sudo sh -c 'ls -1t "$1"/openbinding-*.dump | head -n 1' sh "$OPENBINDING_BACKUP_DIR") || return 1
  sudo cat "$newest" | $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" \
    pg_restore -U openbinding -d openbinding --no-owner --exit-on-error' || return 1
  # 3. start the rest: migrate brings the schema to the release, then check
  $DC up -d
  $DC ps -a
  $DC exec -T gateway curl -fsS http://localhost:8000/health/ready
}

drill_down() {   # removes the drill project and its volumes; only on the drill host
  if [ "${DRILL_HOST:-}" != yes ]; then
    echo "abort: DRILL_HOST=yes is not set on this host; the volumes are not removed" >&2
    return 1
  fi
  $DC down -v
}
drill
```

Check that the row counts of the main tables match the source, that the gateway is healthy and that a known problem
opens. Record the date, the dump used, the time it took and the result in the release notes. Remove the drill with
`drill_down`.

## Rollback

First decide whether the release added a migration: `git diff --stat <previous tag> <release tag> --
openbinding-gateway/alembic/versions`. An older `migrate` cannot find a revision that only the newer release has, so
the order differs. The previous tag is in `/srv/openbinding/releases/previous-*` (written when the release was
deployed). The rollback checks out that whole tag, never a single copied file: `compose.yaml`, `images.env` and the
runbook are those of the previous release.

**The release added a migration.** Restoring images is not enough, and starting the older images against the newer
schema fails. You must restore the database first, from the dump taken before the deployment, and only then bring back
the old images. Data written after that dump is lost; tell the owner before doing this.

The live database is not touched until the dump has been checked and restored elsewhere:

1. Check the chosen dump (`pg_restore --list`). If it fails, stop: nothing has changed.
2. Restore it into a **new** database, `openbinding_rollback`, stopping at the first error. If it fails, drop
   `openbinding_rollback` and stop: the live database is still the running one.
3. Only after that succeeded (`rollback_swap` is called only when `rollback_restore` returned 0), check out the whole
   previous release, run the pre-flight (the function of [Pre-flight](#pre-flight), defined in the same shell) and pull
   its images, all while the running release is untouched. Then stop every client, rename the live database to
   `openbinding_failed_<timestamp>` and the restored one to `openbinding` in one transaction, and bring back the old
   release. If a step of `rollback_swap` fails, it checks out the release that was running again (so `$DC` names the
   running release, never the older one against the newer schema) and starts its services if it had stopped them; the
   live database is unchanged until the single-transaction rename has run.

```bash
rollback_restore() {   # steps 1 and 2; the live database is not touched
  local dump="$1"
  sudo cat "$dump" | $DC exec -T postgres pg_restore --list > /dev/null \
    || { echo "STOP: pg_restore cannot read $dump" >&2; return 1; }
  $DC exec -T postgres psql -U openbinding -d postgres -c 'DROP DATABASE IF EXISTS openbinding_rollback' -c 'CREATE DATABASE openbinding_rollback' \
    || return 1
  sudo cat "$dump" | $DC exec -T postgres sh -c \
    'PGPASSWORD="$(cat /run/secrets/postgres_password)" pg_restore -U openbinding -d openbinding_rollback --no-owner --exit-on-error' \
    || { echo "STOP: the restore failed; drop openbinding_rollback" >&2; return 1; }
}

rollback_swap() {   # step 3; $1 is the previous tag
  local running
  running=$(git rev-parse HEAD) || return 1          # the release that is running now
  # the whole tree of the previous release, checked and pulled while the running release is untouched:
  if ! { git checkout "$1" && preflight && $DC pull; }; then
    git checkout "$running"; return 1
  fi
  # the clients stop, then the two renames run in one transaction:
  if ! { $DC stop nginx gateway worker analysis-worker pg-backup \
    && printf 'ALTER DATABASE openbinding RENAME TO openbinding_failed_%s;\nALTER DATABASE openbinding_rollback RENAME TO openbinding;\n' \
      "$(date +%Y%m%d%H%M%S)" | $DC exec -T postgres psql -U openbinding -d postgres -1 -v ON_ERROR_STOP=1 -f -; }; then
    git checkout "$running" && $DC up -d && $DC restart nginx   # the live database was not renamed: start the running release again
    return 1
  fi
  $DC up -d && $DC restart nginx
}

rollback_restore "$OPENBINDING_BACKUP_DIR/<dump before the release>.dump" && rollback_swap <previous tag>
```

`openbinding_failed_<timestamp>` holds the data of the failed release, which is personal data. Keep it only until the
owner has accepted the rollback, then drop it by hand (`DROP DATABASE openbinding_failed_<timestamp>`, with
`$DC exec -T postgres psql -U openbinding -d postgres`).

**The release did not add a migration.** Return to the previous release; the database stays as it is.

```bash
git checkout <previous tag> && preflight && $DC pull && $DC up -d && $DC restart nginx
```

Then run the [verification](#verification) and write the cause in the release pull request. Migrations should follow
expand then contract, so that the first case is rare (see the release rules).

## Rotation

The files are owned by uid 70 or 10001, so every command uses `sudo` (`put_secret` of the
[secrets directory](#secrets-directory) does). Keep mode 0400, then recreate the services that read the file
(`$DC up -d --force-recreate <service>`): Compose does not detect a changed secret file. After recreating the gateway,
restart `nginx`, which resolves the gateway address once. `put_secret` keeps the previous file as `<name>.prev`; when the
[verification](#verification) passes, delete the previous files, and if it fails move the `.prev` file back and
recreate again (the PostgreSQL password has a step of its own, below). The directory is root's (mode 0700), so the
glob is expanded by a root shell:

```bash
sudo sh -c 'rm -f -- "$1"/*.prev' sh "$OPENBINDING_SECRETS_DIR"
```

- **JWT secret (`gateway_jwt_secret`):** replacing it invalidates every issued token, so **everyone is logged out**.
  Plan it outside working hours.

  ```bash
  printf '%s' "$(openssl rand -hex 32)" | put_secret gateway_jwt_secret 10001
  $DC up -d --force-recreate gateway
  $DC restart nginx
  ```

- **Fernet keys (`secrets_fernet_keys`):** prepend a new key and keep the old ones, so stored values still decrypt. It
  fails unless both the new and the old value are non-empty:

  ```bash
  new=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n')
  old=$(sudo cat "$OPENBINDING_SECRETS_DIR/secrets_fernet_keys")
  if [ -n "$new" ] && [ -n "$old" ]; then
    printf '%s,%s' "$new" "$old" | put_secret secrets_fernet_keys 10001 \
      && $DC up -d --force-recreate gateway worker analysis-worker \
      && $DC restart nginx
  else
    echo "refuse: the new or the old Fernet key is empty" >&2
  fi
  unset new old
  ```

  Remove an old key only after every stored value has been re-encrypted.
- **SPACE and SPHERE keys (`space_api_key`, `sphere_api_key`):** create the new key in the remote service, write the
  file, recreate, then revoke the old key:

  ```bash
  set +o history
  printf 'new SPACE key: ' >&2; IFS= read -rs v; echo >&2; printf '%s' "$v" | put_secret space_api_key 10001; unset v
  set -o history
  $DC up -d --force-recreate gateway worker analysis-worker
  $DC restart nginx
  ```

  The SPHERE key is the same with `sphere_api_key` in place of `space_api_key`.
- **PostgreSQL password (`postgres_password`, `database_url`):** the new password goes to the database through standard
  input of a command inside the container, never as an argument, then both files are written and the services
  recreated. `postgres` itself reads the file only when it first initialises the data directory. `ALTER ROLE` never
  runs with an empty value: `PASSWORD ''` would not set an empty password, it would remove the password of the role
  (PostgreSQL 10 and later). The block fails unless the new password is non-empty, and it removes a stale
  `postgres_password.prev` and `database_url.prev` before it changes the role:

  ```bash
  password=$(openssl rand -hex 24)
  if [ -n "$password" ]; then
    sudo sh -c 'rm -f -- "$1/postgres_password.prev" "$1/database_url.prev"' sh "$OPENBINDING_SECRETS_DIR" \
      && printf "ALTER ROLE openbinding PASSWORD '%s';\n" "$password" \
      | $DC exec -T postgres psql -U openbinding -d openbinding -v ON_ERROR_STOP=1 \
      && printf '%s' "$password" | put_secret postgres_password 70 \
      && printf '%s' "postgresql+asyncpg://openbinding:${password}@postgres:5432/openbinding" | put_secret database_url 10001 \
      && $DC up -d --force-recreate migrate gateway worker analysis-worker pg-backup \
      && $DC restart nginx
  else
    echo "refuse: the new password is empty; the role keeps its password" >&2
  fi
  unset password
  ```

  `psql` inside the container connects over the local socket, which the PostgreSQL image trusts, so no password is
  needed to change one. **To undo a failed change of this password, first set the role back to the old one**, with the
  value read from the `.prev` file on standard input, because the services would otherwise be given a password that the
  server rejects. The function refuses, with a message on standard error and a non-zero status, and leaves the role
  as it is, unless `postgres_password.prev` is non-empty and `database_url.prev` exists and carries that same password
  (a `.prev` file left by an earlier rotation does not; the block above removes the old ones before it changes the
  role, so any `.prev` file comes from the current rotation). The old password reaches `grep` on standard input, never
  as an argument. Then it moves both `.prev` files back (it stops at the first `mv` that fails) and recreates the
  services. If the change stopped half way (the role has the new password but `database_url` was not replaced), the
  undo refuses, because `database_url.prev` does not exist or does not carry the old password: either rewrite
  `database_url` from `postgres_password`, or set the role back to the value of `postgres_password.prev` and move only
  that file back; if `postgres_password.prev` does not exist either, set the role back to the value of
  `postgres_password`:

  ```bash
  undo_password_rotation() {
    local old dir="$OPENBINDING_SECRETS_DIR"
    old=$(sudo cat "$dir/postgres_password.prev") && [ -n "$old" ] \
      && printf ':%s@' "$old" | sudo grep -qF -f - "$dir/database_url.prev" \
      || { echo "refuse: postgres_password.prev is missing or empty, or database_url.prev is missing or has another password; nothing was changed" >&2; return 1; }
    printf "ALTER ROLE openbinding PASSWORD '%s';\n" "$old" \
      | $DC exec -T postgres psql -U openbinding -d openbinding -v ON_ERROR_STOP=1 \
      && sudo sh -c 'for f in postgres_password database_url; do mv -f -- "$1/$f.prev" "$1/$f" || exit 1; done' sh "$dir" \
      && $DC up -d --force-recreate migrate gateway worker analysis-worker pg-backup \
      && $DC restart nginx
  }
  undo_password_rotation
  ```

## TLS renewal

`nginx` reads the certificate and key from `NGINX_SSL_DIR`. Renew with the issuer's client and write the new files in
place with the same owners and modes (the directory 0750 root, `privkey.pem` 0600 root), then reload without
downtime:

```bash
sudo install -m 0600 -o root -g root <new privkey.pem> "$NGINX_SSL_DIR/privkey.pem"
sudo install -m 0644 -o root -g root <new fullchain.pem> "$NGINX_SSL_DIR/fullchain.pem"
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

## Remote SPACE

<!-- [impl->req~lab-deployment-runbook-remote-space~1] -->

Production and the laboratory use the remote SPACE, `https://space.score.us.es`. The gateway and the workers reach it
through `SPACE_URL` (default `https://space.score.us.es`) and the secret file `space_api_key`. The key never goes into
the repository, an image, the logs or the browser. `SPACE_ENABLED` switches the integration, and `APP_ENV=prod` refuses
the open gate (`SPACE_ENABLED=false`). Plans stay blocked only until the key and the URL are supplied.

Production runs no local SPACE: this stack deploys and backs up no SPACE, and `compose.yaml` has no SPACE or SPHERE
service, network or volume, so there is nothing of SPACE to restore. `tests/test_no_local_space.py` in
`openbinding-gateway` guards that. The owner decision of the change `m4-remote-space` replaces the earlier decision to
host a SPACE in production.

## What stays blocked

- **Image registry and publish workflow.** No workflow builds and pushes images, so every image built from this
  repository is still a `gap.invalid/...@sha256:000...` marker in `images.env`, and the pre-flight refuses it. Needs
  the owner's registry choice and a token that can write workflows (CRP-4).
- **Non-root users and dropped capabilities.** The Java engines, `nginx` and `frontend-assets` run as the user of their
  image (root in several of them) with the default capabilities; `compose.yaml` sets only `no-new-privileges`. Setting a
  `user` and `cap_drop` there depends on the writable paths and ports of each image, and cannot be verified without
  Docker, so it is a follow-up (F7 in the tasks of the change `m09-compose-only`), to be rendered and tested on a
  host with Docker.
- **Nginx resolves the gateway once.** After a restart of the gateway by the Docker daemon, `nginx` must be restarted
  by hand ([502 after a gateway restart](#502-after-a-gateway-restart)). Resolving the name on every request is a
  follow-up (F9 in the tasks of the change `m09-compose-only`) that needs the image configuration and a host with
  Docker to test.
- **CI compose-config job.** The job that runs `docker compose config` for development, lab and production is written
  but cannot be pushed until a token with Workflows: write exists (CRP-3). Until then, run the
  [render check](#render-check) by hand.
- **Not yet rendered.** No worker has a Docker binary, so `compose.yaml` was checked by static tests only, and the
  commands of this runbook were never run. Run the render check once on a machine with Docker before the first install.
- **Host facts.** CPU, RAM, disk, Compose version, retention, off-host target and TLS issuer (Q3) are pending.
