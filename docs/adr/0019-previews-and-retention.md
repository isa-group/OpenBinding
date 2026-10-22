Status: PROPOSED for owner review (2026-10-22)

# ADR-0019: Previews before merge and storage retention

- Status: Proposed
- Date: 2026-10-22
- Deciders: owner

## Context

The owner reviews work from a Mac or an iPhone and wants to see `develop` running before any release reaches `main`.
The lab currently holds a 47 GB directory, 23 GB of artifacts and about 70 stale work trees.

## Decision

1. A develop preview follows `develop` in the NiPoGi lab and is published by the homelab Caddy at
   `https://openbinding.home.javiercavlop.com`; PR previews are started on demand and expire after 7 idle days.
2. A change that affects the UI or the runtime is merged only after G12 passed on its preview (constitution Article 19).
3. Every stored data class has a retention rule (`docs/ARCHITECTURE.md` §10); deletion happens only through admin
   purge, factory maintenance operations and `labctl destroy` (constitution Article 18).

## Consequences

- One owner action on the homelab (Caddy site and AdGuard rewrite) enables the develop preview.
- Lab disk stays below 70 % of its quota (INTENT O11).

## Evidence

`docs/ARCHITECTURE.md` §10 and §12, `ROADMAP.md` M0.4–M0.6.
