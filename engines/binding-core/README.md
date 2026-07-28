# binding core

The problem semantics every JVM engine shares. What is left in an engine after
depending on this is its search strategy, which is the only thing that should
differ between them.

## What is here

| | |
|---|---|
| `model/` | The instance, one class per component of the tuple `I' = (M_A, M'_C, Δ, O)`: `application` (T, G, Λ), `candidate` (P, C, F), `placement` (R, L), `constraints` (Δ), `objective` (O) |
| `PlacementModel` | The placement view derived from an instance: pools, demands, capacity scopes, latency matrices with their fallbacks, and the XOR scenarios with their precedence DAG |
| `PlacementAdapter` | `PlacementModel` in the shape the evaluator consumes. Empty when the instance carries no placement blocks, which is why engines need no branch for that case |
| `BindingEvaluator` | Aggregation along the composition, per-feature normalized losses, constraint magnitudes, and the canonical objective |
| `PlacementEvaluator` | End-to-end latency: critical-path scheduling over the scenario DAGs |

## Targets Java 8

random-search and many-heuristic run on a JDK 8 runtime, so the bytecode must
be 8: no records, no `var`, no switch expressions. evolutionary-heuristics runs
on 21 and consumes it without friction.

## Feasibility tolerance

`BindingEvaluator.EPS` is 1e-6, the same as the gateway's reference evaluator
and the MiniZinc model. A tighter tolerance here would let an engine call a
binding feasible that the gateway then reports as infeasible: a disagreement
about the answer, not about rounding.

## Tests

`mvn test`, or `cd engines && mvn test` to build it in order with the engines
that depend on it. The test instances live in `TestInstances` and are published
as a test-jar, so the engines test their searches against the same problems -
which is what makes their results comparable.
