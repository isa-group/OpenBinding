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
- **The ICSOC experiment generator: coexist, frozen.** This bullet first said absorb was
  not expensive but *impossible*, because every instance it emits carries a Placement
  resource and a `scope: selectedCandidate` rule. Both of those reasons are gone: `scope`
  was never inexpressible (section 12 records that correction) and Placement is expressible
  now (section 6.1), so an instance of this generator is a composition this language can
  write. The verdict does not change, but the reason has to: absorbing it is possible and
  still not worth doing, because what matters is its published numbers rather than its
  expressiveness. Its workflow algebra was always expressible here and it already derives
  branch ids by the same rule. The numbers are not the digests pinned beside them: those
  digests are a
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
placement: {...}                    # section 6.1, optional
rules: [...]                        # section 7
goals: [...]                        # section 8
studio: {...}                       # section 9, inert
```

`composition` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`: it becomes
`metadata.name` of every emitted document, suffixed per resource. `version` is a free
non-empty string and becomes `metadata.version`.

**A document is YAML restricted to JSON's data model.** The schema that judges it is a JSON
Schema, the package it compiles into is JSON, and the editor receives it over HTTP as JSON,
so the reader (`composition/syntax.py`) refuses what YAML can say and JSON cannot hold, each
as `c2y_syntax` at the position it was found (section 14):

- an **alias** or a merge key. An alias re-reads a node wherever it is named, so a few
  hundred bytes of nested aliases expand into millions of nodes: measured on the reader this
  replaced, a 521-byte refused document took 7.6 seconds, nearly all of it in the span
  locator walking the expansion, on routes anyone may call. A composition has nothing to
  share that a reference by id does not already say.
- a **duplicate key**, which YAML would silently keep last;
- a **key that is not a string** -- YAML 1.1 reads `on:` as `true` and `1:` as an integer;
  quoted, either is a string;
- a **number that is not finite** (`.inf`, `.nan`), which JSON cannot hold and the
  container refuses as an unreadable package;
- a value of a type JSON has no value for (`!!binary`, `!!set`, `!!omap`, `!!pairs`,
  `!!timestamp`). A plain date is not refused: it stays the string it was written as.
- **nesting deeper than 64 levels**, nearly four times the deepest composition in the
  corpus (17 levels counting every mapping, sequence and scalar); the readers recurse, and
  measured, they ran out of stack at 163 nested workflow steps, about 330 levels.
- an **integer past +-(2^53 - 1)**, which a JavaScript reader rounds and the container's
  canonical form refuses; and a **number written in more than 64 characters**, refused
  before it is converted, because YAML 1.1's base-60 integers (`1:30` is 90) convert in time
  quadratic in their length. The corpus's longest number is 18 characters, and a double
  writes in at most 24.

Scalars otherwise resolve exactly as YAML 1.1 has them, PyYAML's `SafeLoader` rules
unchanged: `yes` is `true`, `010` is 8, `1:30` is 90. Moving to YAML 1.2 would re-read
sealed sources differently, and the writer quotes every string those rules would misread --
and writes a string holding U+0085 double-quoted, the one character a sweep found that the
reader would otherwise fold into a space. The one rule dropped is YAML 1.1's `=` value key:
a plain `=` is a string. The events come from libyaml when it is installed, with the
composer and every rule above in Python: measured on the corpus's largest composition,
reading took 4.7 seconds on PyYAML's own scanner and 0.7 on libyaml's, giving the same
document; and on 20,000 values in a flow list, PyYAML's scanner took 2.4 CPU-seconds flat and
16.3 nested sixty deep, libyaml's 0.3 and 1.0. libyaml reads three corners of YAML 1.1
differently, and its reading is the one of record: a flow key with no value (`{draft:}`) and
a `%YAML 1.0` directive are refused, and a tab between tokens is accepted. Nothing in the
corpus, the test suite or this specification uses any of them.

None of these moves the corpus: the writer never produced any of them, and every package of
section 11.2 reads back through this reader unchanged.

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
shorthands `sum`, `product`, `product` and `min`, and `latency` differs from every shorthand
in its `parallel` operator. **Every one of them is emitted as the full five-key block**,
never as the shorthand string: both lower to the same IR, so the choice is digest-neutral,
and the block is the form that cannot be misread -- a shorthand expands to five operators
that a *partial* block does not reproduce. (An earlier draft of this section said the four
were emitted as the shorthand; the emitter never did.)

`GET /v1/compositions/language` serves this table, the operators each block accepts and
the defaults a property falls back to, read from `model.TEMPLATES`, `neutral.py` and
`text.PROPERTY_DEFAULTS` rather than restated (section 14.1).

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
relevant side, or declare its neutral**, because that bound *is* its neutral otherwise
(section 10). The `throughput` template therefore needs `domain.max` or a `neutral`.
Without either it is reported at authoring time with `c2y_property_neutral`, rather than
producing a package that fails to compile with `feature_neutral`. Until phase F3 this
sentence was a promise: the document was accepted and the emitter raised an exception that
named no property. It is now a completeness check (section 14) -- a bound not yet typed is
something missing, not something contradicted -- so the draft stays readable and sealing and
compiling stop at it.

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
    - {task: L}
    - {task: T}
    - exclusive:
        id: solver_choice
        branches:
          - {probability: 0.8, flow: {task: C}}
          - {probability: 0.2, flow: {task: Q}}
    - {task: L}
```

`L` appears twice on purpose, and it is one task placed twice rather than two tasks. That
is what the container calls shared candidates: both positions bind to the *same* selected
candidate, which is the right reading when one compliance service is consulted twice.
Declaring `L_filter` and `L_validate` instead would let the solver pick two different
providers for what the architecture has as one service.

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
  with no tolerance, so the Studio sums every probability as a `Decimal` and never through
  floating-point arithmetic. The `Decimal` is built the way the container builds it, from
  the shortest text of the number as read (`Decimal(str(value))`), not from the source's
  digits: `0.30000000000000001` reads as `0.3`, and a literal from-text `Decimal` would
  refuse sums the container accepts.
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
exactly that way and compile to the same IR digest.

That twin pair is what licenses **importing** a BPMN package, not only probing one. The
importer delegates the reduction and then emits a JSON workflow, so the package it writes
back is not the package it read -- the diagram is gone and the workflow is a tree. The two
compile to one IR digest, measured rather than argued, so the trip is exact at the level
the gate measures and the BPMN package is a full member of it. What is lost is what
`ir_digest` already discards: the diagram's own bytes, and with them the layout a modeller
would want back. Reproducing those needs the opaque passthrough section 9 asks for, and
until it exists a round trip through the Studio turns a BPMN package into its JSON twin.

The reduction needs a compiler, so `import_bim` takes one: without it a BPMN workflow is
refused, naming what the caller must pass. The alternative -- a composition whose workflow
is silently empty -- is the failure this whole section is arranged to prevent.

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
nor removes a repeat (section 11). **Twelve candidates in five packages** use the plural
form: the three pool candidates of each of `examples/placement/01_small_placement`,
`examples/placement/04_edge_heavy` and `engines/minizinc-csp/tests/fixtures/placement`, two
of `examples/placement/03_cloud_only`, and the `shared` candidate of
`examples/demo/14_shared_candidates`.

An earlier version of this paragraph said exactly one, and the error is worth keeping on
the page because of where it came from: the count was taken over the gate of 75 and written
about the tree of 82, and four of those five packages were the Placement ones the gate
excluded. A gate with exclusions makes every measurement taken through it quietly
conditional. That is a second reason the gate is now the whole corpus, beside the first.

`14_shared_candidates`'s `shared` is the one that is not a placement package. One candidate
serving three tasks is what the package's name means, and it also reads
`scope: selectedCandidate`, the two going together: the scope is what charges it once rather
than three times.

It is not the only package that reads the scope, and saying it was is the same conditional
measurement again. **Seven of the 82 read it**, and the other six are placement packages --
so every package in the list above reads it. The old sentence said "the only *gate* package",
which was true of a gate that excluded them.

A candidate's `title` is Studio-side. The catalog **has** a slot for it -- writing a `name`
under a candidate moves the IR digest, measured -- but no package in the corpus carries one,
so writing one would be inventing a value, and it stays in provenance with the rest of the
Studio's own data. A provider's `title` is a different case and section 6.1 has it: two
packages carry a provider name, so the emitter writes it.

Open tasks draw their rows from a pricing, from a SPHERE collection or from hand-written
rows; which source is used is phase F4 and does not change this translation.

**Property values are never reformatted.** A value is emitted with the shortest
representation that round-trips, because the corpus contains values such as
`0.9984999999999999` whose identity is part of a golden digest. No fixed-precision
formatting is ever applied to an emitted value.

Interval values (`{min, max}`) are **refused** by this version: they validate, compile
and digest, and then fail at dispatch, because every bundled engine mode declares support
for scalar feature values only.

### 6.1 Where the candidates run

A composition that places its candidates carries a `placement` block and a `placement`
member on each candidate row. Both are optional and most compositions have neither; the
seven packages in the corpus that do are what this block was measured against.

```yaml
candidates:
  providers:
    telco: {title: Telco Edge, properties: {region: eu-south}}
  rows:
    - id: c_edge
      provides: [service/ingest, service/score]
      provider: telco
      properties: {cost: 12, latency: 4}
      attributes: {description: Original fog node}     # the container's own map
      placement: {pool: edge, resources: {cpu: 0.75, memory: 1.5}}

placement:
  pools:
    - id: edge
      kind: edge
      name: Edge tier
      capacity: {cpu: 4, memory: 8}
    - id: cloud
      capacity: {cpu: 64, memory: 256}
  network:
    - {from: edge, to: edge, latency: 0}
    - {from: edge, to: cloud, latency: 25}
    - {from: cloud, to: edge, latency: 25}
  events:
    - id: client-request
      pool: edge
      latency:
        - {pool: edge, latency: 5}
        - {pool: cloud, latency: 30}
  transitions:
    - {id: client-to-ingest, from: {event: client-request}, to: ingest, max: 30}
  capacityRules:
    - {resources: [cpu, memory]}
  globalLatency: {parallel: max}
```

**Three fields are new to this section and none of them is a Placement concept.** A
provider's `title` becomes the catalog entry's `name`, a provider's `properties` is its own
free-form map, and a candidate's `attributes` is the container's `properties` map. All
three reach the IR.

An earlier draft of this paragraph said they reach it *unlike* a task's, a feature's or a
candidate's title, "which the container drops". That is false, and measured four ways: a
`name` written under a task, a feature, a candidate or a provider each moves the IR digest,
and the container's own application schema has the slot in every case. What is true is
narrower and is about this translation rather than the container. Of the corpus's 82
packages, **18 carry a task name and 2 carry a provider name; none carries a feature name
or a candidate name.** So the emitter writes a task's title and a provider's title, and
writes neither a feature's nor a candidate's -- not because they would be dropped, but
because there is no value in the corpus to write and inventing one would move every digest
that has none.

Two of these three fields were the only thing keeping `examples/demo/16_json_complete` out
of the gate, and the gate could not see them while that package was excluded for its
placement (section 11.2).

`attributes` is not called `properties` on this surface for one reason: `properties` has
meant the numeric map since section 3, and the container calls that one `features`. Writing
both as `properties` would make the same word mean a criterion's input in one place and a
description in the other.

**Three conveniences are read and not written back.** A placement document may declare a
`defaults` block merged into every demand, a `groups` block placing a named set of
candidates together, and `networkMode: symmetric` to write each edge once. The lowering
erases all three, so the model holds what they expand to -- one demand per candidate with
the defaults merged in, and both directions of every off-diagonal edge -- and re-emitting
writes the expansion. A document that used them comes back longer and compiles to the same
problem, which is what the gate measures. Re-deriving a mode or a group from an expanded
list would be a guess about the author's intent, and the guess would be wrong exactly when
an author placed two pools asymmetrically on purpose.

A transition endpoint is **a task or an event**, and the two are distinguished on the
surface: a bare id names a task, `{event: id}` names an event. A diagram's event and a
task can share a name, so a bare id for both would be ambiguous in the one case where it
matters.

**Which of these lists are ordered was measured, not assumed**, and the corpus answers only
half of it: every one of the seven packages has exactly one capacity rule and one event, so
nothing in the gate would notice either way. Section 11 enumerates the digest-visible lists
of the other resources; these are this one's.

| list | ordered | how it was measured |
| --- | --- | --- |
| `network` | **yes** | reversing it moves the IR digest of `02_stock_market_sample` |
| a `capacityRule`'s position | **yes** | a second rule added to `01_small_placement`, then the two swapped |
| the rows of an event's `latency` | **yes** | that package's three rows reversed |
| the demands | **no** | all 44 of `02_stock_market_sample` reversed, digest unmoved |

So the surface writes the network, the rules and the latency rows exactly as it read them,
and sorts the demands by candidate id. The sort is a canonicalization rather than a
liberty: it is the one of the four that the container does not look at.

Two placement forms are refused rather than approximated, and section 12 carries them: a
**soft** transition, which would need a penalty row in the Optimization keyed by a
placement reference, and a group that names a **capability** instead of its candidates,
which would mean deciding at import time what the catalog holds. No package in the corpus
writes either.

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

All 14 are inside the gate. Seven were once outside it for declaring a Placement resource,
which is why an earlier version of this paragraph counted seven: `examples/demo/01_simple_seq`,
`03_xor_choice`, `14_shared_candidates`, the three `17`/`18`/`19` analysis demos -- the ones
the Studio exists to drive -- and one ICWS instance. Without this field the gate of
section 11.2 would be 68 of 82. Seven of the 14 are lifted by this field alone; the other
seven also read `scope` and need both, and section 11.2 prints that arithmetic.

`clamp` **is** exposed, and the reason is a container default that runs the other way from
the obvious reading: the schema declares `clamp` with `default: false` and the compiler
reads `normalize.get("clamp", False)`, so a criterion that omits the key does **not** clamp.
258 of the gate's 266 criteria clamp and eight do not -- in `examples/demo/01_simple_seq`,
`03_xor_choice`, `examples/placement/01_small_placement` and one ICWS instance, and in each
of those four every criterion omits the key -- so a goal that could not say `false` would
miss four of the gate's packages, while one that always said `false` would miss the other
78. (An earlier draft said 238 of 243, five and three: that was the measurement over the
gate of 75, renumbered rather than re-taken when the gate became the corpus. The extra
package is a placement one.) It
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

The neutral must then lie inside the domain, and that check is the container's exactly:
every neutral is range-checked, inferred as well as declared, and a `ratio` is checked
against its own [0, 1] rather than any narrower bounds the author gave. A neutral outside
the domain is refused by `parse` (`c2y_property_neutral`, a property contradicting itself).
Where the rule yields nothing — a `min` property with no upper bound — the Studio reports
it at authoring time as incomplete, and refuses to seal or compile it, instead of emitting
a package that cannot compile. (Before phase F3 only a declared neutral was range-checked,
and against the author's ratio bounds: an inferred neutral outside its domain reached the
compiler, and a ratio neutral the container accepts was refused.)

A property may instead state its `neutral` outright, and then that value is used. The
container works the same way: it reads a declared neutral before inferring anything, and
range-checks the result against the domain either way. A declared neutral is the honest way
to say what a `local` step contributes when the inferred value would make a claim the
author does not want to make (section 4.1) -- and it is the only way to say it, since no
task of either kind may carry property values of its own.

Applied to the templates: `cost` 0.0, `latency` 0.0, `availability` 1.0, `reliability`
1.0, and `throughput` its `domain.max`.

The table is data in `neutral.py` (`SEQUENCE_NEUTRALS`, `RATIO_NEUTRALS`) that
`infer_neutral` reads, and `GET /v1/compositions/language` serves the same data. What a form
shows for one property is not computed in the browser: `POST /v1/compositions/parse` returns
each property's resolved neutral and whether it was declared or inferred.

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
{"task": "C", "candidate": "cand_C", "property": "qubit_count",
 "value": 0.0, "reason": "domain_mismatch",
 "candidateDomain": "classical", "propertyDomain": "quantum",
 "neutralSource": "inferred",
 "inferredFrom": {"sequence": "sum", "domain": {"kind": "integer", "minimum": 0, "maximum": 4096}}}
```

The domain in `inferredFrom` is the one the rule read, so it carries the container's keys,
`minimum` and `maximum`, not the source's `min` and `max`. (An earlier draft of this
example showed the source's keys; the record never did.) `POST /v1/compositions/compile`
returns this document beside the package it describes.

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
Decided in review: the gate is **the live normalized golden's own package set** -- all 82.
For every key `d` of `packages` in `bim-toolchain/golden/bim_normalized/corpus.json`,

```
ir_digest(compile(emit(import_bim(d)))) == ir_digest(compile(d))
```

There are no exclusions. The gate was first written with seven, said to share one reason:
a Placement resource. Closing that turned out to require four changes rather than one, and
the record of which is what makes the number worth keeping:

| What was missing | What it cost | What it lifted |
| --- | --- | --- |
| Placement itself: pools, demands, network, events, transitions, capacity rules | the model's placement types, the emitter's sixth resource document and the importer's expansion of `defaults` and `groups` | four of the seven |
| A provider's `name` and its own `properties` map | two fields | `examples/demo/16_json_complete` |
| A candidate's own `properties` map, which is **not** the numeric map this surface calls properties -- that one is the container's `features` | one field, named `attributes` on the surface so the two do not collide | `examples/placement/02_stock_market_sample` |
| Reading a BPMN workflow by delegation (section 5.4), which had been written for export only | an injected compiler on `import_bim` | `examples/demo/15_bpmn_complete` |

So the claim that the seven shared one reason was **wrong by three packages**. One of them,
`02_stock_market_sample`, was held out by a single field; `16_json_complete` needed two,
since a provider's `name` and a provider's `properties` each move its digest on their own.
All three fields are digest-visible, and none is a Placement concept: a provider's name is
an ordinary catalog value and a candidate's descriptive map is a sibling of its feature map
rather than a metadata annotation. They sat behind the Placement exclusion because an
excluded package is a package nobody measures.

That is also the second argument for a gate without exclusions, beside the first: a
measurement taken through a gate with exclusions is quietly conditional on them. Section 6
carries an instance of exactly that error, left on the page deliberately -- a count of the
tree's plural `provides` taken over the gate of 75 and written about the tree of 82, wrong
by eleven candidates and four packages, every one of them a Placement package.

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
- **The arithmetic is auditable.** `len(gate) == packageCount == 82`, and with the
  exclusion list gone there is nothing left to reconcile: the gate is the golden's own
  count. A gate whose size nobody can recompute is a claim, not a gate.
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

This section was first written before `import_bim` and `emit` existed, and said plainly
that none of its verdicts was an executed round trip. They all are now:
`tools/check_composition_roundtrip.py` runs the gate, `openbinding-gateway/tests/composition/test_the_roundtrip_gate.py`
runs the same tool rather than restating it, and both derive membership from the golden so
that a package added to the tree shows up as a membership change rather than as a number
nobody can recompute.

One feasibility verdict did not survive contact: the first draft of section 12 would have
made the gate **68**. Fourteen packages scale a criterion onto a range that is not the
property's domain, and **seven of those fourteen** also read `scope: selectedCandidate`.
The two sets nest -- every scope reader is already a range offender, measured -- so the
arithmetic is 82 - 14 = 68 with neither field, 82 - 7 = 75 with an explicit goal
`normalize` (section 8) alone, and 82 with `scope` written too (section 3.1).

Both counts grew when the exclusions closed, and the reason is the one this section keeps
returning to. From inside the gate of 75 there were seven range offenders and **one** scope
reader, which is what earlier drafts of this section and of section 8 say. The range
offenders went from 7 to 14 and the scope readers from 1 to 7, and **every one of the extras
in both sets is a Placement package** -- seven extra range offenders and six extra scope
readers, which is all seven and six of the seven placement packages respectively. The 68 is
unchanged only because 75 - 7 and 82 - 14 happen to meet.

Four fields and one delegation lifted the seven exclusions, as the table above records.
Nothing in the corpus is outside the gate now, so a package that fails it is a compiler bug
or a regression here -- there is no third answer left.

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
| A soft transition, and a placement group that names a capability instead of its candidates | a soft transition needs a penalty row in the Optimization keyed by a placement reference, and a group over a capability would mean deciding at import time what the catalog holds | both are refused by name rather than silently hardened or expanded; no package in the corpus uses either |
| Capability predicates | eligibility is capability matching only | no narrowing beyond the capability type |
| `extensions` at any level | needs an installed dialect with lowering | no ad-hoc fields |
| Non-identity feature bindings | a catalog slot may be named differently from the feature | property names are shared |
| Registered and artifact resource refs | the package is always self-contained | no cross-package reuse yet |
| An empty goal list | compiles, but means "score is penalty only" | an omitted list compiles; an explicit `goals: []` is refused by the schema (`minItems: 1`); nothing requires a goal yet |
| Comments and formatting | the writer re-emits a document, and a document holds neither | a Visual-mode edit keeps everything but them; the canonical form also normalizes the rest |

**Placement left this table.** It was the costliest row in it -- seven packages, said to be
the gate's entire exclusion list -- and section 11.2 records what closing it actually took
and what else was hiding behind it. What remains inexpressible is narrower and has its own
row in the table: a soft transition and a group over a capability, neither of which any
package in the corpus writes. A placement document's `defaults`, `groups` and
`networkMode: symmetric` are expressible but are **not** preserved as written: the lowering
erases all three, so the surface writes what they expand to -- one demand per candidate,
with both directions of every edge. A document that used them comes back longer and means
the same thing, which the gate measures and this sentence records so that nobody reads the
longer form as a change.

Two further rows left this table in review, and both were listed by mistake rather than by
decision. `scope: selectedCandidate` was never inexpressible: the model has typed it from
the first commit and section 3.1 names `scope` among the three fields a template fills, so
the row contradicted both the code and section 3. And a criterion range that is not the
property's domain was missing from the table altogether while being the most expensive
limit in the corpus -- section 8 now carries the field that lifts it. A table of
deliberate omissions is only useful if everything in it is deliberate and everything
deliberate is in it; section 11.2 is what caught both.

The last row is worth stating plainly because phase F3 is where it is felt. Writing from the
model -- the canonical form -- loses comments, key order, blank lines, templates and every
explicit default. Phase F3 narrowed that for the Visual editor: a form edits the document as
the author wrote it, and `POST /v1/compositions/serialise` writes that document back as sent,
so a round trip through the forms keeps templates, explicit defaults and key order and loses
only comments and formatting, which are not part of a document (section 14.1). Losing those
too is what remains; lossless editing needs a concrete syntax tree and belongs with the
editor, not with the compiler.

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

Every diagnostic carries a code, a message and the path of the element at fault, and the
YAML span of it whenever there is text to point into -- a document sent as JSON has none --
so the editor can underline it. Codes are prefixed `c2y_` to keep them distinct from the
container's.

**This section described something nothing produced until phase F3.** `Diagnostic`, `Span`,
`CompositionError` and the codes below shipped with F0 and no code constructed one: `parse`
raised a sentence with no position, so an editor had nothing to put a marker on. The span
now comes from composing the document a second time -- `yaml.compose` keeps the marks
`yaml.safe_load` discards -- and a span runs **from an element's key to the end of its
value**, because the name is the part the author recognises.

Two orderings decide which code a reader sees, and both were measured rather than assumed.

*The readers run before the schema.* The schema catches every shape error the readers do,
so consulting it first made the specific codes unreachable: an unknown template came back
as `c2y_schema` where `c2y_property_template` names the property and says what is wrong
with it. Three property refusals were shadowed that way.

*And the schema is the backstop, because the readers accept what it refuses.* A task
declared both `open` and `local` was read as whichever kind the reader recognised first --
the document meant something the author had not written -- and of the five shape errors
measured, it is the one the readers say nothing at all about. The schema was already the
authority on a composition's shape; it is now asked.

A schema failure reports **every** violation at once, because that is what an editor wants:
one marker per problem, not the first one. A reader refusal reports one, because a reader
stops at the element it cannot read.

| code | meaning |
| --- | --- |
| `c2y_syntax` | the text is not YAML, or is YAML a composition may not use (section 2): an alias, a duplicate key, a key that is not a string, a number that is not finite, nesting past the bound |
| `c2y_schema` | the document violates the Composition2Yaml schema, or a reader refuses its shape |
| `c2y_property_neutral` | a `min`/`max` property has no bound and no explicit neutral yet (incomplete), or its neutral, declared or inferred, lies outside its domain (error) |
| `c2y_property_template` | unknown template name |
| `c2y_task_kind` | a task is not exactly one of open, fixed or local |
| `c2y_task_unknown` | the workflow references a task that is not declared |
| `c2y_task_unreached` | a declared task appears nowhere in the workflow |
| `c2y_exclusive_id` | an exclusive carries probabilities and has no id |
| `c2y_exclusive_probabilities` | probabilities are partial, or do not sum to exactly one |
| `c2y_exclusive_distribution` | `distribution` and inline probabilities are both present |
| `c2y_repeat_count` | `count` and `expected` are both present, or neither |
| `c2y_candidate_property` | a candidate value is an interval, or outside the domain |
| `c2y_candidate_unmatched` | an open task has no eligible candidate |
| `c2y_pricing_href` | the pricing link is relative, on another origin, or has no readable version |
| `c2y_goal_unknown` | a goal references a property that is not declared |
| `c2y_goal_range` | a goal states no `normalize` range and its property's domain has an open end |
| `c2y_rule_expression` | a rule uses a form outside comparison and `and` |
| `c2y_more` | more problems were found than a refusal lists; the first hundred are listed |

Compilation is all-or-nothing, as it is in the container: a document with any error
produces no package.

**Two kinds of check, and the split was measured.** Enforcing every semantic check in
`parse` refused two documents in the suite that are *drafts* -- an open task whose market is
not written yet -- and the diff compares drafts while the editor loads one at every
keystroke. So the table divides:

- *Coherence*, refused by `parse`: one element that contradicts itself, which no document
  can say whether finished or not. `c2y_exclusive_id`, `c2y_exclusive_probabilities`,
  `c2y_exclusive_distribution`, `c2y_repeat_count`, and `c2y_property_neutral` for a
  neutral outside its own domain.
- *Completeness*, refused when a version is sealed: references across sections, an empty
  market, and a bound not yet written, which a draft is allowed to have. `c2y_task_unknown`,
  `c2y_task_unreached`, `c2y_goal_unknown`, `c2y_goal_range`, `c2y_candidate_unmatched`,
  and `c2y_property_neutral` for a property with no neutral yet. A sealed version is citable
  and has to compile, so that is where an unfinished composition stops.

`c2y_property_neutral` and `c2y_goal_range` joined in phase F3, and for one reason: the
emitter raised on both, on documents `parse` accepted and sealing would have sealed -- for the
neutral with an exception that named no property, for the range with one that named the
goal but surfaced only at emit. A sealed version was not, in fact, guaranteed to emit. Both checks call the emitter's own functions (`emit.property_neutral`,
`emit.criterion_range`), and the emitter writes every feature's neutral through the first, so
the check and the package cannot disagree -- and the neutral's range rule is the container's
(section 10.1), so neither can the package and the compiler. One code covers both sides of
the split because the container's `feature_neutral` and `feature_neutral_domain` are the same
property refused for two reasons; the severity says which.

**Completeness is necessary for compiling and not sufficient.** What the container still
refuses on its own, against a JSON pointer, by its code:

- `missing_feature`: a candidate lacks the value of a property a goal or a rule reads. No
  `c2y_` code names it yet.
- `feature_value_domain`: a candidate's value lies outside its property's domain, or is not
  whole for an `integer` one. This is what `c2y_candidate_property` describes, not raised yet.
- `feature_domain`: an `integer` property's bounds are not whole numbers, or a `ratio`'s lie
  outside [0, 1].
- `routing_missing`: an exclusive that states neither probabilities nor a distribution.
  Section 5.2 leaves that distribution unstated for a binding scenario to give (section 5.3),
  and the container refuses it -- "each XOR must be fully probabilistic, explicitly uniform,
  or fully conditional", and this version emits no condition -- until that channel exists in
  phase F5.

`POST /v1/compositions/compile` hands each back as the container wrote it.

The first eight were measured against the 82 packages of section 11.2 before being enforced,
and none refuses a package of the corpus; the measurement is a test. For the two F3 added it
licenses nothing: every gate package already emits, which is the same question, and every
goal in the gate states its range. What they can refuse is hand-written text, and no document
in the test suite or in this specification is refused by either except the ones written to
be.

**The order a reader sees them in is specific before general**, and that was measured twice.
Readers run first, then the coherence checks, then the schema as a backstop: asked earlier,
the schema's generic `c2y_schema` shadowed `c2y_property_template` for three property
refusals, and then -- the same mistake one level down -- shadowed
`c2y_exclusive_distribution`, because the schema refuses a distribution stated beside inline
probabilities too.

**`c2y_exclusive_condition` was removed rather than implemented.** This table named it for
"a branch carries both a probability and a condition", and section 5.2 says the opposite:
a condition is prose, Studio-side and never compiled, so it conflicts with nothing -- and
the guiding case carries both. Implementing the row would have refused
`fleet-management-v2`, whose `solver_choice` has 0.8/0.2 and a reason on each branch.

Still not raised: `c2y_candidate_property` and `c2y_rule_expression`, which are declared,
and `c2y_pricing_href`, which this table names and the code does not declare yet. Only the
first has a counterpart in the container, `feature_value_domain`, which `POST
/v1/compositions/compile` hands back as it is. The other two are checked nowhere yet: a
pricing link never reaches a package, so nothing sees an unversioned or foreign one, and the
container compiles a rule beyond comparison and `and` -- only the exact engine refuses it,
when it solves.

### 14.1 The language over HTTP

The editor has no YAML parser of its own, by decision: `composition/text.py` is the only
authority on the syntax, and a second parser in the browser would be a second definition of
the language. So everything the editor needs to know about a document is a documented
endpoint, under `/v1/compositions`, and every one of them reads what the request carries and
stores nothing:

| operation | answers |
| --- | --- |
| `POST /validate` | every problem, located -- the keystroke operation |
| `POST /parse` | the same, plus the document as written (what a form edits), the canonical document (what each field effectively is) and each property's resolved neutral |
| `POST /serialise` | a form's document written as source -- as sent, or canonical -- and judged as any source is |
| `POST /compile` | whether it compiles, every generated document, its digests (`package.ir_digest`, `package.compilation_digest`, `package.package_digest`) and the provenance of section 10.3 |
| `POST /package` | the `.bim.zip` itself |
| `POST /import` | a composition read back from a BIM package, and whether it compiles back to the same IR |
| `POST /diff` | the typed change list between two documents |
| `GET /language` | the template, operator, neutral and default tables of sections 3 and 10 |
| `GET /schema` | the JSON Schema `parse` consults |

**The operations that read a document answer 200 whatever it says**, with `valid`,
`complete` and the diagnostics, because the question always has an answer and one of the
two kinds of answer -- *incomplete* -- is not an error at all. A malformed request is still a
422. `/package` and `/import` answer 422 when there is nothing to hand back: a download
either has bytes or it has nothing, and an archive the container refuses or the language
cannot express has no composition to open. An import that reads as source and is then not
valid is a 200 with that source and its located diagnostics, because there is text to fix.
`/diff` answers 422 when either document is not a composition: a change list between a
composition and nothing means nothing.

**A form edits the document as written, and loses only comments.** `/parse` returns the
document twice: as the author wrote it -- templates, explicit defaults and key order kept --
and canonical, where a form reads what each field effectively is. `/serialise` writes the
written one back as sent by default, so a round trip through the forms keeps everything a
document holds and loses only what text alone has, comments and formatting; asked for the
canonical form, it normalizes. Either way the text is written out and read back by `parse`
itself, so a form cannot build a composition the text editor would refuse, and every
diagnostic comes back located in the text the response returns -- which comes back even when
the document is not valid, so the editor can always switch to its text. The request body is
read as strict JSON, as the platform reads every document it is sent: a duplicated member or
a `NaN` is refused, not kept last. (Section 12's cost of the Visual editor is therefore
smaller than it says: the canonical form pays it, the written form pays only comments.)

**Compiling goes through the platform's BIM port**, to the same compiler every uploaded
package meets. The archive it compiles is canonical -- every document in RFC 8785 form --
so the bytes `/package` returns are the archive whose `package_digest` `/compile` reports,
and the same digest is the download's `ETag`.
A refusal of the container's comes back as the container wrote it, addressed to a generated
document and a JSON pointer: nothing maps a pointer back to a line, and the Studio's own
checks exist to leave the container as little as possible.

**An import is exact up to what a solver sees, and says whether it was.** The archive is
compiled first, so the toolchain's own limits judge it before anything opens it; a BPMN
workflow is read by delegation from that same compilation; and the composition is compiled
once more and its IR digest compared with the upload's. Section 11.2 proves that equality
for the 82 packages of the corpus; the import runs the same test on the one package it was
given, when the composition it gives back is complete. What the IR does not carry --
document titles and annotations, branch conditions, a fixed task, which comes back as an
open task with one candidate, a property's `applies_to` -- it does not pretend to recover;
`composition/read.py` lists what it keeps and what it drops.

**The work is bounded by what it produces, and runs off the event loop.** A source is
bounded at 256 KiB, three times the largest composition of the corpus outside one
experiment, because measured, reading stops being linear above it; the eight ICWS
`zhang2014` instances (333 KB each) are past it and import as `composition_too_large`. A
document sent as JSON is bounded by the text it writes, the writing stopped as soon as it
passes the bound, because block YAML indents by depth and folds long strings, so a document
can write many times its JSON; and a composition is bounded by the feature values and the neutral
substitutions its package would hold, counted before anything is emitted, because those grow
with candidates times properties while the source grows with their sum. Past any of these
the answer is `composition_too_large`. A refusal lists at most a hundred diagnostics, and a
message is clipped, because a document can be wrong in as many places as it is long. The
work -- reading, writing, emitting, building the responses -- runs on a small pool of its own
threads and compiling on another, each admitting a bounded number of waiting requests and
answering `503` with `Retry-After` past it: these routes are open to anyone, and the
container's compiler runs in the gateway's own process. An editor calls `/validate` per
keystroke and `/compile`, `/package` and `/import` only on request. What these bounds do not
give is a per-client limit: one client can still keep both pools busy, and the platform has
no anonymous rate limit to put in front of them yet.

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
    - {task: L}                       # the same task again, not a second one

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
| Which packages the round trip must reproduce | all 82 of that golden; the 7 exclusions are closed | 11.2, 6.1 |
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
time.

**Placement was the first re-opened, and it is closed.** The entry above changed with it:
the gate is the whole corpus. Three things about how that went are worth keeping, because
each would otherwise have to be learnt again.

It took four changes, not one. The exclusion list had been justified on the grounds that
its seven members shared a single reason, and they did not: two were held out by one
missing field each -- a provider's `name`, a candidate's own `properties` map -- and one by
its BPMN workflow. Section 11.2 carries the table.

An exclusion hides what is behind it. Those two fields are not Placement concepts and were
not hard; they were simply inside packages nobody measured. Section 6 keeps a second
instance of the same effect: a count of the tree's plural `provides` that was taken over
the gate and written about the tree, wrong by eleven candidates.

Closing it needed no new oracle. The BPMN half was licensed by a pair the corpus already
contained -- `examples/demo/15_bpmn_complete` and `16_json_complete`, the same composition
in two notations, compiling to one IR digest (section 5.4) -- and the placement half by the
gate itself. What a measurement licenses is the only reason any of this is written down.
