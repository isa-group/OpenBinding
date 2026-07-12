# MiniZinc CSP engine

Exact solver for OpenBinding instances. A TypeScript service translates each BIM / BIM\* instance
into MiniZinc data (`src/dzn_builder.ts`) and solves `model/composition.mzn` with Gecode.

## Model highlights

- Generic QoS aggregation over the composition tree (SEQ / AND / XOR / LOOP / ELEMENT).
- **BIM\* placement extensions**: per-candidate pool bindings, cumulative `RESOURCE_CAPACITY`
  constraints, pairwise transition-latency constraints (2-D `element` over the latency matrix), and
  end-to-end latency as the expected makespan over XOR scenarios, encoded as a PERT-style
  lower-bounded scheduling model per scenario (sound because the latency feature is only minimized
  or bounded from above; the dzn builder rejects unsound bound directions).
- All placement quantities are integers (latencies scaled by 1000, integral demands/capacities) —
  Gecode propagates integers far better than floats.
- Canonical normalized objective (identical to the gateway reference evaluator) when the instance
  declares normalization bounds; the legacy UB-scaled objective otherwise.
- Search: `int_search(pick_idx, first_fail, indomain_min)` — dramatically stronger than the default
  search on placement instances.

## Anytime behavior

The solver runs with `--intermediate-solutions` and an optional `--time-limit`
(option `time_limit_ms`). When the budget expires it returns the **last incumbent under
consideration** even without an optimality proof, together with a timestamped incumbent trace.
Completion status is reported in provenance:

| status | meaning |
|---|---|
| `OPTIMAL` | search completed with proof |
| `SATISFIED` | budget expired; best (unproven) incumbent returned |
| `UNSATISFIABLE` | infeasibility proved — no assignment satisfies the hard constraints |
| `UNKNOWN` | budget expired before any incumbent was found |

Options: `{"solver": "gecode", "time_limit_ms": 300000, "intermediate_solutions": true, "debug": false}`.
