# MiniZinc exact engine

This service lowers a deliberately small canonical `bim/v1` `BindingProblem`
subset to `model/binding_problem.mzn`. It never reads an `Instance` package or
authoring resource.

The `exact-weighted` mode supports MONO weighted utility, task, empty,
sequence, parallel, probabilistic XOR and exact repeat nodes. Its executable
aggregations are sequence/parallel sum/min/max, XOR weighted sum/min/max,
repeat scale or identity, and selected-candidate sum/min/max. Hard comparison
constraints may read global metrics and task candidate, provider, property or
metric paths.

Placement is optional. With no Placement IR, its arrays and constraints are
vacuous. When supplied, the same exact model consumes canonical pools,
candidate-to-pool demands, per-invocation or selected-candidate capacity rules,
directed network and event latency, hard/soft transition bounds, and global
workflow latency (probabilistic XOR plus parallel max or sum, with optional
execution latency). The mode therefore declares `placement=all` and the
versioned `qos-binding-placement/v1` IR extension. Conditional XOR, expected
repeat counts, soft ConstraintSet expressions, custom expressions and
nonlinear aggregations remain outside this mode and are rejected before
execution.

Options are `solver` (fixed to `gecode`) and `time_budget_ms`. The latter is
mapped directly to MiniZinc's `--time-limit`. A completed proof returns
`OPTIMAL`, a timed incumbent `FEASIBLE`, a proof of no assignment `INFEASIBLE`,
and a run without an incumbent `UNKNOWN`. Returned candidate indices are
translated back to full `{resource,id}` references and reevaluated into the
common result shape.

Run `pnpm test` with Node.js 20 or newer.
