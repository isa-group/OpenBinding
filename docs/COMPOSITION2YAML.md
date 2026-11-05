# Composition2Yaml v1

Composition2Yaml is the high-level, human-facing language of OpenBinding Studio. A
composition is the central entity of the Studio: a name, a workflow, tasks, properties
and versions. QoS binding is one analysis performed on it, not its definition.

**Composition2Yaml has no semantics of its own.** It is defined entirely by its
translation into `qos-binding/v1` documents, and it is the translation below — not this
prose — that fixes its meaning. Everything that is solved, validated, evaluated or
exported goes through a BIM v1 package and the compiler to IR. If a sentence here
disagrees with the translation table, the translation table wins.

Status: **proposal for review**. Section 12 lists what this version deliberately
cannot say, and section 13 states the price of the one design shortcut it takes.

---

## 1. Where the source lives

A Composition2Yaml document is **source that sits outside the BIM package**. It is never
a package entry, and the compiler never reads it.

This is forced by the container, not chosen for convenience:

- `instance.schema.json` admits a local resource path only with suffix `.json`, `.bpmn`
  or `.xml`.
- The compiler rejects any file present in a package but absent from `instance.json`
  with the diagnostic `undeclared_resource`.
- That schema is mirrored byte-for-byte inside `bim_core` and the copies are
  parity-tested, so widening the pattern is a two-tree change plus a guard change plus a
  new canonical byte form.

So the Studio compiles a `.c2y.yaml` file **into** a package directory (or into memory)
and the package that results is an ordinary one: nothing downstream can tell it was
written by hand or generated.

```
fleet-management.c2y.yaml          # Composition2Yaml source, Studio-owned
  │
  │  compile
  ▼
instance.json                      # an ordinary BIM v1 package
application.json
candidates.json
routing.json                       # only when some exclusive carries probabilities
constraints.json                   # only when there are rules
optimization.json
provenance.json                    # Studio-side, NOT a declared resource
```

## 2. Document structure

```yaml
composition: fleet-management       # required, the composition's stable id
version: "2.0.0"                    # required, the composition version
title: Fleet Management System      # optional, free text
description: >                      # optional, free text
  Hybrid SaaS for fleet routing and dispatch.

pricing:                            # optional, a permanent link into SPHERE
  href: https://sphere.score.us.es/faked/fleet-management/2026-01.yaml
  digest: sha256-...                # optional, makes the reference tamper-evident

properties: {...}                   # section 3
tasks: {...}                        # section 4
workflow: {...}                     # section 5
candidates: {...}                   # section 6
rules: [...]                        # section 7
goals: [...]                        # section 8
studio: {...}                       # section 9, inert
```

`composition` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`: it becomes
`metadata.name` of every emitted document, suffixed per resource. `version` is a free
non-empty string and becomes `metadata.version`.

### 2.1 The pricing reference

`pricing` is a reference, never an embedded pricing, and it is **the permanent link SPHERE
publishes for one pricing version** -- the stable, citable address of those exact bytes.
A bare string is the shorthand for `href`:

```yaml
pricing: https://sphere.score.us.es/faked/fleet-management/2026-01.yaml
```

The link must be absolute, must be on the SPHERE origin the installation is configured
with, and the organization, the slug and the version must be readable from it. This
specification does not fix a single path template, because the one SPHERE serves is
SPHERE's to change; the gateway today trusts two shapes, a static pricing path and
`/<organization>/<slug>/<version>.yaml`.

**There is no separate `version` field, and that is a deliberate decision.** The reasons,
in the order they matter:

*One fact in one place.* The permanent link already names the version. A `version` beside
it would be a second source of truth for the same fact, and a document whose two halves
disagree has no good reading -- the Studio would have to pick a winner and would be wrong
half the time. The gateway already meets this problem on the fetching side and resolves it
by *verifying*: it refuses a pricing whose document does not carry the version it asked
for. That is the right shape for a fetch and the wrong shape for a source document a
person edits by hand, where the second field is simply an opportunity to be inconsistent.

*A reference that is not pinned says nothing later.* A concept-level link that always
resolves to the newest version would make the provenance of a composition unfalsifiable:
"the candidates came from the latest pricing" is not a statement anyone can check a year
afterwards. This does not threaten the IR digest -- candidates are a snapshot, so the
compiled problem is already pinned whatever the reference says -- but the reference is
exactly what lets a reader re-derive or audit that snapshot, and it has to name the bytes
it was taken from.

*The repository already works this way.* SPHERE's published versions are immutable, and
the gateway pins the digest of a version's bytes on first read and treats SPHERE changing
a published version as an error rather than serving it. The honest companion to a
permanent link is therefore not a restatement of the version but an optional `digest`,
which is what actually makes the reference tamper-evident.

*And the version history is still reachable.* Phase F4 has to notice that a newer pricing
version exists and show what changed, which needs the pricing's concept identity and not
only this version's. That identity is **derivable**: the organization and the slug are in
the link, and asking SPHERE for that organization and slug lists every version. So
nothing is lost by leaving the version implicit in the link.

What this gives up, honestly: three named fields read better than a URL, and the document
becomes coupled to SPHERE's address layout. The mitigation is that the compiler treats the
link as opaque -- it never fetches during compilation, because the candidates are already a
snapshot -- and the editor shows the organization, slug and version it parsed out of it.

The reference is recorded in provenance. It is not emitted into the package (section 9),
so it reaches neither the IR nor any digest. How the Studio resolves it against SPHERE, and
how a pricing becomes candidate rows, is phase F4.

## 3. Properties

A property is a numeric quality of the composition. Each one becomes one entry of
`Application.spec.features`.

```yaml
properties:
  cost:
    template: cost
    unit: USD/month
    domain: {min: 0, max: 10000}
  latency:
    template: latency
    unit: ms
    domain: {min: 0, max: 20000}
  availability:
    template: availability            # ratio domain, no bounds needed
  security:                           # no template: declare the policy yourself
    unit: score
    direction: maximize
    domain: {kind: real, min: 1, max: 5}
    aggregate:
      sequence: min
      parallel: min
      exclusive: weightedSum
      repeat: identity
      selection: min
```

### 3.1 Templates

A `template` is authoring sugar that fills `direction`, `scope` and `aggregate`. The
five templates reproduce the table in `docs/FEATURES.md` exactly:

| template | direction | scope | sequence | parallel | exclusive | repeat | selection |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cost` | minimize | invocation | sum | sum | weightedSum | scale | sum |
| `latency` | minimize | invocation | sum | **max** | weightedSum | scale | sum |
| `availability` | maximize | invocation | product | product | weightedProduct | power | product |
| `reliability` | maximize | invocation | product | product | weightedProduct | power | product |
| `throughput` | maximize | invocation | min | min | min | identity | min |

`cost`, `availability`, `reliability` and `throughput` coincide with the container's own
shorthands `sum`, `product`, `product` and `min`, so they are emitted as the shorthand
string. `latency` differs from every shorthand in its `parallel` operator, so it is
emitted as a block policy. Either form lowers to the same IR, so the choice is
digest-neutral; the spec picks the shorter source form for readability.

Any field declared alongside a `template` overrides it. A property with no `template`
must declare `direction` and `aggregate` itself.

### 3.2 Domain

`domain` accepts `{kind, min, max}` where `kind` is `real`, `integer` or `ratio` and
defaults to `real`. `min`/`max` become `domain.minimum`/`domain.maximum`. A `ratio`
domain is bounded to `[0, 1]` by the container and needs no explicit bounds.

**A property whose `sequence` operator is `min` or `max` must bound its domain on the
relevant side**, because that bound *is* its neutral (section 10). The
`throughput` template therefore requires `domain.max`. Omitting it is refused at
authoring time with `c2y_property_neutral`, rather than producing a package that fails
to compile with `feature_neutral`.

### 3.3 Domain of applicability

```yaml
properties:
  qubit_count:
    unit: qubits
    direction: minimize
    domain: {kind: integer, min: 0, max: 4096}
    aggregate: {sequence: sum}
    applies_to: quantum               # classical | quantum | all (default)
```

`applies_to` is a Studio concept with no counterpart in the container. It drives the
explicit neutral values of section 10 and is recorded in provenance. It does not reach
the IR.

## 4. Tasks

A task is a step of the composition that the workflow invokes. There are exactly three
kinds, and the distinction is load-bearing because the container treats them differently.

```yaml
tasks:
  R:                                  # OPEN: many candidates compete
    open: true
    requires: service/R
    title: Route Optimization Orchestrator

  C:                                  # FIXED: exactly one candidate
    fixed:
      title: Classical Routing Solver
      provider: inhouse
      properties: {cost: 0, latency: 800, availability: 0.999, reliability: 0.999}

  audit:                              # LOCAL: no candidate at all
    local: true
    title: In-house step, outside the selectable candidate set
```

| kind | emits in `Application.spec.tasks` | candidates | contributes |
| --- | --- | --- | --- |
| `open` | `"<requires>"` (string shorthand) | every catalog candidate whose `provides` matches | the selected candidate's values |
| `fixed` | `"fixed/<task id>"` | exactly one, minted as `cand_<task id>` | that one candidate's values |
| `local` | `{kind: local, name: <title>}` | none | each property's neutral |

A **fixed** task is a service task with a minted, unique capability type: the Studio
writes `fixed/<task id>` as the task's requirement and emits exactly one candidate
providing it, so eligibility is a singleton and the solver has no choice to make. It is
not the same as a local task.

A **local** task is the container's own `kind: local`. It never binds and contributes
each evaluated property's neutral. This kind exists because the guiding case needs it:
FMS v1 models its in-house classical solver as a local task, deliberately outside the
candidate market.

Candidates are **never** attached to open tasks by id. The container is explicit that a
catalog "never lists task ids": eligibility is built by capability matching between
`task.requires` and `candidate.provides`, optionally narrowed by a predicate. This
version emits no predicates (section 12).

## 5. Workflow

The workflow is a tree of four block kinds plus a task leaf and an empty leaf. It maps
one-to-one onto the container's workflow nodes.

```yaml
workflow:
  sequence:
    - parallel:
        - {task: O}
        - {task: F}
        - {task: D}
    - {task: L_filter}
    - {task: T}
    - exclusive:
        id: solver_choice
        branches:
          - {probability: 0.8, flow: {task: C}}
          - {probability: 0.2, flow: {task: Q}}
    - {task: L_validate}
```

| Composition2Yaml | container node |
| --- | --- |
| `{task: X}` | `{"task": {"resource": "application", "id": "X"}}` |
| `{empty: true}` | `{"empty": true}` |
| `{sequence: [...]}` | `{"sequence": [...]}` |
| `{parallel: [...]}` | `{"parallel": [...]}` |
| `{exclusive: {id, branches}}` | `{"exclusive": [...]}` plus routing entries |
| `{repeat: {count: n, body}}` | `{"repeat": {"count": n, "body": ...}}` |
| `{repeat: {expected: x, body}}` | `{"repeat": {"expectedCount": x, "body": ...}}` |

`repeat` takes `count` for an exact repetition or `expected` for a deterministic mean,
never both.

### 5.1 No node ids

**The compiler never mints an id on a workflow node.** The container accepts an `id` on
any node, copies it into the IR, and `ir_digest` does not strip it; worse, its sequence
flattening refuses to flatten a nested sequence that carries one. No package in the
corpus uses a node id, so minting them would silently move the digest of every package
the Studio touches, with no golden to catch a partial mistake.

Branch ids are the one exception, and they are not minted freely: see 5.2.

### 5.2 Exclusive choice and probabilities

This is the single most important translation rule, because the two halves of an
exclusive choice land in **two different documents**.

An `exclusive` block with inline probabilities compiles to:

1. `Application.spec.workflow` gets `{"exclusive": [{"id": ..., "flow": ...}, ...]}`,
   with **no `when` on any branch**.
2. `RoutingOverlay.spec.entries` gets one entry per branch, targeting that branch id.

```yaml
exclusive:
  id: solver_choice
  branches:
    - {probability: 0.8, condition: when the problem is small, flow: {task: C}}
    - {probability: 0.2, condition: when the problem is large, flow: {task: Q}}
```

becomes, in `application.json` (the conditions are Studio-side and do not appear):

```json
{"exclusive": [
  {"id": "solver_choice_branch_1", "flow": {"task": {"resource": "application", "id": "C"}}},
  {"id": "solver_choice_branch_2", "flow": {"task": {"resource": "application", "id": "Q"}}}
]}
```

and in `routing.json`:

```json
{"spec": {"entries": [
  {"target": {"resource": "application", "id": "solver_choice_branch_1"}, "probability": 0.8},
  {"target": {"resource": "application", "id": "solver_choice_branch_2"}, "probability": 0.2}
]}}
```

Why the probabilities live in the overlay and not on the branch, which is the decision
this section records: a distribution is a **scenario, not a structure**. Keeping
structure, candidates and binding apart is the Studio's own separation, and a sweep over
load mixes holds the structure fixed while the distribution varies -- with the probability
inside the application, every point of such a sweep would be a different application and
a different IR digest. `{uniform: true}` only makes sense as an overlay too. And the
weights are not decoration: the exact engine's aggregation list includes
`exclusive.weightedSum` and `exclusive.weightedProduct`, which consume them, so the
probability is what makes an exclusive choice solvable at all.

Rules, each of which exists because the container enforces it:

- **Branch ids are stable labels.** The default is `<exclusive id>_branch_<n>`, one-based
  in source order: a pure function of the exclusive's label and the branch's position,
  never a counter, a hash or a float. They are the join key between the two documents and
  they are visible in the IR digest.
- **An author can always override a branch's `id`, and the language must support it.** It
  is the escape hatch for reproducing an existing package exactly, which the phase F1 gate
  demands. For the guiding case the default derivation already reproduces the package's
  own ids -- an exclusive labelled `node_routing_choice` derives
  `node_routing_choice_branch_1` and `_2` -- but a package whose ids follow no scheme can
  be round-tripped only by naming them.
- **An `exclusive` that carries probabilities and has no `id` is refused**
  (`c2y_exclusive_id`). The Studio does not invent a label, because an invented one would
  be digest-visible and unstable.
- **All probabilities or none**, refused as a diagnostic at authoring time
  (`c2y_exclusive_probabilities`) rather than as a compile error further away.
- **They must sum to exactly one.** The container compares the sum against `Decimal(1)`
  with no tolerance, so the Studio parses and sums every probability as a `Decimal` taken
  from the YAML text and never through floating-point arithmetic.
- **`distribution: uniform` is the only way to say "equally likely"**, and it emits
  `{"uniform": true}`. The Studio never computes `1/n` shares itself: for three branches
  no decimal literal is exactly one third, so three equal literals sum to `0.9999999999`
  and fail that exact comparison. The container does the division internally and gives the
  last branch the remainder, so uniform routing is expressible this way and no other.
  `distribution` and inline probabilities are mutually exclusive.
- An `exclusive` with neither probabilities nor `distribution` emits **no routing
  resource**. That leaves the distribution unstated, which is not the same as uniform, and
  the Studio never silently promotes one into the other.
- **A `condition` on a branch is prose, not semantics.** It records why a branch is taken
  ("when the problem is large"), it is Studio-side (section 9) and it is never compiled.
  It is not the container's `when`, which this version does not emit at all (section 12),
  so a condition and a probability on the same branch are not in conflict: the guiding
  case has both, a documented reason and a measured 0.8/0.2.

### 5.3 The distribution is a default, not a fixture

The inline probabilities are the **composition's default distribution**. A binding
scenario may override it, addressing the branches by those same stable labels, and the
composition does not change: same structure, same tasks, same candidates, one more
scenario.

This version declares that contract without implementing its transport. Phase F1 compiles
the inline path and validates an externally supplied distribution if it is handed one; the
channel that delivers it belongs to the API and to the studies that use it.

Declaring it now costs this paragraph. Not declaring it would later force either inventing
branch labels retroactively -- and branch ids live in the application's workflow, which
the IR digest does not strip, so every existing composition's digest would move -- or
addressing branches by position, which breaks the moment one is reordered.

## 6. Candidates

```yaml
candidates:
  providers:
    ibm: {title: IBM Quantum}
    amazon: {title: Amazon Braket}
  rows:
    - id: cand_q_ibm
      provides: service/Q
      provider: ibm
      properties: {cost: 1500, latency: 12000, availability: 0.997, reliability: 0.997}
```

Each row becomes one entry of `CandidateCatalog.spec.candidates`, with `provides` copied
verbatim and `properties` becoming `features`. `featureBindings` is emitted as the
identity mapping from each property id to the Application feature of the same name.

Open tasks draw their rows from a pricing, from a SPHERE collection or from hand-written
rows; which source is used is phase F4 and does not change this translation.

**Property values are never reformatted.** A value is emitted with the shortest
representation that round-trips, because the corpus contains values such as
`0.9984999999999999` whose identity is part of a golden digest. No fixed-precision
formatting is ever applied to an emitted value.

Interval values (`{min, max}`) are **refused** by this version: they validate, compile
and digest, and then fail at dispatch, because every bundled engine mode declares support
for scalar feature values only.

## 7. Rules

```yaml
rules:
  - id: latency_budget
    assert: "features.latency <= 15000"
    enforcement: hard
  - id: prefer_available
    assert: "features.availability >= 0.99"
    enforcement: soft
    penalty: 25
```

Each rule becomes one entry of `ConstraintSet.spec.constraints`. `assert` is emitted as a
CEL string, which is what all constraints in the corpus use. A soft rule carries a
non-negative `penalty` and is referenced explicitly from the Optimization.

Expressions are restricted to comparisons of properties and tasks combined with `and`,
because the only exact engine accepts nothing else (section 12).

## 8. Goals

```yaml
goals:
  - property: cost
  - property: latency
  - property: availability
```

Each goal becomes one entry of `Optimization.spec.criteria`, as
`{id, feature: {resource: "application", id}, normalize: {min, max, clamp: true}}`.

`normalize` is **always** emitted, taken from the property's domain. The container
refuses criteria that span more than one unit without explicit normalization
(`normalization_required`), and every criterion in the corpus carries it. `direction` is
not emitted on a criterion: it belongs to the property.

Weights, scalarization and objective type are **not** part of a composition. They are
execution-request parameters, chosen per analysis run, and a composition that fixed them
would conflate the structure with one study of it.

## 9. The Studio block

```yaml
studio:
  tags: [jisbd-2026, hybrid]
  layers:
    data: [D, O, F, L, T]
    optimization: [R, C, Q]
    execution: [M]
```

`studio` carries whatever the Studio needs, and **it is not emitted into the package at
all**. Neither is any other field this specification marks as Studio-side: a branch's
`condition` and a property's `applies_to` stay here too.

Not under `spec.extensions`, where a payload with no installed dialect and no
deterministic lowering makes compilation fail and is never copied into the IR. And not
into `metadata.annotations` either, although the container declares that map open:
keeping Studio data out of the package entirely is what makes it inert *by construction*.
The annotations route is inert only for as long as something keeps proving that source
annotations do not reach the IR, and it changes the package digest, so two compositions
differing only in a Studio tag would compile to different packages.

One consequence to carry into phase F1: a package imported from BIM may already carry
annotations of its own, as the guiding case does. Those are not the Studio block and must
not be folded into it -- reproducing such a package byte for byte needs an opaque
passthrough that re-emits them unchanged. The IR digest is unaffected either way, since it
strips metadata.

## 10. Explicit neutral values

Every property has a finite neutral: the value a step contributes when it does not
participate. Local tasks and empty leaves contribute it.

**The Studio always writes `neutral` explicitly**, both on the feature and, where a
property does not apply, on the candidate. It never relies on inference, and it never
omits a value and hopes the container fills it in — the deterministic profile performs no
imputation, and a candidate missing a property that a rule or a goal reads is an error.

### 10.1 The one normative rule

The neutral is **computed from the sequence operator and the domain**, and from nothing
else:

| `aggregate.sequence` | neutral |
| --- | --- |
| `sum` | `0.0` |
| `product` | `1.0` |
| `min` | `1.0` for a `ratio` domain, otherwise `domain.max` |
| `max` | `0.0` for a `ratio` domain, otherwise `domain.min` |

The neutral must then lie inside the declared domain. Where the rule yields nothing — a
`min` property with no upper bound — the Studio refuses the document at authoring time
instead of emitting a package that cannot compile.

Applied to the templates: `cost` 0.0, `latency` 0.0, `availability` 1.0, `reliability`
1.0, and `throughput` its `domain.max`.

**There is a second, different neutral in the container that must never be used here.**
The evaluator has an operator identity — `1.0` for product-like operators and `0.0` for
everything else — which applies only when an operator receives an empty list of values.
Writing that identity in place of the feature-level neutral would be wrong for every
`min` and `max` property. In the guiding case it would give the `security` property `0.0`
instead of `5.0` and move every binding digest of that package.

Because the Studio's rule reproduces the container's exactly, writing the neutral
explicitly is digest-neutral: the IR carries a neutral on every feature either way.
`openbinding-gateway/tests/composition/test_neutral_matches_compiler.py` asserts that
equality for every feature of every package in the corpus, so the two cannot drift apart
silently.

### 10.2 A property that does not apply to a candidate

When a property does not apply to a candidate — a quantum property on a classical solver
— the Studio writes **that property's explicit neutral** into the candidate's features,
and records the substitution in provenance.

This is the semantically right value, not a placeholder: for a `sum` property the
candidate contributes nothing, for a `product` property it does not degrade the result,
and for a `min` property the domain maximum does not constrain the minimum.

### 10.3 Provenance

Provenance is written to `provenance.json` **beside** the package and is never declared
as a resource:

```json
{"task": "C", "candidate": "cand_c_inhouse", "property": "qubit_count",
 "value": 0.0, "reason": "domain_mismatch",
 "candidateDomain": "classical", "propertyDomain": "quantum",
 "neutralSource": "inferred",
 "inferredFrom": {"sequence": "sum", "domain": {"kind": "integer", "min": 0, "max": 4096}}}
```

It cannot live inside the IR. The container's source map entries carry a resource, a
path and an optional pointer, element or span, with no slot for "synthesized because the
property does not apply"; and anything written under `spec.extensions` would change the
IR digest and break the round-trip guarantee.

## 11. Determinism

The same source produces the same IR digest, byte for byte. The Studio does not invent
any of this machinery — it reuses the container's:

- All canonicalization and hashing comes from the container's canonical JSON (RFC 8785)
  and its digest helpers. The composition library computes no digest by hand.
- The compiler already runs the profile lowering twice and compares the results, so any
  set iteration, insertion-order dependence, clock read or random call that reaches an
  emitted document surfaces as a compile error rather than as a flaky test.
- **Maps are emitted in sorted key order**: providers, feature bindings, candidates,
  tasks, properties, constraints, resources.
- **Lists keep author order verbatim**: criteria, penalties, routing entries, and every
  `sequence`, `parallel` and `exclusive` list.
- **Nested sequences are not pre-flattened.** The container canonicalizes them; doing it
  twice, differently, is how an import and an emit stop agreeing.
- **Resource ids are normative**, because they appear in the IR: `application`,
  `catalog`, `routing`, `constraints`, `optimization`. Naming the catalog anything else
  produces a semantically identical package with a different digest and no hint why.

## 12. What this version deliberately cannot say

Each omission is a reviewable decision, not a gap. Three of them are forced by the only
exact engine, whose `exact-weighted` mode accepts a closed list of workflow node kinds
that excludes conditional choice, and a closed list of expression forms limited to
literals, property and task paths, comparison and `and`.

| Not expressible | Why | Cost |
| --- | --- | --- |
| Branch conditions (`when`) | the exact engine rejects conditional choice | none: a branch carries a human-readable `condition` instead, and the distribution carries the semantics |
| Interval property values | every bundled engine mode accepts scalars only | authors must pick a value |
| Rules beyond comparison and `and` | the exact engine's expression list | no arithmetic or disjunction in rules |
| Placement | a separate dialect with its own resource and semantics | two corpus packages do not round-trip |
| `scope: selectedCandidate` | needs the selection operator and per-candidate charging | packages that use it do not round-trip |
| Capability predicates | eligibility is capability matching only | no narrowing beyond the capability type |
| `extensions` at any level | needs an installed dialect with lowering | no ad-hoc fields |
| Non-identity feature bindings | a catalog slot may be named differently from the feature | property names are shared |
| Registered and artifact resource refs | the package is always self-contained | no cross-package reuse yet |
| An empty goal list | compiles, but means "score is penalty only" | at least one goal required |
| Comments and formatting | the writer re-emits from the model | a Visual-mode edit normalizes the text |

The last one is worth stating plainly because it will be felt in phase F3: this version
projects the model back to text, so comments, key order and blank lines are lost on a
round trip through the Visual editor. Lossless editing needs a concrete syntax tree and
belongs with the editor, not with the compiler.

## 13. The dialect question, and its price

The approved decision was that Composition2Yaml should use "the same adapter mechanism
BPMN already uses". That cannot be taken literally, and the reason is in the compiler:

- The generic dialect lowering writes its output **only** under
  `spec.extensions/<dialect id>/resources/<resource id>`. It cannot populate the
  application workflow.
- The generic dialect installation function explicitly refuses the XML case that BPMN
  occupies.
- BPMN's real lowering is a hardwired `bpmn` discriminator in the application schema plus
  a dedicated lowering function. Its named adapter is never resolved through any registry.

So BPMN is not an instance of a reusable mechanism; it is a built-in with a manifest
beside it. Composition2Yaml therefore ships as a **virtual dialect**: a
`composition2yaml/v1` descriptor built with the same manifest shape as the BPMN one and
validated against the dialect schema, recorded in provenance so a compiled composition
states which translation produced it — but **never installed**. It never enters
`spec.dialects` and never moves a digest.

What that gives up: a compiled package cannot be traced back to its source notation by
anything that reads only the IR, and the dialect listing will not show Composition2Yaml
beside the installed ones.

What the faithful reading would cost: a discriminator in the application schema, hence a
new schema digest, hence new built-in manifest versions, hence a moved profile id, hence
**every** golden IR digest in the repository rebaked — plus the package layer learning a
YAML parse and a canonical byte form, the resource index learning a suffix, the instance
schema's path pattern widened in two parity-tested trees, and the repository guard
gaining a media type and a role entry.

That is incompatible with passing the existing pipeline on the current goldens, so it is
not done here. It is a major, golden-rebaking change, and this spec prices it rather than
pretending it is unnecessary.

## 14. Diagnostics

Every diagnostic carries a code, a message and the YAML span of the element at fault, so
the editor can underline it. Codes are prefixed `c2y_` to keep them distinct from the
container's.

| code | meaning |
| --- | --- |
| `c2y_schema` | the document violates the Composition2Yaml schema |
| `c2y_property_neutral` | a `min`/`max` property has no bound and no explicit neutral |
| `c2y_property_template` | unknown template name |
| `c2y_task_kind` | a task is not exactly one of open, fixed or local |
| `c2y_task_unknown` | the workflow references a task that is not declared |
| `c2y_task_unreached` | a declared task appears nowhere in the workflow |
| `c2y_exclusive_id` | an exclusive carries probabilities and has no id |
| `c2y_exclusive_probabilities` | probabilities are partial, or do not sum to exactly one |
| `c2y_exclusive_distribution` | `distribution` and inline probabilities are both present |
| `c2y_exclusive_condition` | a branch carries both a probability and a condition |
| `c2y_repeat_count` | `count` and `expected` are both present, or neither |
| `c2y_candidate_property` | a candidate value is an interval, or outside the domain |
| `c2y_candidate_unmatched` | an open task has no eligible candidate |
| `c2y_pricing_href` | the pricing link is relative, on another origin, or has no readable version |
| `c2y_goal_unknown` | a goal references a property that is not declared |
| `c2y_rule_expression` | a rule uses a form outside comparison and `and` |

Compilation is all-or-nothing, as it is in the container: a document with any error
produces no package.

## 15. Worked example

The nine-service, three-layer architecture of the guiding case, version 2. See
`docs/FMS_CASE.md` for what each service is.

```yaml
composition: fleet-management
version: "2.0.0"
title: Fleet Management System

pricing: https://sphere.score.us.es/faked/fleet-management/2026-01.yaml

properties:
  cost:
    template: cost
    unit: USD/month
    domain: {min: 0, max: 10000}
  latency:
    template: latency
    unit: ms
    domain: {min: 0, max: 20000}
  availability:
    template: availability
  reliability:
    template: reliability

tasks:
  D: {open: true, requires: service/D, title: Depot}
  O: {open: true, requires: service/O, title: Order and Demand}
  F: {open: true, requires: service/F, title: Fleet Assets}
  L: {open: true, requires: service/L, title: Driver and Labor Compliance}
  T: {open: true, requires: service/T, title: Distance and Travel Time}
  R: {open: true, requires: service/R, title: Route Optimization Orchestrator}
  Q: {open: true, requires: service/Q, title: Quantum Routing Solver}
  M: {open: true, requires: service/M, title: Telemetry and Tracking}
  C:
    fixed:
      title: Classical Routing Solver
      provider: inhouse
      properties: {cost: 0, latency: 800, availability: 0.999, reliability: 0.999}

workflow:
  sequence:
    - parallel:
        - {task: O}
        - {task: F}
        - {task: D}
    - {task: L}
    - {task: T}
    - exclusive:
        id: solver_choice
        branches:
          - {probability: 0.8, flow: {task: C}}
          - {probability: 0.2, flow: {task: Q}}
    - {task: M}

candidates:
  providers:
    ibm: {title: IBM Quantum}
    here: {title: HERE}
  rows:
    - id: cand_q_ibm
      provides: service/Q
      provider: ibm
      properties: {cost: 1500, latency: 12000, availability: 0.997, reliability: 0.997}
    - id: cand_t_here
      provides: service/T
      provider: here
      properties: {cost: 120, latency: 300, availability: 0.999, reliability: 0.998}

goals:
  - property: cost
  - property: latency
  - property: availability

studio:
  tags: [jisbd-2026, hybrid]
  layers:
    data: [D, O, F, L, T]
    optimization: [R, C, Q]
    execution: [M]
```

Note that `R` is declared as a task and appears in no workflow position in this excerpt:
the orchestrator is the composition itself. Section 14's `c2y_task_unreached` is exactly
the diagnostic that catches an unintended version of this, and the guiding case needs a
decision on it — recorded as an open question in `docs/FMS_CASE.md`.

## 16. Open questions for review

1. **Which golden set** the F1 gate means. The repository carries a live normalized
   golden, a frozen baseline and a newer frozen baseline; the first two disagree for 64
   of 82 packages. Recommendation: the live normalized one.
2. **The virtual dialect** of section 13: accept it for this version, or pay for the
   faithful reading.
3. **Which corpus packages must round trip.** Placement rules out two; dropping
   `scope: selectedCandidate` rules out a third.
4. **The orchestrator task** (`R` above): is an orchestrator a task with candidates, or
   is it the composition itself? The guiding case models it both ways across versions.
5. **The relationship with the four existing high-level-to-package compilers** already in
   the repository: absorb them, delegate to them, or coexist.
