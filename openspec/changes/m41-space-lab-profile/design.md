# Design: m41-space-lab-profile

Status: plan. Nothing here is built yet. Fixed inputs: ROADMAP M4.1, ARCHITECTURE §9.4, constitution 16.1 and 16.2,
the lab memory cap of 9216 MiB (m05-pr-previews design.md §6), and the rule that the lab file set stays tracked,
loopback-only and secret-free.

## 1. Decisions

| Decision | Choice | Considered |
|---|---|---|
| Where the profile lives | its own file `compose.lab-pricing.json`, run together with the lab file | a Compose `profiles:` entry in `compose.lab.json`: it would change the 4032 MiB sum and the `profiles == ["seed"]` rule of `lab/tests/test_lab_compose.py` for every lab |
| Publishing | no host port | a loopback port for the SPACE web client: not needed, and the lab keeps one published port (`single-loopback-port`) |
| Data | named volumes `space-mongo-data` and `space-redis-data`, labels only at top level | tmpfs: the service would lose its SPACE organization and contracts at each restart |
| Networks | the project default network | a dedicated network: the existing rule forbids `networks` keys |
| Isolation of SPACE from the gateway | the gateway reaches `space-api` by service name only when `DEMO_SPACE_ENABLED=true` is set by the operator; the profile never edits `compose.lab.json` | wiring the gateway env in the base file: it would make the base depend on the optional file |

## 2. Services (final state)

| Service | Image | `mem_limit` | Slice |
|---|---|---|---|
| `space-mongo` | `mongo:7.0.16@sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` | 512 MiB | S2 |
| `space-redis` | `redis:7.4.2@sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9` | 96 MiB | S2 |
| `space-api` | `gap.invalid/space-api:1.7.1` (marker, §3) | 384 MiB | S2 |
| `pricing-bootstrap` (one-shot) | the lab gateway image with `tools/space_lab_bootstrap.py` | 96 MiB | S4, blocked on the CRP |

The S2 manifest has three services and a sum of 992 MiB (512 + 96 + 384). S4 adds `pricing-bootstrap` and reaches 1088
MiB. The profile ceiling stays 1152 MiB. With the develop lab (4032) and one preview (4032) the lab holds
4032 + 4032 + 1088 = 9152 MiB, within the 9216 MiB cap. `space-api` runs with `SPHERE_PUBLIC_URL=https://sphere.score.us.es`
and `SPHERE_SYNC_ENABLED=true` (ARCHITECTURE §9.4); all secrets are `${DEMO_*}` references without defaults, no
service is privileged, and every service sets `mem_limit`.

## 3. Images and the runbook

Verified by the coordinator on 2026-10-24 against Docker Hub: `mongo:7.0.16`
`sha256:c630c59342c1493d50345136df2af14a76b9e827dd5316bfabee07a0880a5f3a` and `redis:7.4.2`
`sha256:fbdbaea47b9ae4ecc2082ecdb4e1cea81e32176ffb1dcf643d422ad07427e5d9`. They are the only entries of the runbook's
verified list (`docs/qa/PRICING_PROFILE.md`, S2) and the static tests read that list.

`space-api` is **unresolved**. No published SPACE image has been found: `isa-group/space` has no packages, its production
Compose builds from source, and release v1.7.1 lives in `SCORELabUS/space`. A name and digest obtained from an
unverified lookup were discarded; no digest is guessed anywhere. `space-api` comes either from a build from the commit
of tag v1.7.1 pinned by commit SHA, or from an official image if the owner supplies one (CRP question 1). Until the
answer:

- the manifest and the tests carry the marker `gap.invalid/space-api:1.7.1`; the `.invalid` TLD can never resolve, so
  the profile cannot start by accident with an unverified image;
- the runbook has a GAP entry for it, and a rule that the marker is accepted for `space-api` only;
- after the answer, the marker is replaced by a reference pinned by digest (or a locally built image whose build
  names the commit SHA), listed as verified in the runbook with its date and source.

## 4. Static rules (S1, tests first)

`lab/tests/test_lab_pricing_profile.py` reads `compose.lab-pricing.json` and `docs/qa/PRICING_PROFILE.md` and checks:
file exists and is separate; service set; no `ports`/`expose`; every service has `mem_limit` and the sum equals the
documented one (992 in S2) and is at most 1152; mongo and redis images are `name:tag@sha256:<64 hex>` and appear in the
runbook's verified list; `space-api` is the GAP marker or a reference listed as verified; the marker, a tag-only
reference or an unlisted digest is refused for `space-api` and the marker is refused for any other service; no literal
secrets, no `privileged`, `cap_add`, binds or `networks` keys. Their order and red expectations are in tasks.md.

`openbinding-gateway/tests/test_no_local_space.py` keeps its checks on `docker-compose.yml` and adds that no other
deployment file (`compose*.json`, `deploy/kubernetes`) declares a SPACE service, network or volume except
`compose.lab-pricing.json`, which may declare only `space-mongo`, `space-redis`, `space-api`, `pricing-bootstrap` and
volumes named `space-*`. The lab test `test_no_space_services` in `lab/tests/test_lab_compose.py` keeps its meaning on
`compose.lab.json`, which stays SPACE-free.

## 5. Memory

See §2. The profile memory is a declared budget, not a measurement; S5 measures it (ARCHITECTURE §9.4 estimates about
0.7 GiB) and lowers or raises the limits only through a change of the documented sum.

## 6. Network

The profile publishes nothing. `space-api` listens inside the project network; `pricing-bootstrap` reaches it by service
name. Outbound HTTPS to `sphere.score.us.es` is the only external access SPACE needs. Rootless Docker keeps the host
loopback unreachable from containers (m05-pr-previews design.md §8).

## 7. Interaction with PR previews

SPACE stays disabled in previews until a memory decision is made for them (m05-pr-previews design.md §6). With this
profile the preview plus profile arithmetic is 4032 + 1088 per preview that enables it; the base stack and the profile
together are checked by the lab at run time. This change does not alter preview planning.

## 8. Bootstrap tool and constitution 16.1

`pricing-bootstrap` runs `tools/space_lab_bootstrap.py` (S4). To create an organization, a key, a service from the
SPHERE link and contracts, the tool has to call SPACE's HTTP API. Constitution 16.1 says: "SPACE MUST be reached only
through its official clients: `space-python-client` in the gateway (plans module) and `space-react-client` in the
browser (token-only mode). No module MAY call SPACE's HTTP API directly." Whether the lab tool is a "module" and
whether the official client offers the needed operations is the second question of the owner request
`crp-openbinding-m41-space-image-and-16-1`, which is in progress. This is risk R8. S3 (bootstrap tests) and S4 (the tool
and the `pricing-bootstrap` service) are blocked until it is answered. The tool never writes to SPHERE and holds no
SPHERE key (constitution 16.2). Requirements about the bootstrap stay in the delta spec because they are the final
state; they are not met until S4.

## 9. Requirements and the slice that delivers each

| Requirement | Slice |
|---|---|
| `pricing-profile-optional-file` | S1 tests, S2 file (three services; the fourth in S4) |
| `pricing-profile-pinned-images` | S1 tests, S2 file and runbook |
| `pricing-profile-memory-budget` | S1/S2 (992 MiB); S4 raises the sum to 1088 |
| `pricing-profile-internal-only` | S1 tests, S2 file |
| `pricing-profile-secrets-and-privileges` | S1 tests, S2 file |
| `pricing-profile-bootstrap` | S3 tests and S4 tool, both blocked on the CRP; S5 live evidence |
| `pricing-profile-bootstrap-boundary` | S3 tests and S4 tool, both blocked on the CRP |
| `no-local-space` ~2 (MODIFIED) | S1 (narrowed test) |

## 10. Failure and rollback

- Removing the profile means not passing `compose.lab-pricing.json` to Compose; the base lab is unchanged.
- A failed bootstrap leaves SPACE running with no service; it is re-run idempotently (S4); `labctl destroy` removes
  the `space-*` volumes with the project.
- Reverting S1+S2 deletes one new file and narrows one test back.

## 11. Open questions

- CRP question 1: which SPACE image or build for `space-api` (build from the commit of tag v1.7.1, or an official image).
- CRP question 2: does constitution 16.1 admit an exception for `tools/space_lab_bootstrap.py`.
- How `lab_compose` (factory) accepts the overlay file. Outside this repository.
