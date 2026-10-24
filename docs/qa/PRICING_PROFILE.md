# Pricing profile (SPACE 1.7.1) for the laboratory

## Purpose

`compose.lab-pricing.json` is an optional laboratory profile that runs a local SPACE 1.7.1 (`space-mongo`,
`space-redis`, `space-api`) as a standalone compose project, `openbinding-lab-pricing`, brought up on its own like
`compose.lab-engines.json`. It is not an overlay of the lab project and is not part of the 4032 MiB `compose.lab.json`
sum (see [../DEMO.md](../DEMO.md)): the develop lab (4032 MiB), one preview (4032 MiB) and this profile fit in 9216 MiB
(4032 + 4032 + 1088 = 9152 MiB once the bootstrap service exists). SPHERE stays remote; no SPHERE runs locally.

The gateway is not wired to this SPACE in M4.1. This change does not decide how `SPACE_URL` reaches the gateway: M4.2 or
M4.5 either fold these services into the main lab manifest (names, keys and rules are merge-ready) or choose another
route with a recorded exception to the no-`networks` rule.

Nothing in this document records a live run of the profile.

## Verified image references

- `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` - verified 2026-10-24
- `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9` - verified 2026-10-24

## GAP

- `space-api` has no verified image (owner request `crp-openbinding-m41-space-image-and-16-1` is open): no space-api reference has been verified by this change, so the manifest carries the marker `gap.invalid/space-api:1.7.1`, a host that can never be pulled, on purpose. The candidate `ghcr.io/scorelabus/space-api:1.7.1` (named in ARCHITECTURE section 9.4) is UNVERIFIED and is submitted to the owner as part of question 1 of that request; no digest is pinned or invented for it.
- Options: build from the commit of tag `v1.7.1` (this needs a revision 2 of the `pinned-images` requirement: build context pinned by commit SHA plus a check for it), or use an official image by verified digest (this needs no revision). Until then the profile cannot start.
- UNVERIFIED for the real image: the `space-api` user `1000:1000` (the node user) and the statement that the slim image
  has no curl, hence a `node -e fetch` healthcheck. The `mongo` and `redis` official images run as `999:999`.

Facts taken from the SPACE v1.7.1 source (medium confidence, lookup, not a running image):

- `api/src/main/app.ts`: `SERVER_PORT` defaults to 3000.
- `api/src/main/routes/HealthcheckRoutes.ts`: `GET /api/v1/healthcheck`.
- `api/src/main/services/sphere/SphereClient.ts`: reads `SPHERE_API_URL` and `SPHERE_ALLOW_LOCAL_HTTP`.

The healthcheck of `space-api` runs inside its container; it is SPACE's own container probe, not an OpenBinding module.

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

All four values must be set and non-empty before bring-up. Compose turns an unset variable into an empty string. The
impact of an empty value, per variable:

- `DEMO_SPACE_ADMIN_PASSWORD` empty: SPACE would start with an empty admin password.
- `DEMO_SPACE_JWT_SECRET` empty: token signing is weakened.
- `DEMO_SPACE_JWT_SALT` empty: token signing is weakened.
- `DEMO_SPACE_MONGO_PASSWORD` empty: MongoDB may be left without authentication (UNVERIFIED).

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

Pricing bootstrap and service creation are not part of this slice. The services publish no port; they are reachable only
inside the project.

## Known advisories

Medium-confidence facts from secondary sources, to be confirmed by the owner. `redis` 7.4.2 and `mongo` 7.0.16 are the
versions of SPACE 1.7.1's production compose, and their digests were verified on Docker Hub on 2026-10-24. They predate
later patch releases with published advisories:

- Redis, fixed in 7.4.3 to 7.4.6: CVE-2025-21605, CVE-2025-27151, CVE-2025-32023, CVE-2025-48367, CVE-2025-49844,
  CVE-2025-46817, CVE-2025-46818, CVE-2025-46819.
- MongoDB, fixed in 7.0.28: CVE-2025-14847.

These ids come from secondary sources (medium confidence). Redis runs without a password and its only peer is
`space-api`. The profile is lab-only, publishes no port and holds synthetic data. Bumping to current patch releases by
verified digest is a follow-up; the acceptance of this lab-only risk remains the owner's decision.
