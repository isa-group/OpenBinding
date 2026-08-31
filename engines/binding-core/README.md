# BIM v1 binding core

`binding-core` is the strict Java implementation of the deterministic
`qos-binding/v1` semantics. It accepts only a canonical `bim/v1`
`BindingProblem`, validates catalog-qualified references, evaluates workflows,
constraints, soft penalties and optimization strategies, and serializes the
common `bim-engine/v1` result.

Source `Instance` packages, authoring documents and dialect resources never
enter an engine. The gateway compiles them to the immutable IR first.

The core evaluates the complete lowered `qos-binding-placement/v1` contract:
candidate-to-pool assignments, invocation- and selected-candidate-scoped
capacity, directed networks and events, hard/soft transitions, and structured
global latency. Random-search, many-heuristic, and evolutionary modes therefore
declare placement selector `all` and select only
`qos-binding-placement/v1` in the open `irExtensions` dimension; the gateway
authoritatively reevaluates their decisions with the same semantics.

The module targets Java 8 bytecode because random-search and many-heuristic run
on Java 8. Run `mvn test` to execute the evaluator and transport conformance
tests.
