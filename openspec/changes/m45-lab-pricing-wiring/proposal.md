# Change: m45-lab-pricing-wiring

## Why

ROADMAP M4.5: "seed users have contracts; previews show real plans". The pricing profile `compose.lab-pricing.json`
cannot start today: `space-api` carries the unpullable marker `gap.invalid/space-api:1.7.1` and the one-shot
`pricing-bootstrap` is not in the manifest. The owner chose a build of SPACE from the pinned commit of `v1.7.1`
(`crp-openbinding-m41-space-image-and-16-1`, 24-10-2026), and change `m41-space-bootstrap` delivered
`lab/space/Dockerfile`, `lab/tools/Dockerfile` and the tool. This change is slice A2 of the plan in
`docs/agent-work/m4-plans-slices/handoff.md`, the profile part of slice S3 of `docs/design/m45-lab-space.md` §6.2: the
manifest wiring of both images, so the profile can be built and started on its own.

## What Changes

- `space-api` is built: `image: openbinding-lab/space-api:1.7.1`, `build: {context: lab/space, dockerfile: Dockerfile}`.
  The GAP marker and the runbook `## GAP` section are retired.
- A fourth service, the one-shot `pricing-bootstrap` (`openbinding-lab/pricing-bootstrap:1` built from `lab/tools`), runs
  as `1000:1000` with `restart: "no"`, 96 MiB, after `space-api` is healthy, with exactly three environment variables
  and no healthcheck, port, proxy variable or SPHERE key.
- The profile's memory sum goes from 992 to 1088 MiB; the 1152 MiB ceiling is unchanged; 4032 + 4032 + 1088 = 9152 MiB.
- The service-key allow-list grows only by `build` (`context` and `dockerfile`, two fixed pairs) and `restart` (`"no"`,
  on `pricing-bootstrap` only). No `cap_drop`, `read_only` or `security_opt`: the lab supervisor drops every capability.
- `${DEMO_SPACE_ADMIN_PASSWORD}` appears twice: `ADMIN_PASSWORD` of `space-api`, `SPACE_ADMIN_PASSWORD` of the bootstrap.
- Built images are not on the runbook's verified list (only mongo and redis by digest); the three base-image digests of
  the Dockerfiles stay UNVERIFIED until the first lab build.

## Impact

- Capability `lab-deployment`, one capability. This delta revises seven requirements of the unarchived change
  `m41-space-lab-profile` (`no-local-space` ~2 → ~3, six `pricing-profile-*` ~1 → ~2) and adds
  `pricing-profile-bootstrap-environment` ~1. `pricing-profile-remote-sphere` stays ~1 unchanged.
- Files of the following slices: `lab/tests/test_lab_pricing_profile.py`,
  `openbinding-gateway/tests/test_no_local_space.py`, `compose.lab-pricing.json`, `docs/qa/PRICING_PROFILE.md`.
- No HTTP API, OpenAPI, database schema or production change. The gateways are not wired to this SPACE yet.
- Order at archive: `m41-space-lab-profile` (and `m41-space-bootstrap`) archive first; this delta then applies on top.

## Out of scope

- How `compose.lab.json` and the previews reach SPACE (shared SPACE, `lab-pricing-net`), where the MANAGEMENT key lives,
  per-user plans, the `:?required` form and preflight, preview planner and seed changes, `docs/DEMO.md`, factory F1/F2:
  open points in design.md, each waiting for the owner or for another slice.
- `compose.lab.json`, `docs/DEMO.md`, `lab/previews/previews.py` and `lab/tests/test_lab_compose.py` stay untouched.
- Any live build or run of the images (risk R1).
