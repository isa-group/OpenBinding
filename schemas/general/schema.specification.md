# Compact QoS-Aware Service Composition

## What this schema represents

This schema describes a **QoS-aware service composition problem instance**. It models:

* A **workflow** of abstract **tasks** (what needs to be done)
* For each task, a set of **candidate services** (ways to do it)
* A set of **QoS features** (attributes like latency, cost, availability)
* A **composition structure** (a *structured tree* workflow)
* **Aggregation policies** that define how QoS propagates through the workflow
* Optional **constraints**
* An **objective** definition (types: `MONO`, `MULTI`, `MANY`) using `targets` + `weights`

The schema focuses on **compactness** and **tool-friendly parsing**. It is designed to be consumed by optimizers/solvers that compute an optimal (or near-optimal) candidate selection under QoS objectives and constraints.

---

# How to read this document

* “**MUST**” / “**SHOULD**” / “**MAY**” indicate recommended semantics.
* JSON Schema validates **structure**, **types**, and some **conditional rules**.
* Some important semantics (e.g., ID cross-references, XOR probability sums) **cannot be fully enforced** by vanilla JSON Schema and require a second validation layer. See **Validation & invariants**.

---

# Top-level document

## Required fields

The root object MUST contain:

* `metadata`
* `features`
* `providers`
* `tasks`
* `candidates`
* `composition`
* `aggregation_policies`
* `objective`

Optional fields:

* `constraints` (defaults to `[]` if absent in many implementations; schema allows it omitted)
* `resource_model` (placement extension, see section 10)
* `latency_model` (placement extension, see section 11)

The root has `additionalProperties: false`, so unknown top-level keys are rejected unless listed.

---

# 1) `metadata`

```json
"metadata": {
  "id": "string",
  "name": "string",
  "version": "string",
  "created_at": "2026-01-19T12:34:56Z",
  "description": "string (optional)",
  "...": "any additional metadata allowed"
}
```

### Semantics

* `id` SHOULD be a stable instance identifier.
* `version` SHOULD reflect the instance version (not the schema version).
* `created_at` MUST be ISO 8601 date-time.
* `metadata.additionalProperties: true` allows you to attach arbitrary provenance (dataset info, authorship, generator config, etc.).

---

# 2) `providers`

```json
"providers": [
  {
    "id": "aws-usw2",
    "name": "AWS",
    "description": "Cloud provider"
  }
]
```

### Semantics

Providers represent organizations/platforms hosting candidate services.

* `id` SHOULD be unique across providers.
* The current schema only allows: `id`, `name`, and optional `description`.

---

# 3) `tasks`

```json
"tasks": [
  { "id": "t_auth", "name": "Authenticate user" },
  { "id": "t_pay",  "name": "Process payment" }
]
```

### Semantics

Tasks are abstract steps in the workflow. A solver selects **one candidate per task**.

* `id` SHOULD be unique across tasks.
* `name` is a human-readable label.

---

# 4) `candidates`

```json
"candidates": [
  {
    "id": "svc_auth_1",
    "task_id": "t_auth",
    "provider_id": "aws-usw2",
    "name": "AuthService",
    "features": {
      "latency_ms": 120,
      "availability": 0.999
    },
    "description": "Concrete service option"
  }
]
```

### Semantics

A candidate is a concrete service option to implement a task.

* `task_id` MUST reference a task (not enforced by JSON Schema; enforce separately).
* `provider_id` MUST reference a provider (not enforced by JSON Schema).
* `features` is a map from **attribute IDs** to numeric values. Keys SHOULD correspond to `features[*].id` (not fully enforceable in JSON Schema). The `features` object MUST have at least one key-value pair.
* QoS keys are constrained to a conservative identifier pattern: `^[A-Za-z0-9_.-]+$` (same for several other maps).

### Guidance on missing QoS values

Schema does not specify whether every candidate must provide every feature. Common choices:

* **Strict**: every candidate MUST have values for all features → validate in a second layer
* **Partial**: missing features use `neutral` (from aggregation policy) or are imputed (document the rule outside the schema)

---

# 5) `features` (QoS feature model)

```json
"features": [
  {
    "id": "latency_ms",
    "name": "Latency",
    "direction": "MINIMIZE",
    "unit": "ms",
    "scale": "RATIO",
    "valid_range": { "min": 0, "max": 10000 }
  }
]
```

### Field meaning

* `id`: canonical identifier used in:

  * `candidates[*].features`
  * `aggregation_policies` keys / values
  * `objective.targets` / `objective.weights`
  * constraints referencing `attribute_id`
* `direction`:

  * `"MAXIMIZE"` for attributes like availability, throughput
  * `"MINIMIZE"` for attributes like latency, cost
* `scale`:

  * `RATIO`: meaningful zero and ratios (latency, cost)
  * `INTERVAL`: differences meaningful, zero arbitrary (temperature-like)
  * `ORDINAL`: ordering matters but spacing not meaningful (e.g., “bronze/silver/gold” encoded numerically)
* `valid_range`: acceptable raw bounds for candidate QoS values

---

# 6) `composition`

The workflow is expressed as a **structured tree**.

## Structured workflow tree (`type: "STRUCTURED"`)

```json
"composition": {
  "type": "STRUCTURED",
  "root": { ... node ... }
}
```

### Node types

Each node is one of:

* `TASK` leaf node: binds to a `task_id`
* `ELEMENT` leaf node: a generic leaf node without `task_id`
* `SEQ`: sequential composition of children
* `AND`: parallel AND-join composition
* `XOR`: probabilistic branch (each branch has probability `p`)
* `LOOP`: repeats a body with expected iterations or bounds

#### TASK node

```json
{ "id": "n1", "kind": "TASK", "task_id": "t_auth" }
```

#### SEQ / AND nodes

```json
{ "id": "n2", "kind": "SEQ", "children": [ ... at least 2 nodes ... ] }
{ "id": "n3", "kind": "AND", "children": [ ... at least 2 nodes ... ] }
```

#### XOR node

```json
{
  "id": "n4",
  "kind": "XOR",
  "branches": [
    { "p": 0.7, "child": { ... } },
    { "p": 0.3, "child": { ... } }
  ]
}
```

**Important semantic invariant (not enforced):**

* XOR branch probabilities SHOULD sum to **1.0** (within tolerance).

#### LOOP node

```json
{
  "id": "n5",
  "kind": "LOOP",
  "body": { ... },
  "expected_iterations": 3
}
```

or:

```json
{
  "id": "n5",
  "kind": "LOOP",
  "body": { ... },
  "bounds": { "min": 1, "max": 5 }
}
```

Schema rule (enforced):

* LOOP MUST contain at least one of:

  * `expected_iterations`
  * `bounds`

---

# 7) `aggregation_policies`

```json
"aggregation_policies": {
    "latency_ms": {
      "neutral": 0,
      "compose": {
        "seq":  { "fn": "SUM" },
        "and":  { "fn": "MAX" },
        "xor":  { "fn": "MEAN" },
        "loop": { "fn": "SCALED_SUM" }
      }
    }
  },
```

### What a policy means

For each QoS attribute:

* `compose` defines how to **aggregate child values** across workflow operators
* `neutral` is the identity / default value when needed (e.g., missing data or empty aggregation)
* The current schema does **not** define normalization; only raw aggregation operators are modeled.

### Schema-enforced rule

* `compose` MUST define at least one operator (`seq`, `and`, `xor`, or `loop`) (enforced by `minProperties` + `anyOf` required keys).

### Compose functions (`compose_fn`)

```json
{ "fn": "SUM" | "PRODUCT" | "MAX" | "MIN" | "SCALED_SUM" | "SCALED_PRODUCT" | "SCALED_MIN" | "SCALED_MAX" | "MEAN" }
```

### Typical interpretations (recommended)

Your solver should document exact semantics; common defaults:

* `SUM`: ( f(x_1..x_n) = \sum_i x_i )
* `PRODUCT`: ( \prod_i x_i ) (often for reliabilities)
* `MAX`: ( \max_i x_i ) (e.g., latency in parallel if all must finish)
* `MIN`: ( \min_i x_i ) (e.g., best-of)
* `SCALED_SUM`: typically for LOOP with expected iterations `c`: ( c \cdot x )
* `SCALED_PRODUCT`: typically for LOOP with expected iterations `c`: ( x^c )
* `SCALED_MIN`: solver-defined scaling of a `MIN`-like aggregation (often used for LOOP)
* `SCALED_MAX`: solver-defined scaling of a `MAX`-like aggregation (often used for LOOP)
* `MEAN`: ( (1/n) \sum_i x_i )

**Note:** `compose` lives per attribute, so different QoS attributes can aggregate differently for the same operator.

---

# 8) `constraints` (optional)

```json
"constraints": [
  { ... },
  { ... }
]
```

Constraints are one of:

* `ATTRIBUTE_BOUND`
* `DEPENDENCY`

Each constraint has an optional `hard` boolean (defaults to `true` in many implementations).

## 8.1 Attribute bound constraint (`kind: "ATTRIBUTE_BOUND"`)

```json
{
  "id": "c_latency_global",
  "kind": "ATTRIBUTE_BOUND",
  "scope": "GLOBAL",
  "attribute_id": "latency_ms",
  "op": "<=",
  "value": 500,
  "hard": true
}
```

### Scope

* `GLOBAL`: applies to the aggregated workflow output
* `LOCAL`: applies to a subset of tasks and/or candidates

**Schema-enforced rule for `LOCAL` scope:**
If `scope == "LOCAL"`, the constraint MUST include at least one of:

* `tasks`: array of task IDs
* `candidates`: array of candidate IDs

### Operator + value shape (schema-enforced)

* If `op == "IN_RANGE"` → `value` MUST be:

  ```json
  { "min": number, "max": number }
  ```
* Otherwise → `value` MUST be a number

Examples:

```json
{ "op": "IN_RANGE", "value": { "min": 0.99, "max": 1.0 } }
{ "op": ">=", "value": 0.999 }
```

## 8.2 Dependency constraint (`kind: "DEPENDENCY"`)

```json
{
  "id": "c_same_provider",
  "kind": "DEPENDENCY",
  "type": "SAME_PROVIDER",
  "tasks": ["t_auth", "t_pay"],
  "hard": true
}
```

### Dependency types

* `SAME_PROVIDER`: selected candidates for all listed tasks share a provider
* `DIFFERENT_PROVIDER`: selected candidates for all listed tasks must be on different providers

---

# 9) `objective`

An objective is one of:

* `MONO`: `targets` has at least 1 entry it can have more than 1, but it’s a mono scalar objective (e.g., weighted sum)
* `MULTI`: `targets` has 2–3 entries
* `MANY`: `targets` has at least 3 entries

All objective variants share the same shape:

```json
"objective": {
  "type": "MONO" | "MULTI" | "MANY",
  "targets": ["feature_id", "..."],
  "weights": { "feature_id": 0.7, "...": 0.3 },
  "weights_sum_to_one": true
}
```

Schema-enforced rules:

* `targets` items must be unique
* `weights` is a non-empty map with values in `[0,1]`
* `weights_sum_to_one` is optional (defaults to `true`)

Important semantic invariants (not enforced):

* Keys of `weights` SHOULD match the entries in `targets`
* If `weights_sum_to_one == true`, weights SHOULD sum to 1 (within tolerance)

---

# Validation & invariants (what schema enforces vs what it can’t)

## Enforced by JSON Schema

* Required top-level sections
* Basic shapes and types
* No unknown top-level properties (`additionalProperties: false` at the root)
* LOOP requires either `expected_iterations` or `bounds`
* `ATTRIBUTE_BOUND.value` shape depends on `op`
* `ATTRIBUTE_BOUND` with `scope == "LOCAL"` requires `tasks` or `candidates`
* Aggregation policy `compose` must define at least one operator (`seq`, `and`, `xor`, `loop`)
* Objective `targets` uniqueness and size constraints depend on objective type

## NOT enforceable (or not enforced) in pure JSON Schema (validate separately)

### Referential integrity (“foreign keys”)

* All `task_id` references exist in `tasks[*].id`
* All `provider_id` references exist in `providers[*].id`
* All `composition` `TASK` nodes reference valid `task_id`
* All `constraints[*].tasks` reference valid task IDs
* All `constraints[*].candidates` reference valid candidate IDs

### Uniqueness

* `providers[*].id`, `tasks[*].id`, `candidates[*].id`, node IDs should be unique

### Workflow semantics

* XOR branch probabilities SHOULD sum to 1 (within tolerance)

### QoS feature alignment

* Candidate QoS keys SHOULD be a subset of `features[*].id`
* Candidate QoS values SHOULD lie within feature `valid_range`

### Objective consistency

* `objective.targets` SHOULD reference existing feature IDs
* `objective.weights` keys SHOULD reference existing feature IDs

---

# Recommended conventions (practical interoperability)

## IDs

Use stable, readable identifiers:

* `t_*` for tasks, `svc_*` for candidates, `p_*` for providers, `n_*` for nodes
* Feature IDs like: `latency_ms`, `cost_usd`, `availability`

## Units

Be explicit:

* Latency: `ms`
* Cost: `usd` (or `usd_per_call`)
* Availability: unit `ratio` with range `[0,1]`

---

# End-to-end minimal valid example (passes the current schema)

```json
{
  "metadata": {
    "id": "example-001",
    "name": "Single-task example",
    "version": "1.0.0",
    "created_at": "2026-01-19T12:00:00Z"
  },
  "features": [
    {
      "id": "latency_ms",
      "name": "Latency",
      "direction": "MINIMIZE",
      "unit": "ms",
      "scale": "RATIO",
      "valid_range": { "min": 0, "max": 10000 }
    }
  ],
  "providers": [
    { "id": "p1", "name": "ProviderOne" }
  ],
  "tasks": [
    { "id": "t1", "name": "DoThing" }
  ],
  "candidates": [
    {
      "id": "c1",
      "name": "CandidateOne",
      "task_id": "t1",
      "provider_id": "p1",
      "features": { "latency_ms": 120 }
    }
  ],
  "composition": {
    "type": "STRUCTURED",
    "root": { "id": "n1", "kind": "TASK", "task_id": "t1" }
  },
  "aggregation_policies": {
    "latency_ms": {
      "neutral": 0,
      "compose": { "seq": { "fn": "SUM" } }
    }
  },
  "objective": {
    "type": "MONO",
    "targets": ["latency_ms"],
    "weights": { "latency_ms": 1.0 },
    "weights_sum_to_one": true
  }
}
```

---

# Appendix: Quick reference of key enums

## Feature direction

* `MAXIMIZE`, `MINIMIZE`

## Feature scale

* `RATIO`, `INTERVAL`, `ORDINAL`

## Composition type

* `STRUCTURED`

## Structured node kinds

* `TASK`, `ELEMENT`, `SEQ`, `AND`, `XOR`, `LOOP`

## Compose functions

* `SUM`, `PRODUCT`, `MAX`, `MIN`, `SCALED_SUM`, `SCALED_PRODUCT`, `SCALED_MIN`, `SCALED_MAX`, `MEAN`, `WEIGHTED_SUM`

## Constraint kinds

* `ATTRIBUTE_BOUND`, `DEPENDENCY`

## Attribute bound scope

* `GLOBAL`, `LOCAL`

## Attribute bound operators

* `<=`, `>=`, `==`, `!=`, `<`, `>`, `IN_RANGE`

## Dependency types

* `SAME_PROVIDER`, `DIFFERENT_PROVIDER`, `SAME_POOL`, `DIFFERENT_POOL`

  `SAME_POOL` and `DIFFERENT_POOL` require a `resource_model` declaring pools; an instance
  that uses them without one is rejected by semantic validation.

## Objective types

* `MONO`, `MULTI`, `MANY`


---

# 10) `resource_model` (optional, placement extension)

Declares the infrastructure a binding is placed on, and the capacity it must respect.

```json
"resource_model": {
  "resources": ["cpu_millicores", "memory_mb"],
  "pools": [
    { "id": "edge_1", "name": "Edge node 1", "kind": "EDGE",
      "capacity": { "cpu_millicores": 4000, "memory_mb": 8192 } }
  ],
  "candidate_bindings": [
    { "candidate_id": "c_t1_edge1", "pool_id": "edge_1",
      "demand": { "cpu_millicores": 500, "memory_mb": 512 } }
  ],
  "constraints": [
    { "id": "cap_all", "kind": "DEPENDENCY", "type": "RESOURCE_CAPACITY",
      "scope": "ALL_POOLS", "resources": ["cpu_millicores", "memory_mb"], "hard": true }
  ]
}
```

### Field meaning

* `resources` — the resource names capacities and demands are expressed in.
* `pools` — where candidates can run. `kind` groups pools (`EDGE`, `FOG`, `CLOUD`, …) so that a
  constraint can target a class of pools rather than each one. A resource missing from
  `capacity` means unbounded for that resource.
* `candidate_bindings` — the pool each candidate runs on, and what it consumes there. Selecting
  a candidate therefore determines its placement: the pool is a function of the choice, not an
  independent decision.
* `constraints` — capacity constraints. `scope: ALL_POOLS` applies to every pool;
  `scope: POOL_KIND` applies to the pools whose `kind` is listed in `pool_kinds`.

### Semantics

For every pool in scope and every listed resource, the cumulative `demand` of the selected
candidates placed on that pool must not exceed the pool `capacity`. This is a cumulative
bin-packing constraint, evaluated over the whole binding rather than per task.

The legacy spelling `kind: "RESOURCE_CAPACITY"` (without `type`) is still accepted.

---

# 11) `latency_model` (optional, placement extension)

Declares network latency between pools, and how it turns into an end-to-end latency for the
whole composition.

```json
"latency_model": {
  "unit": "ms",
  "pool_latency_matrix_ms": { "edge_1": { "edge_1": 0, "cloud_1": 40 } },
  "event_generator_pools": { "sensor": "edge_1" },
  "event_latency_matrix_ms": { "sensor": { "edge_1": 1, "cloud_1": 45 } },
  "transition_constraints": [
    { "id": "t1_to_t2", "from_task": "T1", "to_task": "T2",
      "op": "<=", "value": 50, "hard": true }
  ],
  "global_latency": {
    "attribute_id": "latency",
    "include_execution_latency_feature": true,
    "xor_semantics": "EXPECTED",
    "and_semantics": "MAX"
  }
}
```

### Field meaning

* `pool_latency_matrix_ms` — pairwise latency between pools. Lookups fall back to the
  transposed entry when a direction is missing, so a symmetric matrix can be given once.
* `event_generator_pools` / `event_latency_matrix_ms` — external event sources that feed the
  composition, and their latency to each pool.
* `transition_constraints` — bounds on the latency between the pools hosting two tasks, or an
  event generator and a task. `from_task` and `from_event` are mutually exclusive.
* `global_latency` — binds the computed end-to-end latency to a feature of the instance.

### Semantics

The composition is read as a precedence DAG. Each XOR node fixes one branch per scenario, and
the end-to-end latency of a scenario is its makespan under critical-path scheduling: a task
starts once every predecessor has finished and its output has crossed the network. With
`xor_semantics: EXPECTED` the scenarios are averaged weighted by their branch probabilities;
with `WORST_CASE` the maximum is taken. `include_execution_latency_feature` adds each selected
candidate's own latency feature to its task duration.

Because the model needs a precedence DAG, an instance carrying a `latency_model` may not use
`LOOP` nodes and may not repeat a task in the composition. Only `and_semantics: MAX` is
implemented.

When `global_latency.attribute_id` names a feature, the computed end-to-end latency **replaces**
the value that ordinary aggregation would produce for that feature.
