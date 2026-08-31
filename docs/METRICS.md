# Metric definitions and informative templates

The BIM container does not define a metric vocabulary. In the installed
`qos-binding/v1` sublanguage, a `MetricDefinition` declares numeric type, unit,
domain, direction, scope, and block aggregation; the Profile adapter
materializes defaults into `BindingProblem`. Catalog metric bindings use
explicit BIM references and candidate values fill catalog-local slots. For
example, `metricBindings.latency_ms` may reference
`{ "resource": "application", "id": "latency" }`, after which each candidate's
`metrics.latency_ms` supplies that Application metric.

The following are authoring templates, not normative enums. A different
Profile or compatible metric Dialect may define other terms without changing
the BIM core:

| Intent | Typical unit | Direction | Scope | Sequence | Parallel | Exclusive | Repeat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| latency | `ms` | minimize | invocation | sum | max | routing-weighted sum | scale |
| cost | currency unit | minimize | invocation or selectedCandidate | sum | sum | routing-weighted sum | scale |
| availability | `1` ratio | maximize | invocation | product | product | routing-weighted product | power |
| reliability | `1` ratio | maximize | invocation | product | product | routing-weighted product | power |
| throughput | requests/time | maximize | invocation | min | min | min or explicit expression | identity |

Every canonical metric also has a finite `neutral`. Local tasks and empty
workflow leaves contribute this value; they never select a candidate and never
derive a hidden identity from their parent block. The source may omit `neutral`
only when the sequence operator and declared domain determine it unambiguously:
`0` for sum, `1` for product, the upper bound for min, or the lower bound for
max. Ratio bounds are `0..1`. Otherwise the author must provide `neutral`, and
it must lie in the metric domain.

Percentages used in products should be authored as ratios in `[0,1]`; `99.9`
must first become `0.999`. This prevents unit-dependent aggregation and keeps
constraints and normalization explicit. A candidate eligible for a task must
supply every metric read by a constraint, optimization term, or selected
placement policy. BIM performs no imputation.

Use a pure aggregation expression only when these operators cannot state the
domain rule. The expression receives typed `values`, `weights`, and `count`,
and is lowered to Expression IR rather than shipped as executable package
code.
