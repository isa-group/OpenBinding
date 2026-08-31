# BIM v1 evolutionary design rationale

Bindings are categorical decisions, not integers with a meaningful distance.
The implementation therefore stores each gene as a complete candidate
reference, uses uniform gene crossover and mutates by resampling from the
compiled eligibility domain. This also prevents collisions when catalogs use
the same local candidate id.

Search and semantics are deliberately separate. `binding-core` is the single
deterministic evaluator; the evolutionary module only creates and selects
decisions. Feasibility is ranked before objective loss. Pareto mode keeps only
feasible, non-dominated evaluations and bounds the archive explicitly.

The engine receives no authoring resources. Its public declaration fixes
`qos-binding/v1`, `bim/v1`, closed options and honest heuristic guarantees.
Unsupported constructs are rejected before search.
