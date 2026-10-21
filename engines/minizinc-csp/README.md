# MiniZinc exact engine

This service lowers a deliberately small canonical `bim/v1` `BindingProblem`
subset to `model/binding_problem.mzn` and solves it with Gecode. It never reads
an `Instance` package or authoring resource.

## Declared subset (`exact-weighted` mode)

* **Objective:** SINGLE weighted-sum utility over normalised (clamped or
  unclamped) or raw criteria, plus constant soft-constraint penalties and
  placement penalties.
* **Workflow nodes:** task, empty, sequence, parallel, probabilistic XOR,
  repeat with an exact `count` or an `expectedCount`.
* **Aggregations:** sequence/parallel `sum`, `product`, `min`, `max`; XOR
  `weightedSum`, `weightedProduct`, `min`, `max`; repeat `scale`, `power`,
  `identity`; selected-candidate `sum`, `product`, `min`, `max`. Multiplicative
  aggregations are lowered with the logarithmic linearisation described in
  [`MULTIPLICATIVE_AGGREGATIONS.md`](MULTIPLICATIVE_AGGREGATIONS.md).
* **Constraints:** hard and soft comparisons (soft ones need a constant,
  non-negative penalty), optionally joined by `and`, over global features and
  task candidate/provider/property/feature paths.
* **Placement:** the complete `qos-binding-placement/v1` overlay (pools,
  demands, per-invocation or selected-candidate capacity rules, directed network
  and event latency, hard/soft transition bounds, global workflow latency).

Conditional XOR, custom aggregation expressions, dynamic soft penalties and
expressions other than comparisons/conjunctions remain outside this mode and are
rejected (HTTP 422 with the construct named) before execution.

## Options

`solver` (fixed to `gecode`), `time_budget_ms` (flattening and search together),
and `product_constraints` (`log`, the default, or `real`: whether comparisons on
multiplicative features are posted in log space or on the real product; the
objective always uses the exact product).

## Execution pipeline

1. The lowering (`src/dzn_builder.ts`) writes the data file. Every number it
   prints that is not instance data is deliberately *not* tight
   (`src/numeric.ts`, slack relative `1e-9`, absolute `1e-9` below magnitude 1):
   * the technical bounds the model needs for finite float domains
     (`metric_bound`, `node_metric_bound`, `term_bound`, `objective_bound`,
     `log_metric_bound`, placement time and penalty bounds) are widened by one
     slack;
   * the literal of every non-strict comparison (`<=`, `>=`, including the
     placement capacity limits and transition maxima) is moved by one slack in
     the direction that enlarges the feasible region. Strict comparisons and
     (in)equalities keep their literal.

   MiniZinc prints float literals into the FlatZinc with 16 significant
   digits, one short of the 17 that round-trip a double, and Gecode propagates
   outward-rounded intervals. A bound or limit that equals an attainable value
   exactly (the sum of the slowest candidate of every task, a limit generated
   from a reference binding) can therefore leave the flattener one ulp below
   that value and exclude precisely the extreme binding it was computed from.
   The first QACOBench campaign recorded two false optima of this kind
   (`qfbs_guaranteed_20_011` and `_033`): the tight `metric_bound` survived as
   an explicit `float_le` that the FlatZinc post-processing below does not
   rewrite. The solver thus reasons about a relaxation; the exact evaluation of
   every returned decision (step 4) is the arbiter.
2. `minizinc -c` flattens the model with the data into FlatZinc.
3. The FlatZinc is post-processed (`src/minizinc_runner.ts`):
   * every bounded float domain is widened by the same slack. MiniZinc derives
     float domains from the parameter data and prints them with finite
     precision, so an optimum lying exactly on a derived bound (the best
     candidate of every task, a normalised loss of 0 or 1) could fall one ulp
     outside the printed domain and produce a false `UNSATISFIABLE` or a false
     optimum. Explicit `float_le`/`float_lt` constraints are left alone: the
     post-processing cannot tell a technical bound from a user constraint,
     which is why step 1 widens the bounds at the source;
   * dead variables (declared but referenced by no constraint) are dropped;
   * every float variable is declared functionally defined. Gecode's FlatZinc
     front-end otherwise appends a default float brancher for floats that are
     neither defined nor searched, and splitting intervals that propagation
     keeps a few ulps wide multiplied the search tree by orders of magnitude
     (millions of nodes on instances that need a hundred). All floats of this
     model are functions of the slot variables, so nothing is lost.
4. `fzn-gecode -a -time <remaining budget>` solves. The solver stream is
   translated back to candidate references; when an output was fixed at
   flattening time (every candidate of a task decided by propagation, a
   constant objective) the solver prints nothing for it and the block is
   rendered through MiniZinc's own output pass (`minizinc --ozn-file`,
   provenance `ozn_rendered`). Every incumbent is re-evaluated exactly: the
   latest one that satisfies the exact constraints is returned, as `OPTIMAL`
   only when it is the last one and the proof completed; an incumbent that
   satisfies only the relaxed comparisons (it lies within one slack beyond a
   limit) is rejected and listed in the provenance
   (`relaxed_incumbents_rejected`). The gateway re-evaluates the decision once
   more and is the authority on feasibility and on the objective value.

The solver is pinned to the official MiniZinc 2.8.7 bundle (Gecode 6.3.0) in
the Dockerfile; `MINIZINC` / `FZN_GECODE` environment variables override the
executables and `MINIZINC_CSP_MODEL` the model path (used by the campaign's
regression harness).

A completed proof returns `OPTIMAL`, a timed incumbent `FEASIBLE`, a proof of
no assignment `INFEASIBLE`, and a run without an incumbent `UNKNOWN`. Returned
candidate indices are translated back to full `{resource,id}` references and
re-evaluated into the common result shape; the provenance carries the flattening
time, the number of widened domains, whether the `.ozn` pass was needed, any
rejected relaxed incumbents and the encoding facts (flat products, log-space
features, log-space atoms, soft constraints, bin-packing columns, relaxed
literals).

## Search and encoding of candidate tables

The model branches on the slot variables only (`first_fail`, `indomain_min`).
The lowering lists each task's candidates from the most to the least promising
estimated weighted loss, so the in-order value choice reaches good incumbents
early; every float variable is functionally determined by the slots.

Gecode has no float element propagator: MiniZinc decomposes `value = table[slot]`
into one reified equality per slot, which never tightens the value's bounds from
the remaining slots and, on catalogs with tens of thousands of candidates
(BWS-SCP: 240 tasks x 240 servers), produced FlatZinc files of half a million
constraints whose flattening alone exceeded the time budget. Every float table
(candidate values, powers, logarithms, demands, constrained task properties) is
therefore read through native integer element constraints over **fixed-point
limbs**: `hi = round(v * s)` with `s` the largest power of ten keeping `|hi| <
2^31`, plus `lo = round((v - hi/s) * s * 1e9)` when the values are not exact
decimals at that scale. The value is recovered through an exact linear
equality (`value * s == hi`, or `value * (s * 1e9) == hi * 1e9 + lo`). For
decimal data the recovered rational is the decimal itself and the interval
Gecode keeps for `value` contains the original double; otherwise the
reconstruction is within one ulp. The same instance flattens in about one
second instead of twelve, and the integer element propagates bounds in both
directions.

Capacity rules whose demand is constant per task (the demand does not depend on
which candidate of the pool's model is chosen) and whose weights and limits are
integral after a common power-of-ten scaling are posted as one native
`bin_packing_capa` per resource column over the task pool variables (Gecode's
bin-packing propagator reasons about the loads of all pools at once); other
rules keep the reified per-pool sums.

Run `pnpm test` with Node.js 20 or newer; the end-to-end cases run when
`minizinc` is on `PATH`.
