# MiniZinc CSP engine

Exact solver for OpenBinding instances. A TypeScript service translates each BIM / BIM′ instance
into MiniZinc data (`src/dzn_builder.ts`) and solves `model/composition.mzn` with Gecode.

## Model highlights

- Generic QoS aggregation over the composition tree (SEQ / AND / XOR / LOOP / ELEMENT).
- **Shared candidates**: a candidate appears in the market of every task it can implement, so
  two tasks may select the same one. `task_share[t]` counts how many do, and a feature declared
  `DIVIDE` is read through `shared_qos`, a table of every quotient the division can produce -
  dividing by a decision variable is neither linear nor kind to a finite-domain solver. The
  table collapses to a single dummy column when no feature divides, leaving those models
  exactly as they were. Capacity sums over *candidates* rather than tasks for the same reason:
  one candidate is one deployment however many tasks it serves.
- **BIM′ placement extensions**: per-candidate pool bindings, cumulative `RESOURCE_CAPACITY`
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

## Tests

```bash
pnpm test                       # compiles, then runs node:test over dist/
pnpm run regenerate-dzn-golden  # rewrites tests/golden/*.dzn
```

The DZN snapshots are taken from `tests/fixtures/*.json`, which are checked-in copies of the
bundled examples **in their canonical form**. An example may be written with the authoring
shorthands, and expanding those is the gateway's job, done once on the way in; this engine only
ever sees the expansion. Refresh a fixture with:

```bash
python openbinding-gateway/tools/bim_desugar.py \
    examples/placement/01_small_placement.json \
    -o engines/minizinc-csp/tests/fixtures/placement.json
```
