# Level 4 — canonical IR and execution

This level is the boundary between source-language extensibility and decision
search. Engines receive only the Profile-declared output IR. They do not parse
packages, fetch schemas, select Dialects, or assign meaning to source
extensions.

## BindingProblem IR

Status: **normative-derived**.

![UML metamodel of the canonical BindingProblem IR and its provenance records](generated/04-binding-problem-ir.svg)

PlantUML source:
[`04-binding-problem-ir.puml`](plantuml/04-binding-problem-ir.puml). Primary
source:
[`binding-problem.schema.json`](../../schemas/bim/v1/binding-problem.schema.json).

The `qos-binding/v1` Profile emits one closed `bim/v1` `BindingProblem`. It
pins the Profile and selected Dialect adapters, retains Instance and resource
identity, materializes defaults and eligibility, and contains the canonical
application, routing, policy, Placement, optimization, extension output, and
source map. Output identity and schema are declared by the Profile and checked
after lowering.

```mermaid
flowchart LR
  accTitle: Source package to canonical BindingProblem
  accDescr: The core resolves an Instance and installed contracts, Dialect and Profile adapters lower validated source, and the declared output schema admits one closed BindingProblem.
  ZIP[Directory or deterministic .bim.zip] --> CORE[Core package validation]
  CORE --> INDEX[Resolve Instance roles and resources]
  P[Installed Profile contract] --> INDEX
  D[Installed Dialect contracts] --> INDEX
  INDEX --> SCHEMA[Validate exact source schemas]
  SCHEMA --> LOWER[Deterministic Dialect and Profile lowering]
  LOWER --> OUT[Validate declared output identity and schema]
  OUT --> IR[Canonical BindingProblem]
```

## Engine and Registration contracts

Status: **normative-derived**.

![UML metamodel of Engines, modes, capability selectors, limits, guarantees, and deployment registrations](generated/04-engine-metamodel.svg)

PlantUML source:
[`04-engine-metamodel.puml`](plantuml/04-engine-metamodel.puml). Primary
sources: [`engine.schema.json`](../../schemas/bim/v1/engine.schema.json),
[`engine-registration.schema.json`](../../schemas/bim/v1/engine-registration.schema.json),
and compatibility logic in
[`routes/v1.py`](../../openbinding-gateway/src/openbinding_gateway/routes/v1.py).

An Engine is an immutable public declaration with one or more modes. Each mode
targets an exact Profile and IR identity, selects supported values for every
Profile capability dimension, validates closed options, declares Profile-known
limits, and states only guarantees the concrete algorithm can establish.
Deployment is separate: EngineRegistration pins an Engine revision, protocol
and OpenAPI digests, same-origin paths, endpoint, and authentication scheme.
Credentials are stored separately and never serialized in a manifest.

## Compatibility

```mermaid
flowchart TD
  accTitle: Engine mode compatibility decision
  accDescr: Actual IR features and sizes are compared with every Profile-defined capability selector and declared limit before a job may be dispatched.
  IR[Canonical BindingProblem] --> ID{Profile and IR identity match?}
  ID -->|no| REJECT[Incompatible mode]
  ID -->|yes| FEATURES[Extract reachable IR features]
  FEATURES --> EACH{For every Profile dimension}
  EACH --> NONE[none accepts only an empty actual set]
  EACH --> ALL[all accepts known values only in a closed dimension]
  EACH --> ONLY[only requires actual values to be a subset]
  NONE --> LIMITS{All declared limits hold?}
  ALL --> LIMITS
  ONLY --> LIMITS
  LIMITS -->|no| REJECT
  LIMITS -->|yes| ACCEPT[Compatible mode]
```

The open `irExtensions` dimension can never use `all`; a mode must select
`none` or explicitly name every extension namespace it evaluates. Placement
therefore requires both the closed `placement=placement` feature and
`irExtensions=qos-binding-placement/v1`.

## Job, solve, and authoritative evaluation

```mermaid
sequenceDiagram
  accTitle: BIM job execution and authoritative reevaluation
  accDescr: A client submits a complete package or immutable snapshot, the gateway compiles and selects a compatible mode, the Engine searches the canonical IR, and the gateway reevaluates every returned decision before persisting the result.
  participant Client
  participant Gateway
  participant Compiler
  participant Engine
  participant Evaluator
  Client->>Gateway: POST package or snapshot job
  Gateway->>Compiler: resolve and compile
  Compiler-->>Gateway: BindingProblem + provenance
  Gateway->>Gateway: select compatible Engine mode and options
  Gateway->>Engine: bim-engine/v1 BindingProblem
  Engine-->>Gateway: termination + candidate solutions
  loop every returned decision
    Gateway->>Evaluator: canonical evaluate(binding)
    Evaluator-->>Gateway: metrics, violations, penalties, objective
  end
  Gateway->>Gateway: discard invalid or incomplete decisions
  Gateway-->>Client: OPTIMAL | FEASIBLE | INFEASIBLE | UNKNOWN
```

An algorithm family never implies a termination status. The result reports the
evidence produced by that run, and all retained decisions must agree with the
gateway evaluator.

## Digests and provenance

```mermaid
flowchart TB
  accTitle: BIM semantic identity and job provenance
  accDescr: Canonical semantic content determines the reusable IR digest, while source files, representation, adapters, compiler, Engine, Registration, options, and limits remain separately pinned in job provenance.
  FILES[Canonical file bytes] --> FD[file digests]
  RES[Logical local and registered resources] --> RD[resource digests]
  FD --> INSTANCE[Instance identity]
  RD --> INSTANCE
  SEM[Profile + canonical executable semantics] --> IRD[semantic IR digest]
  EXCLUDED[Source representation, source map, Instance provenance, Dialect descriptors] -. excluded from .-> IRD
  FD --> JOB[Job provenance]
  RD --> JOB
  INSTANCE --> JOB
  IRD --> JOB
  CONTRACTS[Profile, Dialects, adapters, compiler, evaluator] --> JOB
  EXEC[Engine, Registration, algorithm, options, limits] --> JOB
```

Representation independence allows equivalent BPMN and native JSON to share a
semantic problem identity without discarding their different source locations
or installed-Dialect evidence. See [ENGINE_INTEGRATION](../ENGINE_INTEGRATION.md)
for the wire contract and lifecycle details.
