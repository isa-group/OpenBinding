# Pricing profile (SPACE 1.7.1) for the laboratory

## Purpose

`compose.lab-pricing.json` is an optional laboratory profile that runs a local SPACE 1.7.1 as a standalone compose
project, `openbinding-lab-pricing`, brought up on its own like `compose.lab-engines.json`. It has four services:
`space-mongo`, `space-redis`, `space-api` and the one-shot `pricing-bootstrap`, which seeds SPACE. It is not an overlay of
the lab project and is not part of the 4032 MiB `compose.lab.json` sum (see [../DEMO.md](../DEMO.md)): the develop lab
(4032 MiB), one preview (4032 MiB) and this profile fit in 9216 MiB (4032 + 4032 + 1088 = 9152 MiB). SPHERE stays remote;
no SPHERE runs locally.

How the gateway reaches this SPACE is still undecided. Open points: a shared SPACE or a `lab-pricing-net` network, the
placement of the api key, and per-user plans; see `openspec/changes/m45-lab-pricing-wiring/design.md` section 3.

The manifest carries no `cap_drop`, `read_only` or `security_opt`: the lab supervisor drops capabilities. Nothing here
was built or run live; live evidence is a later slice.

## Verified image references

- `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` - verified 2026-10-24
- `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9` - verified 2026-10-24

## Facts to confirm on the first build

- `space-api` is built from `SCORELabUS/space` pinned to the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` of tag
  `v1.7.1` (never the tag), by owner decision of 24-10-2026; `mongo` and `redis` are pulled by digest.
- UNVERIFIED for the built image: the `space-api` user `1000:1000` (the node user) and the statement that the slim image
  has no curl, hence a `node -e fetch` healthcheck. The `mongo` and `redis` official images run as `999:999`.

Facts taken from the SPACE v1.7.1 source (medium confidence, lookup, not a running image):

- `api/src/main/app.ts`: `SERVER_PORT` defaults to 3000.
- `api/src/main/routes/HealthcheckRoutes.ts`: `GET /api/v1/healthcheck`.
- `api/src/main/services/sphere/SphereClient.ts`: reads `SPHERE_API_URL` and `SPHERE_ALLOW_LOCAL_HTTP`.

The healthcheck of `space-api` runs inside its container; it is SPACE's own container probe, not an OpenBinding module.

## Memory

Memory sum: 1088 MiB

`space-mongo` 512 MiB (WiredTiger cache 0.25 GB), `space-redis` 96 MiB (`maxmemory 64mb`, `noeviction`), `space-api`
384 MiB (`--max-old-space-size=192`) and `pricing-bootstrap` 96 MiB, for 1088 MiB; the ceiling is 1152 MiB.
4032 + 4032 + 1088 = 9152 of 9216 MiB.

## Variables

The supervisor injects them; the manifest holds bare references only, with no value and no default.

- `DEMO_SPACE_JWT_SECRET`: signing secret of SPACE tokens (`JWT_SECRET`).
- `DEMO_SPACE_JWT_SALT`: salt of SPACE tokens (`JWT_SALT`).
- `DEMO_SPACE_ADMIN_PASSWORD`: password of the SPACE admin `lab-space-admin`; used by `space-api` (`ADMIN_PASSWORD`) and by
  `pricing-bootstrap` (`SPACE_ADMIN_PASSWORD`).
- `DEMO_SPACE_MONGO_PASSWORD`: password of the MongoDB root user `space`, used by `space-mongo` and in the `MONGO_URI` of
  `space-api`. Use only letters, digits, `-`, `_` and `.`: it is embedded in a URL.

All four values must be set and non-empty before bring-up. Compose turns an unset variable into an empty string. The
impact of an empty value, per variable:

- `DEMO_SPACE_ADMIN_PASSWORD` empty: SPACE may start with an empty admin password or fail to start (UNVERIFIED; the built image has not been run).
- `DEMO_SPACE_JWT_SECRET` empty: token signing may be weakened or SPACE may fail to start (UNVERIFIED).
- `DEMO_SPACE_JWT_SALT` empty: token signing may be weakened or SPACE may fail to start (UNVERIFIED).
- `DEMO_SPACE_MONGO_PASSWORD` empty: MongoDB may be left without authentication, or the URI may fail (UNVERIFIED).

A preflight that refuses an unset or empty value does not exist yet; it is a factory follow-up.

MongoDB creates its root user on the first start of an empty volume only. Changing `DEMO_SPACE_MONGO_PASSWORD` later means
removing the project's `lab-pricing-mongo` volume (`labctl destroy` of this project removes its own `lab-pricing-*`
volumes).

## SPHERE

`SPHERE_SYNC_ENABLED=true`, `SPHERE_PUBLIC_URL=https://sphere.score.us.es`,
`SPHERE_API_URL=https://sphere.score.us.es/api/v1`, `SPHERE_ALLOW_LOCAL_HTTP=false`: SPACE syncs with the remote SPHERE.

## Procedure

Proposed; `lab_compose` support for `file=` is factory follow-up F1.

```
lab_compose up file=compose.lab-pricing.json
lab_compose logs file=compose.lab-pricing.json
lab_compose down file=compose.lab-pricing.json
```

Bring-up builds the two images (see the next section). `pricing-bootstrap` runs once, after `space-api` is healthy. A
one-shot with unchanged configuration may not run again under `up`: use `down` then `up`, or
`run --rm pricing-bootstrap` (UNVERIFIED). The services publish no port; they are reachable only inside the project.

## Build of space-api from the pinned commit

`lab/space/Dockerfile` builds the SPACE api from `SCORELabUS/space` at the commit
`ef4dc8949435d998e2aff525226e3fcc85e2f7ba` (the commit of the 1.7.1 release, fetched by commit id only). The `source`
stage fails the build unless `HEAD` equals that commit; the `build` and runtime stages reproduce the upstream
`api/docker/release/Dockerfile` (pnpm 10.9.0, frozen lockfile, port 3000). The build context may be `lab/space`: no
`COPY` reads the host.

Base images, UNVERIFIED. These three digests are unbuilt lookups: they come from a Docker Hub lookup of 24-10-2026
(medium confidence), no image was built or pulled from them, and they are NOT part of the verified list above until the
lab builds them. A wrong digest fails the build loudly.

- `node:21.1` (stage `source`), digest `sha256:0052410af98158173b17a26e0e2a46a3932095ac9a0ded660439a8ffae65b1e3`, UNVERIFIED.
- `node:21.1-slim` (stages `build` and runtime), digest `sha256:cba276a6db06f49c589bcea35c598b5a960880ed5631bd4407a61c414ec7a9b9`, UNVERIFIED.
- `python:3.12.8-slim-bookworm` (tool image `lab/tools/Dockerfile`), digest `sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0`, UNVERIFIED.

Built images, each by the manifest `build` (never in the verified list):

- `openbinding-lab/space-api:1.7.1`, context `lab/space`.
- `openbinding-lab/pricing-bootstrap:1`, context `lab/tools`.

Proposed build commands (not run): `docker build -t openbinding-lab/space-api:1.7.1 lab/space` and
`docker build -t openbinding-lab/pricing-bootstrap:1 -f lab/tools/Dockerfile lab/tools` (the context is `lab/tools`,
whose `.dockerignore` sends only `requirements.txt` and `space_lab_bootstrap.py`; the repository root is not used because
its `.dockerignore` excludes `lab/`).

To confirm after the first build, with `docker inspect` and a `docker run` of the image:

- the image user is `1000:1000` and matches the `user` of `space-api` in the manifest;
- `node` is present (the compose healthcheck is a `node -e fetch(...)` call; the slim image has no curl);
- the api listens on port 3000 and answers `GET /api/v1/healthcheck`.

Nothing here was built by the author of this document.

## Bootstrap

`lab/tools/space_lab_bootstrap.py` runs as the `pricing-bootstrap` service. It is a one-shot tool that fills an empty
SPACE: the `openbinding` organization, a
`MANAGEMENT` api key, the `openbinding` service linked to the public SPHERE pricing (read-only for SPHERE), and one
contract per seed user. It is idempotent by lookup before each create. It reads these variables:

- `SPACE_URL`: base URL of SPACE (`http://space-api:3000` in the profile).
- `SPACE_ADMIN_USER`: the admin user (`lab-space-admin`).
- `SPACE_ADMIN_PASSWORD`: filled from `DEMO_SPACE_ADMIN_PASSWORD` by Compose.
- `SPACE_BOOTSTRAP_PLAN`: the plan of every contract (default `FREE`). It is not set in the manifest, so `FREE` applies
  (design `m41-space-bootstrap` section 4).

`SPACE_URL` must be an `http` or `https` URL with a host and no credentials. The tool reports one JSON line; the items
are `exists` or `created`, the synchronization is `ready` or `skipped`.

The tool keeps no secret: the password and every api key live in process memory only and are never written, logged or
printed. ASSUMPTION, pending owner question 3: the `MANAGEMENT` key stays inside SPACE and a re-run reuses the
organization's existing key. The HTTP sequence comes from the SPACE documentation and is UNVERIFIED against a live
1.7.1. Its direct HTTP use is the constitution 16.1 exception of ADR 0022.

Recovery: a service created but never synchronized (the run request was lost) is not completed by a later run, which
only polls the status. SPACE is believed to import the pricing and reach `ready` when the service is created
(UNVERIFIED). If the status never becomes `ready`, delete the service in SPACE and run the tool again; the follow-up
decides after the live run (S5) whether the tool sends the run request itself.

## Known advisories

Medium-confidence facts from secondary sources, to be confirmed by the owner. `redis` 7.4.2 and `mongo` 7.0.16 are the
versions of SPACE 1.7.1's production compose, and their digests were verified on Docker Hub on 2026-10-24. They predate
later patch releases with published advisories. The lists below are non-exhaustive: later 7.4.x and 7.0.x patch
releases fix more advisories (medium confidence, secondary sources).

- Redis, fixed in 7.4.3 to 7.4.6: CVE-2025-21605, CVE-2025-27151, CVE-2025-32023, CVE-2025-48367, CVE-2025-49844,
  CVE-2025-46817, CVE-2025-46818, CVE-2025-46819.
- MongoDB, fixed in 7.0.28: CVE-2025-14847.

The new builds also start from old base images: `node:21.1` and `node:21.1-slim` (node 21 is end of life; the image was
last updated on 2023-11-01) and `python:3.12.8-slim-bookworm`. They are a lab-only risk that the owner must accept
(medium confidence, secondary sources). The follow-up moves both to maintained tags by verified digest.

Supply chain, deferred: the tool requirements carry no hashes. The follow-up generates `--require-hashes` from
`openbinding-gateway/uv.lock` and, once the closure is complete, adds `pip --only-binary=:all:` and `--no-deps`; it also
adds an integrity check for the npm-installed pnpm in the SPACE image.

These ids come from secondary sources (medium confidence). Redis runs without a password and its only peer is
`space-api`. The profile is lab-only, publishes no port and holds synthetic data. The follow-up bumps both to the latest
7.4.x and 7.0.x patch by verified digest; the acceptance of this lab-only risk and the bump remain the owner's decision.
