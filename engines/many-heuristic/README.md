# Many-Heuristic engine

Java service for **many-objective** problems: three or more objectives, where a
single best solution does not exist and the answer is a Pareto front.

## What is its own

Only `ManyBindingSearch`: sampling into a Pareto archive over the per-target
normalized losses the shared evaluator computes. Because those are losses,
lower is better on every objective and domination needs no direction handling.

Everything else - the instance model, the evaluator, the placement semantics -
comes from [`binding-core`](../binding-core).

## Feasibility and the empty front

Constraints follow the same feasibility-first rule as the other engines: only
feasible bindings enter the archive. When nothing feasible is found the best
infeasible one is returned instead, marked as such and naming what it breaks.
An empty front used to become a 422, which told the caller their request was
invalid about a problem that was merely hard.

## Request

`{"instance": ..., "options": {"iterations_count": 1000, "archive_size": 20}}`,
like every other JVM engine. Placement is derived from the instance, not
received.

Builds against a JDK 8 runtime.
