# Evolutionary Heuristics Engine

This engine solves OpenBinding service-binding problems with evolutionary
algorithms: Java 21 and jMetal, over the instance model and evaluator shared
with every other JVM engine in [`binding-core`](../binding-core). What is its
own is the search - NSGA-II/III, its operators, and its options.

It used to carry a private copy of the evaluator and the instance models, each
with a note promising it was kept in sync with the core by hand;
`DESIGN_RATIONALE.md` Decision 1 ("implement an independent engine") records
the reasoning from that period and is superseded on that point.

The reasoning behind the remaining architectural and algorithmic choices is in
[`DESIGN_RATIONALE.md`](DESIGN_RATIONALE.md).

## Scope

The initial implementation supports:

- Structured compositions: `TASK`, `SEQ`, `AND`, `XOR`, `LOOP`, and `ELEMENT`.
- Mono-, multi-, and many-objective problems.
- Global and local attribute bounds.
- Same-provider and different-provider dependency constraints (plus
  `SAME_POOL`/`DIFFERENT_POOL` on the BIM′ path).
- Hard and soft constraints.
- Reproducible runs through an explicit random seed.

The HTTP contract is:

- `GET /health`
- `POST /solve` with `{ "instance": <general OpenBinding instance>, "options": {...}, "options": {...}? }`

## Placement support and anytime behavior

When the instance carries `resource_model` or `latency_model`, the evaluator additionally
computes the end-to-end latency over precomputed XOR-scenario precedence DAGs, resource-capacity
and transition-latency violations (`PlacementEvaluator`), mirroring the gateway reference
evaluator.

For **MONO** objectives:

- Deb's feasibility rules are folded into the scalar objective (any feasible solution beats any
  infeasible one; infeasible solutions rank by hard violation) — necessary because jMetal's
  dominance comparator ignores `constraints()`.
- The engine tracks the **best individual ever evaluated** and returns it (anytime behavior — it
  survives generational replacement and budget interruptions); when nothing feasible was found the
  least-violating individual is returned instead.
- A wall-clock budget can be set with `options.time_budget_ms`; `options.max_evaluations` then acts
  as a minimum-evaluation floor that is always honoured. A best-so-far trace
  `[{eval_index, elapsed_ms, best_objective, feasible, hard_violation}]` is reported in provenance
  metadata for offline convergence and cutoff studies.
- Each solution's `objective_value` is the engine's **internal search objective**
  (`objectives()[0]`: weighted mean of normalized losses, plus Deb's offset when infeasible);
  the legacy quality score moved to `metadata.quality_score`. The gateway replaces the objective
  with the canonical reference value and keeps the engine's number as `engine_objective_value`
  for the per-run integrity audit.

## Representation

A binding is represented as a bounded integer vector. There is one gene per
abstract task and one allele per candidate service:

```text
[candidate_index_for_task_1, ..., candidate_index_for_task_n]
```

This representation guarantees that every generated individual is a complete
binding and that every gene refers to an existing candidate. Task order is
derived deterministically from the composition tree.

## Global quality evaluation

Each individual is decoded into a task-to-candidate binding. QoS is then
aggregated recursively over the composition tree, using the functions declared
in `aggregation_policies`:

- `SEQ` and `AND`: sum, product, minimum, maximum, or mean.
- `XOR`: probability-weighted aggregation when using sum/weighted-sum.
- `LOOP`: scale-by-iterations for additive attributes and exponentiation for
  multiplicative attributes.

Raw candidate values are never mutated during normalization. Aggregated values,
normalized values, and objective losses remain separate.

For optimization, every target is converted to a minimization loss:

```text
MINIMIZE: (Q - Qmin) / (Qmax - Qmin)
MAXIMIZE: 1 - (Q - Qmin) / (Qmax - Qmin)
```

Values are clipped to `[0, 1]`. Bounds come from an explicit min-max
normalization policy when present, otherwise from the feature `valid_range`.

The public `objective_value` remains a weighted quality score where larger is
better. The minimization vector used by jMetal is returned in solution metadata
for diagnosis and experimentation.

## Objective strategy

- `MONO`: an elitist evolutionary run with one weighted loss objective.
- `MULTI`: NSGA-II, with one loss per target.
- `MANY`: NSGA-III, with one loss per target and reference-point niching.

Weights affect the mono-objective loss and the public summary score. They do
not collapse multi- or many-objective search into a weighted sum.

## Constraint handling

Hard constraints use feasibility-first comparison through jMetal constraints:

1. A feasible solution is preferred to an infeasible solution.
2. Between infeasible solutions, the lower normalized violation is preferred.
3. Objective comparison applies between feasible solutions.

Attribute-bound violations are divided by the feature range. Dependency
violations are divided by the number of involved tasks. This prevents units
such as milliseconds and probabilities from dominating each other.

Soft constraints are handled as follows:

- `MONO`: `soft_penalty * normalized_soft_violation` is added to the loss.
- `MULTI` and `MANY`: normalized soft violation is appended as an additional
  minimization objective.

All violations are still reported in the returned solution.

## Library decision

jMetal 7.4 is used because the engine needs established implementations of
NSGA-II and NSGA-III, bounded integer solutions, constraint-aware comparison,
and a path toward standard quality indicators and experiment tooling.

Jenetics remains a reasonable alternative for a smaller general-purpose GA,
but jMetal better matches the research-oriented multi/many-objective scope.

## Initial configuration

Supported options:

```json
{
  "algorithm": "AUTO",
  "population_size": 100,
  "max_evaluations": 10000,
  "crossover_probability": 0.9,
  "mutation_probability": null,
  "distribution_index": 20.0,
  "archive_size": 100,
  "soft_penalty": 10.0,
  "seed": 1,
  "reference_divisions": 12
}
```

When mutation probability is omitted, it is set to `1 / number_of_tasks`.
`AUTO` selects NSGA-II for `MONO`/`MULTI` and NSGA-III for `MANY`.

## Planned refinements

The first implementation establishes the full evaluation and optimization
pipeline. The following refinements should be evaluated experimentally before
being enabled by default:

- Feasibility-aware population seeding.
- Repair operators for local bounds and provider dependencies.
- A discrete uniform crossover instead of integer SBX.
- Adaptive penalties and epsilon constraint handling.
- Parallel evaluation for large populations.
- Hypervolume, IGD+, epsilon, and optimality-gap reports.
- Memoization of repeated chromosomes.
- Termination by wall-clock budget and stagnation.

## Experimental protocol

Compare against MiniZinc, random search, and the existing many-objective
heuristic using:

- Feasibility rate.
- Optimality gap for instances with an exact solution.
- Hypervolume, IGD+, and epsilon for Pareto fronts.
- Evaluations, runtime, and memory.
- At least 20 independent seeds.
- Scaling by tasks, candidates, objectives, and constraints.

The primary budget should be number of evaluations, because it is more
comparable across machines than generations or elapsed time.
