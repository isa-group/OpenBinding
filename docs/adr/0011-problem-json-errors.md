Status: DRAFT for owner review (2026-10-21)

# ADR-0011: Every error is an RFC 9457 problem document with a stable code

- Status: Accepted
- Date: 2026-10-21 (recorded)
- Deciders: owner

## Decision

All gateway errors use `application/problem+json` with `type`, `title` (= `code`), `status`, `code`, `detail`; every 422
carries a non-empty `diagnostics` list with JSON Pointers and, for compiler findings, the resource and source span.
Clients (including the frontend) branch on `code`, never on message text.

## Evidence

`docs/ERRORS.md`, `openbinding-gateway/src/openbinding_gateway/core/public_errors.py`, `openbinding-gateway/tests/test_b4_problem_schema.py`,
`frontend/src/api/problem.test.ts`.
