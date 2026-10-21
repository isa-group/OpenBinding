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

## Asynchronous mode and cancellation (opt-in)

Three classes give every JVM engine the same optional job layer; none of them
changes an engine that does not enable it.

* `Cancellation` — cooperative stop. A search loop calls
  `Cancellation.checkpoint()` once per iteration (the evaluator also calls it once
  per evaluation). With no job bound to the thread, which is every synchronous
  request and every library caller, it does nothing.
* `EngineJobs` — in-memory jobs: random UUID ids, a bounded pool with bounded
  queue and retention, states `queued/running/cancelling/completed/failed/cancelled`,
  immutable final states, tenant ownership and a TTL for finished jobs. `cancelled`
  is only reported after the solver returned.
* `EngineHttp` — mounts the engine on a JDK `HttpServer`. Synchronous by default;
  with `ENGINE_JOB_MODE=async` the same POST answers `202` and `GET`/`DELETE
  /internal/v1/jobs/{id}` and `/openapi.json` appear. `ENGINE_AUTH_TOKENS`
  (`tenant=token,...`) adds bearer authentication and job ownership.

An engine implements `EngineHttp.Engine` (`prepare(payload)` validates the whole
request and returns the work, so an invalid request is a `422` before a job
exists) and calls `EngineHttp.install(...)` from its `Server`. The protocol, the
guarantees and the failure modes are in
[`docs/qa/ENGINE_CANCELLATION_JAVA.md`](../../docs/qa/ENGINE_CANCELLATION_JAVA.md).
`bim-engine/v1` has no `DELETE`: cancellation is an optional extension advertised
as `extensions.cancellation = {supported: true, idScope: "attempt"}`.

`TestProblems` (published in the test jar) also carries the real-HTTP test bench
the engines' `*CancelTest` classes share.
