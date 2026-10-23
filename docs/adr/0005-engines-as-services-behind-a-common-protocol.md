Status: DRAFT for owner review (2026-10-21)

# ADR-0005: Engines are separate services behind `bim-engine/v1`, and their answers are re-evaluated

- Status: Accepted
- Date: 2026-10-21 (recorded)
- Deciders: owner

## Context and problem

Solvers are written in different languages (TypeScript + MiniZinc, Java heuristics) and third parties must be able to
add their own. Results must be comparable and trustworthy regardless of the engine.

## Decision

Every engine is an HTTP service implementing `schemas/engine-contract.openapi.yaml`
(`POST /internal/v1/binding-problems` answering `200` result or `202` job receipt; `GET /internal/v1/jobs/{id}`;
optional `DELETE` cancellation declared as a capability). Each engine publishes a manifest with exact modes, capability
selectors, options and termination guarantees (`schemas/bim/v1/manifests/`). The gateway selects only compatible modes,
sends only the IR, validates the result shape, keeps the raw answer as evidence, and re-evaluates every binding with the
canonical evaluator, downgrading termination claims the mode does not guarantee. Third-party engines are registered
(`/v1/engine-registrations`) and verified for conformance before activation.

## Consequences

- No engine-specific code paths in the gateway beyond manifests.
- Engines must tolerate seeing a job more than once (at-least-once, ADR-0006).
- Java engines share `binding-core` (canonical evaluator, async job layer); MiniZinc supports an explicitly declared subset.

## Evidence

`docs/ENGINE_INTEGRATION.md`, `schemas/engine-contract.openapi.yaml`, `openbinding-gateway/tests/test_v1_job_guarantees.py`,
`openbinding-gateway/tests/test_v1_remote.py`, `openbinding-gateway/tests/test_engine_registry_service.py`,
`engines/binding-core/README.md`.
