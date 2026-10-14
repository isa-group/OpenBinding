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

## Asynchronous mode (opt-in)

By default the service is synchronous and listens on `PORT` (default `8080`). With
`ENGINE_JOB_MODE=async` the same POST answers `202` with a job id, `GET
/internal/v1/jobs/{id}` reads the job and `DELETE` cancels it; the sampler stops at
its next iteration and the job is reported `cancelled` only once the solver thread
has returned. `ENGINE_AUTH_TOKENS=tenant=token,...` makes jobs private to the tenant
that submitted them. See
[`docs/qa/ENGINE_CANCELLATION_JAVA.md`](../../docs/qa/ENGINE_CANCELLATION_JAVA.md).
