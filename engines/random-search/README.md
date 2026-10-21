# Random-search engine

Seeded uniform sampling over the eligibility matrix of a canonical `bim/v1`
`BindingProblem`. Candidate identity is always the full `{resource,id}` pair,
so equal local ids in different catalogs remain distinct.

The service accepts `bim-engine/v1` requests at
`POST /internal/v1/binding-problems`. It rejects source packages, unknown
request fields, and unknown options. Its mode declares placement selector
`all` and selects only `qos-binding-placement/v1` in `irExtensions`;
non-empty lowered placement is evaluated by `binding-core`, including capacity,
network/event latency, transitions, and global latency. Every returned binding
includes the common deterministic evaluation.

Options are `iterations`, `seed` and `time_budget_ms`. The mode returns
`FEASIBLE` only when it found a feasible sample; otherwise it returns
`UNKNOWN`. This heuristic never claims optimality or proves infeasibility.

Run `mvn test` with Java 8 or newer.

## Asynchronous mode (opt-in)

By default the service is synchronous and listens on `PORT` (default `8080`). With
`ENGINE_JOB_MODE=async` the same POST answers `202` with a job id, `GET
/internal/v1/jobs/{id}` reads the job and `DELETE` cancels it; the search loop
stops at its next iteration and the job is reported `cancelled` only once the
solver thread has returned. `ENGINE_AUTH_TOKENS=tenant=token,...` makes jobs
private to the tenant that submitted them. See
[`docs/qa/ENGINE_CANCELLATION_JAVA.md`](../../docs/qa/ENGINE_CANCELLATION_JAVA.md)
for the protocol, the limits and the failure modes (no exactly-once; a restart
loses every id).
