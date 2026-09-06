# SPACE runtime for OpenBinding

OpenBinding uses [SPACE](https://github.com/isa-group/space) for contracts,
feature evaluation and usage accounting. It does not use SPACE as the source of
the pricing document:

1. SPHERE owns every immutable `OpenBinding/openbinding` pricing version.
2. The OpenBinding control room validates a SPHERE URL and deploys that URL to
   SPACE.
3. SPACE pins contracts to a deployed version and records consumption.
4. PostgreSQL stores only release metadata, audit records and the LIVE pointer.

The API never mounts or reads `pricing/openbinding.yml`. That file is the
reviewable source for the first `0.1.0` release and a CI fixture; the runtime
copy is published to SPHERE and then fetched by SPACE.

## Pinned versions

| Component | Version |
|---|---|
| SPACE | `v1.5.0`, commit `79aea10c9acff1d85e4931d09aa21d3a253d1ce1` |
| `space-python-client` | `>=1.0,<2.0` (lock: `1.0.0`) |
| Pricing2Yaml | `3.1` |
| `pricing4ts` | `0.11.1` |
| `pricing-renderer` | `0.1.0` |

SPACE's `v1.5.0` tag still contains historical `version` fields (`1.0.0` in
the root package and `0.1.0` in the API package). Verify the Git tag and commit,
not those package fields. `VERSION` is the machine-readable pin and
`prepare.sh` installs or verifies it without vendoring another repository.

```bash
./space/prepare.sh
git -C space/space-src describe --tags --exact-match
git -C space/space-src rev-parse HEAD
```

## Local stack

Copy `.env.example` to `.env` and set, at minimum:

```dotenv
SPACE_ADMIN_PASSWORD=<random value>
SPACE_DATABASE_ROOT_PASSWORD=<URL-safe random value>
SPACE_JWT_SECRET=<at least 32 random bytes>
SPACE_JWT_SALT=<independent random value>
```

Then start OpenBinding plus the optional SPACE profile:

```bash
./space/prepare.sh
docker compose --profile dev --profile space up -d --build
docker compose --profile dev --profile space ps
```

The profile runs the SPACE 1.5 API, MongoDB and its Redis cache on the private
`openbinding-space` network. The API is exposed only on
`127.0.0.1:${SPACE_HOST_PORT:-5403}` for local bootstrap and smoke tests; no
SPACE administration frontend is published. OpenBinding's authenticated
pricing control room is the management surface. Use
`bootstrap/bootstrap_space.py` once to mint the scoped server keys; pricing is
then managed only through the control room and SPHERE, never uploaded from a
local helper.

The checkout is ignored by Git. `docker compose build space-server` builds it
locally and stamps the `v1.5.0` tag and exact revision into OCI labels.

## Keys and least privilege

Create two different organization keys in SPACE's single OpenBinding
administration organization:

- `SPACE_API_KEY`: `MANAGEMENT`, used for evaluation, contracts, deployments
  and availability changes.
- `SPACE_DESTRUCTIVE_API_KEY`: `ALL`, used only when an administrator confirms
  deletion of one archived SPACE pricing version.

Never expose either key to the browser or to an OpenBinding user. The
destructive key is optional until deletion is needed. Do not use an `ALL` key
as `SPACE_API_KEY`.

For a disposable local environment only,
`bootstrap/bootstrap_space.py` can authenticate to upstream SPACE and mint a
`MANAGEMENT` key and, when requested, a separate `ALL` key. It never registers
or uploads a pricing. Production and local pricing releases both go through
SPHERE and the OpenBinding control room.

```bash
python space/bootstrap/bootstrap_space.py \
  --url http://127.0.0.1:5403 \
  --include-destructive-key
```

Set the resulting values in `.env` and restart the gateway and worker:

```dotenv
SPACE_ENABLED=true
SPACE_URL=http://space-server:3000
SPACE_API_KEY=<management organization key>
SPACE_DESTRUCTIVE_API_KEY=<separate all-scope organization key>
SPACE_FAIL_MODE=open
```

Use `SPACE_FAIL_MODE=closed` in production. A closed deployment refuses
metered operations when SPACE cannot account for them; local development may
remain open. The LIVE pricing version is resolved from OpenBinding's release
metadata. `SPACE_PRICING_VERSION=0.1.0` is only the bootstrap fallback before a
LIVE row exists.

## Pricing lifecycle

- A private SPHERE draft may be deployed to SPACE for authenticated preview.
- Only a public SPHERE release may become LIVE for new contracts.
- Existing contracts remain pinned until renewal, when OpenBinding novates them
  before evaluation.
- Old SPACE versions remain active while contracts reference them; otherwise
  they can drain and be archived.
- A draft can be deleted only after its SPACE preview is archived/removed.
- Public SPHERE releases are immutable and are never deleted.

The canonical `0.1.0` file has BASIC, ADVANCED, RESEARCH and PRO. RESEARCH has
no add-ons and alone enables `institutionalBranding`. Add-ons are limited to
the plan combinations in the file and all paid options use the textual price
`Contact us / Institutional agreement`; there is no checkout or simulated
payment.

Validate the document with the exact parser used by SPACE:

```bash
cd frontend
node -e "const fs=require('fs'); const p=require('pricing4ts').retrievePricingFromYaml(fs.readFileSync('../space/pricing/openbinding.yml','utf8')); console.log(p.syntaxVersion, p.version)"
```

## Health, data and recovery

SPACE 1.5's `/api/v1/healthcheck` verifies MongoDB rather than only its HTTP
listener. From the root Compose project:

```bash
docker compose --profile space exec -T space-server \
  node -e "require('http').get('http://127.0.0.1:3000/api/v1/healthcheck',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
```

MongoDB owns contracts and must be backed up when SPACE is self-hosted. The
Kubernetes overlay includes a daily `mongodump` CronJob and a manual restore
template. SPACE Redis is a cache; SPHERE can repopulate immutable pricing
files. OpenBinding's PostgreSQL and artifact backups remain separate.

Never restore over a running SPACE API. Stop contract-changing traffic, restore
MongoDB, verify the service/version catalogue and contracts, then run the
OpenBinding reconciliation sweep before reopening metered operations.

See `UPSTREAM.md` for the compatibility audit performed while moving from the
old integration to SPACE 1.5.
