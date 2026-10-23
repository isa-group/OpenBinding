Status: PROPOSED for owner review (2026-10-22)

# ADR-0017: Modular monolith by bounded context and a feature-sliced frontend

- Status: Proposed; evolves ADR-0012
- Date: 2026-10-22
- Deciders: owner

## Context

The gateway is layered by technical role (`routes`, `services`, `repositories`) with ratchets (ADR-0012), but several
top-level modules mix use cases and persistence, the largest files exceed 1,000 lines, and a change to one domain
touches many folders. The frontend groups 30 page areas with a 1,659-line API client. One deployable is right for the
team and the NiPoGi; what is missing is internal modularity.

## Decision

The gateway becomes a modular monolith of ten bounded contexts (`docs/ARCHITECTURE.md` §4), each with `domain`,
`application` and `adapters`, talking to each other only through application APIs or domain events, and to the
outside only through ports. The frontend adopts a feature-sliced layout (`app`, `pages`, `widgets`, `features`,
`entities`, `shared`) with generated API types. Migration is a strangler: new code in modules first, then one module
per behaviour-preserving refactor change.

## Consequences

- import-linter and ESLint boundaries become gate checks (G9); ADR-0012 ratchets keep shrinking until the old layout
  is gone.
- No big-bang rewrite; the OpenAPI snapshot must not change during moves.

## Evidence

`docs/architecture/gateway-as-is.md`, `docs/ARCHITECTURE.md` §4–5, `ROADMAP.md` M9.
