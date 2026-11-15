# 0043. Global values and binding validity come only from BimPort, exactly as returned

- Status: accepted
- Date: 2026-11-15 (F1, decisions D5 and D10 of the F1 implementation plan)

## Context

BIM already defines how a binding aggregates into global values and when it is feasible, in one implementation (the
toolchain). The evaluator works in IEEE-754 doubles (`latency 51.650000000000006`), and its binding check
(`validate_binding`) raises one `binding_invalid` with a message. Re-summing values or re-deciding eligibility in the
gateway would be a fourth implementation of the semantics, and would drift.

## Decision

- Values are `BimPort.evaluate`'s floats, stored and written exactly as returned; a written float reads back as the
  same double. No aggregation, conversion or rounding happens in gateway code. Exact `Decimal` arithmetic applies
  only to the document's own `xor` probabilities, compared the way the compiler compares them.
- A binding is valid when `evaluate` raises no `EvaluationError` and returns no hard violation. Every binding that
  translates into `{resource, id}` goes to the toolchain, including an ineligible candidate or a local-task misuse;
  `c2y_candidate_not_allowed` and `c2y_task_local_mismatch` only locate the toolchain's refusal
  (`c2y_binding_invalid`, its message carried as given, never parsed). Only an untranslatable id
  (`c2y_candidate_unknown`, `c2y_candidate_ambiguous`) skips the call.
- Units are the problem's strings and compatible means equal. `c2y_value_differs` ignores a relative difference
  below `1e-9`; the stored value is always the computed one.
- The only IR reads are data lookups of the interchange format: task kinds, workflow and routing, eligibility,
  catalogs, feature units and required features.

## Consequences

- A parity test runs every lookup finding through the real port, so the lookup is never stricter than the
  toolchain; the gateway logs `composition_lookup_stricter_than_toolchain` if it ever is.
- One request evaluates at most once (or once per binding for `evaluate`), so tests pin the number of port calls.

Where: `composition/problem.py`, `modules/compositions/application/assess.py`, `integrations/bim.py`.
