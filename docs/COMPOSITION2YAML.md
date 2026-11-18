# Composition2Yaml

Composition2Yaml is the document of a **final composition**: the candidate chosen for each task of a workflow,
where each candidate came from, the global values the choice yields, and optionally the BIM problem it was judged
against, the composition's own offering and the evidence of how its values were obtained.

It stands to a BIM problem as a subscription stands to a Pricing2Yaml file. A Pricing2Yaml file describes the space
a customer chooses from (plans, add-ons, limits), and a subscription is one choice in it, with the price that choice
costs. A BIM problem describes the space of alternatives (tasks, candidates, properties, constraints, objectives),
and a composition is one binding in it, with the values that binding yields. Everything about the alternatives
lives in the problem; none of it is written here.

This is the normative specification of syntax version `1.0`. Every fenced example marked ```` ```yaml c2y valid ````
or ```` ```yaml c2y invalid <code> ```` is a test fixture (`openbinding-gateway/tests/composition/test_the_spec_examples.py`):
the fence names the outcome and every code the reading reports, and the test holds the gateway to it.

Contents: [1 Identity and versioning](#1-identity-and-versioning) · [2 An example](#2-an-example) ·
[3 The document](#3-the-document) · [4 Workflow](#4-workflow) · [5 Binding](#5-binding) ·
[6 Provenance (`from`)](#6-provenance-from) · [7 Offering](#7-offering) · [8 Values and units](#8-values-and-units) ·
[9 Evidence](#9-evidence) · [10 Numbers](#10-numbers) · [11 Canonical form](#11-canonical-form) ·
[12 YAML 1.1 surprises](#12-yaml-11-surprises) · [13 Against a problem](#13-against-a-problem) ·
[14 Diagnostics](#14-diagnostics) · [15 Routes](#15-routes) · [16 What is not in the language](#16-what-is-not-in-the-language)

## 1. Identity and versioning

The language is called Composition2Yaml, with no version in its name. The problem-authoring language that used the
name before the redesign was never public and was removed in F0b ([ADR 0038](adr/0038-old-composition2yaml-removed.md)),
so nothing recognises or refuses it: a document that writes problem content (tasks, properties, candidates,
constraints) gets `c2y_problem_content`, whatever it was meant to be.

The language is versioned the way Pricing2Yaml is. Every document carries **`syntaxVersion`**, a required root key
holding a quoted `<major>.<minor>` string, checked against the versions the gateway reads:

| | |
|---|---|
| Written by this gateway | `"1.0"` (`composition.document.SYNTAX_VERSION`) |
| Read by this gateway | `"1.0"` (`composition.document.SUPPORTED_SYNTAX_VERSIONS`) |
| JSON Schema | `openbinding-gateway/src/openbinding_gateway/composition/resources/composition2yaml/1.0/composition.schema.json`, `$id` `https://openbinding.dev/schemas/composition2yaml/1.0/composition.schema.json`, served by `GET /v1/compositions/schema?syntaxVersion=1.0` (the latest supported version by default) |

- `syntaxVersion` is the version of the language, not of the document. The document's own label is `version`, a
  Semantic Versioning string, as Pricing2Yaml keeps `version` apart from `syntaxVersion`.
- Composition2Yaml belongs to OpenBinding Studio and the SCORETech ecosystem and is versioned **independently of
  BIM**: `syntaxVersion` never follows a BIM or bim-toolchain release.
- A **minor** version (`1.x`) only adds optional keys: every `1.0` document is a `1.x` document with the same meaning.
  A **major** version changes the meaning of something already there.
- A sealed version keeps the `syntaxVersion` it was sealed with (the `syntax_version` column of
  `composition_versions`), so a later reader of `1.1` still knows it holds a `1.0` document.
- Missing, `syntaxVersion` is `c2y_missing_key`. Not a quoted `<major>.<minor>` string (YAML reads an unquoted
  `1.0` as a number) is `c2y_syntax_version_type`. A well-formed version this gateway does not read is
  `c2y_syntax_version_unsupported`.

```yaml c2y invalid c2y_syntax_version_type
syntaxVersion: 1.0
composition: hello
version: 0.1.0
kind: workflow
workflow: greet
binding: {greet: {candidate: greeter}}
values: {}
```

```yaml c2y invalid c2y_syntax_version_unsupported
syntaxVersion: "2.0"
composition: hello
version: 0.1.0
kind: workflow
workflow: greet
binding: {greet: {candidate: greeter}}
values: {}
```

```yaml c2y invalid c2y_missing_key
composition: hello
version: 0.1.0
kind: workflow
workflow: greet
binding: {greet: {candidate: greeter}}
values: {}
```

**Changelog.**

| `syntaxVersion` | Date | Changes |
|---|---|---|
| `1.0` | F1 (2026-11) | First version: `composition`, `version`, `kind`, `problem`, `workflow`, `binding` (with `from`), `values`, `offering`, `evidence` |

## 2. An example

TomatoMeter, the flagship composite: a sign-in done in house, a daily e-mail summary and an export in parallel,
then a quote of the day. The e-mail candidate carries its SPHERE provenance, and the composite's own pricing is a
SPHERE pricing. Written as an author might:

```yaml c2y valid
syntaxVersion: "1.0"
composition: tomatometer
version: 1.3.0
kind: application
problem: {ref: isa/problems/tomatometer-email@3, compilation: sha256-6b1c0d6f1e9e4a8f0d2c3b4a5968778695a4b3c2d1e0f9e8d7c6b5a493827160}
workflow: {seq: [login, {and: [dailySummary, export]}, quotes]}
binding:
  login: {local: true}
  dailySummary: {candidate: email.brevo.business, from: {sphere: brevo/brevo, version: 665f1c2e9b1d4a0012ab34cd, plan: BUSINESS}}
  export: {candidate: storage.dropbox.plus}
  quotes: {candidate: quotes.zenquotes.free}
values: {cost: {value: 34.5, unit: EUR/month}, availability: 0.9985, latency: {value: 420, unit: ms}}
offering: {sphere: isa/tomatometer}
evidence: {run: 3f2b8c1e-7d4a-4e9b-9c1f-2a6d8e5b7c90, evaluatedBy: gateway, toolchain: bim-core 0.2.0}
```

The same document in canonical form, the bytes a seal stores (§11):

```yaml c2y valid canonical
syntaxVersion: '1.0'
composition: tomatometer
version: 1.3.0
kind: application
problem:
  ref: isa/problems/tomatometer-email@3
  compilation: sha256-6b1c0d6f1e9e4a8f0d2c3b4a5968778695a4b3c2d1e0f9e8d7c6b5a493827160
workflow:
  seq:
  - login
  - and:
    - dailySummary
    - export
  - quotes
binding:
  login:
    local: true
  dailySummary:
    candidate: email.brevo.business
    from:
      sphere: brevo/brevo
      version: 665f1c2e9b1d4a0012ab34cd
      plan: BUSINESS
  export:
    candidate: storage.dropbox.plus
  quotes:
    candidate: quotes.zenquotes.free
values:
  availability: 0.9985
  cost:
    value: 34.5
    unit: EUR/month
  latency:
    value: 420
    unit: ms
offering:
  sphere: isa/tomatometer
evidence:
  run: 3f2b8c1e-7d4a-4e9b-9c1f-2a6d8e5b7c90
  evaluatedBy: gateway
  toolchain: bim-core 0.2.0
```

The smallest document: one task, one candidate, no values, no problem.

```yaml c2y valid
syntaxVersion: "1.0"
composition: hello
version: 0.1.0
kind: workflow
workflow: greet
binding: {greet: {candidate: greeter}}
values: {}
```

## 3. The document

A document is one YAML mapping (JSON's data model in YAML's syntax, §12) of at most **262 144 UTF-8 bytes**
(`c2y_too_long`; the same limit applies to the canonical text written from a document). Its keys:

| Key | Required | Content |
|---|---|---|
| `syntaxVersion` | yes | the language version, a quoted `<major>.<minor>` string: `"1.0"` (§1) |
| `composition` | yes | the composition's slug: lower-case letters, digits and inner hyphens, 1 to 64 (`c2y_slug_invalid`). When the document is submitted to a composition with another slug, the composition's slug counts and the document gets the info `c2y_slug_mismatch` |
| `version` | yes | the document's label, Semantic Versioning 2.0.0, at most 64 characters (`c2y_version_not_semver`) |
| `kind` | yes | `application`, `workflow`, `pipeline` or `system` (`c2y_kind_unknown`). Metadata only: no rule depends on it |
| `problem` | no | `{ref, compilation}`: the BIM problem revision the composition was judged against, and the compilation it was judged on (§13) |
| `workflow` | yes | the high-level orchestration of the tasks (§4) |
| `binding` | yes | one entry per task of the workflow (§5) |
| `values` | yes | the global values, possibly `{}` (§8) |
| `offering` | no | the composition's own pricing, by reference only (§7) |
| `evidence` | no | how the values were obtained (§9) |

Any other root key is `c2y_unknown_key`, located at the key itself; `presentation:` (renderer hints, which live in the
renderer: §16) is one of them. A key that holds a problem's content (`tasks`, `properties`, `candidates`,
`alternatives`, `constraints`, `rules`, `objectives`, `goals`, `services`, `scenarios`, `providers`, `placement`,
`demand`, `weights`, `scalarization`) is `c2y_problem_content`: it belongs in the BIM problem (or, for weights and
scalarization, in a run preset). A required key that is absent is `c2y_missing_key` at the key's own path, underlined
at its parent; a value of the wrong JSON type is `c2y_type`.

`problem.ref` is `<organization>/problems/<problem>@<revision>`, the organization and the problem by slug or UUID,
the revision by number, UUID or digest. `problem.compilation` is a `compilation_digest` (`sha256-` and 64 hex
digits). Either malformed is `c2y_problem_ref`.

```yaml c2y invalid c2y_problem_content
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
constraints: [{max: {latency: 100}}]
```

```yaml c2y invalid c2y_unknown_key
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
presentation: {highlight: pick}
```

```yaml c2y invalid c2y_kind_unknown
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: service
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
```

```yaml c2y invalid c2y_slug_invalid
syntaxVersion: "1.0"
composition: My Shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
```

```yaml c2y invalid c2y_problem_ref
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
problem: {ref: isa/tomatometer-email@3, compilation: sha256-6b1c0d6f1e9e4a8f0d2c3b4a5968778695a4b3c2d1e0f9e8d7c6b5a493827160}
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
```

```yaml c2y invalid c2y_type
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: [{pick: {candidate: c_pick}}]
values: {}
```

## 4. Workflow

The workflow is the order in which the tasks run, at the level of detail BIM's compiled problem keeps. A node is one of:

| Form | Meaning |
|---|---|
| `<task>` | a task, by id: the container's own pattern for a map key, a letter then up to 127 letters, digits, `_`, `.` or `-` (`c2y_task_id_invalid`) |
| `null` | the empty step (the IR's `empty`): a branch that does nothing. `null` is the one spelling that cannot collide with a task id |
| `{seq: [n, ...]}` | the nodes in order |
| `{and: [n, ...]}` | the nodes in parallel |
| `{xor: [b, ...]}` | exactly one of the branches. A branch is a node, or `{probability, flow}` with the branch's routing probability (a number in [0, 1]) and its node |
| `{xor: [n, ...], uniform: true}` | exactly one of the branches, all equally likely |
| `{loop: n, count: k}` | the node repeated exactly `k` times (an integer ≥ 0) |
| `{loop: n, expected: x}` | the node repeated `x` times on average (a number ≥ 0) |

- `seq`, `and` and `xor` take one or more children, as the IR schema allows (`minItems: 1`); a loop takes exactly one
  of `count` or `expected`, never both and never neither, because the toolchain distinguishes them. Anything else is
  `c2y_workflow_malformed`.
- A task may appear more than once (a task repeated in two branches is still one task with one binding entry).
- The branches of an `xor` state their probabilities **all or none**, and never beside `uniform: true`
  (`c2y_xor_probabilities`). Stated probabilities must add up to **exactly 1** (`c2y_xor_sum`), summed as the decimals
  they are written as (§10). Three equally likely branches cannot be written out (three `0.3333333333333333` add up
  to `0.9999999999999999`): write `uniform: true`.
- Branch and exclusive ids of the BIM problem never appear: workflows are compared by position.

```yaml c2y valid
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow:
  seq:
    - order
    - xor:
        - {probability: 0.7, flow: courier}
        - {probability: 0.2, flow: {seq: [pack, post]}}
        - {probability: 0.1, flow: null}
    - {loop: notify, count: 2}
binding:
  order: {candidate: c_order}
  courier: {candidate: c_courier}
  pack: {candidate: c_pack}
  post: {candidate: c_post}
  notify: {candidate: c_notify}
values: {}
```

```yaml c2y valid
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow: {seq: [pick, {xor: [express, courier, post], uniform: true}, {loop: retry, expected: 2.5}]}
binding:
  pick: {candidate: c_pick}
  express: {candidate: c_express}
  courier: {candidate: c_courier}
  post: {candidate: c_post}
  retry: {candidate: c_retry}
values: {}
```

A task that appears twice is one task with one entry:

```yaml c2y valid
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow: {xor: [{seq: [pick, courier]}, {seq: [pick, post]}]}
binding:
  pick: {candidate: c_pick}
  courier: {candidate: c_courier}
  post: {candidate: c_post}
values: {}
```

```yaml c2y invalid c2y_xor_sum
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow:
  xor:
    - {probability: 0.3333333333333333, flow: express}
    - {probability: 0.3333333333333333, flow: courier}
    - {probability: 0.3333333333333333, flow: post}
binding:
  express: {candidate: c_express}
  courier: {candidate: c_courier}
  post: {candidate: c_post}
values: {}
```

```yaml c2y invalid c2y_xor_probabilities
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow: {xor: [{probability: 0.5, flow: express}, courier]}
binding:
  express: {candidate: c_express}
  courier: {candidate: c_courier}
values: {}
```

```yaml c2y invalid c2y_xor_probabilities
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow: {xor: [{probability: 0.5, flow: express}, {probability: 0.5, flow: courier}], uniform: true}
binding:
  express: {candidate: c_express}
  courier: {candidate: c_courier}
values: {}
```

```yaml c2y invalid c2y_workflow_malformed
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow: {seq: [pick, {and: []}]}
binding: {pick: {candidate: c_pick}}
values: {}
```

```yaml c2y invalid c2y_workflow_malformed
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow: {loop: retry, count: 2, expected: 2.5}
binding: {retry: {candidate: c_retry}}
values: {}
```

```yaml c2y invalid c2y_task_id_invalid
syntaxVersion: "1.0"
composition: delivery
version: 1.0.0
kind: workflow
workflow: {seq: [pick, 2nd-step]}
binding:
  pick: {candidate: c_pick}
  2nd-step: {candidate: c_two}
values: {}
```

## 5. Binding

`binding` maps every task of the workflow to exactly one entry, and names no other task:

- `{candidate: <ref>}` binds the task to a candidate of the problem. `<ref>` is the candidate's id, or
  `<resource>/<id>` when two catalogs of the problem give the task the same id (`c2y_candidate_ref_invalid` for
  anything else). A candidate may carry a provenance, `from` (§6).
- `{local: true}` says the task is done in house: it is bound to no candidate. BIM's binding holds exactly the
  service tasks of a problem, so a local task never reaches the toolchain; writing it keeps "a task without an entry
  is an error" decidable without a problem, and with one the flag is checked against the task's kind.

A task of the workflow with no entry is `c2y_task_unbound`; an entry for a task the workflow does not have is
`c2y_binding_unknown_task`. An entry that is not exactly one of `candidate` or `local: true` (`local: false`
included), or a `from` beside `local: true`, is `c2y_binding_entry`. An entry that lists alternatives
(`candidates`, `alternatives`) is `c2y_problem_content`.

```yaml c2y valid
syntaxVersion: "1.0"
composition: catalog-ref
version: 1.0.0
kind: application
workflow: {and: [login, store, index]}
binding:
  login: {local: true}
  store: {candidate: storage/blob}
  index: {candidate: search}
values: {}
```

```yaml c2y invalid c2y_task_unbound
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: {seq: [pick, ship]}
binding: {pick: {candidate: c_pick}}
values: {}
```

```yaml c2y invalid c2y_binding_unknown_task
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding:
  pick: {candidate: c_pick}
  ship: {candidate: c_ship}
values: {}
```

```yaml c2y invalid c2y_binding_entry
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {local: true, from: {sphere: acme/picking, version: v7, plan: Pro}}}
values: {}
```

```yaml c2y invalid c2y_binding_entry
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick, local: false}}
values: {}
```

```yaml c2y invalid c2y_candidate_ref_invalid
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: catalog/picker/eu}}
values: {}
```

## 6. Provenance (`from`)

`binding.<task>.from` says where a candidate came from: a plan of a SPHERE pricing, at a pinned version.

```yaml
from: {sphere: <owner/name>, registry: <alias>, version: <versionId>, plan: <plan>, addons: [<add-on>, ...]}
```

- It is **SPHERE only**. `sphere` is the pricing, `owner/name`. `version` is the SPHERE pricing version id the
  candidate was chosen against, and it is **mandatory**: without it, a later version of the pricing could not be
  detected (`c2y_from_version_missing`). `plan` is the plan's name. `sphere` and `plan` are required too
  (`c2y_from_incomplete`).
- `registry` is optional and names an on-premise SPHERE by the alias the deployment defines in `SPHERE_REGISTRIES`
  (its URL and credentials live there, never in a document). An alias the deployment does not define is an
  **error** in `from` (`c2y_from_registry_unknown`): a pin that cannot be watched is no pin. Without `registry`,
  the pricing is in the deployment's SPHERE.
- `addons` lists the add-ons of the subscription, each once.
- There is **no `contentHash`**: SPHERE version ids are immutable, and a content hash is an internal detail of the
  snapshots F3 keeps (`c2y_unknown_key`).
- Any field that is not well formed (an `owner/name`, an alias, a version id, a plan or add-on name of 1 to 128
  characters with no control character), or an add-on listed twice, is `c2y_from_shape`.
- **Derive writes it.** A composition derived from a problem a SPHERE import generated gets the `from` of every
  candidate the import generated, from the revision's value origins: the family's `owner/name` when it was read,
  the version id, the plan and add-ons as the pricing names them. A candidate written by hand gets none.
- **Coherence with the problem.** Wherever a document is assessed against its problem (check, seal, derive, fork,
  re-evaluation, stored versions included), a `from` on a candidate the import generated must say what the
  revision recorded: `owner/name`, registry, version, plan and the add-ons as a set (`c2y_provenance_mismatch`, an
  error at the first field that differs). An entry **without** `from` on such a candidate is valid, with the
  warning `c2y_provenance_missing`: the version then pins no upstream version of its own (it can still be watched
  through the revision's value origins). On a candidate no import generated, a hand-written `from` is not checked.

```yaml c2y valid registries=lab
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: {seq: [pick, ship]}
binding:
  pick: {candidate: c_pick, from: {sphere: acme/picking, registry: lab, version: "2024-05:r3", plan: Pro, addons: [Priority support, SSO]}}
  ship: {candidate: c_ship, from: {sphere: acme/shipping, version: v7, plan: Basic}}
values: {}
```

```yaml c2y invalid c2y_from_registry_unknown
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick, from: {sphere: acme/picking, registry: lab, version: v7, plan: Pro}}}
values: {}
```

```yaml c2y invalid c2y_from_version_missing
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick, from: {sphere: acme/picking, plan: Pro}}}
values: {}
```

```yaml c2y invalid c2y_unknown_key
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick, from: {sphere: acme/picking, version: v7, plan: Pro, contentHash: sha256-0f}}}
values: {}
```

```yaml c2y invalid c2y_from_shape
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick, from: {sphere: acme/picking, version: v7, plan: Pro, addons: [SSO, SSO]}}}
values: {}
```

## 7. Offering

`offering` is **optional**. It names the composition's own pricing, the one F4's margins per plan come from (plan
revenue minus upstream cost). It is a **reference only**: the plans, prices and limits live outside the document, in
SPHERE or in a Pricing2Yaml file. A composition without an offering is complete and valid, and gets no diagnostic for
it; a derivation never adds one unless the request gives it.

It has **exactly one source**:

| Form | Source |
|---|---|
| `{sphere: <owner/name>}` | a pricing of the deployment's SPHERE (recommended) |
| `{sphere: <owner/name>, registry: <alias>}` | a pricing of an on-premise SPHERE the deployment defines in `SPHERE_REGISTRIES` |
| `{url: https://…}` | a public Pricing2Yaml file over HTTPS, with no credentials |

It has **no version**. A new version of the offering does not need a new composition version: the document, its
bytes and the feed's ETag stay the same. Changing *which* offering is referenced is a change of the document.

**Errors** (only when `offering` is present):

- no source or more than one (`offering: {}`, a `registry` alone, `sphere` and `url` together): `c2y_offering_sources`;
- a wrong shape: a key the offering does not have, among them its content (`plans`, `addOns`, `price`, `version`,
  …), a `sphere` that is not `owner/name`, a `registry` beside `url`, a malformed URL or one longer than 2048
  characters, one with credentials or no host: `c2y_offering_shape`;
- a `url` that is not an absolute `https://` URL: `c2y_offering_url_not_https`.

**Warnings** (the composition stays valid and sealable; it only has no margins): a `registry` the deployment does not
define (`c2y_offering_registry_unknown`, from the language, and then nothing is read), an offering that cannot be read
(`c2y_offering_unreadable`, with the reason in words: not found or not visible, ambiguous, a redirect or an address it
may not follow, too large, too slow) or whose content is not a valid Pricing2Yaml 3.x pricing
(`c2y_offering_invalid_pricing`). **The commercial part never invalidates the binding.**

**When it is read.** The offering is read when an evaluation is created: on a seal, a derivation that seals, a fork
and a re-evaluation on a new basis, never on `versions/check` (the editor's lint), `evaluate` or `neighborhood`, and
never when reading a sealed version. Sealing content that already has an evaluation on the requested basis returns
that evaluation and reads nothing: the offering version per evaluation is the one read when the evaluation was first
created. `sphere: owner/name` is resolved by organization and exact slug (never by display name; two families with
one name are "ambiguous"), and its latest version (by date) is read.

What is stored: F1 keeps the offering's source on each version (`composition_versions.offering`, for the version
view and the F6 watcher, without re-reading the YAML). From F3, every evaluation and every upstream event also
stores the offering version it used: the SPHERE version id, or for a `url` a reference to the stored copy of the file
(`pricing_snapshots`, whose sha256 is internal and never appears in the document). F3 reads the offering through its
`PricingSource` port, over HTTPS only, with no credentials, no redirects to another scheme, private and link-local
addresses blocked, 5 MiB and a time limit. A new offering version is an F6 upstream event ("offering changed"),
which recomputes margins and ends at *reviewed*: sealing never resolves it, since the document does not pin the
offering version.

```yaml c2y valid
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {url: "https://pricings.example.org/shop/pricing.yml"}
```

```yaml c2y valid c2y_offering_registry_unknown
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {sphere: acme/shop, registry: lab}
```

```yaml c2y valid registries=lab
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {sphere: acme/shop, registry: lab}
```

```yaml c2y invalid c2y_offering_sources
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {sphere: acme/shop, url: "https://pricings.example.org/shop/pricing.yml"}
```

```yaml c2y invalid c2y_offering_sources
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {}
```

```yaml c2y invalid c2y_offering_url_not_https
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {url: "http://pricings.example.org/shop/pricing.yml"}
```

```yaml c2y invalid c2y_offering_shape
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {sphere: acme/shop, version: "2026-11"}
```

```yaml c2y invalid c2y_offering_shape
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
offering: {url: "https://user:secret@pricings.example.org/shop/pricing.yml"}
```

## 8. Values and units

`values` maps property ids (the container's pattern for a map key, `c2y_property_id_invalid`) to global values:

- a bare number is **dimensionless** (unit `"1"`): an availability, a probability, a count;
- `{value, unit}` is a number with a unit, any non-empty string, exactly as BIM types a feature's unit.

A boolean is never a value, and a unit is never empty (`c2y_value_shape`). Without a problem, nothing says which
magnitude has which unit and the toolchain has no unit catalogue, so a declared document may write a bare number or
any non-empty unit. Against a problem, the problem's units decide (§13): a bare number for a property the problem
measures in a unit is `c2y_unit_missing`, another unit is `c2y_unit_mismatch`, and "compatible" means equal strings.

Values are **verified** or **declared**:

- With `problem` (verified), a seal replaces the values by the ones the toolchain computes with `BimPort.evaluate`
  on the linked problem. A declared value that differs gets the warning `c2y_value_differs`, and the computed value
  is kept; a declared value of a property the toolchain does not compute gets `c2y_value_not_computed` and is
  dropped. The toolchain computes the problem's required features, so those are the values a verified version has.
- Without `problem` (declared), the values are stored as written and marked `declared` (`evaluatedBy: declared`).
  A diff never compares declared values with verified ones (§15).

```yaml c2y valid
syntaxVersion: "1.0"
composition: numbers
version: 1.0.0
kind: system
workflow: run
binding: {run: {candidate: runner}}
values:
  availability: 0.9985
  count: 7
  latency: {value: 30.0, unit: ms}
  error: {value: 1.0e-05, unit: "1/run"}
  balance: {value: -2.5, unit: EUR}
```

```yaml c2y invalid c2y_value_shape
syntaxVersion: "1.0"
composition: numbers
version: 1.0.0
kind: system
workflow: run
binding: {run: {candidate: runner}}
values: {encrypted: true}
```

```yaml c2y invalid c2y_value_shape
syntaxVersion: "1.0"
composition: numbers
version: 1.0.0
kind: system
workflow: run
binding: {run: {candidate: runner}}
values: {latency: {value: 30, unit: ""}}
```

```yaml c2y invalid c2y_property_id_invalid
syntaxVersion: "1.0"
composition: numbers
version: 1.0.0
kind: system
workflow: run
binding: {run: {candidate: runner}}
values: {"cost per month": 4.5}
```

## 9. Evidence

`evidence` says how the values were obtained:

| Key | Meaning |
|---|---|
| `run` | the UUID of a run of the organization whose solution the binding is |
| `point` | with `run`: the solution's index in the run's result (a point of its trade-off set), an integer ≥ 0 |
| `manual` | `true`: the binding was chosen by hand, not from a run |
| `evaluatedBy` | `gateway` (the toolchain computed the values) or `declared` (the author wrote them) |
| `toolchain` | the toolchain that computed the values, `<name> <version>` |

- A run is never also `manual`, a `point` needs a `run`, a run is a UUID, `evaluatedBy` is one of the two words and
  a `toolchain` is never empty (`c2y_evidence_shape`).
- Only a composition linked to a problem can come from a run (`c2y_evidence_run_without_problem`) or have been
  evaluated by the gateway (`c2y_evidence_gateway_without_problem`).
- **A seal stamps the evidence**: a linked document gets `evaluatedBy: gateway` and the installed toolchain's
  `toolchain`, plus `manual: true` when it named no run; a declared one gets `evaluatedBy: declared`. What an author
  writes for these keys is replaced.
- With a problem, the run must be one of the organization's that solved the linked revision (or a compilation that
  reads it alike), and the binding must be its solution: the one `point` names, or any of them without a `point`
  (§13).

```yaml c2y invalid c2y_evidence_gateway_without_problem
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
evidence: {evaluatedBy: gateway, toolchain: bim-core 0.2.0}
```

```yaml c2y invalid c2y_evidence_run_without_problem
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
evidence: {run: 3f2b8c1e-7d4a-4e9b-9c1f-2a6d8e5b7c90}
```

```yaml c2y invalid c2y_evidence_shape
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
problem: {ref: isa/problems/shop@1, compilation: sha256-6b1c0d6f1e9e4a8f0d2c3b4a5968778695a4b3c2d1e0f9e8d7c6b5a493827160}
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
evidence: {run: 3f2b8c1e-7d4a-4e9b-9c1f-2a6d8e5b7c90, manual: true}
```

## 10. Numbers

- **Numbers stay the `int` or `float` YAML (or JSON) reads**, and are written back as the same double: no
  `Decimal`, no rounding, no re-formatting beyond PyYAML's float form (§11). A value is the double the toolchain
  computed, and reads back as that double: `51.650000000000006` is written as it is.
- **The document's own probabilities are summed exactly.** The branches of an `xor` must add up to 1 as the decimals
  their `repr` writes (`Decimal`, no epsilon), the way the compiler compares routing probabilities. `0.7 + 0.2 + 0.1`
  is 1; three `0.3333333333333333` are not, which is what `uniform: true` is for.
- **Values are never summed here.** Global values come only from `BimPort.evaluate`, exactly as it returns them:
  the gateway aggregates, converts and rounds nothing.
- **The warning tolerance.** `c2y_value_differs` ignores a relative difference below `1e-9`, so that representation
  noise (`51.65` written for `51.650000000000006`) gets no warning. It filters a warning and nothing else: the value
  stored is always the computed one.
- An integer past ±(2^53 − 1) loses digits in every JavaScript reader and is refused (`c2y_syntax`), as are numbers
  that are not finite (`.inf`, `.nan`) and numbers written in more than 64 characters.

```yaml c2y invalid c2y_syntax
syntaxVersion: "1.0"
composition: numbers
version: 1.0.0
kind: system
workflow: run
binding: {run: {candidate: runner}}
values: {requests: 9007199254740993}
```

## 11. Canonical form

Writing a document is canonical: two equal documents write the same bytes, and the bytes of a document read back to
it.

- Root keys in the order `syntaxVersion, composition, version, kind, problem, workflow, binding, values, offering,
  evidence`; `problem` as `{ref, compilation}`; absent optional parts omitted.
- The binding in the order a depth-first walk of the workflow first meets each task, each entry as `candidate` (and
  `from` as `sphere, registry, version, plan, addons`) or `local: true`.
- The values sorted by property id (code point), a dimensionless value as a bare number, any other as
  `{value, unit}`.
- The offering as `{sphere, registry}` or `{url}`; the evidence as `run, point, manual, evaluatedBy, toolchain`.
- Workflow nodes as above, with an `xor`'s `uniform: true` after its branches and a loop's `count` or `expected`
  after its node.
- Block style, no anchors, no folding (lines up to 4096 characters), strings quoted wherever YAML 1.1 would misread
  them (`syntaxVersion: '1.0'`, `'yes'`), and PyYAML's float form: `repr`, with `.0` before a bare exponent
  (`1e-05` is written `1.0e-05`), so every float reads back as the same double.

**Why a seal stores it.** A sealed version stores the canonical bytes of its effective document, not the text
submitted (author comments and layout are not kept; drafts belong to the editor). So a derivation is
byte-idempotent (the same binding gives the same bytes, and deriving again answers the version that has them), a
seal deduplicates by meaning (a re-formatted copy of a sealed document answers 200 with the version that has it), and
the content digest and the F4 feed's ETag change only when the composition does. `POST /v1/compositions/serialise`
writes the canonical form of any document.

## 12. YAML 1.1 surprises

A document is YAML narrowed to JSON's data model: an alias or merge key, a duplicate key, a key that is not a
string, a non-finite number, a timestamp tag and nesting deeper than 64 levels are all `c2y_syntax`, located where
the reader stopped. Otherwise scalars resolve as YAML 1.1 resolves them (PyYAML's `SafeLoader`), which surprises:

- **`version: 1.3` is a number**, not the label `1.3`. A label is semver anyway (`1.3.0` is a string), so the
  document gets `c2y_version_not_semver`; `syntaxVersion: 1.0` gets `c2y_syntax_version_type`.
- **`yes`, `no`, `on`, `off`, `true`, `false`, `y`, `n` are booleans.** As a task id in the workflow they are a
  boolean where a task goes (`c2y_workflow_malformed`); as a key they are not a string (`c2y_syntax`). Quote them.
- **`010` is 8** (an octal integer), and `1:30` is 90 (base 60). Write `10` and `"1:30"`.
- **`1e5` without a dot is a string**, not a number; write `1.0e5` (or `100000`).

```yaml c2y invalid c2y_version_not_semver
syntaxVersion: "1.0"
composition: shop
version: 1.3
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
```

```yaml c2y invalid c2y_syntax
syntaxVersion: "1.0"
composition: switch
version: 1.0.0
kind: workflow
workflow: {seq: ["on", "off"]}
binding:
  on: {candidate: c_on}
  "off": {candidate: c_off}
values: {}
```

```yaml c2y valid
syntaxVersion: "1.0"
composition: switch
version: 1.0.0
kind: workflow
workflow: {seq: ["on", "off"]}
binding:
  "on": {candidate: c_on}
  "off": {candidate: c_off}
values: {}
```

```yaml c2y invalid c2y_workflow_malformed
syntaxVersion: "1.0"
composition: consent
version: 1.0.0
kind: workflow
workflow: {seq: [ask, yes]}
binding:
  ask: {candidate: c_ask}
  "yes": {candidate: c_yes}
values: {}
```

```yaml c2y invalid c2y_type
syntaxVersion: "1.0"
composition: numbers
version: 1.0.0
kind: system
workflow: run
binding: {run: {candidate: runner}}
values: {requests: 1e5}
```

```yaml c2y invalid c2y_syntax
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: {seq: [pick, ship]}
binding:
  pick: &same {candidate: c_any}
  ship: *same
values: {}
```

```yaml c2y invalid c2y_syntax
syntaxVersion: "1.0"
composition: shop
version: 1.0.0
kind: application
workflow: pick
binding: {pick: {candidate: c_pick}}
values: {}
values: {cost: 1}
```

## 13. Against a problem

A document with `problem` is judged against that problem revision, in the organization it is submitted to, by the
toolchain installed in the gateway. The language reads the document first (§3 to §12, errors stop there); then:

1. **The link.** `problem.ref` must name a problem of the same organization (`c2y_problem_foreign`; nothing is
   looked up elsewhere) and a revision of it (`c2y_problem_not_found`). `problem.compilation` must be a stored
   compilation of that revision (`c2y_compilation_not_found`). The binding is always evaluated on the **installed**
   toolchain's compilation of the revision (compiled on a miss; `c2y_problem_not_recompilable` when the installed
   toolchain refuses the stored package), because an IR from another release cannot be evaluated. When that is
   another compilation than the one named:
   - with the same **semantic digest** (the digest of the IR's meaning, the same across releases that read the
     problem alike), the link holds and the document gets the info `c2y_compilation_superseded`, still naming its
     compilation;
   - with another semantic digest, the installed toolchain reads the problem differently:
     `c2y_compilation_semantics_changed`, derive the composition again.

   After a seal the link is the stored revision and compilation ids, so renaming the organization or the problem
   does not break a version.
2. **The document against the problem's facts**, read from the compiled IR (task kinds, workflow, eligibility,
   catalogs, feature units). The workflow must be the problem's, compared by position after both are normalised the
   way the compiler flattens sequences, with probabilities and loop details compared where the document writes them
   (`c2y_workflow_mismatch`). A candidate no catalog holds (`c2y_candidate_unknown`) or that two catalogs give the
   task (`c2y_candidate_ambiguous`: write `<resource>/<id>`) cannot be sent to the toolchain. A value of a property
   the problem does not have (`c2y_property_unknown`) or in the wrong unit (`c2y_unit_missing`,
   `c2y_unit_mismatch`) refuses the document whatever the binding.
3. **The toolchain's verdict.** Every binding that translates into BIM's `{resource, id}` goes to
   `BimPort.evaluate`, which alone decides whether it is valid: the binding holds exactly the service tasks, each
   candidate is eligible for its task and present in a catalog, and no hard constraint is violated. A refusal is
   `c2y_binding_invalid` at `binding`, carrying the toolchain's message as given, next to the located findings that
   explain it on the right line (`c2y_candidate_not_allowed`, `c2y_task_local_mismatch`), which are reported only
   then. A hard violation is `c2y_constraint_violated`; a soft one the warning `c2y_constraint_soft`, with its
   penalty; a failure to evaluate is `c2y_evaluation_failed`.
4. **The values** (§8): replaced by the computed ones, with `c2y_value_differs` and `c2y_value_not_computed`.
5. **The evidence run** (§9): a run the caller may see in the organization (`c2y_run_not_found`), that solved the
   linked revision or a compilation that reads it alike (`c2y_run_foreign_revision`), completed with a binding to
   cite (`c2y_run_point_invalid`), whose solution is the binding (`c2y_run_binding_mismatch`, listing the tasks that
   differ).

Every sealed version gets one **evaluation** at seal: a linked version one per toolchain that evaluated it (outcome
`verified`, or `binding_invalid` / `semantics_changed` when a later toolchain re-evaluates it), a declared version
one `declared` evaluation. Its diagnostics are located in the stored content.

## 14. Diagnostics

A finding is one JSON object:

```json
{"code": "c2y_from_version_missing", "message": "…", "severity": "error",
 "path": "binding.t1.from.version", "pointer": "/binding/t1/from/version",
 "span": {"line": 9, "column": 22, "end_line": 9, "end_column": 64}}
```

- `severity`: an `error` refuses the document; a `warning` or an `info` only informs. One list holds all three,
  errors first.
- `path` is the dotted path a person reads (`workflow.seq[1].and[0]`, empty for the whole document); `pointer` is the
  same path as an RFC 6901 JSON Pointer, built from the same segments, and unambiguous where the dotted path is not
  (a task id may contain a dot).
- `span` is where the element sits in the text, one-based with the end exclusive, or `null` when there is no text (a
  JSON body). A finding about something the text does not have (a missing key) is underlined at its nearest
  ancestor that it does have.
- A reading lists at most 100 findings, then `c2y_more`.

The phases: **language** findings need only the text (and, for registry aliases and the slug, the deployment and
the composition submitted to; a stored version is re-read without those two checks, so an alias leaving
`SPHERE_REGISTRIES` never makes a sealed version unreadable). **Problem** findings come from judging the document
against the facts of the linked problem's compiled IR. **Assessment** findings come from resolving the link in the
organization, the toolchain's evaluation and the evidence run.

| Code | Severity | Phase | Meaning |
|---|---|---|---|
| `c2y_too_long` | error | language | the document, or the canonical text written from it, is longer than 262 144 UTF-8 bytes |
| `c2y_syntax` | error | language | not YAML, or YAML that JSON cannot hold (§12) |
| `c2y_problem_content` | error | language | content that belongs to the BIM problem |
| `c2y_unknown_key` | error | language | a key the language does not have (`presentation:`, `contentHash` included) |
| `c2y_missing_key` | error | language | a required key is absent |
| `c2y_type` | error | language | a value of the wrong JSON type |
| `c2y_syntax_version_type` | error | language | `syntaxVersion` is not a quoted `<major>.<minor>` string |
| `c2y_syntax_version_unsupported` | error | language | `syntaxVersion` names a version this gateway does not read |
| `c2y_slug_invalid` | error | language | `composition` is not a slug |
| `c2y_version_not_semver` | error | language | `version` is not a Semantic Versioning label |
| `c2y_kind_unknown` | error | language | `kind` is not one of the four kinds |
| `c2y_problem_ref` | error | language | `problem.ref` or `problem.compilation` is malformed |
| `c2y_workflow_malformed` | error | language | a node that is not a task, `null` or one well-formed block |
| `c2y_task_id_invalid` | error | language | a task id the container would not accept |
| `c2y_property_id_invalid` | error | language | a property id the container would not accept |
| `c2y_candidate_ref_invalid` | error | language | a candidate that is neither an id nor `<resource>/<id>` |
| `c2y_task_unbound` | error | language | a task of the workflow has no binding entry |
| `c2y_binding_unknown_task` | error | language | a binding entry names a task the workflow does not have |
| `c2y_binding_entry` | error | language | an entry that is not exactly one of `candidate` or `local: true`, or a `from` beside `local: true` |
| `c2y_xor_probabilities` | error | language | some branches state a probability and some do not, or `uniform: true` beside probabilities |
| `c2y_xor_sum` | error | language | stated probabilities do not add up to exactly 1 |
| `c2y_from_version_missing` | error | language | a `from` without the version it pins |
| `c2y_from_incomplete` | error | language | a `from` without its `sphere` or `plan` |
| `c2y_from_shape` | error | language | a malformed `from` field, or an add-on listed twice |
| `c2y_from_registry_unknown` | error | language | a `from` on a registry the deployment does not define |
| `c2y_offering_sources` | error | language | an offering with no source or more than one |
| `c2y_offering_shape` | error | language | an offering that is not a well-formed reference |
| `c2y_offering_url_not_https` | error | language | an offering URL that is not an absolute `https://` URL |
| `c2y_offering_registry_unknown` | warning | language | an offering on a registry the deployment does not define |
| `c2y_offering_unreadable` | warning | assessment | the offering cannot be read when the evaluation is created; no margins |
| `c2y_offering_invalid_pricing` | warning | assessment | the offering's content is not a valid Pricing2Yaml 3.x pricing; no margins |
| `c2y_value_shape` | error | language | a value that is a boolean, or an empty unit |
| `c2y_evidence_shape` | error | language | evidence that does not hold together |
| `c2y_evidence_gateway_without_problem` | error | language | `evaluatedBy: gateway` with no problem |
| `c2y_evidence_run_without_problem` | error | language | a run with no problem |
| `c2y_slug_mismatch` | info | language | the document's slug is not the composition's it is submitted to |
| `c2y_schema` | error | language | the JSON Schema backstop refused something no specific rule names |
| `c2y_more` | info | language | more findings than a list holds; fix these first |
| `c2y_workflow_mismatch` | error | problem | the workflow is not the problem's |
| `c2y_candidate_unknown` | error | problem | no catalog of the problem holds the candidate |
| `c2y_candidate_ambiguous` | error | problem | two catalogs give the task the same id: write `<resource>/<id>` |
| `c2y_candidate_not_allowed` | error | problem | the task may not take the candidate; reported only when the toolchain refuses the binding |
| `c2y_task_local_mismatch` | error | problem | `local: true` on a service task, or a candidate on a local task; reported only when the toolchain refuses the binding |
| `c2y_property_unknown` | error | problem | a value of a property the problem does not have |
| `c2y_unit_missing` | error | problem | a bare number for a property the problem measures in a unit |
| `c2y_unit_mismatch` | error | problem | a unit that is not the problem's |
| `c2y_value_differs` | warning | problem | a declared value is not the computed one; the computed one is kept |
| `c2y_value_not_computed` | warning | problem | a declared value of a property the toolchain does not compute; dropped |
| `c2y_constraint_violated` | error | problem | the binding violates a hard constraint |
| `c2y_constraint_soft` | warning | problem | the binding misses a soft constraint, with its penalty |
| `c2y_provenance_mismatch` | error | problem | a `from` disagrees with the provenance a SPHERE-generated problem recorded for the candidate (owner/name, registry, version, plan, add-ons) |
| `c2y_provenance_missing` | warning | problem | an entry without `from` whose candidate a SPHERE import generated: the version pins no upstream version of its own |
| `c2y_problem_foreign` | error | assessment | `problem.ref` names a problem of another organization |
| `c2y_problem_not_found` | error | assessment | no such problem or revision in the organization |
| `c2y_problem_not_recompilable` | error | assessment | the installed toolchain refuses the linked revision's stored package |
| `c2y_compilation_not_found` | error | assessment | the revision has no compilation with that digest |
| `c2y_compilation_superseded` | info | assessment | another toolchain release that reads the problem alike made the named compilation |
| `c2y_compilation_semantics_changed` | error | assessment | the installed toolchain reads the revision differently: derive again |
| `c2y_binding_invalid` | error | assessment | the toolchain refused the binding; its message as given |
| `c2y_evaluation_failed` | error | assessment | the toolchain could not evaluate a binding it accepted |
| `c2y_run_not_found` | error | assessment | no run of the organization the caller may see |
| `c2y_run_foreign_revision` | error | assessment | the run solved another revision, or a compilation that reads it differently |
| `c2y_run_point_invalid` | error | assessment | the run has no binding to cite, or `point` is not one of its solutions |
| `c2y_run_binding_mismatch` | error | assessment | the binding is not the run's solution |

The HTTP codes that wrap these findings (`composition_invalid`, `evaluation_invalid`, `derivation_invalid`, …) are in
[ERRORS.md](ERRORS.md).

## 15. Routes

The stateless language services (`application/problem+json`; anyone may call them under the `read` work budget, an
API key needs `compositions:read`):

| Route | Does |
|---|---|
| `POST /v1/compositions/validate` | lint: 200 `{valid, diagnostics}` |
| `POST /v1/compositions/parse` | the document as its JSON model, or 422 `composition_invalid` |
| `POST /v1/compositions/serialise` | a JSON document written as its canonical text |
| `POST /v1/compositions/diff` | what changed between two documents |
| `GET /v1/compositions/schema` | the JSON Schema of a syntax version (open, no permission) |

The compositions of an organization (`/v1/organizations/{org}/compositions`; a composition the caller cannot read
answers `404`, exactly as a missing one; who may do what is in [ACCESS_POLICY.md](ACCESS_POLICY.md)):

| Route | Does |
|---|---|
| `GET`, `POST …/compositions`; `GET`, `PATCH`, `DELETE …/{composition}` | the composition: slug, name, description, `kind`, `archived`, `visibility` (`private` or `public`; ADMIN changes it) |
| `POST …/{composition}/versions` | **seal** a document: read in full, assessed (§13), stored as canonical bytes with one evaluation. 201 for a new version; 200 with the version that already holds the same bytes; 409 `version_label_taken` when another content holds the label |
| `POST …/{composition}/versions/check` | the same assessment, storing nothing: 200 `{valid, values_status, values, content, diagnostics}`, `content` being the exact text a seal would store |
| `GET …/{composition}/versions`, `GET …/versions/{version}`, `GET …/versions/{version}/content` | versions by id, label or ordinal and their stored bytes. A list row is light (`current_evaluation`) unless `?include=evaluations`; `?include=analytics` adds the stored counts, and `created_after`, `created_before` and `order=oldest` page them by date. `?include=document` on one version adds its document, read from the stored bytes in stored mode |
| `POST …/versions/{version}/evaluations` | re-evaluate a version with the installed toolchain (one evaluation per toolchain; 200 when it has one) |
| `GET …/{composition}/diff?from=&to=` | compare two versions |
| `POST …/{composition}/evaluate` | evaluate another binding of a version (`{version?, binding: {task: candidate}}`), storing nothing |
| `GET …/{composition}/neighborhood` | the toolchain's one-task alternatives of a version's binding (`?version`, `task`, `limit` ≤ 128) |
| `POST …/{composition}/derive` | derive a version from a binding of a problem (below) |
| `POST …/{composition}/fork` | copy a version into **another** organization as a new composition (below) |

A public composition is read by anybody through the five reads above (the composition, its versions, a version, its
content and the diff), redacted to what the documents carry, and `GET /v1/compositions` lists every organization's
public compositions ([ACCESS_POLICY.md](ACCESS_POLICY.md#public-compositions),
[ADR 0047](adr/0047-public-compositions.md)).

**Derive.** `{run, point?}` derives the solution `point` (0 by default) of a run of the organization; `{revision,
binding}` derives `{task: candidate}` of `<problem>@<revision>` (local tasks are bound `local: true` on their own).
`version` is required, since the label is part of the bytes; `kind` defaults to the composition's; `offering` is
written only when the request gives it, and no `from` is ever written. The document links the compilation the run
solved (or the installed one, for a binding) and is evaluated through the same path as a seal, so its values are the
toolchain's; a binding with a hard violation is not derivable. The evidence is `{run, point}` for a run and
`manual: true` for a binding. The same binding of the same compilation gives the **same bytes**: deriving again
answers the version that has them (200), and `seal: false` returns the draft (`content`, `document`, `values`,
`diagnostics`) without storing it. Each derived version keeps an immutable derivation edge (source, revision,
compilation, binding and its digest, run and point).

**Diff.** Both diffs answer SPHERE's PricingDiff shape, ported from SPHERE
(`frontend/src/modules/pricing/utils/pricing-diff.ts`): `general` changes (the workflow compared whole, `problem`,
`kind`, `composition`), `sections` `binding` (by task), `values` (by property, always as `{value, unit}`) and
`offering` (one entry, `source`), `totals` and `isEmpty`, plus `comparison: {comparable, problemRefChanged,
compilationChanged, valueStatus: {before, after}}`. `version` and `evidence` differ between versions by definition
and are not reported. Values are compared only between comparable sides (the same value status on the same problem
and compilation); otherwise the `values` section is empty.

**Fork.** As SPHERE forks a pricing, a fork copies a version's bytes into a new composition of another organization
(`targetOrganization`, where the caller is MEMBER) and seals them there through the same pipeline, with an immutable
`forked_from` snapshot of the source. Problems stay private to their organization, so a version that links one is
forked only with `dropProblem: true`, which removes `problem` and `evidence` and seals the copy with its values
declared; it is never done silently.

## 16. What is not in the language

- **The alternatives.** Candidates to choose from, constraints, objectives, demand and scenarios are the BIM
  problem's. A different demand is a different problem revision.
- **Optimisation settings.** Weights and scalarisation belong to a run preset (`/v1/organizations/{org}/presets`),
  and never enter a document.
- **The offering's content.** Plans, prices and limits stay in SPHERE or in the Pricing2Yaml file; the document
  holds one reference (§7), without a version.
- **Presentation.** Renderer hints (sections, order, highlights, density, labels) are not language: see Rendering
  below.
- **Identity and visibility.** Who owns a composition, who may read it and whether it is public are the platform's,
  not the document's.

**Rendering.** How a composition is shown is the renderer's, not the document's. The web renderer
(`frontend/src/modules/core/components/composition-renderer`, [ADR 0049](adr/0049-composition-renderer-core.md)) draws a version in
modes (catalog, architecture, workflow, comparison, calculator, configurator, showcase) whose sections are presets in
its code; each screen chooses which to hide and how dense to be, and a viewer's preferences (a chart's axis, the
series hidden, the columns of a matrix) stay in that viewer's browser. None of it is written in a document, so two
people who render the same bytes differently still hold the same version, and none of it is stored on the
composition either. `presentation:` is therefore `c2y_unknown_key`, like any key the language does not have. The
renderer reads a sealed version from its stored bytes (`?include=document`), shows only values the gateway
evaluated or the author declared, and draws upstream plans from their `from` reference until OpenBinding reads
SPHERE's pricings (F3).

The library is `openbinding-gateway/src/openbinding_gateway/composition/` (`syntax`, `spans`, `diagnostics`, `ids`,
`workflow`, `document`, `text`, `checks`, `problem`, `derive`, `diff`), pure by contract (`composition-library-pure`):
it imports neither the web layer, the database nor the toolchain, and facts about a problem reach it as plain data
read from the stored IR. The decisions behind it are ADRs [0041](adr/0041-composition2yaml-final-composition.md) to
[0046](adr/0046-compositions-module.md); how compositions are published, projected and rendered on the web, ADRs
[0047](adr/0047-public-compositions.md) to [0050](adr/0050-frontend-layers-and-sphere-reuse.md).
