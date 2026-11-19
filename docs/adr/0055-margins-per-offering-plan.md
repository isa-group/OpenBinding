# 0055. Margins per offering plan

- Status: accepted
- Date: 2026-11-19 (F4-A; plan §7.1 "margen por plan = ingreso − coste upstream por usuario")

## Context

A composition that names its own offering (`offering`, a SPHERE pricing or a Pricing2Yaml URL) can say what each of
its plans earns once the upstream services it binds are paid. The only cost the gateway knows is the global value the
toolchain returns for the binding (`subscription`, `USD/month`); the toolchain returns no cost per task, demand is a
literal of each problem revision, and nothing stores how many users a plan has.

## Decision

**One implementation on the gateway**: `modules/compositions/application/margins.compute()`, pure, over an
evaluation's stored global values and the offering snapshot that evaluation read, with F3's normaliser and
`effective()`. The frontend formats the strings it receives and never subtracts.

- **Rows.** Each plan alone, then each plan with each single non-metered, dependency-free add-on available to it, at
  its minimum quantity, in the pricing's declared order (the single variants), at most 200 (`rowsTruncated`: an
  offering may hold thousands). Revenue per row is the sum of the parts `effective()` keeps, each unit amount ×
  billing multiplier × quantity × the month factor of its unit's period (one table, shared with the SPHERE problem
  generator). A part without a period is named in `excludedParts`; a label price needs a quote. Per subscription: a
  per-seat part counts one seat (`basis: seat`).
- **Cost.** The only global value whose unit is a currency per period (or the one `cost` names), made monthly. **Users
  are explicit**: `users` on the request, `expectedUsers` on an environment; without them the rows carry revenue and
  `users_required`. The cost is **apportioned uniformly** per user and every answer says so (`apportionment:
  uniform`); charging a task's cost only to the plans that use its feature would need per-task costs the toolchain
  does not return.
- **Exact money.** Every amount is turned into a `Decimal` from the float's shortest repr, computed in a 34-digit
  context with traps on and quantized stepwise to six places half-even, so the numbers shown always subtract exactly
  (`29.990000000000002` becomes `29.990000`). Amounts are fixed six-place strings. Any amount beyond 10¹² or not
  finite is `amount_out_of_range` (the cost) or an `outOfRange` row; a hostile price never makes a 500.
- **Statuses, never a silent number.** `no_offering`, `offering_unreadable`, `offering_invalid`,
  `offering_registry_unknown` (no rows), `no_cost_value`, `ambiguous_cost`, `currency_mismatch` (no conversion),
  `binding_invalid` and `semantics_changed` (the cost is not one the version stands behind), `users_required`, and
  `ok`; declared values are computed and said (`declared_values`), never mixed with verified ones.
- **Which evaluation.** `GET …/versions/{version}/margins` reads the current evaluation, or the one `evaluation`
  names: an environment passes its adoption's pinned evaluation, so its margins move only with an adoption. Margins
  are members only (cost per user is business data even for a public composition) and counted as a `read`.
- **Not in the feed.** The feed changes only on adopt ([ADR 0054](0054-composition-environments-and-the-feed.md));
  margins move with an offering version or an evaluation.
- **What-if.** `evaluateComposition` with `users` answers the margins of the what-if values against the offering
  version the version's current evaluation read, and with `revision` evaluates the binding against another revision
  of the linked problem (a demand variant), in memory, stating the demand its recipe pins. Nothing is stored.
- **Goldens.** `tools/dump_margin_goldens.py` writes and checks the cases of `tests/golden/margins` offline, among
  them the hand-computed TomatoMeter numbers.

## Consequences

- F6's "offering changed" deltas call `margins.compute()` with the new snapshot; feature-aware apportionment waits
  for a toolchain that returns per-task contributions; configurations (more than one add-on) are F8's margin rows.
