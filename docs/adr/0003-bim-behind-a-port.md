Status: DRAFT for owner review (2026-10-21)

# ADR-0003: The platform reaches BIM only through `BimPort`

- Status: Accepted
- Date: 2026-10-21 (recorded; implemented in the platform work up to 9b5be00)
- Deciders: owner (approved joint plan, 2026-10-12/14)

## Context and problem

The language code lived inside the gateway (`openbinding_gateway/v1/`), coupled to routes, persistence and pricing.
BIM must evolve and be released independently and must be runnable out of process (untrusted ZIP/XML parsing with its
own limits).

## Decision

Split BIM into `bim-core` (library), `bim-service` (stateless HTTP `/bim/v1`) and `bim-client` (`BimPort` with
`InProcessBim` and `HttpBim`, which must return the same values and raise the same errors). The gateway builds the port
in one place (`integrations/bim.py`, `BIM_MODE=inproc|http`) and no other module imports BIM packages. In `http` mode the
gateway refuses to start if the service `compilerDigest` differs from the local one.

## Consequences

- Platform concepts never enter BIM; BIM errors are translated to HTTP in one place.
- An equivalence battery and consumer fixtures keep both implementations and both repositories in step.
- `bim-service` has no accounts or authorisation beyond bearer tokens; the platform decides who may call BIM.

## Evidence

`openbinding-gateway/src/openbinding_gateway/integrations/bim.py`, `openbinding-gateway/tests/test_bim_boundary.py`,
`openbinding-gateway/tests/test_bim_port_host.py`, `bim-toolchain/docs/CLIENT.md`, `bim-toolchain/packages/bim-client/tests/test_equivalence.py`.
