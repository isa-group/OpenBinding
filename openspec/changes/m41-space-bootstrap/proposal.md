# Change: m41-space-bootstrap

## Why

ROADMAP M4.1 asks for a pinned SPACE 1.7.1 and a `pricing-bootstrap` that creates the `openbinding` service from
`https://sphere.score.us.es/p/6ab0a323697330667ccce891` (`all_last`) and contracts for the synthetic users.
`m41-space-lab-profile` delivered the profile with the marker `gap.invalid/space-api:1.7.1` and left the bootstrap as
two placeholder requirements. The owner answered on 24-10-2026 (own-36b6e089): "M4.1 second part, SPACE image from the
v1.7.1 commit and bootstrap with exception 16.1 in lab/tools" (earlier answers own-78031d63, build-pinned-exception,
and own-e95fb0a1, approve-m41).

## What Changes

- `lab/space/Dockerfile` builds SPACE's api from `SCORELabUS/space` at commit
  `ef4dc8949435d998e2aff525226e3fcc85e2f7ba` (tag `v1.7.1`, never the tag), checks the checked-out `HEAD`, and uses
  bases pinned by digest and a numeric non-root user.
- `lab/tools/space_lab_bootstrap.py` (image `lab/tools/Dockerfile`) creates the organization `openbinding`, a
  `MANAGEMENT` key, the `openbinding` service from the SPHERE link with `all_last`, waits for its first synchronization
  and creates one contract per synthetic user of the seed; a re-run changes nothing.
- The tool holds no SPHERE key, sends nothing to SPHERE and never persists or prints a secret.
- ADR 0022 records the exception to constitution 16.1 limited to `lab/tools`; an architecture test forbids direct HTTP
  to SPACE or SPHERE elsewhere, except the gateway plans module and two pinned pre-existing deviations
  (`openbinding-gateway/tools/_remote_common.py`, `openbinding-gateway/src/openbinding_gateway/sphere_client.py`).

## Impact

- Capability `lab-deployment`: five ADDED requirements. On archive of `m41-space-lab-profile` the coordinator replaces
  its stubs `pricing-profile-bootstrap` and `pricing-profile-bootstrap-boundary` by them (design.md §1).
- Repository: `lab/space/Dockerfile`, `lab/tools/Dockerfile`, `lab/tools/space_lab_bootstrap.py` and its requirements,
  `lab/tests/test_space_lab_bootstrap.py`, `lab/tests/test_no_direct_space_http.py`, `docs/qa/PRICING_PROFILE.md`,
  `docs/adr/0022-lab-bootstrap-exception-to-constitution-16-1.md`. Compose files are not edited (wiring is a
  follow-up, design.md §7). The constitution is not edited.
- No gateway, HTTP API, OpenAPI or database change. No production impact.
- Risks: the SPACE HTTP sequence is UNVERIFIED against a live v1.7.1; three base digests have medium confidence and are
  unbuilt here; the `MANAGEMENT` key placement is an assumption pending the owner's question 3.

## Out of scope

- Wiring `pricing-bootstrap` and the `space-api` build into `compose.lab-pricing.json`, and the revision of the
  pricing-profile tests that allows `build`.
- Live evidence (slice S5 of `m41-space-lab-profile`), and moving the gateway to this SPACE (M4.2/M4.5).
- Moving or retiring `openbinding-gateway/tools/_remote_common.py`.
