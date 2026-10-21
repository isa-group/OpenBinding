Status: DRAFT for owner review (2026-10-21)

# ADR-0012: Layered gateway enforced by architecture tests with shrinking ratchets

- Status: Accepted
- Date: 2026-10-21 (recorded)
- Deciders: owner (approved joint plan, goal 4)

## Decision

`routes → services → repositories / integrations → db`, with `domain`, `models` (DTOs, not ORM) and `core` usable by
all; `services/`, `domain/`, `jobs/` never import `routes`. Legacy exceptions are frozen lists that may only shrink
(`ALLOWED_LEGACY`, `GATE_LIFECYCLE_LEGACY`) and `routes/v1.py` has a line ceiling that only goes down.

## Evidence

`docs/ARCHITECTURE.md`, `openbinding-gateway/tests/test_architecture_layers.py`.
