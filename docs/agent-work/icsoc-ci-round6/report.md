# icsoc-ci-round6: latency lookups through the native integer element

## Hypothesis (inferred from the model text, not measured; MiniZinc is not available here)

CI on PR #24 (head 6bb9bbd) still ends FEASIBLE in minizinc-csp at 30000 ms:
nodes 96465, propagators 27851, variables 14874, about 2600 propagations per
node. Threads and dropping vacuous capacity checks barely changed it.

`pool_latency[a, b]` (2-D) and `event_latency[e, p]` are float arrays read with
pool variables as subscripts. Gecode has no float element propagator, so
MiniZinc decomposes each access into one reified equality per cell:
`n_pool_slots^2` (56 pools: 3136) for each `pool_latency` access and
`n_pool_slots` for each `event_latency` access. The previous model used integer
latencies, which compile to a single native element. That would explain the
propagator and variable counts and the slow nodes.

## Change

- `model/binding_problem.mzn`: two functions defined after `table_value` and
  after the `pool_latency`, `event_latency` and `n_pool_slots` declarations.
  - `pool_pair_latency(from_pool, to_pool)` flattens `pool_latency` row-major and
    reads cell `(from_pool - 1) * n_pool_slots + to_pool` through `table_value`.
  - `event_pool_latency(event, to_pool)` reads row `event` of `event_latency`
    through `table_value`.
- `transition_latency` and the activity predecessor constraint call these
  functions instead of subscripting the float tables. No raw variable subscript
  of either table is left; the only subscripts remaining are in the two
  comprehensions that feed `table_value`.
- `src/minizinc_runner.test.ts`: `latency lookups` describe with three static
  checks on the model text (comments filtered).

Not touched: `time_budget_ms`, thresholds, expected OPTIMAL, baseline JSON,
digests, weights.

## Why the semantics are preserved

The lookup returns the same table entry for the same pool indices. It uses the
same fixed-point `table_value` as every other float table in the model
(task metrics, candidate demands, candidate values), with the same `value` bounds
`min(table)..max(table)`. Indices are 1-based in both functions: row-major
cell `(a - 1) * n + b` ranges over `1..n^2` for `a, b` in `1..n`.

## Risks

- Precision: `table_value` scales to a 32-bit integer and recovers the value
  within one ulp (exact for decimal data). The engine and the gateway
  re-evaluate returned bindings with the original doubles, as for the other tables.
- The real accesses of the instance (how many `transition_latency` and predecessor
  accesses use variable pools) were not measured; the gain depends on it.
- `table_value` adds an auxiliary float `value` and an int `high` per access, so
  variables may rise slightly while propagators should fall.
- No MiniZinc here: the model change was not compiled. Only the static tests and
  the TypeScript build ran.

## What to look at in the next CI

Compare against 27851 / 14874 / 96465:

- `propagators`: expected a large drop. If it stays near 28k, the hypothesis
  is false and the cost is elsewhere.
- `variables`: should not grow much.
- `nodes` and `search_ms`: more nodes in the same time budget.
- `termination`: whether it reaches OPTIMAL (expected) or stays FEASIBLE.
