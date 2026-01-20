# Compact QoS-Aware Service Composition

## What this schema represents

This schema describes a **QoS-aware service composition problem instance** (and optionally a solution). It models:

* A **workflow** of abstract **tasks** (what needs to be done)
* For each task, a set of **candidate services** (ways to do it)
* A set of **QoS features** (attributes like latency, cost, availability)
* A **composition structure** (either a *structured tree* workflow or a *DAG*)
* **Aggregation policies** that define how QoS propagates through the workflow
* Optional **constraints** (hard or soft)
* An **objective** (weighted sum / lexicographic / Pareto)
* Optional **solution output**: chosen candidates + aggregated/normalized QoS + provenance

The schema focuses on **compactness** and **tool-friendly parsing**. It is designed to be consumed by optimizers/solvers that compute an optimal (or near-optimal) candidate selection under QoS objectives and constraints.

---

# How to read this document

* “**MUST**” / “**SHOULD**” / “**MAY**” indicate recommended semantics.
* JSON Schema validates **structure**, **types**, and some **conditional rules**.
* Some important semantics (e.g., ID cross-references, DAG acyclicity, XOR probability sums) **cannot be fully enforced** by vanilla JSON Schema and require a second validation layer. See **Validation & invariants**.

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
* `runtime`
* `solver_config`
* `solution`

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
    "location": { "region": "us-west-2", "zone": "us-west-2a" },
    "affinity_tags": ["us", "tier1"]
  }
]
```

### Semantics

Providers represent organizations/platforms hosting candidate services.

* `id` SHOULD be unique across providers.
* `location` is optional but is used by dependency constraints like `co_located` / `not_co_located`.
* `affinity_tags` are free-form labels used by `affinity` / `anti_affinity`.

---

# 3) `tasks`

```json
"tasks": [
  { "id": "t_auth", "name": "Authenticate user" },
  { "id": "t_pay",  "name": "Process payment" }
]
```

### Semantics

Tasks are abstract steps in the workflow. A solver selects **one candidate per task** (unless your runtime allows multi-selection; if so, represent that in `solver_config` and `solution`).

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
    "version": "1.2.0",
    "api": { "name": "AuthAPI", "version": "v1" },
    "qos": {
      "latency_ms": 120,
      "availability": 0.999
    }
  }
]
```

### Semantics

A candidate is a concrete service option to implement a task.

* `task_id` MUST reference a task (not enforced by JSON Schema; enforce separately).
* `provider_id` MUST reference a provider (not enforced by JSON Schema).
* `qos` is a map from **attribute IDs** to numeric values. Keys SHOULD correspond to `features[*].id` (not fully enforceable in JSON Schema).
* QoS keys are constrained to a conservative identifier pattern: `^[A-Za-z0-9_.-]+$` (same for several other maps).

### Guidance on missing QoS values

Schema does not specify whether every candidate must provide every feature. Common choices:

* **Strict**: every candidate MUST have values for all features → validate in a second layer
* **Partial**: missing features use `neutral` (from aggregation policy) or are imputed (document the rule in `solver_config`)

---

# 5) `features` (QoS feature model)

```json
"features": [
  {
    "id": "latency_ms",
    "name": "Latency",
    "direction": "minimize",
    "unit": "ms",
    "scale": "ratio",
    "valid_range": { "min": 0, "max": 10000 },
    "normalization": {
      "type": "minmax",
      "bounds": { "min": 0, "max": 1000 },
      "increasing_is_better": false
    }
  }
]
```

### Field meaning

* `id`: canonical identifier used in:

  * `candidates[*].qos`
  * `aggregation_policies` keys / values
  * `objective.weights` / `objective.priority` / `objective.attributes`
  * constraints referencing `attribute_id`
* `direction`:

  * `"maximize"` for attributes like availability, throughput
  * `"minimize"` for attributes like latency, cost
* `scale`:

  * `ratio`: meaningful zero and ratios (latency, cost)
  * `interval`: differences meaningful, zero arbitrary (temperature-like)
  * `ordinal`: ordering matters but spacing not meaningful (e.g., “bronze/silver/gold” encoded numerically)
* `valid_range`: acceptable raw bounds for candidate QoS values
* `normalization`: how to map raw values to solver space (often `[0,1]`)

---

# 6) Normalization (shared definition)

Both `features[*].normalization` and `aggregation_policies[*].normalize` use the same shape:

```json
{
  "type": "minmax" | "zscore" | "piecewise" | "identity" | "custom",
  "bounds": { "min": number, "max": number },      // required for minmax
  "expr": "string expression",                     // required for piecewise/custom
  "increasing_is_better": true | false
}
```

### Conditional requirements (enforced by schema)

* If `type == "minmax"` → `bounds` is **required**
* If `type == "piecewise"` → `expr` is **required**
* If `type == "custom"` → `expr` is **required**

### Expression conventions (recommended)

The schema doesn’t define an expression language. Pick one and document it in `solver_config`. A common convention:

* `x` = raw value
* You may allow standard math ops: `+ - * /`, `min`, `max`, `log`, etc.

Examples:

* min-max (explicit bounds already provided):

  * `type: "minmax"`, bounds `{min,max}`
* piecewise:

  * `expr: "x <= 100 ? 1 : (x <= 500 ? 0.7 : 0.2)"` (ternary style)
* custom:

  * `expr: "1/(1+x)"`

---

# 7) `composition`

The workflow can be expressed in one of two ways:

## 7.1 Structured workflow tree (`type: "structured"`)

```json
"composition": {
  "type": "structured",
  "root": { ... node ... }
}
```

### Node types

Each node is one of:

* `TASK` leaf node: binds to a `task_id`
* `SEQ`: sequential composition of children
* `AND_PAR`: parallel AND-join composition
* `XOR`: probabilistic branch (each branch has probability `p`)
* `LOOP`: repeats a body with expected iterations or bounds

#### TASK node

```json
{ "id": "n1", "kind": "TASK", "task_id": "t_auth" }
```

#### SEQ / AND_PAR nodes

```json
{ "id": "n2", "kind": "SEQ", "children": [ ... at least 2 nodes ... ] }
{ "id": "n3", "kind": "AND_PAR", "children": [ ... at least 2 nodes ... ] }
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

## 7.2 DAG workflow (`type: "dag"`)

```json
"composition": {
  "type": "dag",
  "nodes": [
    { "id": "a", "kind": "TASK", "task_id": "t_auth" },
    { "id": "b", "kind": "TASK", "task_id": "t_pay" },
    { "id": "g1", "kind": "XOR" }
  ],
  "edges": [
    { "from": "a", "to": "g1" },
    { "from": "g1", "to": "b", "p": 0.5 }
  ]
}
```

### DAG nodes

* Each node MUST have `id` and `kind`.
* If `kind == "TASK"`, then `task_id` is required (enforced).
* If `kind != "TASK"`, then `task_id` must not be required (enforced indirectly).

### DAG edges

Edges are:

```json
{ "from": "nodeId", "to": "nodeId", "p": 0..1 (optional) }
```

**Important semantic invariants (not enforced):**

* `from`/`to` MUST reference existing node IDs
* Graph SHOULD be acyclic (a true DAG)
* If a node behaves like XOR-split, outgoing edge probabilities SHOULD sum to 1

---

# 8) `aggregation_policies`

```json
"aggregation_policies": {
  "latency_ms": {
    "attribute_id": "latency_ms",
    "direction": "minimize",
    "scale": "ratio",
    "neutral": 0,
    "compose": {
      "seq":  { "fn": "sum" },
      "and":  { "fn": "max" },
      "xor":  { "fn": "weighted_sum", "expr": "Σ(p_i * x_i)" },
      "loop": { "fn": "scale_by_c", "expr": "c * x" }
    },
    "normalize": {
      "type": "minmax",
      "bounds": { "min": 0, "max": 1000 },
      "increasing_is_better": false
    }
  }
}
```

### What a policy means

For each QoS attribute:

* `compose` defines how to **aggregate child values** across workflow operators
* `neutral` is the identity / default value when needed (e.g., missing data or empty aggregation)
* `normalize` defines how to produce **normalized QoS** for objectives that require it

### Schema-enforced rule

* `compose` MUST define at least one operator (`seq`, `and`, `xor`, or `loop`) (enforced by `minProperties` + `anyOf` required keys).

### Compose functions (`compose_fn`)

```json
{ "fn": "sum" | "product" | "max" | "min" | "weighted_sum" | "scale_by_c" | "custom",
  "expr": "string (required for weighted_sum/scale_by_c/custom)" }
```

Schema-enforced rule:

* If `fn` is `weighted_sum`, `scale_by_c`, or `custom`, then `expr` is required.

### Typical interpretations (recommended)

Your solver should document exact semantics; common defaults:

* `sum`: ( f(x_1..x_n) = \sum_i x_i )
* `product`: ( \prod_i x_i ) (often for reliabilities)
* `max`: ( \max_i x_i ) (e.g., latency in parallel if all must finish)
* `min`: ( \min_i x_i ) (e.g., best-of)
* `weighted_sum`: typically for XOR: ( \sum_i p_i x_i )
* `scale_by_c`: for LOOP with expected iterations `c`: ( c \cdot x )
* `custom`: expression-based aggregator

**Note:** `compose` lives per attribute, so different QoS attributes can aggregate differently for the same operator.

---

# 9) `constraints` (optional)

```json
"constraints": [
  { ... },
  { ... }
]
```

Constraints are one of:

* `attribute_bound`
* `dependency`
* `custom` (expression constraint)

Each constraint MAY be hard or soft:

* `hard: true` means infeasible if violated
* `hard: false` means feasible but penalized; `penalty` describes penalty parameters

## 9.1 Attribute bound constraint (`kind: "attribute_bound"`)

```json
{
  "id": "c_latency_global",
  "kind": "attribute_bound",
  "scope": "global",
  "attribute_id": "latency_ms",
  "op": "<=",
  "value": 500,
  "hard": true
}
```

### Scope

* `global`: applies to the whole composed workflow (aggregated value)
* `local`: applies to a specific task or candidate

**Schema-enforced rule for local scope:**
If `scope == "local"`, the constraint must include **either**:

* `task_id`
* `candidate_id`

### Operator + value shape (schema-enforced)

* If `op == "in_range"` → `value` MUST be:

  ```json
  { "min": number, "max": number }
  ```
* Otherwise → `value` MUST be a number

Examples:

```json
{ "op": "in_range", "value": { "min": 0.99, "max": 1.0 } }
{ "op": ">=", "value": 0.999 }
```

## 9.2 Dependency constraint (`kind: "dependency"`)

```json
{
  "id": "c_same_provider",
  "kind": "dependency",
  "type": "same_provider",
  "tasks": ["t_auth", "t_pay"],
  "hard": false,
  "penalty": { "type": "linear", "value": 10 }
}
```

### Dependency types

* `same_provider`: selected candidates for all listed tasks share a provider
* `different_provider`: selected candidates must be on different providers
* `co_located`: providers share region/zone (define rule in solver)
* `not_co_located`: avoid co-location
* `affinity`: satisfy affinity tags (define rule in solver)
* `anti_affinity`: avoid same tags/providers (define rule)
* `version_compatible`: enforce version constraints (use `details.version`)

`details` is intentionally open-ish:

* `details.additionalProperties: true` within the `details` object, but `dependency_constraint` overall has `additionalProperties: false`.

## 9.3 Custom expression constraint (`kind: "custom"`)

```json
{
  "id": "c_custom",
  "kind": "custom",
  "expr": "latency_ms + 2*cost_usd",
  "op": "<=",
  "rhs": 1000,
  "hard": true
}
```

This is a generic escape hatch. Document the expression language in `solver_config`.

---

# 10) `objective`

An objective is one of:

## 10.1 Weighted sum (`type: "weighted_sum"`)

```json
"objective": {
  "type": "weighted_sum",
  "weights": {
    "latency_ms": 0.7,
    "cost_usd": 0.3
  },
  "normalized": true,
  "weights_sum_to_one": true
}
```

Schema-enforced rules:

* `normalized` is **required** and must be `true` (const).
* each weight must be between **0 and 1**
* `weights` must contain at least one entry

Important semantic invariant (not enforced):

* if `weights_sum_to_one == true`, the weights SHOULD sum to 1 (enforce in second layer)

## 10.2 Lexicographic (`type: "lexicographic"`)

```json
"objective": {
  "type": "lexicographic",
  "priority": ["availability", "latency_ms", "cost_usd"],
  "tie_breaker": "weighted_sum"
}
```

Interpretation:

* Optimize the first attribute; break ties with the next; etc.
* `tie_breaker` determines how to resolve exact ties at the end:

  * `"weighted_sum"` or `"none"`

## 10.3 Pareto (`type: "pareto"`)

```json
"objective": {
  "type": "pareto",
  "attributes": ["availability", "latency_ms"],
  "reference_points": [{ "availability": 0.999, "latency_ms": 300 }],
  "epsilon_constraints": { "availability": 0.99 }
}
```

Interpretation is solver-defined. Common use:

* Generate a Pareto front, or apply ε-constraint method.

---

# 11) `runtime` and `solver_config` (optional)

Both are open `object` types to store engine-specific configuration.

Common `solver_config` fields:

* solver name/version
* time limit, gap
* normalization conventions
* expression language details
* missing QoS handling
* candidate feasibility rules

---

# 12) `solution` (optional output section)

```json
"solution": {
  "selection": {
    "by_task": {
      "t_auth": "svc_auth_1",
      "t_pay": "svc_pay_3"
    }
  },
  "aggregated_qos": {
    "latency_ms": 420,
    "availability": 0.998
  },
  "normalized_qos": {
    "latency_ms": 0.58,
    "availability": 0.92
  },
  "objective_value": 0.77,
  "feasible": true,
  "violations": [
    { "constraint_id": "c_same_provider", "slack": -1, "penalty_applied": 10 }
  ],
  "solver_provenance": {
    "solver": "my-mip-solver",
    "version": "2.1",
    "seed": 42,
    "time_sec": 0.83,
    "gap": 0.0,
    "timestamp": "2026-01-19T12:40:00Z"
  }
}
```

### Semantics

* `selection.by_task`: map task_id → candidate_id
* `aggregated_qos`: final aggregated raw QoS at workflow output
* `normalized_qos`: normalized form (commonly for objectives)
* `objective_value`: solver’s final scalar value (if applicable)
* `feasible`: whether constraints were satisfied (solver-defined; for soft constraints you may still mark feasible)
* `violations`: list of violations with optional slack/penalty info
* `solver_provenance`: reproducibility/debugging info

---

# Validation & invariants (what schema enforces vs what it can’t)

## Enforced by JSON Schema

* Required top-level sections
* Basic shapes and types
* No unknown top-level properties
* LOOP requires either `expected_iterations` or `bounds`
* `attr_bound_constraint.value` shape depends on `op`
* local attribute bounds require `task_id` or `candidate_id`
* normalization: `minmax` requires bounds; `piecewise/custom` require expr
* aggregation policy compose must define at least one operator
* compose_fn with `weighted_sum/scale_by_c/custom` requires expr
* weighted sum weights in `[0,1]` and non-empty

## NOT enforceable (or not enforced) in pure JSON Schema (you should validate separately)

You SHOULD add a second validation pass to enforce:

### Referential integrity (“foreign keys”)

* All `task_id` references exist in `tasks[*].id`
* All `provider_id` references exist in `providers[*].id`
* All `composition` task nodes reference valid `task_id`
* `solution.selection.by_task` keys are valid tasks
* Selected candidate IDs exist and match the correct task
* DAG edges refer to existing node IDs

### Uniqueness

* `providers[*].id`, `tasks[*].id`, `candidates[*].id`, node IDs should be unique

### Graph/workflow semantics

* DAG must be acyclic
* XOR probabilities should sum to 1 (tree XOR and/or DAG outgoing probs)
* Composition operators should be consistent with aggregation policies (e.g., if workflow contains XOR but attribute policy lacks `xor`, define fallback)

### QoS feature alignment

* Candidate QoS keys should be subset of feature IDs
* Each candidate should provide required attributes (if your solver expects it)
* Candidate QoS values should lie within feature `valid_range`

### Objective consistency

* Weighted-sum weights sum to 1 if `weights_sum_to_one` is true
* Objective attributes exist in features and aggregation policies

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
* Availability: unit `"ratio"` or `"prob"` with range `[0,1]`

## Direction vs `increasing_is_better`

They should align:

* direction: `"maximize"` ↔ increasing_is_better: `true`
* direction: `"minimize"` ↔ increasing_is_better: `false`

(Your schema doesn’t enforce this; keep it consistent in data generation.)

---

# End-to-end minimal valid example (passes the fixed schema)

```json
{
  "metadata": {
    "id": "example-001",
    "name": "Single-task example",
    "version": "1.0.0",
    "created_at": "2026-01-19T12:00:00Z"
  },
  "providers": [
    { "id": "p1", "name": "ProviderOne" }
  ],
  "tasks": [
    { "id": "t1", "name": "DoThing" }
  ],
  "candidates": [
    {
      "id": "c1",
      "task_id": "t1",
      "provider_id": "p1",
      "qos": { "latency_ms": 120 }
    }
  ],
  "features": [
    {
      "id": "latency_ms",
      "name": "Latency",
      "direction": "minimize",
      "unit": "ms",
      "scale": "ratio",
      "valid_range": { "min": 0, "max": 10000 },
      "normalization": {
        "type": "minmax",
        "bounds": { "min": 0, "max": 1000 },
        "increasing_is_better": false
      }
    }
  ],
  "composition": {
    "type": "structured",
    "root": { "id": "n1", "kind": "TASK", "task_id": "t1" }
  },
  "aggregation_policies": {
    "latency_ms": {
      "attribute_id": "latency_ms",
      "direction": "minimize",
      "scale": "ratio",
      "neutral": 0,
      "compose": { "seq": { "fn": "sum" } },
      "normalize": {
        "type": "minmax",
        "bounds": { "min": 0, "max": 1000 },
        "increasing_is_better": false
      }
    }
  },
  "objective": {
    "type": "weighted_sum",
    "weights": { "latency_ms": 1.0 },
    "normalized": true
  }
}
```

---

# Appendix: Quick reference of key enums

## Feature direction

* `maximize`, `minimize`

## Feature scale

* `ratio`, `interval`, `ordinal`

## Normalization types

* `minmax`, `zscore`, `piecewise`, `identity`, `custom`

## Structured node kinds

* `TASK`, `SEQ`, `AND_PAR`, `XOR`, `LOOP`

## Compose functions

* `sum`, `product`, `max`, `min`, `weighted_sum`, `scale_by_c`, `custom`

## Constraint kinds

* `attribute_bound`, `dependency`, `custom`

## Dependency types

* `same_provider`, `different_provider`, `co_located`, `not_co_located`,
  `affinity`, `anti_affinity`, `version_compatible`

## Objective types

* `weighted_sum`, `lexicographic`, `pareto`
