Status: DRAFT for owner review (2026-10-21)

# ADR-0010: Plans are read from remote SPACE/SPHERE; nothing is metered or charged

- Status: Superseded by ADR-0015 (its "nothing is metered or charged" rule stays)
- Date: 2026-10-21 (recorded; decided 2026-10-13/14)
- Deciders: owner

## Context and problem

An earlier version had local pricing, credits, compute units and automatic engine selection, duplicating what SPACE
and SPHERE (SCORE Lab services) provide.

## Decision

SPACE (remote, `MANAGEMENT`-scoped client) owns contracts and plan entitlements; SPHERE publishes the pricing
read-only. OpenBinding shows plans, reads the published pricing, and reads plan capabilities only through
`services/entitlements.py`. There are no credits, compute units, metering or automatic engine selection. The only
non-plan limit is the technical per-account concurrency cap. With `SPACE_ENABLED=false` an open gate applies.
SPACE is on hold: zero calls until the owner decides.

## Consequences

- Tests forbid a local SPACE stack, local pricing and metering imports.
- Usage counters of "class B" are not applied until a real SPACE is measured.

## Evidence

`docs/ACCOUNTS_AND_PLANS.md`, `openbinding-gateway/tests/test_no_local_space.py`, `openbinding-gateway/tests/test_no_local_pricing.py`,
`openbinding-gateway/tests/test_architecture_layers.py`, `openbinding-gateway/tests/test_published_pricing.py`.
