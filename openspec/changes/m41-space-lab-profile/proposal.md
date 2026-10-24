# Change: m41-space-lab-profile

## Why

ROADMAP M4.1: "Lab `pricing` profile: a pinned SPACE 1.7.1 (`space-api`, MongoDB, Redis), `pricing-bootstrap` that
creates the `openbinding` service from `https://sphere.score.us.es/p/6ab0a323697330667ccce891` (`all_last`) and
contracts for the synthetic users; no local SPHERE; `tests/test_no_local_space.py` narrowed (ADR-0015)". ARCHITECTURE
§9.4 describes the profile and ARCHITECTURE §9 row "Lab, PR previews, develop preview" says those environments use the
stack's own SPACE 1.7.1 linked to the SPHERE permanent link. Today the lab has no SPACE, and
`req~lab-deployment-no-local-space~1` forbids one in every deployment file.

## What Changes

- A new optional file `compose.lab-pricing.json` holds the profile. It is never part of `compose.lab.json` or of the
  four lab profiles derived from it. Final state: four services, `space-mongo`, `space-redis`, `space-api` and the
  one-shot `pricing-bootstrap`. Intermediate state (slice S2): the first three.
- Images are pinned: `mongo:7.0.16` and `redis:7.4.2` by digest, checked against Docker Hub on 2026-10-24. The
  `space-api` image is unresolved (open owner request, below): until the owner answers, the manifest and tests carry the
  explicit marker `gap.invalid/space-api:1.7.1`, which can never resolve, and the runbook lists it as a GAP.
- The profile has its own memory budget: 992 MiB with three services (S2), 1088 MiB with the bootstrap (S4), under a
  ceiling of 1152 MiB. Develop lab (4032) + one preview (4032) + profile (1088) = 9152 MiB, within the 9216 MiB lab cap.
- The profile publishes no host port. SPACE is reached inside its Compose network; the stack needs outbound HTTPS to
  `sphere.score.us.es` only. SPHERE is not run locally and no SPHERE key is used (constitution 16.2).
- `pricing-bootstrap` creates the SPACE organization and a MANAGEMENT key (kept inside SPACE, not in a lab secret store), the `openbinding` service from the SPHERE
  permanent link (`source: sphere`, `policy: all_last`) with a first synchronization, and contracts for the synthetic
  users of the seed. Blocked on the owner's answer about constitution 16.1.
- `openbinding-gateway/tests/test_no_local_space.py` is narrowed: the SPACE exemption exists only for
  `compose.lab-pricing.json`. A runbook `docs/qa/PRICING_PROFILE.md` lists the verified images and the GAPs.

## Impact

- Capability: `lab-deployment`. One MODIFIED requirement (`no-local-space` ~1 → ~2) and the ADDED
  `pricing-profile-*` requirements (design.md §9 lists them with the slice that delivers each).
- Repository: `compose.lab-pricing.json`, `lab/tests/test_lab_pricing_profile.py`,
  `openbinding-gateway/tests/test_no_local_space.py`, `docs/qa/PRICING_PROFILE.md`, `docs/DEMO.md`; later
  `tools/space_lab_bootstrap.py` and its tests (design.md §8).
- Factory (outside this repository): `lab_compose` has to accept `compose.lab-pricing.json` as an overlay of the
  lab project. This is not decided here.
- No HTTP API, OpenAPI or database schema change. No production impact.
- Open owner request `crp-openbinding-m41-space-image-and-16-1`, two questions: (1) which SPACE image or build to use
  for `space-api`; (2) whether constitution 16.1 ("No module MAY call SPACE's HTTP API directly") admits an exception
  for the lab tool `tools/space_lab_bootstrap.py`. Slices S3 and S4 wait for question (2); the real `space-api`
  reference waits for question (1).
- Risks: R1 `space-api` image unresolved (marker in place); R8 constitution 16.1 conflict with the bootstrap tool,
  open until the CRP is answered; R3 memory of the profile is a budget, measured in S5 (ARCHITECTURE §9.4 says
  about 0.7 GiB).
- Order: S1+S2 in one PR, then S3 and S4 once the CRP is answered, then S5 (tasks.md).

## Out of scope

- A local SPHERE, or any SPHERE API key. The pricing is changed only in SPHERE (constitution 16.2).
- The SPACE web client. It is added only when an administrator needs it.
- Enabling the profile in PR previews (needs a memory decision first, m05-pr-previews design.md §6) and any change
  to the gateway, the plans module or the browser code.
- Choosing the `space-api` image or build, and the 16.1 exception: both are the owner's decisions.
- Production use of a local SPACE. Contracts held by a lab SPACE are synthetic and not carried over.
