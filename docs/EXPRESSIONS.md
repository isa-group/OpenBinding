# Expressions in BIM v1

The installed `qos-binding/v1` Profile accepts two authoring forms: a compact
JSON AST and a restricted CEL expression. Both are type-checked and lower to
the same closed Expression IR, so spelling does not change evaluation or the
semantic IR digest.

This expression language belongs to the Profile, not to the BIM container. A
different Profile may install another condition language and lower it to a
different output IR without changing `Instance`.

## JSON AST and CEL

At an expression position, a JSON string is the CEL source form. Bare numbers,
Booleans, and `null` are literal AST values; a string literal in JSON AST must
use `{"literal":"text"}`. The remaining JSON form uses small tagged objects.
For example, these two assertions lower to the same IR:

```json
{
  "op": "lte",
  "left": {"path": ["metrics", "latency"]},
  "right": {"literal": 250}
}
```

```cel
metrics.latency <= 250
```

A JSON path may be a dotted identifier such as `metrics.latency` or a
non-empty segment array. Use the array whenever an id contains punctuation:

```json
{"path": ["tasks", "checkout.payment", "metrics", "latency"]}
```

The equivalent CEL form uses constant string subscripts:

```cel
tasks["checkout.payment"].metrics.latency
```

Lowering always represents a path as
`{"kind":"path","segments":[...]}`. Engines must traverse those exact
segments; they must not split a reconstructed dotted string. This preserves
the distinction between one id containing a dot and two nested identifiers.

The JSON AST supports:

- `literal` and `path` nodes;
- Boolean `and`, `or`, and `not`;
- comparisons `eq`, `ne`, `lt`, `lte`, `gt`, and `gte`;
- arithmetic `add`, `sub`, `mul`, `div`, `pow`, `scale`, `power`, and unary
  `negate`; and
- approved calls `has`, `min`, `max`, `sum`, `product`, `weightedSum`, and
  `weightedProduct`.

`scale` and `power` are authoring aliases for multiplication and exponentiation
in the canonical IR. `has` accepts exactly one path. Weighted calls accept the
typed `values` and `weights` lists supplied to an aggregation expression.

The CEL subset provides the corresponding scalar literals, typed paths,
constant string subscripts, Boolean operators, comparisons, arithmetic, and
approved calls. It has no comprehensions, arbitrary macros, dynamic indexing,
method dispatch, object construction, or user-defined functions.

## Contexts are closed and typed

There is no universal global environment. Each expression position receives
only the roots meaningful there:

- a capability predicate sees `candidate` and the matching `capability`;
- workflow conditions, constraints, and soft penalties see declared binding,
  task, metric, and installed-extension values;
- a custom metric aggregation sees only `values`, `weights`, and `count`.

Known task and metric ids are registered as exact path segments before
compilation. Candidate property paths are exposed only when their scalar type
is stable across every eligible value; installed Dialect lowerings likewise
contribute a closed, typed JSON shape. Opaque wildcard paths are never treated
as if they had every possible type. A path outside that environment is a
diagnostic. Candidate
predicates run before optimization to materialize the eligibility matrix; an
Engine receives the resulting matrix rather than an unevaluated source
predicate.

Boolean operators require Boolean operands. Arithmetic requires finite
numbers and excludes Boolean values. Ordered comparison accepts two numbers or
two strings; equality accepts two numbers or values of the same runtime type.
Incompatible types are errors rather than coercions. Strings use Unicode
code-point ordering consistently across the gateway and bundled engines.

## Constraints and penalties

A constraint has an optional `when`, a Boolean `assert`, and
`enforcement: hard|soft`. `when` short-circuits the assertion. A soft
constraint also declares a fixed or computed finite, non-negative numeric
penalty. Every soft penalty must be referenced explicitly by `Optimization`;
an inert soft constraint is invalid.

Metric aggregation expressions use the same pure IR. Prefer the built-in sum,
product, minimum, maximum, routing-weighted sum/product, scale, power, and
identity operators when they state the rule directly; use an expression only
for a domain rule the built-ins cannot express.

## Safety limits

An expression has no I/O, reflection, network access, package-code execution,
external lookup, or unbounded regular expression. Compilation currently limits
CEL source to 4,096 characters, the canonical tree to 256 nodes and depth 32,
and a call to 16 arguments. Division by zero, overflow, a non-finite result,
or an invalid fractional power is an evaluation error.

QoS values remain finite deterministic scalars. Metric distributions,
intervals, scenarios, risk measures, telemetry, and runtime rebinding are
outside `qos-binding/v1`. A future Profile may compose independently versioned
expression and uncertainty Dialects while retaining the generic BIM
`Instance`; it must define an appropriate output IR, capability vocabulary,
and authoritative evaluator instead of changing this deterministic Profile.

For the broader language, see the [BIM architecture](BIM_V1.md) and
[deterministic semantics](SEMANTICS.md). CEL's general language model is
described at <https://cel.dev/overview/cel-overview>; only the subset above is
executable here.
