# Design: m41-space-lab-profile

Status: slices S1 and S2 are built (manifest, runbook, tests); S2b, S3, S4 and S5 are not. Fixed inputs: ROADMAP M4.1, ARCHITECTURE §9.4, constitution 16.1 and 16.2,
the lab memory cap of 9216 MiB (m05-pr-previews design.md §6), and the rule that the lab file set stays tracked,
loopback-only and secret-free.

## 1. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Where the profile lives | its own file `compose.lab-pricing.json`, a standalone project `openbinding-lab-pricing` brought up by `lab_compose up file=compose.lab-pricing.json` (the pattern of `compose.lab-engines.json`); not an overlay of the lab project, because a later file's top-level `name` would rename the develop lab | a Compose `profiles:` entry in `compose.lab.json`: it would change the 4032 MiB sum and the `profiles == ["seed"]` rule of `lab/tests/test_lab_compose.py` for every lab |
| Publishing | no host port | a loopback port for the SPACE web client: not needed, and the lab keeps one published port (`single-loopback-port`) |
| Data | named volumes `lab-pricing-mongo` (`/data/db`) and `lab-pricing-redis` (`/data`), declared with labels only at top level | tmpfs: the service would lose its SPACE organization and contracts at each restart |
| Networks | the project default network; the manifest has no `networks` key | a dedicated network: the existing rule forbids `networks` keys |
| Gateway wiring | none in M4.1: the gateway is NOT wired to this SPACE. M4.2/M4.5 either fold the services (names, keys and rules are merge-ready) into the main lab manifest or choose another route with a recorded exception to the no-`networks` rule; this change does not decide how `SPACE_URL` reaches the gateway | wiring the gateway env in the base file: it would make the base depend on the optional file |

## 2. Services (final state)

| Service | Image | `mem_limit` | Slice |
|---|---|---|---|
| `space-mongo` | `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` | 512 MiB | S2 |
| `space-redis` | `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9` | 96 MiB | S2 |
| `space-api` | `gap.invalid/space-api:1.7.1` (marker, §3) | 384 MiB | S2 |
| `pricing-bootstrap` (one-shot) | the lab gateway image with `lab/tools/space_lab_bootstrap.py` | 96 MiB | S4, follow-on PR |

The S2 manifest has three services and a sum of 992 MiB (512 + 96 + 384). S4 adds `pricing-bootstrap` and reaches 1088
MiB. The profile ceiling stays 1152 MiB. With the develop lab (4032) and one preview (4032) the lab holds
4032 + 4032 + 1088 = 9152 MiB, within the 9216 MiB cap. `space-api` runs with `SPHERE_PUBLIC_URL=https://sphere.score.us.es`
and `SPHERE_SYNC_ENABLED=true` (ARCHITECTURE §9.4); all secrets are the four bare `${DEMO_SPACE_*}` references without
defaults (`JWT_SECRET`, `JWT_SALT`, `ADMIN_PASSWORD`, `MONGO_PASSWORD`), no service is privileged, and every service
sets `mem_limit`, a numeric non-root `user` (mongo and redis `999:999`, `space-api` `1000:1000`) and a healthcheck:
`mongosh` ping for mongo, `redis-cli ping` for redis, and a `node` fetch of `http://127.0.0.1:3000/api/v1/healthcheck`
for `space-api`, which waits for both databases with `condition: service_healthy`. Memory caps inside the containers:
MongoDB `--wiredTigerCacheSizeGB 0.25`, Redis `--maxmemory 64mb`, Node `--max-old-space-size=192`.

The healthcheck path and port 3000 come from the SPACE v1.7.1 source (`api/src/main/routes/HealthcheckRoutes.ts`,
`api/src/main/app.ts`; medium confidence, lookup). UNVERIFIED: the `space-api` user `1000:1000` and the absence of curl
in the image; no running image has been inspected because the image is the GAP marker. They are checked when the real
image is available (S2b); the static tests only require a numeric non-root user and a healthcheck.

## 3. Images and the runbook

Verified by the coordinator on 2026-10-24 against Docker Hub: `mongo:7.0.16`
`sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `redis:7.4.2`
`sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`. They are the only entries of the runbook's
verified list (`docs/qa/PRICING_PROFILE.md`, S2) and the static tests read that list.

`space-api` is **unresolved**: no space-api reference has been verified by this change. `isa-group/space` has no
packages, its production Compose builds from source, and release v1.7.1 lives in `SCORELabUS/space`. ARCHITECTURE §9.4
names `ghcr.io/scorelabus/space-api:1.7.1`; it is an UNVERIFIED candidate and is neither pinned nor given a digest
here. A name and digest obtained from an unverified lookup were discarded; no digest is guessed anywhere. The owner
answered CRP question 1 on 24-10-2026 (option build-pinned-exception): SPACE is built from `SCORELabUS/space` pinned to
the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` of tag `v1.7.1` (never the tag; source
`https://api.github.com/repos/SCORELabUS/space/git/refs/tags/v1.7.1`), mongo and redis by digest. Implementing it is
slice S2b of a follow-on PR, so in this PR:

- the manifest and the tests carry the marker `gap.invalid/space-api:1.7.1`; the `.invalid` TLD can never resolve, so
  the profile cannot start by accident with an unverified image;
- the runbook has a GAP entry for it, and a rule that the marker is accepted for `space-api` only;
- in S2b the build from the pinned commit replaces the marker. It needs a revision ~2 of `pinned-images` (build context
  pinned by commit SHA plus a check for it) and the manifest and test allow-list for `build`.

## 4. Static rules (S1, tests first)

`lab/tests/test_lab_pricing_profile.py` holds one rule function per requirement (manifest dict in, failure message or
None out), applies each to the real files, and calls each on a conforming in-memory sample mutated to prove the rule
refuses what it must. The trace names are `optional`, `pinned-images`, `isolated`, `memory-budget`,
`secret-references`, `start-order` and `remote-sphere`: separate file, service set and no `profiles` key; no
`ports`/`expose`/`networks`, only the two named volumes, numeric non-root users; mongo and redis images
`name:tag@sha256:<64 hex>` listed in the runbook, `space-api` the GAP marker (with an open GAP entry) or a listed
`:1.7.1@sha256:` reference (the marker is refused once the verified list holds a `space-api` digest); `mem_limit` on
every service, sum equal to the runbook and at most 1152, caches and heap fixed below limits; no `$` other than the four
exact secret references (unbraced `$VAR` refused), each variable pinned to its own reference, `MONGO_URI` embedding the
Mongo reference, a `SECRET_SHAPES` scan, all four documented in the runbook; an allow-list of service keys (`image`,
`user`, `command`, `environment`, `volumes`, `mem_limit`, `healthcheck`, `depends_on`), so `security_opt`,
`userns_mode`, `build` and the like are refused; healthchecks and `service_healthy`; the four SPHERE variables and every
URL of any scheme with a host in {`space-mongo`, `space-redis`, `space-api`, `sphere.score.us.es`, `127.0.0.1`}.

`openbinding-gateway/tests/test_no_local_space.py` reads `compose.lab-pricing.json` apart and checks every other
manifest (`docker-compose.yml`, `compose.lab*.json`, `compose.pgtest.json`, `deploy/**`): SPACE services only in the
pricing profile, which defines exactly `space-mongo`, `space-redis`, `space-api` (plus `pricing-bootstrap` later) with
volumes named `lab-pricing-*`; no SPHERE service in any manifest; the `space-api` image is the marker
`gap.invalid/space-api:1.7.1` or `<repo>:1.7.1@sha256:<64 hex>`; no SPACE service, profile, network, volume or
destructive key elsewhere. The lab test `test_no_space_services` in `lab/tests/test_lab_compose.py` keeps its meaning
on `compose.lab.json`, which stays SPACE-free.

## 5. Memory

See §2. The profile memory is a declared budget, not a measurement; S5 measures it (ARCHITECTURE §9.4 estimates about
0.7 GiB) and lowers or raises the limits only through a change of the documented sum.

## 6. Network

The profile publishes nothing. `space-api` listens inside the project network; `pricing-bootstrap` reaches it by service
name. The gateway is not wired to it in M4.1 (§1). The in-container healthcheck of `space-api` is SPACE's own
container probe, not an OpenBinding module. Outbound HTTPS to `sphere.score.us.es` is the only external access SPACE needs. Rootless Docker keeps the host
loopback unreachable from containers (m05-pr-previews design.md §8).

## 7. Interaction with PR previews

SPACE stays disabled in previews until a memory decision is made for them (m05-pr-previews design.md §6). With this
profile the preview plus profile arithmetic is 4032 + 1088 per preview that enables it; the base stack and the profile
together are checked by the lab at run time. This change does not alter preview planning. Follow-ups: the lab admission
check and the preview planner must count this project's memory (factory F1/F2); M4.5 needs a memory decision for SPACE
in previews (2 x (4032 + 1088) > 9216) and must change the seed guard that refuses service `openbinding`
(`docs/DEMO.md`, about line 195).

## 8. Bootstrap tool and constitution 16.1

`pricing-bootstrap` runs `lab/tools/space_lab_bootstrap.py` (S4). Where the MANAGEMENT key lives is an OPEN decision:
ARCHITECTURE §9.4 says it is kept in the stack's secret store; the alternative is to keep it inside SPACE until M4.5.
It is settled with the owner before S4 (question 3 of `crp-openbinding-m41-space-image-and-16-1`, to be added by
the coordinator); ARCHITECTURE §9.4 is updated once decided (the coordinator owns that file). To create an organization, a key, a service from the
SPHERE link and contracts, the tool has to call SPACE's HTTP API. Constitution 16.1 says: "SPACE MUST be reached only
through its official clients: `space-python-client` in the gateway (plans module) and `space-react-client` in the
browser (token-only mode). No module MAY call SPACE's HTTP API directly." ADR-0015 §2 says the plans module is the only
code that talks to SPACE. This is risk R8. The owner answered on 24-10-2026 (option build-pinned-exception): the 16.1
exception applies only to the lab bootstrap tool under `lab/tools`; an architecture test forbids direct HTTP to SPACE
outside `lab/tools` and the plans module; the client is used wherever `space-python-client` covers the operation; the
exception is recorded in a short ADR, `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md`. S3 (bootstrap
tests and architecture test, under `lab/tests`) and S4 (the tool under `lab/tools` and the `pricing-bootstrap`
service) are planned for a follow-on PR after this one merges. The tool never writes to SPHERE and holds no
SPHERE key (constitution 16.2). Requirements about the bootstrap stay in the delta spec because they are the final
state; they are not met until S4.

## 9. Requirements and the slice that delivers each

| Requirement | Slice |
|---|---|
| `pricing-profile-optional` | S1 tests, S2 file (three services; the fourth in S4) |
| `pricing-profile-pinned-images` | S1 tests, S2 file and runbook |
| `pricing-profile-memory-budget` | S1/S2 (992 MiB); S4 raises the sum to 1088 |
| `pricing-profile-isolated` | S1 tests, S2 file |
| `pricing-profile-secret-references` | S1 tests, S2 file and runbook |
| `pricing-profile-start-order` | S1 tests, S2 file |
| `pricing-profile-remote-sphere` | S1 tests, S2 file; live evidence S5 |
| `pricing-profile-bootstrap` | S3 tests and S4 tool, both in the follow-on PR; S5 live evidence |
| `pricing-profile-bootstrap-boundary` | S3 tests and S4 tool, both in the follow-on PR |
| `no-local-space` ~2 (MODIFIED) | S1 (narrowed test) |

## 10. Failure and rollback

- Removing the profile means not bringing up `compose.lab-pricing.json`; the base lab is unchanged.
- A failed bootstrap leaves SPACE running with no service; it is re-run idempotently (S4); `labctl destroy` of the
  `openbinding-lab-pricing` project removes its own `lab-pricing-*` volumes.
- Reverting S1+S2 deletes one new file and narrows one test back.

## 11. Open questions

- CRP questions 1 and 2 are answered (24-10-2026, option build-pinned-exception): build from the pinned commit, and a
  16.1 exception limited to `lab/tools`. Their implementation (S2b, S3, S4, ADR 0022) is the follow-on PR; the marker
  stays in this PR.
- CRP question 3 (to be added by the coordinator): where the MANAGEMENT key lives (the stack's secret store per
  ARCHITECTURE §9.4, or inside SPACE until M4.5), settled before S4.
- How `lab_compose` (factory, follow-up F1) accepts `file=compose.lab-pricing.json`. Outside this repository.
- How `SPACE_URL` reaches the gateway (M4.2/M4.5), and the admission and preview memory accounting (factory F1/F2).
