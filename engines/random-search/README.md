# Random Search engine

Java service implementing uniform random search over the binding space. It serves as the
**baseline** of the OpenBinding experimental studies: fast, unbiased, and expected to produce the
weakest solutions.

## Two request paths

- **Legacy path** (`SolveRequest` DTO: `composition` + `market` + `features`): the original
  QoS-aware composition solver (`es.us.isa.qosawarewsbinding`). Budget: `config.max_iterations`.
- **BIM\* placement path** (payload with `instance` + `placement` + `config`): activated by the
  gateway for placement-aware instances. Implemented in `es.us.isa.qosawarewsbinding.bimstar`
  (Java 8 — this engine builds with JDK 8), which mirrors the evolutionary engine's evaluator and
  the gateway reference evaluator: end-to-end latency over precomputed XOR-scenario DAGs, resource
  capacity, transition latency, budgets and the canonical normalized objective.

## BIM\* options and anytime behavior

```json
{"max_iterations": 1000, "seed": 7, "time_budget_ms": 300000}
```

- `seed` makes runs fully reproducible.
- `time_budget_ms` is the wall-clock stopping criterion; `max_iterations` acts as a **minimum
  evaluation floor** that is always honoured (without a time budget it is the sole budget).
- The engine returns its **best sample even when infeasible** (the gateway reference evaluator
  flags it `feasible=false`), plus a best-so-far trace
  `[{eval_index, elapsed_ms, best_objective, feasible, hard_violation}]` for offline convergence
  and cutoff studies.
- The response's `objective_value` is the engine's **internal search objective** (weighted mean of
  normalized losses, lower is better). The gateway replaces it with the canonical reference value
  and keeps the engine's number as `engine_objective_value` for the per-run integrity audit.
