# 0046. The compositions module, its access rule and key permissions, and run presets in execution

- Status: accepted
- Date: 2026-11-15 (F1, decisions D12, D16, D17 and D18 of the F1 implementation plan; owner direction of
  2026-11-15 on SPHERE's read rule)

## Context

Compositions are derived from runs and will be produced from a study's trade-off set, and runs start from presets.
The language library must not grow a second semantics of BIM. The platform answers a non-member of an organization
in two ways today (403 for problems and studies, 404 for runs), and SPHERE answers a private pricing the caller
cannot read exactly like a missing one.

## Decision

- `modules/compositions` sits between `laboratory` and `execution` in the module layers. Other modules reach it only
  through `modules.compositions.application`. The audit helper is shared from `modules/shared/application`.
- The library `openbinding_gateway/composition` stays outside `modules/` and is pure: the blocking import-linter
  contract `composition-library-pure` forbids it the modules, the database, the web layer, the toolchain and HTTP
  clients. Facts about a problem reach it as plain data.
- Access follows SPHERE's private read rule: a composition the caller cannot read answers `404`, exactly as a
  missing one, on every route and before any conditional-request handling. A member whose role is too weak for a
  write gets `403 organization_forbidden`. VIEWER reads, checks, compares, evaluates other bindings and explores the
  neighbourhood; MEMBER creates, seals, re-evaluates and derives; ADMIN deletes. A fork needs read on the source and
  MEMBER on another organization.
- New API key permissions `compositions:read` and `compositions:write`; `organizations:*` does not reach
  compositions. Creating and forking need the plan's `repository` feature (pricing 0.2.0 has no composition feature).
- Bounded cost: 262 144 bytes per document; per-process slots for the language (4) and for evaluations (2), refused
  at once with `429 composition_busy`; two work classes, `read` (stateless language services) and `evaluate`
  (seal, check, fork, re-evaluate, evaluate, neighbourhood, derive).
- Run presets (`run_presets`: engine, registration, mode, options, optimisation) live in `execution`, because
  `createRun` expands them and execution may not import compositions. A run copies the preset's settings and records
  it as `{id, slug}`. Presets never enter a document (this supersedes [ADR 0029](0029-no-run-presets-in-f0b.md)).

## Consequences

- "One semantics" is enforced mechanically rather than by review.
- An outsider cannot tell a private composition from a missing one.
- Public read arrives with the showcase (F2/F9), as one more case of the read rule.

Where: `modules/compositions/`, `modules/execution/`, `importlinter-modules.ini`, `security/apikeys.py`,
`access/work_limits.py`, `docs/ACCESS_POLICY.md`.
