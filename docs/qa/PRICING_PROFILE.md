# Pricing profile (SPACE 1.7.1) for the laboratory

## Purpose

`compose.lab-pricing.json` is an optional laboratory profile that runs a local SPACE 1.7.1 (`space-mongo`,
`space-redis`, `space-api`) as its own compose project, `openbinding-lab-pricing`. It is not part of the 4032 MiB
`compose.lab.json` sum (see [../DEMO.md](../DEMO.md)): the develop lab (4032 MiB), one preview (4032 MiB) and this
profile fit in 9216 MiB (4032 + 4032 + 1088 = 9152 MiB once the bootstrap service exists). SPHERE stays remote; no SPHERE runs locally.

Nothing in this document records a live run of the profile.

## Verified image references

- `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` - verified 2026-10-24
- `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9` - verified 2026-10-24

## GAP

- `space-api` has no verified image (owner request `crp-openbinding-m41-space-image-and-16-1` is open): no SPACE image is published or verified, so the manifest carries the marker `gap.invalid/space-api:1.7.1`, a host that can never be pulled, on purpose.
- Options: build from the commit of tag `v1.7.1` and pin the image by commit SHA and digest, or use an official image if the owner supplies one. Until then the profile cannot start.
- The `space-api` user (`1000:1000`, the node user), healthcheck (`/api/v1/healthcheck` on port 3000, run with
  `node -e fetch`, as the slim image has no curl) and port are unverified for the real image, as are its environment variable names other than the four SPHERE ones. The `mongo` and `redis`
  official images run as `999:999`.

## Memory

Memory sum: 992 MiB

`space-mongo` 512 MiB (WiredTiger cache 0.25 GB), `space-redis` 96 MiB (`maxmemory 64mb`, `noeviction`), `space-api`
384 MiB (`--max-old-space-size=192`). A pricing-bootstrap service, not part of this slice, will add 96 MiB for 1088 MiB;
the ceiling is 1152 MiB.

## Variables

The supervisor injects them; the manifest holds bare references only, with no value and no default.

- `DEMO_SPACE_JWT_SECRET`: signing secret of SPACE tokens (`JWT_SECRET`).
- `DEMO_SPACE_JWT_SALT`: salt of SPACE tokens (`JWT_SALT`).
- `DEMO_SPACE_ADMIN_PASSWORD`: password of the SPACE admin `lab-space-admin` (`ADMIN_PASSWORD`).
- `DEMO_SPACE_MONGO_PASSWORD`: password of the MongoDB root user `space`, used by `space-mongo` and in the `MONGO_URI` of
  `space-api`. Use only letters, digits, `-`, `_` and `.`: it is embedded in a URL.

MongoDB creates its root user on the first start of an empty volume only. Changing `DEMO_SPACE_MONGO_PASSWORD` later means
removing the project's `lab-pricing-mongo` volume (with `labctl destroy` once the follow-up below exists).

## SPHERE

`SPHERE_SYNC_ENABLED=true`, `SPHERE_PUBLIC_URL=https://sphere.score.us.es`,
`SPHERE_API_URL=https://sphere.score.us.es/api/v1`, `SPHERE_ALLOW_LOCAL_HTTP=false`: SPACE syncs with the remote SPHERE.

## Procedure

```
lab_compose up file=compose.lab-pricing.json
lab_compose logs file=compose.lab-pricing.json
lab_compose down file=compose.lab-pricing.json
```

`lab_compose` support for this file is a factory follow-up. Pricing bootstrap and service creation are not part of this
slice. The services publish no port; they are reachable only inside the project.
