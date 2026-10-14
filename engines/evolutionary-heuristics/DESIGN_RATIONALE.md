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

## Cancellation

Options and the objective class are validated by `EvolutionarySolver.plan`, a
step separate from the search, so that the optional asynchronous mode can refuse an
unsupported request with `422` before it creates a job; the synchronous POST runs
the same plan at once. The search calls `Cancellation.checkpoint()` at the head of
each generation, before each chromosome is scored and before each child is bred,
and `binding-core` calls it once more per evaluation. A cancel therefore stops the
search within one evaluation, with no state to unwind: the incumbent and the archive
of a cancelled run are simply dropped, and the job is reported cancelled only after
the search method returned. The checkpoint does nothing when no job is bound to the
thread, so seeded runs, and their results, are the same in both modes.
