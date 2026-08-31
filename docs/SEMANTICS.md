# BIM v1 deterministic binding semantics

This document states the mathematical model of the installed
`qos-binding/v1` Profile and its bundled Dialects after lowering to `bim/v1`
`BindingProblem`. These equations are not universal rules of the BIM
container: another Profile may define different roles, terms, output IR, and
decision semantics. The Profile/Dialect schemas define the source syntax; the
pinned adapters and canonical evaluator implement this model.

## Eligibility and decisions

Let `T` be the service tasks and `C` the candidate references. For each task
`t`, the compiler constructs an eligibility set `E(t) ⊆ C` by exact
capability-type matching followed by its optional typed predicate. A binding
decision is a total function `b : T → C` with `b(t) ∈ E(t)`. Local tasks occur
in the workflow but are not in the domain of `b`.

Every metric definition `m` assigns a finite scalar `q(c,m)` to every eligible
candidate whose value is required by policy. Missing values are compilation
errors. Invocation-scoped values are evaluated at each task occurrence;
selected-candidate values are charged once for each distinct candidate in the
range of `b`.

## Workflow aggregation

The workflow is a structured tree. For a fixed binding and metric, service-task
leaves produce the selected candidate's value. Local-task and empty leaves
produce that metric's `neutral` value from the canonical IR. They do not derive
a fresh identity from the surrounding block operator. The compiler may infer a
neutral only when the source metric's domain and sequence operator make it
unambiguous; otherwise the author must state it. In every case the compiler
materializes the value before an engine receives the problem.

Each metric separately declares operators for sequence, parallel, exclusive,
repeat, and selected-candidate aggregation. Therefore the same local activity
can contribute, for example, `0` to an additive latency metric and `1` to a
multiplicative reliability metric without carrying QoS values of its own.

Built-ins are sum, product, minimum, maximum, routing-weighted sum/product,
scale, power, and identity. For exclusive branch values `x_i` and a complete
routing vector `p_i`, weighted sum is `Σ p_i x_i` and weighted product is
`Π x_i^p_i`. A zero-weight product factor contributes `1` without evaluating
an otherwise undefined power. A weighted operator is invalid without one
explicit weight per branch. An exact repeat count `n` applies scale `n x` or
power `x^n`; `expectedCount` uses the same formulas with an explicit decimal
multiplier. These are deterministic expected-flow calculations, not QoS
distributions.

Custom aggregation is a pure, typed CEL/AST expression over `values`,
`weights`, and `count`. It has no I/O or external state.

## Placement semantics

When the placement dialect is selected, every eligible candidate has exactly
one pool assignment. Let `P(c)` be that pool, `d(c,r)` its demand for resource
dimension `r`, and `I_b(t)` the deterministic invocation count of service task
`t` under the workflow. Sequence and parallel preserve the incoming count, a
routed XOR multiplies by its branch probability, a condition XOR selects one
branch, and repeat multiplies by `count` or `expectedCount`.

For an invocation-scoped capacity rule, pool usage is
`Σ_t I_b(t) d(b(t),r)` over tasks bound to that pool. For a
selected-candidate rule, usage is `Σ_c d(c,r)` over the distinct selected
candidates in that pool. Usage above declared capacity is a hard violation.

Network latency is directed. With `networkMode: directed` (the default),
co-location defaults to zero and every other required direction must be
declared, with no reverse or shortest-path inference. With
`networkMode: symmetric`, lowering materializes an equal reverse link and
rejects conflicting opposite values. The resulting directed graph must be
complete over pools represented by normalized candidate assignments whenever
transitions or global latency need it. An event is fixed to its declared source
pool; an event-specific latency overrides that source-to-destination link.
Transition bounds compare the resulting direct transfer latency with their
maximum and produce a hard violation or the declared soft penalty. Local tasks
are not placement transition endpoints.

A `globalLatency` policy derives its referenced metric from the structured
SESE workflow. Declared events are its external starting frontier. It
optionally includes candidate execution values, computes routing XORs as the
weighted expected latency or selects exactly one condition XOR, joins parallel
branches by `max` or `sum`, evaluates exact repeats, and scales one iteration
for `expectedCount`. The derived value replaces the ordinary workflow aggregate
for that metric before constraints and objectives run. A metric can have only
one placement derivation.

## Constraints and penalties

Hard constraints are typed Boolean assertions and must all evaluate to true.
`when` is evaluated first and short-circuits an inactive assertion. A soft
constraint evaluates to zero when satisfied and otherwise to its declared
fixed or non-negative numeric penalty. Every soft penalty must be referenced
by the Optimization resource; there is no implicit global penalty and no
hidden comparison epsilon.

## Objective losses

For explicit bounds `a < z`, affine normalization is `n(x)=(x-a)/(z-a)`.
When `clamp:true`, `n` is then saturated to `[0,1]`; otherwise out-of-range
values remain out of range. A normalized minimizing term has loss `n`, while a
normalized maximizing term has loss `1-n`. Without normalization the losses
are respectively `x` and `-x`.

Weighted optimization accepts positive relative weights and the compiler
normalizes them to sum to one. Its loss is the weighted sum of term losses and
the explicitly weighted soft penalties. Terms with different units require
normalization. Lexicographic optimization compares its ordered loss vector.
Pareto optimization uses ordinary non-strict dominance with at least one
strictly better component. `satisfy` requires hard feasibility and, when soft
penalties are declared, ranks by their explicit penalty objective.

The gateway reevaluates every engine decision with this model. `OPTIMAL`,
`FEASIBLE`, `INFEASIBLE`, and `UNKNOWN` describe the evidence obtained by that
run; an algorithm family alone never determines termination.
