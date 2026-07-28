# Random Search engine

Java service implementing uniform random search over the binding space. It serves as the
**baseline** of the OpenBinding experimental studies: fast, unbiased, and expected to produce the
weakest solutions.

## One request path

The engine takes `{"instance": ..., "options": ...}` and reads the instance itself. Placement
is not a separate path: if the instance carries `resource_model` or `latency_model`, the view
derived from them has pools, capacities and latencies in it; if not, it is empty and the same
search runs unchanged.

Everything but the search strategy lives in [`binding-core`](../binding-core): the instance
model, the evaluator, and the placement semantics - end-to-end latency over the XOR-scenario
DAGs, resource capacity, transition latency and the canonical normalized objective. What is
this engine's own is `RandomBindingSearch`: uniform sampling with feasibility-first selection.

Builds against a JDK 8 runtime, so the core it consumes targets Java 8 bytecode.

## Options and anytime behavior

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
