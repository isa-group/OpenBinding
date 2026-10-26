# Design: m45-lab-pricing-wiring

Slice A2 of `docs/agent-work/m4-plans-slices/handoff.md`; the `compose.lab-pricing.json` part of slice S3 of
`docs/design/m45-lab-space.md` §6.2 (the M4.5 plan), without the network, key volume and `:?` items. Nothing here was
built or run.

## 1. Context

- `compose.lab-pricing.json` today: three services, 992 MiB, `space-api` on the marker `gap.invalid/space-api:1.7.1`
  (`req~lab-deployment-pricing-profile-pinned-images~1`). The tests mirror it: `rule_images` accepts the marker while the
  runbook has a `## GAP` entry; `ALLOWED_SERVICE_KEYS` has no `build` or `restart`; `${DEMO_SPACE_ADMIN_PASSWORD}` must
  appear once; `test_no_local_space.py` accepts the marker or a `1.7.1` digest.
- `lab/space/Dockerfile` (SPACE api from commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba`, `USER 1000:1000`) and
  `lab/tools/Dockerfile` (bootstrap tool, `USER 1000:1000`, context `lab/tools` because the root `.dockerignore` excludes
  `lab/`) exist from change `m41-space-bootstrap`. Its design §7 and `docs/qa/PRICING_PROFILE.md` ("Compose wiring
  still needed") list the wiring this change specifies.

## 2. Decisions (decided by this change, inside the owner's earlier answers)

| Decision | Choice | Reason |
|---|---|---|
| Image of `space-api` | `image: openbinding-lab/space-api:1.7.1` + `build: {context: lab/space, dockerfile: Dockerfile}` | owner answer of 24-10-2026 (build from the pinned commit); the Dockerfile checks the commit, so the local name needs no digest |
| Bootstrap | one-shot `pricing-bootstrap`, `openbinding-lab/pricing-bootstrap:1` from `lab/tools`, `user: 1000:1000`, `restart: "no"`, `mem_limit: 96m`, `depends_on` `space-api` healthy, no healthcheck | a one-shot exits; the lab rules exempt one-shots from healthchecks |
| Memory | 512 + 96 + 384 + 96 = 1088 MiB, ceiling 1152 | budgeted in `m41-space-lab-profile`; 4032 + 4032 + 1088 = 9152 ≤ 9216 |
| Hardening keys | no `cap_drop`, `read_only`, `security_opt` in the manifest | the lab supervisor drops every capability for all projects and `compose.lab.json` does not state it; the earlier runbook proposal is withdrawn |
| Allow-list | `build` (exactly `context`, `dockerfile`; two fixed pairs) and `restart` (`"no"`, `pricing-bootstrap` only) | the smallest growth that admits the two images |
| Bootstrap environment | exactly `SPACE_URL=http://space-api:3000`, `SPACE_ADMIN_USER=lab-space-admin`, `SPACE_ADMIN_PASSWORD=${DEMO_SPACE_ADMIN_PASSWORD}` | no proxy route, no SPHERE key (constitution 16.2); `SPACE_BOOTSTRAP_PLAN` keeps the tool default `FREE` |
| Runbook | `## GAP` removed; verified list keeps only mongo and redis; built images and the three base digests stay outside it, base digests marked UNVERIFIED | a built image has no registry digest to verify |

The pin of `pricing-bootstrap`'s environment is a new requirement (`pricing-profile-bootstrap-environment` ~1) rather
than a clause of `secret-references` ~2: the obligation is distinct (exact keys and values, no proxy variables) and the
statement of `secret-references` would pass the 500-character limit. `remote-sphere` ~1 already covers the host of
`SPACE_URL` (`space-api` is a profile host) and stays unchanged.

`no-local-space` ~3 counts SPACE services by name and image; `pricing-bootstrap` is not one (no `space` name element,
image without `space-api`), so the exact SPACE set stays three.

## 3. Open points (not specified here; recorded for the owner and later slices)

| # | Point | State |
|---|---|---|
| D1 | Shared SPACE reached from `compose.lab.json` and the previews (M4.5 design option B, network `lab-pricing-net`) | waits for the owner; needs an ADR naming ADR-0015 §5, constitution 16.6 and ARCHITECTURE §9.1 |
| D2 | Exception to the no-`networks` rule for `gateway`/`worker` | waits for the owner, with D1 |
| D3 | Where the MANAGEMENT key lives (key volume `lab-pricing-key` written by the bootstrap, or a value SPACE adopts) | waits for the owner (question 3) |
| D4 | Per-user plans `SPACE_BOOTSTRAP_PLANS` and the seed no longer creating contracts | waits for the owner; would add a fourth bootstrap variable and revise `bootstrap-environment` |
| — | `${DEMO_SPACE_X:?required}` form and a factory preflight that refuses unset or empty `DEMO_*` | proposed; changes `secret-references` (another revision) and the factory |
| S4 | Preview planner (`previews.py`) and seed changes (`DEMO_SPACE_ENABLED`, `preview_space_unavailable`, seed guard) | later slice |
| — | `docs/DEMO.md` (variables, status of the profile) | later documentation slice |
| F1 | `lab_compose file=compose.lab-pricing.json`, and the validator accepting `build` and `restart` | factory follow-up; until it lands no slice is accepted live |
| F2 | `--running` accounting of the pricing project (1088 MiB) in preview admission | factory follow-up |
| R1 | First live build: image users (`1000:1000` in both Dockerfiles), the three base digests, the `space-api` healthcheck (`node -e fetch`) | first lab build; then the base digests may move to the verified list |
| R6 | Old base images (`node:21.1` end of life, `python:3.12.8`) and redis/mongo advisories | owner accepts the lab-only risk or bumps by verified digest |

## 4. Files outside this change that stay untouched

`compose.lab.json`, `docs/DEMO.md`, `lab/previews/previews.py`, `lab/tests/test_lab_compose.py`. The next slices touch
only `lab/tests/test_lab_pricing_profile.py`, `openbinding-gateway/tests/test_no_local_space.py`,
`compose.lab-pricing.json` and `docs/qa/PRICING_PROFILE.md` (tasks.md).

## 5. Risks

- The Compose validator of the factory may refuse `build` or `restart` until F1; static tests pass before that.
- A build that fails on a wrong base digest fails loudly; it never falls back (R1).
- Archive order: this delta MODIFIES requirements that exist only in `m41-space-lab-profile`; archiving it first is a
  precondition (proposal.md, Impact).
