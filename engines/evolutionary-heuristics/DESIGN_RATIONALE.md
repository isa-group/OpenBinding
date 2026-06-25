# Evolutionary Heuristics Engine: Design Rationale

## Purpose

This document records the main architectural and algorithmic decisions made
while implementing the evolutionary heuristic solvers for OpenBinding. It
complements the operational description in `README.md` by explaining why the
current design was selected, which alternatives were considered, and which
trade-offs remain open for experimental validation.

## Decision 1: Implement an independent engine

### Decision

The evolutionary solvers are implemented as a separate service under
`engines/evolutionary-heuristics`.

### Rationale

The existing Java heuristic engines target Java 7/8 and contain a legacy domain
model tightly coupled to their solver implementations. Current jMetal versions
require a modern Java runtime and provide APIs that do not fit cleanly into that
codebase without a broad migration.

Keeping the engine independent provides:

- Java 21 without changing the runtime of existing engines.
- An explicit integration boundary through the OpenBinding HTTP contract.
- Independent dependency, deployment, and performance tuning.
- A controlled place for experimental algorithms and quality indicators.
- Lower regression risk for the existing random and many-objective engines.

### Alternatives considered

- **Extend `many-heuristic`:** rejected because it would combine legacy model
  migration with the new optimization work.
- **Implement the engine in Python:** viable, especially with pymoo or
  jMetalPy, but inconsistent with the existing heuristic engine ecosystem and
  less direct for sharing JVM-based experimental infrastructure.
- **Replace the existing heuristic engines:** rejected because the new engine
  is initially experimental and should be evaluated before replacing established
  behavior.

### Consequence

Some mapping and evaluation concepts are duplicated across services. The
gateway remains responsible for canonical output normalization, while the
engine must preserve equivalent aggregation semantics during optimization.

## Decision 2: Use Java 21 and jMetal 7.4

### Decision

The engine targets Java 21 and uses jMetal 7.4 for evolutionary algorithms.

### Rationale

jMetal is focused on single-, multi-, and many-objective metaheuristics and
provides:

- NSGA-II and NSGA-III implementations.
- Bounded integer solutions and evolutionary operators.
- Constraint-aware solution comparison.
- Standard experiment and quality-indicator infrastructure.
- A direct path to MOEA/D, RVEA, and other algorithms for future comparison.

Java 21 is the runtime adopted by jMetal 7.4 and also allows lightweight HTTP
request handling with virtual threads.

### Alternatives considered

- **Jenetics:** has a clean API and strong general genetic algorithm support,
  but jMetal better matches the research requirement for Pareto-based and
  many-objective algorithms.
- **Custom genetic algorithm:** rejected because selection, ranking, diversity,
  and reference-point behavior are established algorithmic components that
  should not be reimplemented without a specific research reason.
- **Older jMetal release:** rejected to avoid starting on an obsolete Java/API
  baseline and to retain current constraint-handling improvements.

### Consequence

The engine image is larger than the legacy engines and requires Java 21. This
is accepted because engines are independently containerized.

## Decision 3: Accept the general OpenBinding instance

### Decision

The gateway sends:

```json
{
  "instance": "<general OpenBinding instance>",
  "options": {}
}
```

The engine does not use the legacy random-search DTO.

### Rationale

The general model contains the information required to implement the intended
semantics without lossy translation:

- Objective type and targets.
- Hard versus soft constraints.
- Feature ranges and directions.
- Structured aggregation policies.
- Candidate/provider information.

Using the general model also keeps the engine independent from implementation
details of the existing Java engines.

### Consequence

The gateway plugin is deliberately thin. General schema validation and common
semantic validation occur before routing, while the engine performs defensive
checks required for standalone execution.

## Decision 4: Represent bindings as bounded integer vectors

### Decision

An individual has one integer variable per abstract task. The variable value is
the index of the selected candidate for that task.

### Rationale

This representation matches the structure of the binding problem:

```text
gene i = candidate selected for abstract task i
```

It guarantees by construction that:

- Every individual assigns one candidate to every task.
- Every allele references a candidate in the corresponding task domain.
- Crossover and mutation cannot create an unknown service identifier.
- Decoding is linear in the number of tasks.

Task order is collected deterministically from the composition tree using
insertion order. Repeated references to the same abstract task share one gene.

### Alternatives considered

- **Binary encoding:** rejected because candidate domains have different sizes
  and binary operators would generate invalid encodings.
- **Permutation encoding:** rejected because service binding is an assignment
  problem, not an ordering problem.
- **Provider-first hierarchical encoding:** potentially useful for dependency
  constraints, but more complex and not universally beneficial.

### Consequence

The current implementation uses jMetal integer variation operators. A custom
categorical uniform crossover and random-reset mutation may be a better
domain-specific choice and remains an explicit experimental refinement.

## Decision 5: Evaluate global QoS over the composition tree

### Decision

Fitness evaluation decodes the binding and recursively evaluates each target
feature over `TASK`, `SEQ`, `AND`, `XOR`, `LOOP`, and `ELEMENT` nodes.

### Rationale

Binding quality is not the sum of independent local rankings. It depends on the
workflow structure and feature-specific aggregation rules. For example:

- Sequential latency is usually additive.
- Parallel latency is usually the maximum branch latency.
- Reliability and availability are commonly multiplicative.
- XOR branches require probability-weighted aggregation.
- Loop contributions depend on the expected iteration count.

The evolutionary algorithm must therefore optimize the global composed quality,
not a proxy based only on candidate-level scores.

### Consequence

Evaluation is the main computational cost. Future performance work should
prioritize chromosome memoization, incremental evaluation, and parallel
population evaluation before changing algorithmic operators.

## Decision 6: Keep raw, aggregated, normalized, and optimization values separate

### Decision

Candidate feature values are never modified. Evaluation maintains separate
representations for:

1. Raw candidate values.
2. Globally aggregated values.
3. Normalized quality/loss values.
4. The objective vector consumed by jMetal.

### Rationale

Mutating candidate values during scaling makes repeated evaluation difficult to
reason about and can scale constraints inconsistently. Separation provides:

- Stable input data.
- Traceable output values.
- Consistent constraint evaluation in the original units.
- Independent adjustment of normalization policies.

### Consequence

The public response reports original-unit aggregated features, while solution
metadata reports the internal minimization vector.

## Decision 7: Normalize after global aggregation

### Decision

Optimization losses are computed from the globally aggregated value using an
explicit normalization policy when available, otherwise the feature
`valid_range`.

For minimization:

```text
loss = clamp((Q - Qmin) / (Qmax - Qmin))
```

For maximization:

```text
loss = 1 - clamp((Q - Qmin) / (Qmax - Qmin))
```

### Rationale

Objectives expressed in different units cannot be compared or combined
directly. Normalizing the final aggregate preserves workflow semantics and
prevents candidate-level normalization from changing non-linear aggregation
behavior.

### Percentage product handling

Ratio features whose valid maximum is greater than one, such as availability in
`[0, 100]`, are converted to `[0, 1]` before multiplicative composition and
converted back afterwards. This avoids multiplying percentages as if `99`
represented a probability of ninety-nine.

### Consequence

Clipping stabilizes optimization but makes all values outside the configured
range equally bad once they cross a bound. Better dynamic or instance-derived
normalization may be evaluated later.

## Decision 8: Convert every optimization objective to minimization

### Decision

The internal jMetal objective vector always represents losses to minimize.

### Rationale

A uniform orientation simplifies dominance and algorithm configuration.
Feature direction remains part of the mapping from global QoS to normalized
loss.

The API-level `objective_value` is kept as a weighted quality score where larger
is better, preserving an intuitive external summary while exposing the internal
vector in metadata.

### Consequence

The summary score must not be used to reconstruct Pareto dominance for
`MULTI`/`MANY`; consumers should use the objective vector or aggregated
features.

## Decision 9: Use NSGA-II for MONO/MULTI and NSGA-III for MANY

### Decision

`AUTO` resolves algorithms as follows:

- `MONO`: NSGA-II with one weighted objective.
- `MULTI`: NSGA-II with one objective per target.
- `MANY`: NSGA-III with one objective per target.

### Rationale

NSGA-II is a well-established baseline for two and three objectives. NSGA-III
uses reference points to preserve diversity when Pareto dominance loses
selection pressure with many objectives.

Using NSGA-II for the first mono-objective implementation reduces the number of
algorithm integration paths. A dedicated generational GA can be introduced
later if experiments show a material benefit.

### Consequence

The mono-objective path currently carries some multi-objective infrastructure
overhead. This is acceptable for the initial implementation and should be
measured before specialization.

## Decision 10: Do not collapse MULTI/MANY into a weighted sum

### Decision

Weights are used for mono-objective optimization and for the public summary
score. Multi- and many-objective optimization retain one independent objective
per target.

### Rationale

A weighted sum can miss non-convex regions of the Pareto front and returns only
one preference-specific compromise. OpenBinding's `MULTI` and `MANY` models
require a set of trade-off solutions.

### Consequence

The engine returns an archive/front rather than one binding for `MULTI` and
`MANY`. `archive_size` bounds response size.

## Decision 11: Apply feasibility-first handling to hard constraints

### Decision

All normalized hard violations are summed and exposed as a jMetal constraint
value. Feasible solutions are preferred over infeasible solutions.

### Rationale

Hard constraints define admissibility and should not be traded against QoS
through an arbitrary penalty coefficient. Feasibility-first comparison avoids
a situation where a sufficiently good quality score compensates for an invalid
binding.

Violations are normalized:

- Attribute bounds by the corresponding feature range.
- Provider dependencies by the number of involved tasks.

This prevents constraints with large physical units from dominating the total
violation.

### Consequence

If no feasible solution is found, the engine returns the least-violating
solutions instead of failing silently. Their `feasible` metadata and violation
details make this explicit.

## Decision 12: Treat soft constraints differently by objective mode

### Decision

- `MONO`: add `soft_penalty * normalized_soft_violation` to the weighted loss.
- `MULTI`/`MANY`: append total soft violation as an additional objective.

### Rationale

Mono-objective optimization requires a scalar ordering, so an explicit penalty
is practical and configurable. In Pareto optimization, adding soft violation as
an objective preserves the trade-off between QoS and preference satisfaction
without hiding it behind one coefficient.

### Alternatives considered

- **Lexicographic comparison:** predictable but prevents any QoS/soft-constraint
  trade-off.
- **One objective per soft constraint:** maximally expressive but can increase
  dimensionality dramatically.
- **Treat soft constraints as hard:** violates their intended semantics.

### Consequence

The current multi/many strategy aggregates all soft violations. Per-constraint
objectives may be useful for small numbers of semantically distinct preferences
and should be studied separately.

## Decision 13: Start without repair operators

### Decision

The initial engine relies on evolutionary selection and constraint comparison.
It does not automatically repair provider dependencies or attribute bounds.

### Rationale

Repair changes the search distribution and can introduce hidden preferences.
For example, repairing a same-provider constraint requires deciding which
provider to preserve, potentially biasing cost or reliability. The correctness
and benefit of each repair strategy should be measured rather than assumed.

### Consequence

Highly constrained instances may spend many evaluations in infeasible regions.
Feasibility-aware initialization and explicit repair operators are high-priority
future experiments.

## Decision 14: Make evaluation budgets and seeds explicit

### Decision

The primary termination option is `max_evaluations`, and every run accepts a
`seed`.

### Rationale

Evaluation count is more comparable across machines than elapsed time or
generation count. Explicit seeds make failures reproducible and enable
statistically meaningful repeated experiments.

### Consequence

Wall-clock and stagnation termination are not yet implemented. They should be
added as secondary limits without replacing evaluation budgets in experiments.

## Decision 15: Return diagnostic optimization metadata

### Decision

Each solution includes:

- The internal objective vector.
- Hard and soft violation totals.
- A feasibility flag.

Provenance includes algorithm, seed, population size, evaluation budget, and
the number of returned solutions.

### Rationale

Evolutionary results are stochastic and cannot be assessed from the binding
alone. Diagnostic metadata is required to reproduce runs, compare algorithms,
and detect infeasible fallback results.

### Consequence

The response is slightly larger, especially for Pareto fronts, but remains
bounded by `archive_size`.

## Decision 16: Keep the gateway plugin thin

### Decision

The gateway plugin declares capabilities, validates engine-specific essentials,
filters options, and passes the general instance through unchanged.

### Rationale

Duplicating a large transformation layer would make it harder to maintain
semantic equivalence and would hide information needed by future evolutionary
strategies.

### Consequence

The engine must remain compatible with the general schema. Schema evolution
should be handled through explicit versioning and compatibility tests.

## Decision 17: Containerize and register the engine independently

### Decision

The engine has its own multi-stage Docker image, health check, registry entry,
environment variable, and Compose service.

### Rationale

This follows OpenBinding's engine integration model and allows independent
deployment and scaling.

### Consequence

Gateway startup currently depends on the evolutionary engine health in the same
way as the existing engines. If optional engine availability becomes desirable,
the broader gateway dependency policy should be changed consistently for all
engines.

## Verification decisions

The initial tests focus on deterministic semantic behavior:

- Global aggregation and objective direction.
- Percentage ratio products.
- Hard/soft violation normalization.
- Provider dependency violations.
- NSGA-II and NSGA-III execution paths.
- Gateway option filtering and capability declaration.

This is intentional: incorrect QoS or constraint semantics can produce
plausible but invalid optimization results, making them higher risk than
operator-level stochastic variation.

## Known limitations

- Integer SBX and polynomial mutation are generic numeric operators rather than
  categorical binding-specific operators.
- There is no evaluation cache.
- There are no repair operators or feasibility-aware seeding.
- NSGA-III reference divisions are configured manually.
- The engine does not yet calculate hypervolume, IGD+, epsilon, or optimality
  gaps.
- The API currently exposes only one aggregate soft-violation objective.
- Dynamic changes to candidates or QoS during a run are not supported.
- The engine assumes all required candidate feature values have passed gateway
  validation.

## Experimental questions

The following decisions should be revisited using the experimentation suite:

1. Does categorical uniform crossover outperform integer SBX?
2. Which mutation rate scales best with tasks and candidate-domain size?
3. When do repair operators improve time-to-feasibility without reducing front
   diversity?
4. Is NSGA-III preferable to MOEA/D or RVEA for the OpenBinding many-objective
   instances?
5. Should soft constraints remain aggregated or become separate objectives?
6. Which normalization strategy is most stable when valid ranges are loose?
7. When does parallel evaluation offset coordination overhead?
8. How should reference divisions adapt to objective count and archive size?

Changes to defaults should be justified with repeated-seed evidence rather than
single-instance performance.
