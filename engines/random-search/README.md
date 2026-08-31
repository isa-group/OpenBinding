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
