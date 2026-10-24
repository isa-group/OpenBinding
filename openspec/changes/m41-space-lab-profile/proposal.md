# Change: m41-space-lab-profile

## Why

ROADMAP M4.1: "Lab `pricing` profile: a pinned SPACE 1.7.1 (`space-api`, MongoDB, Redis), `pricing-bootstrap` that
creates the `openbinding` service from `https://sphere.score.us.es/p/6ab0a323697330667ccce891` (`all_last`) and
contracts for the synthetic users; no local SPHERE; `tests/test_no_local_space.py` narrowed (ADR-0015)". ARCHITECTURE
§9.4 describes the profile and ARCHITECTURE §9 row "Lab, PR previews, develop preview" says those environments use the
stack's own SPACE 1.7.1 linked to the SPHERE permanent link. Today the lab has no SPACE, and
`req~lab-deployment-no-local-space~1` forbids one in every deployment file.

## What Changes

- A new optional file `compose.lab-pricing.json` holds the profile as a standalone project `openbinding-lab-pricing`,
  brought up by `lab_compose up file=compose.lab-pricing.json` (the pattern of `compose.lab-engines.json`). It is never
  part of `compose.lab.json` or of the four lab profiles derived from it, and the gateway is not wired to this SPACE in
  M4.1 (M4.2/M4.5 decide how `SPACE_URL` reaches it). Final state: four services, `space-mongo`, `space-redis`, `space-api` and the
  one-shot `pricing-bootstrap`. Intermediate state (slice S2): the first three.
- Images are pinned: `mongo:7.0.16` and `redis:7.4.2` by digest, checked against Docker Hub on 2026-10-24. The
  `space-api` image is unresolved (open owner request, below; no space-api reference has been verified by this change, and
  `ghcr.io/scorelabus/space-api:1.7.1` from ARCHITECTURE §9.4 is an unverified candidate): the owner answered on
  24-10-2026 (build from `SCORELabUS/space` pinned to the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` of tag
  `v1.7.1`), but implementing it is the follow-on PR, so in this PR the manifest and tests carry the explicit marker
  `gap.invalid/space-api:1.7.1`, which can never resolve, and the runbook lists it as a GAP.
- The profile has its own memory budget: 992 MiB with three services (S2), 1088 MiB with the bootstrap (S4), under a
  ceiling of 1152 MiB. Develop lab (4032) + one preview (4032) + profile (1088) = 9152 MiB, within the 9216 MiB lab cap.
- The profile publishes no host port. SPACE is reached inside its Compose network; the stack needs outbound HTTPS to
  `sphere.score.us.es` only. SPHERE is not run locally and no SPHERE key is used (constitution 16.2).
- `pricing-bootstrap` creates the SPACE organization and a MANAGEMENT key (where the key lives is an open decision, below), the `openbinding` service from the SPHERE
  permanent link (`source: sphere`, `policy: all_last`) with a first synchronization, and contracts for the synthetic
  users of the seed. Planned for a follow-on PR (the owner admitted a 16.1 exception limited to `lab/tools`).
- `openbinding-gateway/tests/test_no_local_space.py` is narrowed: the SPACE exemption exists only for
  `compose.lab-pricing.json`. A runbook `docs/qa/PRICING_PROFILE.md` lists the verified images and the GAPs.

## Impact

- Capability: `lab-deployment`. One MODIFIED requirement (`no-local-space` ~1 → ~2) and the ADDED
  `pricing-profile-*` requirements (design.md §9 lists them with the slice that delivers each).
- Repository: `compose.lab-pricing.json`, `lab/tests/test_lab_pricing_profile.py`,
  `openbinding-gateway/tests/test_no_local_space.py`, `docs/qa/PRICING_PROFILE.md`, `docs/DEMO.md`; later
  `lab/tools/space_lab_bootstrap.py`, `lab/tests/test_space_lab_bootstrap.py` and ADR 0022 (design.md §8).
- Factory (outside this repository): `lab_compose` has to accept `file=compose.lab-pricing.json` (follow-up F1); the
  lab admission check and the preview planner must count this project's memory (F1/F2); a preflight that refuses an
  unset or empty `DEMO_SPACE_*` value is a follow-up.
- Follow-ups for M4.2/M4.5: how `SPACE_URL` reaches the gateway (fold the services into the main lab manifest, or
  another route with a recorded exception to the no-`networks` rule); a memory decision for SPACE in previews
  (2 x (4032 + 1088) > 9216); a change to the seed guard that refuses service `openbinding` (`docs/DEMO.md`, about
  line 195); bumping redis and mongo to current patch releases by verified digest (`docs/qa/PRICING_PROFILE.md`, Known
  advisories); an update of ARCHITECTURE §9.4 once the key placement is decided (the coordinator owns that file).
- No HTTP API, OpenAPI or database schema change. No production impact.
- Owner request `crp-openbinding-m41-space-image-and-16-1`, answered on 24-10-2026 (option build-pinned-exception):
  (1) SPACE is built from `SCORELabUS/space` pinned to the commit `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` of tag
  `v1.7.1` (never the tag), mongo and redis by digest; (2) the constitution 16.1 exception applies only to the lab
  bootstrap tool under `lab/tools`, with an architecture test forbidding direct HTTP to SPACE outside `lab/tools` and the
  plans module, the client used wherever `space-python-client` covers the operation, and the exception recorded in
  `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md`. Implementation (S2b, S3, S4) is a follow-on PR after
  this one merges; the marker stays here. Question 3, to be added by the coordinator: where the MANAGEMENT key lives
  (the stack's secret store per ARCHITECTURE §9.4, or inside SPACE until M4.5), settled before S4.
- Risks: R1 `space-api` image unresolved (marker in place until S2b); R8 constitution 16.1 conflict with the bootstrap
  tool, answered with a limited exception implemented in the follow-on PR; R3 memory of the profile is a budget, measured in S5 (ARCHITECTURE §9.4 says
  about 0.7 GiB).
- Order: S1+S2 in one PR, then S2b, S3 and S4 in a follow-on PR, then S5 (tasks.md).

## Out of scope

- A local SPHERE, or any SPHERE API key. The pricing is changed only in SPHERE (constitution 16.2).
- The SPACE web client. It is added only when an administrator needs it.
- Enabling the profile in PR previews (needs a memory decision first, m05-pr-previews design.md §6) and any change
  to the gateway, the plans module or the browser code.
- Implementing the owner's `space-api` build and the 16.1 exception (follow-on PR), and the MANAGEMENT key placement
  (still the owner's decision).
- Wiring the gateway to this SPACE (M4.2/M4.5).
- Production use of a local SPACE. Contracts held by a lab SPACE are synthetic and not carried over.
