# Feature definitions and informative templates

The BIM container does not define a feature vocabulary. In the installed
`qos-binding/v1` sublanguage, a `FeatureDefinition` declares numeric type, unit,
domain, direction, scope, and block aggregation; the Profile adapter
materializes defaults into `BindingProblem`. Catalog feature bindings use
explicit BIM references and candidate values fill catalog-local slots. For
example, `featureBindings.latency_ms` may reference
`{ "resource": "application", "id": "latency" }`, after which each candidate's
`features.latency_ms` supplies that Application feature.

## Scalar and interval slot values

`candidates.<id>.features.<slot>` accepts a finite number or a range object
with **both** keys `min` and `max`. Each end is a finite JSON number or `null`;
`null` means an infinite (open) end: `min: null` is -∞ and `max: null` is +∞.

```json
{"features": {
  "latency_ms": 120,
  "cost": {"min": 0.8, "max": 1.2},
  "throughput": {"min": 100, "max": null},
  "temperature": {"min": null, "max": 200},
  "unknown_load": {"min": null, "max": null}
}}
```

| Range | Meaning |
| --- | --- |
| `{"min": 0.8, "max": 1.2}` | closed interval [0.8, 1.2] |
| `{"min": 100, "max": null}` | [100, +∞) |
| `{"min": null, "max": 200}` | (-∞, 200] |
| `{"min": null, "max": null}` | no information (allowed) |

- The JSON Schema of the catalog (`schemas/bim/v1/candidate-catalog.schema.json`,
  diagnostic code `schema`) requires the object to have exactly the keys `min`
  and `max`, so extra, missing or misspelled keys (`mni`) are rejected there. It
  also requires each end to be a JSON number or `null`, which rejects booleans,
  strings (`"inf"`), lists, and objects. `null` as a **scalar** slot value is
  still invalid; it is only meaningful inside a range.
  The compiler keeps a `feature_interval_shape` check on the same key set as an
  additional defense; it is not reached through `compile_instance`, because the
  schema rejects such a value first.
- `NaN`, `Infinity` and `-Infinity` are not JSON; the package layer refuses the
  literals, and the compiler rejects a non-finite number that arrives by another
  route (`finite_number`, pointer `.../min` or `.../max`). Infinity is spelled
  `null`, never `1e999` or a string.
- `min <= max` is required only when both ends are finite; the compiler rejects
  a violation with `feature_interval_order`. The interval is closed;
  `min == max` is allowed and is kept as an interval, distinct from a scalar in
  the canonical digest. An open end never triggers an order error.
- The compiler validates each finite end against the feature domain
  (`feature_value_domain`, pointer `.../min` or `.../max`). If `domain.kind` is
  `integer`, every finite end must be an integer. An open end is not compared
  with the domain: it states that no bound is known.

The `BindingProblem` keeps the literal range, `null` included
(`$defs/featureValue` of `binding-problem.schema.json` allows it); it is never
replaced by a midpoint or approximated. Fractional-product validation uses `min`,
and an open `min` (-∞) counts as negative (`fractional_product_value`). The
canonical evaluator defines no interval semantics (neither optimistic,
pessimistic, nor midpoint): reading such a feature for a selected candidate
raises an explicit error, so constraints and objectives that reference it
compile but fail at evaluation. A candidate whose interval is not bound by the
selection evaluates normally. Neighborhood analysis reports moves toward an
interval candidate as failures and errors if the base binding selects one.

Engine compatibility uses the `featureValues` capability dimension (`scalar`,
`interval`). The gateway computes `featureValues` from every bound slot of
every candidate of every catalog in the problem, not only from the selected
candidates or from the required features (see `MANIFESTS.md`). The bundled
modes declare only `scalar`, so a job in which any bound slot of any candidate
is an interval, open or closed, fails closed with
`unsupported_capability_value` (`unsupported: ["interval"]`); scalar-only jobs
are unchanged. An open range has no extra capability value: it is an `interval`.

## Authoring templates

The following are authoring templates, not normative enums. A different
Profile or compatible feature Dialect may define other terms without changing
the BIM core:

| Intent | Typical unit | Direction | Scope | Sequence | Parallel | Exclusive | Repeat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| latency | `ms` | minimize | invocation | sum | max | routing-weighted sum | scale |
| cost | currency unit | minimize | invocation or selectedCandidate | sum | sum | routing-weighted sum | scale |
| availability | `1` ratio | maximize | invocation | product | product | routing-weighted product | power |
| reliability | `1` ratio | maximize | invocation | product | product | routing-weighted product | power |
| throughput | requests/time | maximize | invocation | min | min | min or explicit expression | identity |

Every canonical feature also has a finite `neutral`. Local tasks and empty
workflow leaves contribute this value; they never select a candidate and never
derive a hidden identity from their parent block. The source may omit `neutral`
only when the sequence operator and declared domain determine it unambiguously:
`0` for sum, `1` for product, the upper bound for min, or the lower bound for
max. Ratio bounds are `0..1`. Otherwise the author must provide `neutral`, and
it must lie in the feature domain.

Percentages used in products should be authored as ratios in `[0,1]`; `99.9`
must first become `0.999`. This prevents unit-dependent aggregation and keeps
constraints and normalization explicit. A candidate eligible for a task must
supply every feature read by a constraint, optimization term, or selected
placement policy. BIM performs no imputation.

Use a pure aggregation expression only when these operators cannot state the
domain rule. The expression receives typed `values`, `weights`, and `count`,
and is lowered to Expression IR rather than shipped as executable package
code.
