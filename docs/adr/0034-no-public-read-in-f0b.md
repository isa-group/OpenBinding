# 0034. No public read in F0b

- Status: accepted
- Date: 2026-11-14 (F0b, decision D17 of the F0b implementation plan)

## Context

Public read was entirely project-based: public projects exposed their cases, runs and studies to visitors. F0b
removed projects.

## Decision

F0b has no public entity and no public read. Problems, runs and studies are visible to members of their organization
only. The stateless `/v1/bim/validate` and `/v1/bim/templates*`, which serve the anonymous Workbench (ADR 0037), read
no entity.

## Consequences

- Public reads come back with compositions (F1/F9), as a showcase.
- F1 added compositions without public read: a composition the caller cannot read answers `404`
  ([ADR 0046](0046-compositions-module.md)), and public composition read is deferred to the showcase (F2/F9).
- The engine catalogue stays public, as before.

Where: `security/apikeys.py`, `docs/ACCESS_POLICY.md`.
