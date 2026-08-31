# Many-objective heuristic engine

This BIM v1 engine performs seeded sampling and keeps a bounded non-dominated
archive for Pareto optimization. Its single mode rejects other optimization
strategies instead of returning a result with different semantics.

It receives only `BindingProblem` IR through `bim-engine/v1`. Full
catalog-qualified candidate references are preserved in the archive and in
every decision. Source resources are rejected. Its mode declares placement
selector `all` and selects only `qos-binding-placement/v1` in `irExtensions`.
`binding-core` applies the complete lowered placement contract to every sampled
decision.

Options are `iterations`, `archive_size`, `seed` and `time_budget_ms`. The
algorithm is heuristic: successful results terminate as `FEASIBLE`, and an
empty feasible archive terminates as `UNKNOWN`.

Run `mvn test` with Java 8 or newer.
