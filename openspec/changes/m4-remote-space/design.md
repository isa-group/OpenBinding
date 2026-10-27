# Design: m4-remote-space

OpenBinding uses the remote SPACE `https://space.score.us.es` everywhere; no manifest defines a local SPACE. Nothing in
this change was run against `space.score.us.es`.

## 1. Context (read from the files)

- `compose.lab-pricing.json` today: `space-mongo` (512 MiB), `space-redis` (96), `space-api` (384, built from
  `lab/space` at the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba`), `pricing-bootstrap` (96), volumes
  `lab-pricing-mongo` and `lab-pricing-redis`; 1088 MiB; secrets `DEMO_SPACE_JWT_SECRET`, `DEMO_SPACE_JWT_SALT`,
  `DEMO_SPACE_ADMIN_PASSWORD`, `DEMO_SPACE_MONGO_PASSWORD`. It was never brought up live.
- `lab/tools/space_lab_bootstrap.py` today: admin login (`POST /users/authenticate`), organization lookup or create,
  MANAGEMENT key lookup or create, then the service, the synchronization and the contracts; `SPACE_URL` default
  `http://space-api:3000`, `http` or `https`.
- Requirements of the local profile live in three unarchived changes: `m41-space-lab-profile`, `m41-space-bootstrap`
  and `m45-lab-pricing-wiring`. The living spec has only `req~lab-deployment-no-local-space~1`.
- `docs/runbooks/production.md` has "Local SPACE (owner decision local-space)", which says production eventually runs
  its own SPACE and lists a follow-up to add one; `INTENT.md` lists hosting SPACE in production as a non-goal.
- `compose.lab.json` and its derived profiles already reach SPACE by environment (`DEMO_SPACE_ENABLED`,
  `DEMO_SPACE_DEV_SERVICE`, ...); this change does not touch them.

## 2. Decisions

| # | Decision | Options considered | Reason |
|---|---|---|---|
| D1 | Remote SPACE everywhere; no local SPACE in any manifest (`no-local-space` ~4) | keep the local profile until M4.6; keep it off by default | owner request; constitution 16.6 foresees the switch; removes the open points of the local profile (network, key volume, image build, old base images, advisories, 1088 MiB) |
| D2 | `compose.lab-pricing.json` stays, as the optional project `openbinding-lab-pricing` with the single one-shot `pricing-bootstrap` | run the tool by hand from a worker; fold it into `compose.lab.json` | the lab runs code only through Compose projects; a separate project keeps the base lab (4032 MiB) unchanged and is started only when the seed contracts are needed |
| D3 | The key reaches the tool as `SPACE_API_KEY=${DEMO_SPACE_MANAGEMENT_KEY}`: a bare reference without default; the supervisor injects the value from a root-only secret file outside the repository | a Compose `secrets:` file (needs a host path, which the lab rules forbid); a key file in a volume; the admin login of today (no admin credentials exist for a shared SPACE) | the supervisor already injects `DEMO_*` values; a bare reference follows `req~lab-deployment-secret-references~2`; an unset value becomes empty and the tool refuses it before any request |
| D4 | No admin login, no organization, no api-key creation | keep them for a self-hosted SPACE | on a shared SPACE the organization and its MANAGEMENT key are issued by the SPACE operator to the owner; a tool that can create keys would need an admin account |
| D5 | `SPACE_URL` must be `https` with a host and no credentials (tool) and is exactly `https://space.score.us.es` (manifest) | keep `http` for a local SPACE | the key travels in the `x-api-key` header; there is no local SPACE left that needs `http`; the production pre-flight refuses a non-https `SPACE_URL` too |
| D6 | The tool creates the `openbinding` service from the SPHERE permanent link (`sphere`, `all_last`) if it is missing, and aborts without modifying when an `openbinding` service has another source, link or policy | require the owner to create it by hand; repair a service with other settings | ADR-0015 §1 wants exactly that link and policy; creating it keeps the lab reproducible on an empty organization; a foreign service in a shared SPACE belongs to someone else and is never changed |
| D7 | Synchronization: one run request after a create, then polls every 5 s at most 60 times (5 min); an existing service is never run again | always run | as today; SPACE synchronizes on its own five-minute cycle |
| D8 | Contracts only for the six synthetic seed users (`lab-admin`, `lab-owner`, `lab-orgadmin`, `lab-member`, `lab-viewer`, `lab-outsider`), user id `uuid5(SEED_NAMESPACE, "user:<username>")`, email `<username>@example.org`, plan `SPACE_BOOTSTRAP_PLAN` (default `FREE`), newest active version, read back | per-user plans (`SPACE_BOOTSTRAP_PLANS`) | unchanged from `m41-space-bootstrap`; per-user plans stay an open point (§7) |
| D9 | Report `{service, synchronization, contracts}` as one JSON line; failures as one redacted line on standard error, status 1 | keep `organization` and `apiKey` items | those steps no longer exist |
| D10 | ADR-0022's constitution 16.1 exception for `lab/tools` stays; contracts go through `space-python-client`; services, synchronization and pricings through httpx | wait for the client to cover services | `space-python-client` 1.0.0 still has no service operation |
| D11 | The profile environment holds no SPHERE variable and no proxy variable; the tool reads none | — | constitution 16.2 (no SPHERE key); the key must not pass through a proxy |

Memory: the profile drops from 1088 MiB to 96 MiB. The profile ceiling (1152 MiB) and the lab cap (9216 MiB) are
unchanged; 4032 + 4032 + 96 = 8160 MiB.

## 3. Requirements of this change

| Id | Kind | Evidence |
|---|---|---|
| `req~lab-deployment-no-local-space~4` | MODIFIED (living spec `~1`) | `openbinding-gateway/tests/test_no_local_space.py` |
| `req~lab-deployment-remote-bootstrap-profile~1` | ADDED | `lab/tests/test_lab_pricing_profile.py` (tool image rules: `lab/tests/test_space_lab_bootstrap.py`) |
| `req~lab-space-remote-bootstrap~1` | ADDED | `lab/tests/test_space_lab_bootstrap.py` |
| `req~lab-space-remote-bootstrap-secrets~1` | ADDED | `lab/tests/test_space_lab_bootstrap.py`, `lab/tests/test_no_direct_space_http.py` |
| `req~lab-deployment-runbook-remote-space~1` | ADDED | `openbinding-gateway/tests/test_compose_production.py` |

## 4. Removed: superseded and retired ids

The requirements below exist only in unarchived changes, so this delta cannot list them under `REMOVED` (that section
applies to the living spec). They are superseded and retired by this change: tests drop their tags, and no new tag may
use them.

| Retired id | Change | Why | Replaced by |
|---|---|---|---|
| `req~lab-deployment-no-local-space~2` | `m41-space-lab-profile` | exempted the local SPACE of the pricing profile | `req~lab-deployment-no-local-space~4` |
| `req~lab-deployment-no-local-space~3` | `m45-lab-pricing-wiring` | exempted `space-mongo`, `space-redis`, `space-api` and their image rule | `req~lab-deployment-no-local-space~4` |
| `req~lab-deployment-pricing-profile-optional~1`, `~2` | both | four-service project | `req~lab-deployment-remote-bootstrap-profile~1` (one service, same project name) |
| `req~lab-deployment-pricing-profile-pinned-images~1`, `~2` | both | mongo and redis digests, `space-api` marker or build from `lab/space` | `req~lab-deployment-remote-bootstrap-profile~1` (one build pair, `lab/tools`) |
| `req~lab-deployment-pricing-profile-memory-budget~1`, `~2` | both | 992 and 1088 MiB, Mongo cache, Redis `maxmemory`, Node heap | `req~lab-deployment-remote-bootstrap-profile~1` (96 MiB) |
| `req~lab-deployment-pricing-profile-isolated~1`, `~2` | both | allow-list of keys and the two `lab-pricing-*` volumes | `req~lab-deployment-remote-bootstrap-profile~1` (exact keys, no volume, no port) |
| `req~lab-deployment-pricing-profile-secret-references~1`, `~2` | both | the four `DEMO_SPACE_*` secrets of a local SPACE | `req~lab-deployment-remote-bootstrap-profile~1` (`${DEMO_SPACE_MANAGEMENT_KEY}` only) |
| `req~lab-deployment-pricing-profile-start-order~1`, `~2` | both | healthchecks and `depends_on` of local services | none: one service, no `depends_on` |
| `req~lab-deployment-pricing-profile-remote-sphere~1` | `m41-space-lab-profile` | SPHERE variables of the local `space-api` | none in the manifest (the remote SPACE has its own SPHERE configuration); no SPHERE variable: `req~lab-deployment-remote-bootstrap-profile~1` |
| `req~lab-deployment-pricing-profile-bootstrap~1` | `m41-space-lab-profile` | organization and key creation in a local SPACE | `req~lab-space-remote-bootstrap~1` |
| `req~lab-deployment-pricing-profile-bootstrap-boundary~1` | `m41-space-lab-profile` | 16.1 exception pending | `req~lab-space-remote-bootstrap-secrets~1` and `req~lab-space-no-direct-http~1` (exception recorded in ADR-0022) |
| `req~lab-deployment-pricing-profile-bootstrap-environment~1` | `m45-lab-pricing-wiring` | `SPACE_URL=http://space-api:3000`, admin user and password | `req~lab-deployment-remote-bootstrap-profile~1` |
| `req~lab-space-image-pinned-commit~1` | `m41-space-bootstrap` | `lab/space/Dockerfile` from the pinned commit; tool image rules | `lab/space` deleted; tool image rules kept under `req~lab-deployment-remote-bootstrap-profile~1` |
| `req~lab-space-bootstrap-creates~1` | `m41-space-bootstrap` | admin login, organization, key | `req~lab-space-remote-bootstrap~1` |
| `req~lab-space-bootstrap-idempotent~1` | `m41-space-bootstrap` | idempotence over organization and key | `req~lab-space-remote-bootstrap~1` |
| `req~lab-space-bootstrap-sphere-readonly~1` | `m41-space-bootstrap` | admin password and created keys kept secret | `req~lab-space-remote-bootstrap-secrets~1` |

Kept, not superseded: `req~lab-space-no-direct-http~1` (`m41-space-bootstrap`; ADR-0022, `test_no_direct_space_http.py`)
and `req~lab-deployment-production-runbook~1` (`m09-compose-only`; only its test about the Local SPACE section is
replaced, by the test of `req~lab-deployment-runbook-remote-space~1`).

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Synthetic contracts are written to a SPACE shared with other users of `space.score.us.es` | only the six synthetic users, with deterministic `uuid5` ids of the seed namespace and `@example.org` emails; lookup before create, never update or delete; the tool aborts rather than touch a foreign `openbinding` service; the owner chooses the organization of the key (§7 O1) |
| R2 | The lab key, if it belongs to the organization used by production, would put synthetic contracts next to real ones | recommend a dedicated lab organization and key (§7 O1); the spec cannot enforce it |
| R3 | The routes, body shapes and the authority of a MANAGEMENT key to create services are UNVERIFIED against `space.score.us.es` | the first live run is evidence; any difference is a new revision of `req~lab-space-remote-bootstrap~1` |
| R4 | The key is high-risk (MANAGEMENT scope) | bare reference only; never printed, logged, raised or written; https only, no redirect, no proxy; rotation per the production runbook "Rotation" section, by the owner |
| R5 | The lab needs outbound HTTPS to `space.score.us.es:443` | already needed for `sphere.score.us.es`; the first live run confirms it |
| R6 | `space-python-client` 1.0.0 may follow redirects or read proxy variables in its own HTTP client | UNVERIFIED; checked on the first live run (as in `docs/qa/PRICING_PROFILE.md` today) |
| R7 | Archiving one of the superseded changes after this one would bring the local profile back into the living spec | archive plan in §7 O3 |
| R8 | Contracts stay on the remote SPACE after a lab teardown | accepted: synthetic data, re-used by the next run |

## 6. Verification on the first live run (UNVERIFIED today)

- The remote SPACE version and that `POST /api/v1/services` with a MANAGEMENT key creates a service from a SPHERE link.
- The synchronization routes and the `configuration.status` field.
- The pricing list shape (`activePricings` map or list).
- `docker compose -f compose.lab-pricing.json run --rm --entrypoint env pricing-bootstrap` shows no proxy variable
  injected outside the manifest.

## 7. Open points for the owner

| # | Point | Proposed |
|---|---|---|
| O1 | Organization and key on `space.score.us.es` for the lab: dedicated lab organization, or the production one | dedicated lab organization with its own MANAGEMENT key, stored by the supervisor as `DEMO_SPACE_MANAGEMENT_KEY` |
| O2 | Whether the lab gateways and the previews use the same key when plans are enabled (M4.5) | decided in M4.5, not here |
| O3 | Archive plan: `m41-space-lab-profile` and `m45-lab-pricing-wiring` are withdrawn without archiving; `m41-space-bootstrap` is archived only with `req~lab-space-no-direct-http~1`, or that requirement moves to a new change | the coordinator plans it; this change must be archived after that step |
| O4 | Owner documents: `INTENT.md` D5 (§12) and the third non-goal of §8 (local SPACE until `space.score.us.es` runs the latest release), constitution 16.4 (contract tests "against the pinned images in the lab") and 16.6 ("they run their own pinned SPACE"), ADR-0015 §5, ADR-0022 context, `ROADMAP.md` M4 | wording in `docs/agent-work/m4-remote-space/roadmap-m4.md` |
| O5 | Per-user plans (`SPACE_BOOTSTRAP_PLANS`) | stays open (`m45-lab-pricing-wiring` D4) |
| O6 | Whether `seed_lab.py --space-contracts` is retired now that the bootstrap writes the same contracts | later slice |

## 8. Migration

Nothing to migrate: the local profile never ran. A lab host that built `openbinding-lab/space-api:1.7.1` may remove the
image and any `lab-pricing-*` volume by hand.
