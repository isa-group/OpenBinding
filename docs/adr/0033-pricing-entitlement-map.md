# 0033. Pricing 0.2.0 is read through one entitlement map

- Status: accepted
- Date: 2026-11-14 (F0b, decision D15 of the F0b implementation plan)

## Context

The gateway enforces OpenBinding's published pricing 0.2.0 (plans FREE, RESEARCH and LAB). Feature and limit ids
were spelled across the code, and a pricing missing one of them only failed when a request needed it.

## Decision

- `modules/plans/domain/entitlement_map.py` is the only place the ids are spelled; the frontend mirrors them in
  `frontend/src/utils/limits.ts`.
- The startup check runs in the `main.py` lifespan. It reads the pricing from SPACE through the SDK, or from a
  package-data byte copy of the YAML (the image copies only `src/`). With SPACE enabled it also requires
  `SPACE_ORGANIZATION_ID` and the `pricing-token-jwks` capability, and fails the boot in production.
- Pricing tokens are verified against SPACE's JWKS and matched to the user with the SDK's `pricing_token_user_id`;
  there is no unverified fallback.
- The YAML text is never edited, and MB means 10^6 bytes.
- `solverHours`, `generator`, `generatedInstances`, `maxInstancesPerGeneration`, `collaboration`, `maxCollections` and
  `maxPrivateProjects` are not enforced, so the check does not require them.

## Consequences

- `tools/check_retired_surface.py` (in the gateway suite as `tests/test_retired_surface.py`) fails when an id is
  spelled as a literal outside the map.
- Publishing pricing 0.3.0, without the ids F0b no longer uses, is an owner action.

Where: `modules/plans/`, `space_client/`, `docs/pricing/README.md`.
