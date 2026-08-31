# BIM v1 placement dialect

Placement is the optional `qos-binding-placement/v1` Dialect compatible with
the `qos-binding/v1` Profile. It contributes a complete
`qos-binding-placement/v1` `Placement` resource type to the Profile-declared
`application` role; neither that role nor any four-role layout is hard-coded in
the BIM container. The Dialect pins its schema and adapter and emits both
`placement=placement` and `irExtensions=qos-binding-placement/v1` as IR
features. A package may contain multiple Placement resources, and every
internal endpoint is an explicit `{resource,id}` reference.

Placement is recognized natively by the sole executable QoS Profile, so its
lowered representation occupies the closed `BindingProblem.spec.placement`
field. The `irExtensions` value is the mandatory Engine capability marker for
that installed Dialect; it does not imply a second copy under
`BindingProblem.spec.extensions`.

## Resources and assignment

`pools` declares named capacity dimensions and optional properties.
`defaults` provides demand dimensions inherited by assignments. A `group`
assigns either one capability type or an explicit non-empty candidate set to a
pool; it cannot use both selectors. An item in `demands` assigns one explicit
candidate to one pool and overrides the assignment produced by a group. A
candidate cannot receive two group assignments. Every referenced candidate and
pool must exist, demand dimensions must exist on the pool, and each individual
demand must be finite, non-negative, and no greater than the corresponding
pool capacity. When Placement is present, every eligible candidate must resolve
to exactly one assignment across all Placement resources.

`capacityRules` names the dimensions to account and chooses their basis.
`invocation` multiplies demand by the deterministic workflow invocation count,
including routing probabilities and exact/expected repeat multipliers.
`selectedCandidate` charges once for each distinct candidate selected anywhere
in the binding. Every constrained dimension must be declared by every pool.
Capacity violations are always hard. The rule is explicit so the evaluator
never infers sharing from repeated task-to-candidate bindings.

## Network, events, and latency

`networkMode` is either `directed` (the default) or `symmetric`. In directed
mode, each `network` entry means only `from -> to`. In symmetric mode, the
compiler materializes the opposite direction with the same latency; explicitly
declaring both directions with different values is an error. Co-location has a
compact zero default, but BIM adds no shortest-path fallback. Whenever
transitions or `globalLatency` are present, the resulting directed graph must
contain every direction between pools represented by the normalized candidate
assignments in that Placement resource.

An event is a fixed external endpoint, not a task and not a binding decision.
It declares its source pool and may override the directed latency to individual
destination pools; a missing event-specific entry uses the explicit directed
network entry from the event's source pool. Every destination pool that may be
reached from the event must therefore have an event override or a corresponding
network link.

Transition endpoints reference either an Application service task or an event
in the same Placement resource; local tasks cannot be endpoints. A transition
declares a maximum, an Application metric, and `hard` or `soft` enforcement
(`hard` is the materialized default). A task-to-task transition reads the
direct pool link. An event-to-task transition uses its event override when
present, otherwise the event source's directed pool link. A soft transition
also declares a finite non-negative penalty, which must be referenced from
`Optimization` by the exact `{resource,id}` transition reference like any other
soft constraint.

`globalLatency` references and replaces exactly one Application metric. Its
`includeExecution` flag controls whether each selected candidate's value for
that metric is added to transfer time. The calculation runs over the compiled
structured SESE workflow (including BPMN only after successful lowering to the
same subset). Declared events form the external starting frontier; each service
task starts after its incoming frontier can reach the task's assigned pool.
`exclusive: routing` computes the probability-weighted latency of every routed
variant; `exclusive: condition` evaluates the binding context and requires
exactly one selected branch. `parallel: max` uses the branch makespan and
`parallel: sum` serializes branch durations at the join. Exact repeats are
evaluated exactly; an `expectedCount` scales one deterministic iteration.
Missing topology, routing, conditions, or metric values are diagnostics, never
approximations. Two Placement resources cannot derive the same metric.

No Placement problem is dispatched to a mode whose Engine manifest rejects
either the `placement` feature or the `qos-binding-placement/v1` value in the
generic `irExtensions` dimension. The bundled random-search, many-heuristic,
evolutionary, and MiniZinc modes declare `placement: all` and explicitly select
only `qos-binding-placement/v1` in the open `irExtensions` dimension.
Compatibility is checked before a job is queued. A mode claiming support must
evaluate every lowered construction and return a decision that passes
authoritative gateway reevaluation. MiniZinc translates that same canonical
Placement payload into exact pool, demand, capacity, topology, transition,
event, and global-latency constraints; this is support in this repository's
adapter, not an intrinsic property of the MiniZinc language.

Placement remains deterministic in BIM v1. Scheduling, stochastic demand,
uncertain latency, simulation, BPSim, and runtime relocation are not lowered
by `qos-binding/v1`.
