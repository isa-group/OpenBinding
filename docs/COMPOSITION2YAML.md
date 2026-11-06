# Composition2Yaml v1

Composition2Yaml is the high-level, human-facing language of OpenBinding Studio. A
composition is the central entity of the Studio: a name, a workflow, tasks, properties
and versions. QoS binding is one analysis performed on it, not its definition.

**Composition2Yaml has no semantics of its own.** It is defined entirely by its
translation into `qos-binding/v1` documents, and it is the translation below — not this
prose — that fixes its meaning. Everything that is solved, validated, evaluated or
exported goes through a BIM v1 package and the compiler to IR. If a sentence here
disagrees with the translation table, the translation table wins.

Status: **proposal for review**. Section 12 lists what this version deliberately cannot
say, section 13 prices the three ways it could have related to the container's dialect
mechanism and says which one it takes, and section 16 is the register of what review has
settled so far.

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

### 1.1 The translators already in the repository

Composition2Yaml is not the first thing here that writes a BIM package, and phase F1 has
to say what it does about the others. Decided in review: **coexist with all of them**, and
share rule tables rather than code. None of them is a Composition2Yaml front end, and the
reason differs in each case.

The inventory first, because "four existing compilers" was the wrong shape. There is **one
package-writing back end in the gateway with three front ends**: a statistical synthesizer,
a legacy text parser, and a Java command-line program whose output is read back into the
same dataclasses. Outside it there is the ICSOC experiment generator, and beside those a
handful of smaller writers -- a package-to-package transformer for the ICWS instances, five
dataset scripts, and the frontend's own document builder.

- **The shared back end: coexist, and share the rule table, not the code.** Its input is a
  sampling model with no place for an author-chosen branch id, a repeat by expected count,
  a declared neutral, a unit per property or a pricing reference. Worse, where it and this
  language already agree on a rule they disagree on the failure mode: it widens a declared
  domain so a neutral fits, where this language must refuse with `c2y_property_neutral`; it
  mints counter-based branch ids, where this language mandates `<exclusive id>_branch_<n>`
  as a digest-visible join key and forbids a counter by name; and it emits six resources
  *always*, writing a uniform routing document even for a workflow with no exclusive at
  all -- which section 5 forbids the Studio from doing, because an unstated distribution is
  not the same as a uniform one. Calling into it would either move its own digests, which
  sit in a committed manifest for thousands of generated packages, or make this language
  inherit behaviour it has already ruled out. What must not drift is the part both share:
  the five normative resource ids, the neutral table, the exclusive-to-routing split and
  the branch-id derivation, each with a parity test. The neutral rule already has one.
- **The legacy text parser: coexist, fenced.** Its grammar really does coincide with the
  four blocks -- sequence, parallel, a branch list with inline probabilities, a loop with
  an exact count -- and only the expected-count repeat is missing, which is what makes
  absorbing it look cheap. It is not: the format also carries aggregation functions and
  weights, which this language expresses as per-property overrides and goals, and the
  parser reads both and discards them. Absorbing it would mean importing that silent
  discard or rewriting the translation anyway, and it would tie this language to an
  endpoint, a UI tab and a committed API snapshot that have nothing to do with it.
- **The ICSOC experiment generator: coexist, frozen.** Here absorb is not expensive, it is
  impossible: every instance it emits carries a Placement resource and a
  `scope: selectedCandidate` rule, so this version expresses none of them (section 11.2
  excludes exactly those packages). Its workflow algebra, on the other hand, *is*
  expressible here, and it already derives branch ids by the same rule. The constraint that
  matters is its published numbers, not the digests pinned beside them: those digests are a
  change detector and have been legitimately refreshed for schema migrations, while no
  published figure has ever moved. Saying that out loud matters, because a reader who
  mistakes the digest for the result will refuse a migration the repository has already
  performed.
- **The Java generator: coexist.** It is not a package compiler at all -- it prints a
  problem description that the gateway lowers, and that lowering already goes through the
  container. Its historical command-line mode is not reproducible, which is a defect of its
  own and not an argument about this language; its configuration mode is.

One number this specification should print rather than imply. Canonicalization and
digesting are single-sourced in the container -- a package digest is provably invariant
under indentation, separators and key order -- so the feared "second determinism story" is
not in the byte layout. It is in the samplers: three of them, in three languages, which
give three different answers to the same seed and none of which can reproduce another.
Two of the three could be collapsed; the third is pinned to a published campaign and
should be left alone. There is also one probability normalizer in the shared back end that
quantizes to four decimals and hands the remainder to the last branch -- precisely the
computation section 5.2 refuses to do, where `distribution: uniform` leaves the division to
the container.

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

Any field declared alongside a `template` overrides it, and an `aggregate` beside a
template is merged operator by operator rather than replacing the block: `{template:
availability, aggregate: {exclusive: weightedSum}}` keeps the template's other four
operators. A property with no `template` must declare `direction` and `aggregate` itself.

That merge is not a convenience, it is what lets the guiding case be written at all. FMS
v1 aggregates **every** feature's exclusive with `weightedSum`, `availability` and
`reliability` included, where `docs/FEATURES.md` gives the canonical operator for those two
as the routing-weighted product -- which is what the templates follow. Version 1 written
with bare templates therefore cannot reproduce its own package, and the two overrides are
required. Worth knowing why the departure is invisible in the corpus: under `weightedSum`
those properties acquire a floor at the weight of any branch contributing the neutral,
which at the recorded values agrees with the product to six decimals and diverges only when
a branch degrades.

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

It is matched against the **candidate's own** `domain`, which takes the same three values
and defaults to `all` as well -- a candidate, or a fixed task, declares which kind of
solver it is, and a property declares which kind it is meaningful for. The two meet in
exactly one place, section 10.2, and nowhere else. Every candidate in the corpus is `all`,
which is why the pair costs no digest.

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

### 4.1 Which kind, and when a component gets no task at all

The table above says what the container does with each kind. Which kind a component
*deserves* is a separate question, and it is the one that bites: the guiding case models
the same role two ways across its versions, so the version-to-version diff reports a
change of architecture where there is only a change of notation.

Decide by **whether the component occupies a step of the workflow, and whether it has QoS
of its own**. Never by whether it is bought.

| the component | kind | why |
| --- | --- | --- |
| is the control flow, and occupies no step | no task at all | the sequence, the parallel block and the exclusive choice *are* its work |
| occupies a step you run, whose consumption you deliberately do not charge | `local` | a kind of its own; the container forbids it a requirement, so nothing is synthesized |
| occupies a step you run that consumes what you pay for | `fixed` | the only construct in the container that can carry that cost |
| occupies a step you buy, with competitors | `open` | eligibility is the market |

An orchestrator is the first row whenever its own work is coordination. FMS v1's `S1` is
the composition, and its choice between the in-house and the procured solver is the
`exclusive` node, not a step. What the language refuses is the half-way state -- declaring
the task and never placing it (`c2y_task_unreached`) -- and it refuses it because the
container accepts it in silence: a declared service task that no node invokes reaches the
IR, is forced on every engine by the binding validation, and multiplies the binding space
while contributing to no property. Adding one to the guiding case takes its cardinality
from 32 to 64 with no diagnostic at all.

Ownership is not the discriminator, and this specification already proves it: `C` in the
worked example is a solver the owner runs, with no competitor, and it is a `fixed` task
with real values. The corpus agrees. `examples/literature/cremaschi` declares its own
closing step as a `local` task, and 20 of the 83 packages the walk finds carry a task that
is not a service task.

**A local task is an assertion, not an abstention.** It is exactly a single-candidate
service task pinned to the neutral vector: on the guiding case both forms produce the same
five property values to nine decimals and the same cardinality, and differ only in the IR
digest. What that vector says out loud is "free, instantaneous, perfectly available,
perfectly reliable and *maximally secure*" -- for a `min` property over a bounded domain
the neutral is the best attainable value, not the worst. And the neutral is an identity for
the `sequence` operator only; it is contributed under every operator. In the guiding case
the local step sits in an exclusive aggregated with `weightedSum` at probability 0.8:

- `cost` reads `0.8 * 0 + 0.2 * 1200 = 240`, which is why the recorded minimum is exactly
  `220 + 500 + 300 + 240 + 950 = 2210`. Four fifths of that branch's weight is pinned at
  zero, and the choice between the two quantum providers moves 60 of a 1080 spread.
- `security` reads `0.8 * 5.0 + 0.2 * 5.0 = 5.0`, which never binds the outer `min`, so the
  recorded 4.0 is set by another task entirely. Had that branch contributed the bottom of
  its domain, the node would read 1.8, its loss would go from 0.25 to 0.8, and the score
  would move about four times the whole spread of the 32 bindings.

So `local` is right exactly where that sentence is an acceptable approximation, and `fixed`
is right as soon as anyone draws a conclusion from the branch -- comparing an in-house
solver with a procured one on latency, for instance. Choosing `fixed` does not grow the
search space: eligibility stays a singleton and the binding space is multiplied by one,
which `examples/literature/cremaschi` proves with six singleton service tasks and a
cardinality of 1. What `fixed` costs is the identity of an existing package, which is why
the next rule exists.

**An imported package keeps the kind its author wrote.** This rule is for an author writing
a composition, never for the importer. The IR carries every task's id and name, and the
phase F1 gate is digest equality, so re-deciding a kind on import would move the digest of
each of those 19 packages.

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

### 5.4 A BPMN workflow is read by delegation

The Studio parses no BPMN. The reduction of BPMN 2.0.2 to the four blocks already exists,
is validated against the five vendored OMG schemas and is exercised by the corpus, so the
Studio builds a package whose workflow is a `bpmn` reference, hands it to the compiler, and
lifts the **already reduced** workflow out of the IR. Two reducers that must agree forever
would not.

The lift is a conversion rather than a copy, because the IR's workflow is not shaped like a
source document's: it writes `{kind: sequence, steps: [...]}` where a source writes
`{sequence: [...]}`. That is the one place the Studio reads the IR's node shapes, and an
unknown node kind is refused rather than dropped -- a workflow that quietly lost a block
would compile to a different problem with no diagnostic.

**The compile is injected, not imported.** The composition library may not reach into the
toolchain: the gateway has exactly one door to BIM and a boundary test enforces that
nothing else imports the language. So the lift takes a callable that turns a package's
files into an IR document, and the caller supplies it -- a test the in-process compiler, a
route the port. That is not only hygiene: under the deployment where the gateway delegates
to a remote service, the compiler is not in this process at all, so a lift that imported it
would work on one deployment and fail on the other. It is also what keeps this layer
liftable into a distribution of its own, which the architecture test already pins.

Two things worth knowing before trusting a lifted workflow:

- **It is the flattened tree, not the author's.** The container flattens a nested sequence
  while canonicalizing, so a lifted workflow can differ structurally from the source
  document it came from while compiling to the same problem. This is the same rule that
  stops the Studio pre-flattening anything of its own (section 11).
- **A branch id survives; the rest of the diagram does not.** A reduced exclusive carries
  the BPMN sequence flow's id -- `Flow_Cache`, not `{stem}_branch_1` -- which is precisely
  why an imported composition keeps branch ids verbatim instead of deriving them.

One asymmetry to expect when comparing a BPMN package with a hand-written twin: the
routing overlay targets **the resource where the branch ids are declared**, which is the
diagram for a BPMN workflow and the application for a JSON one. The IR does not distinguish
them. `examples/demo/15_bpmn_complete` and `examples/demo/16_json_complete` differ in
exactly that way and compile to the same IR digest, which is what makes them this version's
oracle for the lift -- and they are both outside the gate of section 11.2, since they
declare a Placement resource, so the lift needs that oracle rather than the gate.

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

`provides` takes **one capability or a list of them**, and the list is ordered: it is
visible in the IR in both its order and its multiplicity, so the Studio neither sorts it
nor removes a repeat (section 11). Exactly one candidate in the whole tree uses the plural
form -- the `shared` candidate of `examples/demo/14_shared_candidates`, which offers three
capabilities at once and is also the only gate package reading
`scope: selectedCandidate`. One candidate serving three tasks is what the package's name
means, and the two features go together: the scope is what charges it once rather than
three times.

A candidate's `title` and a provider's are Studio-side. The catalog has no slot for either
-- writing a `name` under a candidate or a provider moves the IR digest and no package in
the gate carries one -- so they stay in provenance with the rest of the Studio's own data.

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
  - property: security
    normalize: {min: 1, max: 4}       # narrower than the property's domain, on purpose
```

Each goal becomes one entry of `Optimization.spec.criteria`, as
`{id, feature: {resource: "application", id}, normalize: {min, max, clamp}}`.

**The criterion's id is the property name.** The container requires an id and reads it
from the source, so it is visible in the IR and renaming it moves the digest. No
criterion in the whole corpus names anything other than the feature it reads -- 0 of 268
-- so deriving it drops a field rather than losing a capability. It is written down here
because it is the one required, digest-visible field a reader would otherwise have to
guess.

`normalize` is **always** emitted, and by default it is the property's domain. The
container refuses criteria that span more than one unit without explicit normalization
(`normalization_required`), and every criterion in the corpus carries one. `direction` is
not emitted on a criterion: it belongs to the property.

A goal may **override** that range, as the fourth goal above does, and the corpus forces
the option: a criterion's `normalize` is an independent number in the IR, and **14 of the
83 packages** scale a property onto a range that is not its domain -- sometimes narrower
(`cost` over `[0, 200]` where the domain is `[0, 100]`), sometimes a range where the
property declares no bounds at all. Widening the domain to match is not a way out: the
domain is in the IR too, so moving it to rescue the criterion moves the digest just the
same.

Seven of those 14 declare a Placement resource and are outside the gate for that reason
anyway. The other **seven are inside it**: `examples/demo/01_simple_seq`,
`03_xor_choice`, `14_shared_candidates`, the three `17`/`18`/`19` analysis demos -- the
ones the Studio exists to drive -- and one ICWS instance. Without this field the gate of
section 11.2 would be 68 of 82 rather than 75, and six of the seven are lifted by this
field alone.

`clamp` **is** exposed, and the reason is a container default that runs the other way from
the obvious reading: the schema declares `clamp` with `default: false` and the compiler
reads `normalize.get("clamp", False)`, so a criterion that omits the key does **not** clamp.
238 of the gate's 243 criteria clamp and five do not -- in `examples/demo/01_simple_seq`,
`03_xor_choice` and one ICWS instance -- so a goal that could not say `false` would miss
three of the 75 packages, while one that always said `false` would miss the other 72. It
defaults to `true` here, because that is what a goal written from scratch wants. There is no
need to express the key's *absence*: the IR always carries an explicit boolean, and an
omitted key and an explicit `false` compile to the same IR digest.

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

Unless the author declares one, the neutral is **computed from the sequence operator and
the domain**, and from nothing else:

| `aggregate.sequence` | neutral |
| --- | --- |
| `sum` | `0.0` |
| `product` | `1.0` |
| `min` | `1.0` for a `ratio` domain, otherwise `domain.max` |
| `max` | `0.0` for a `ratio` domain, otherwise `domain.min` |

The neutral must then lie inside the declared domain. Where the rule yields nothing — a
`min` property with no upper bound — the Studio refuses the document at authoring time
instead of emitting a package that cannot compile.

A property may instead state its `neutral` outright, and then that value is used. The
container works the same way: it reads a declared neutral before inferring anything, and
range-checks the result against the domain either way. A declared neutral is the honest way
to say what a `local` step contributes when the inferred value would make a claim the
author does not want to make (section 4.1) -- and it is the only way to say it, since no
task of either kind may carry property values of its own.

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
as a resource. The file holds `{"substitutions": [...]}` -- a list, because one package can
substitute many values and a file holding a single record cannot grow -- and each record
is shaped like this:

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
- **Lists keep author order verbatim**: criteria, penalties, routing entries, a
  candidate's `provides`, and every `sequence`, `parallel` and `exclusive` list. Two of
  those are easy to think of as sets and are not. A candidate's `provides` is visible in
  the IR in its order *and* its multiplicity, so it is never sorted and never deduplicated.
  And a `parallel` block's children are ordered in the digest even though the block's
  meaning is not: 27 of the 29 gate packages that contain one hold children that are not in
  id order.
- **Nested sequences are not pre-flattened.** The container canonicalizes them; doing it
  twice, differently, is how an import and an emit stop agreeing.
- **Resource ids are normative**, because they appear in the IR: `application`,
  `catalog`, `routing`, `constraints`, `optimization`. Naming the catalog anything else
  produces a semantically identical package with a different digest and no hint why.

### 11.1 The golden set the next phase is measured against

Phase F1 must reproduce an existing package exactly, and the repository holds more than
one answer to "exactly". Decided in review: the **live normalized golden**,
`bim-toolchain/golden/bim_normalized/corpus.json`.

Three facts make that choice cheap rather than brave:

- **The pipeline already compares against it.** The gateway keeps a byte copy in a
  directory named `bim_baseline`, and those bytes are the normalized corpus, not the
  frozen one: `test_bim_baseline.py` asserts the two files are byte-identical, the
  informative members included. Naming the live golden therefore changes no test and no
  job -- it writes down what the pipeline already enforces.
- **The newest frozen set could not gate a package anyway.**
  `golden/bim_baseline_1_1_1` records engine-mode compatibility per package, the one
  recorded move of an Engine and the protocol digests. It carries no corpus document and
  no semantic digest at all, so it never held the thing a compiler would be compared
  with. The three-way choice was a two-way one.
- **"Live" is not "a moving target."** Only the informative `toolchain` members
  (`compilerDigest`, `irDigest`) are ever refreshed, by
  `bim-toolchain/tools/regen_normalized_metadata.py`, which refuses to write unless the
  semantic digests, the section digests, the evaluations, the binding spaces and
  `zip_equivalence.json` are the recorded ones, and then verifies that every changed line
  holds one of those two members. The baseline comparison strips them before comparing.
  What a compiler has to reproduce is exactly the part that cannot be rebaked.

The frozen baselines keep their own job, and it is not this one: `golden/bim_baseline` and
`golden/ir_previous` record the previous IR and are never recomputed, which is what makes
them evidence of what moved between toolchain versions. Normalization moved the semantic
digest of 64 of the 82 packages -- a figure a test pins -- so implementing against a
frozen baseline is the mistake that looks like a compiler bug and never goes green.

### 11.2 Which packages the round trip must reproduce

"The demo examples" is not a set, and the phase F1 gate cannot be phrased over it.
Decided in review: the gate is **the live normalized golden's own package set, minus the
packages that declare a Placement resource** -- 75 of its 82. For every key `d` of
`packages` in `bim-toolchain/golden/bim_normalized/corpus.json` that declares no
Placement resource,

```
ir_digest(compile(emit(import_bim(d)))) == ir_digest(compile(d))
```

The seven exclusions are named, and they share one reason -- a Placement resource, whose
price section 13 already carries: `examples/demo/15_bpmn_complete` (which is also the only
BPMN workflow anywhere near the gate), `examples/demo/16_json_complete`, the four packages
under `examples/placement/`, and `engines/minizinc-csp/tests/fixtures/placement`. Nothing
else in the tree declares one, and no package outside that seven needs anything this
version cannot say.

Four things make this the gate rather than a number:

- **Membership is the golden file, not the walk.** The walk is a filesystem scan: its
  membership is whatever is on disk. The golden's `packages` map is 82 checked-in keys
  with a `packageCount` beside them, and the regeneration tool refuses to rewrite it
  unless everything semantic is unchanged. Section 11.1 already named that file as F1's
  target, so this adds no second one. The walk keeps its job -- finding packages -- and a
  package added to the tree surfaces as a walk-versus-golden mismatch that somebody has
  to resolve by putting it in the gate or in the exclusion list. The count is already
  pinned in fourteen places across three jobs -- four at 83, which is the walk, and ten at
  82, which is this golden; a gate phrased this way collides with none of them and
  inherits every one of their tripwires.
- **The arithmetic is auditable.** `len(gate) + len(exclusions) == packageCount == 82`,
  with the seven names pinned beside it. A gate whose size nobody can recompute is a
  claim, not a gate.
- **The 83rd walk member is out of scope.** `bim-toolchain/packages/bim-core/tests/fixtures/example-package`
  is the one package the walk finds and the golden does not hold, and it is also the only
  package in the tree whose constraint uses a form outside comparison and `and`. It is the
  compiler's own fixture; it is not a composition and it is not a target.
- **The gate is `ir_digest` equality, so it says nothing about bytes.** Four container
  defaults are therefore not blockers and must not be counted as such: a package's
  `metadata.annotations` -- 78 of the 83 carry them, and the compiler never copies them
  into the IR at all -- a feature with no declared `direction` (3 packages), a domain with
  an open end (6), and a feature with no `unit`, which the container defaults to `1` (1
  package, one ICWS instance). Each of those is a field the emitter may write explicitly
  and a reader may mistake for a blocker; counting the unit one as a blocker is what turns
  75 into 74 and puts an eighth package in a list whose whole argument is that its members
  share a reason. A byte-for-byte gate would be a different and much larger promise, and
  it would need the opaque annotation passthrough section 9 already asks for.

**This gate is what made two fields necessary**, and that is the honest reason to record
it rather than a round number. Measured against section 12 as it was first written the gate
would have been **68** of 82, not 75. Seven packages inside it scale a criterion onto a
range that is not the property's domain -- a limit no section mentioned -- and one of those
seven also reads `scope`, which the model has typed all along. An explicit goal `normalize`
(section 8) lifts six of them, and writing `scope` (section 3.1) lifts the seventh: one
field each, 68 to 74 to 75. Discovering that from a gate is the point of writing the gate
down before the phase that has to pass it.

What this section does **not** claim: that any package has round-tripped. Neither
`import_bim` nor `emit` exists yet -- phase F0 ships the model and this specification. Each
verdict above is a feasibility verdict, measured per limit against the compiled IR: *this
language can hold everything in this package that `ir_digest` looks at*. Phase F1 turns
them into executed round trips, and a package that then fails is either a compiler bug or a
limit this section missed.

## 12. What this version deliberately cannot say

Each omission is a reviewable decision, not a gap. Three of them are forced by the only
exact engine, whose `exact-weighted` mode accepts a closed list of workflow node kinds
that excludes conditional choice, and a closed list of expression forms limited to
literals, property and task paths, comparison and `and`.

| Not expressible | Why | Cost |
| --- | --- | --- |
| Branch conditions (`when`) | the exact engine rejects conditional choice | none: a branch carries a human-readable `condition` instead, and the distribution carries the semantics |
| Interval property values | every bundled engine mode accepts scalars only | authors must pick a value |
| Rules beyond comparison and `and` | the exact engine's expression list | no arithmetic, no disjunction and no CEL macro in rules; one package in the tree, the compiler's own fixture, and it is outside the gate |
| Placement | a separate dialect with its own resource and semantics | **seven** packages do not round trip, and they are the gate's entire exclusion list (section 11.2) |
| Capability predicates | eligibility is capability matching only | no narrowing beyond the capability type |
| `extensions` at any level | needs an installed dialect with lowering | no ad-hoc fields |
| Non-identity feature bindings | a catalog slot may be named differently from the feature | property names are shared |
| Registered and artifact resource refs | the package is always self-contained | no cross-package reuse yet |
| An empty goal list | compiles, but means "score is penalty only" | at least one goal required |
| Comments and formatting | the writer re-emits from the model | a Visual-mode edit normalizes the text |

Two rows left this table in review, and both were listed by mistake rather than by
decision. `scope: selectedCandidate` was never inexpressible: the model has typed it from
the first commit and section 3.1 names `scope` among the three fields a template fills, so
the row contradicted both the code and section 3. And a criterion range that is not the
property's domain was missing from the table altogether while being the most expensive
limit in the corpus -- section 8 now carries the field that lifts it. A table of
deliberate omissions is only useful if everything in it is deliberate and everything
deliberate is in it; section 11.2 is what caught both.

The last row is worth stating plainly because it will be felt in phase F3: this version
projects the model back to text, so comments, key order and blank lines are lost on a
round trip through the Visual editor. Lossless editing needs a concrete syntax tree and
belongs with the editor, not with the compiler.

## 13. The dialect question, and its price

The approved decision was that Composition2Yaml should use "the same adapter mechanism
BPMN already uses". That cannot be taken literally, and the reason is in the compiler:

- The generic dialect lowering writes its output **only** under
  `spec.extensions/<dialect id>/resources/<resource id>` or, for an inline extension,
  under `.../inline/<resource>:<pointer>`. It cannot **emit** an application workflow.
  It is not insulated from one either: an installed dialect's lowered payload is
  addressable from inside the workflow, because a branch condition may read
  `extensions/<dialect id>/...` as a declared path, and a lowerer that stops writing a key
  such a condition reads turns the package into a compile error. This version emits no
  branch conditions, so it never exercises that coupling -- but the coupling exists and
  the earlier wording denied it.
- The generic dialect installation function explicitly refuses the XML case that BPMN
  occupies, and the dialect schema makes the refusal total: any XML media type is required
  to carry an `xmlRoot`, and an `xmlRoot` is exactly what that function rejects.
- BPMN's real lowering is a hardwired `bpmn` discriminator in the application schema plus
  a dedicated lowering function, reached through a literal tuple of discriminator keys.
  Its named adapter is never resolved through any registry: it is consumed by three string
  comparisons and never by the lowerer table that installation writes to.

So BPMN is not an instance of a reusable mechanism; it is a built-in with a manifest
beside it. That diagnosis was right. The prescription that followed from it was wrong.

**Settled in review: Composition2Yaml ships as a real, installed Dialect** --
`composition2yaml/v1`, JSON only, declaring **no resource type** and one inline extension
point on the Application. And **the notation marker it makes room for is written only when
the composition has no existing package to reproduce.** Those are two decisions because
they have two different prices, which the earlier text bundled into one.

Installing the dialect is **free**. Measured: with `composition2yaml/v1` installed, an
untouched corpus package recompiles to the identical `irDigest` *and* the identical
`compilationDigest`, and `spec.dialects` does not even name it -- only the contracts a
package actually uses appear there. Nothing on disk moves, no schema is touched, no module
enters `bim_core`, and the dialect listing gains an entry.

Writing the marker is **not** free, and this is the constraint that decides when to write
it. `ir_digest` strips `metadata`, `spec.instance`, `spec.dialects` and `spec.sourceMap` --
and keeps `spec.extensions`. So a package carrying the marker has a different IR digest
from the same package without it: measured on one corpus package, `sha256-60bcb31e…` became
`sha256-bf35b407…`, with the `application` section digest unchanged. Since the phase F1
gate is IR-digest equality with an existing package (section 11.2), a composition written
to reproduce one is compiled **without** the marker, and a composition with no package
behind it is compiled with it. That is a rule of the language, not a flag in an
implementation.

Three consequences to design around, each measured, none of them a reason to choose
otherwise:

- **The install belongs wherever `bim_core` runs, not in the gateway process.** Under the
  supported deployment where the gateway delegates to a remote service, a gateway-side
  install is invisible to the dialect listing and absent where packages are actually
  compiled -- and the startup check compares only the compiler digest, which installing a
  dialect does not move, so the mismatch would pass silently and surface later as a
  compile failure on composition-sourced packages alone. At least two install sites, in two
  deployable packages.
- **One existing test fails under a process-wide install**, structurally rather than
  incidentally: a host-installed dialect never passes through the built-in release
  labelling, so its manifest version does not track the compiler bundle digest, and the
  test that asserts every installed dialect's version moves with that digest no longer
  holds for all of them. It is the test that needs the exception, and it should say why.
- **Four `protocol.json` goldens record the installed dialect set** and go stale in their
  informative `toolchain` members. Nothing fails -- the baseline comparison drops every
  `toolchain` field before comparing -- but "costs no golden" means "fails no golden", and
  the difference is worth writing down rather than discovering.

**The virtual dialect was rejected because it buys nothing.** A descriptor that is never
installed has nowhere to be recorded: the IR's `spec` is closed over twelve fixed members,
its `metadata` admits only `name` and the compiler writes only `{"name": …}`, so a
package's own annotations never reach the IR at all. And a never-installed id placed in
`spec.dialects` anyway makes the stored IR unrehydratable -- verification requires every
member of `spec.dialects` to be an installed contract, and rejects the document otherwise.
So "recorded in provenance but never installed" could only ever mean "recorded outside the
IR", which is the loss it was offered as a remedy for. It paid zero and bought zero, where
zero also buys the installed dialect.

**What the faithful reading would cost**, corrected in the same review, because two links
of the old chain were wrong. A discriminator in the application schema gives a new schema
digest, hence new built-in manifest versions -- but **not** a moved profile *id*: the id is
`name/vMAJOR` and is invariant inside major version 1. What moves is the profile's version,
its digest and its adapter version, and through them every **live** golden IR digest: 170
of the 252 in the tree, the other 82 being the frozen baselines that are deliberately never
recomputed. No semantic digest moves at all. Nor is the rebake "incompatible with passing
the existing pipeline": the repository ships a guarded tool whose only purpose is that
rebake, which refuses to write unless every semantic digest, section digest, evaluation and
binding space is already identical, and the receipt of its last run is itself a golden --
165 changed lines, none of them about anything but the toolchain.

The real reasons to decline the discriminator are the rest of the chain, which the
rebake does not touch: a schema edit duplicated byte-for-byte in two parity-tested trees,
the instance path pattern widened in both, the package layer learning a YAML parse and a
canonical byte form, the resource index learning a suffix, the repository guard gaining a
media type and a role entry -- and a new module inside `bim_core`, which by itself breaks
the test that pins that package's module set and moves the bundle digest, forcing the
rebake whatever is decided about dialects. That is why the composition library lives in
the gateway. It is still a major, golden-rebaking change, and this section prices it rather
than pretending it is unnecessary.

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
    optimization: [R, C, Q]       # R is the composition itself, not a task
    execution: [M]
```

`R` is deliberately not a task. What the orchestrator does -- gather, choose, validate --
is the workflow, so by section 4.1 it is the composition itself. The `studio` layer still
names it: that block is inert and is never checked against the task set, which is how the
architecture view keeps a name for the component that *is* the composition. Declaring `R`
as a task and leaving it out of the workflow is the one state the language refuses, with
`c2y_task_unreached`.

## 16. What review settled

Every question this document opened has been answered, and each answer lives in the
section it governs rather than in a list at the end:

| question | answer | where |
| --- | --- | --- |
| Which golden set the phase F1 gate means | the live normalized one | 11.1 |
| Which packages the round trip must reproduce | that golden's 82, minus the 7 with a Placement resource | 11.2 |
| How an orchestrator is modelled | it is the composition itself, and gets no task | 4.1 |
| Which kind a component earns | by whether it occupies a step and has QoS of its own | 4.1 |
| Where the probabilities of an exclusive live | inline on the branch, with the routing overlay as the emitted form | 5.2, 5.3 |
| The dialect: virtual, real, or the schema discriminator | a real, installed, JSON-only dialect; the notation marker only when no package has to be reproduced | 13 |
| The four existing translators: absorb, delegate or coexist | coexist with all of them, sharing rule tables and not code | 1.1 |

Four of the seven changed the language or the measurements rather than only the prose, and
that is the argument for answering them before phase F1 rather than during it: the gate of
section 11.2 is reachable only because answering it added an explicit criterion range and
wrote down a `scope` the model had always had; section 4.1's rule removed a task from the
worked example; and section 13's answer turned out to cost nothing where the shortcut it
replaced bought nothing.

What is **not** settled is anything this document says it cannot say. Section 12 is a list
of deliberate omissions, each with its price, and the next version re-opens them one at a
time -- Placement first, since it is the whole of the gate's exclusion list.
