# Feature definitions and informative templates

The BIM container does not define a feature vocabulary. In the installed
`qos-binding/v1` sublanguage, a `FeatureDefinition` declares numeric type, unit,
domain, direction, scope, and block aggregation; the Profile adapter
materializes defaults into `BindingProblem`. Catalog feature bindings use
explicit BIM references and candidate values fill catalog-local slots. For
example, `featureBindings.latency_ms` may reference
`{ "resource": "application", "id": "latency" }`, after which each candidate's
`features.latency_ms` supplies that Application feature.

The following are authoring templates, not normative enums. A different
Profile or compatible feature Dialect may define other terms without changing
the BIM core:

## Scalar and interval slot values

`candidates.<id>.features.<slot>` accepts a finite number or a closed interval
object:

```json
{"features": {"latency_ms": 120, "cost": {"min": 0.8, "max": 1.2}}}
```

- The object has exactly the keys `min` and `max`; extra or missing keys are
  rejected (`feature_interval_shape`).
- Both endpoints must be finite numbers. Booleans, strings, `null`, `NaN`, and
  infinity are rejected.
- `min <= max` is required (`feature_interval_order`). The interval is closed;
  `min == max` is allowed and is kept as an interval, distinct from a scalar in
  the canonical digest.
- Each endpoint is validated against the feature domain
  (`feature_value_domain`, pointer `.../min` or `.../max`). If `domain.kind` is
  `integer`, both endpoints must be integers.

The `BindingProblem` keeps the literal interval; it is never replaced by a
midpoint or approximated. Fractional-product validation uses `min`. The
canonical evaluator defines no interval semantics (neither optimistic,
pessimistic, nor midpoint): reading such a feature for a selected candidate
raises an explicit error, so constraints and objectives that reference it
compile but fail at evaluation. A candidate whose interval is not bound by the
selection evaluates normally. Neighborhood analysis reports moves toward an
interval candidate as failures and errors if the base binding selects one.

Engine compatibility uses the `featureValues` capability dimension (`scalar`,
`interval`). The bundled modes declare only `scalar`, so a job whose bound
candidates carry any interval fails closed with
`unsupported_capability_value`; scalar-only jobs are unchanged.

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
