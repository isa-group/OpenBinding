# The engine manifest

Every engine OpenBinding knows about — the four in this repository and any
registered later — describes itself in one document. This is the reference for
that document: what each field means, whether you have to write it, and how to
choose a value.

You should rarely write one from scratch. For an in-tree engine there is a
scaffolding command; for a federated one the gateway reads your OpenAPI
document and proposes the whole manifest. Both are described under
[Initializing a manifest](#initializing-a-manifest).

## Where a manifest lives

| Kind of engine | Where its manifest is | `transport` |
| --- | --- | --- |
| **In-tree** — ships with the gateway | `schemas/manifests/<engine-id>.manifest.json` | absent |
| **Federated** — somebody else's running solver | a row in `federated_engines`, submitted through the API | required |

The two are the same document. An in-tree engine is reached at a URL from the
environment, over the contract in `schemas/engine-contract.openapi.yaml`, so it
has no transport to describe. A federated engine has to say where it lives and
how to speak to it.

Read any engine's manifest with:

```bash
curl -s localhost:8000/v1/engines/random-search/manifest
```

That is also the fastest way to start a new one: fetch the manifest of the
engine closest to yours and change what differs.

## The smallest thing that works

An in-tree engine:

```json
{
  "manifest_version": "1",
  "engine_id": "my-engine",
  "display_name": "My Engine",
  "type": "HEURISTIC",
  "capabilities": {
    "composition_nodes_supported": ["TASK", "SEQ"],
    "objective_types_supported": ["MONO"]
  },
  "instance_schema": { "type": "object" }
}
```

A federated one adds a transport, and the only mapping it must supply is where
the Task → Candidate map sits in its own response:

```json
{
  "manifest_version": "1",
  "engine_id": "tabu",
  "display_name": "ACME Tabu Search",
  "type": "HEURISTIC",
  "capabilities": {
    "composition_nodes_supported": ["TASK", "SEQ"],
    "objective_types_supported": ["MONO"]
  },
  "instance_schema": { "type": "object" },
  "transport": {
    "openapi": { "url": "https://acme.example/openapi.json" },
    "operations": { "solve": { "operationId": "postOptimize" } },
    "response_mapping": { "binding": "/assignment" }
  }
}
```

---

## Top-level fields

Unknown top-level keys are **rejected**, not ignored: a typo in a field name
would otherwise be accepted silently, which is the worst of the three possible
outcomes.

### `manifest_version`

*String. Optional, defaults to `"1"`. Must be `"1"`.*

The version of this document format, not of your engine. A manifest declaring
anything else is refused by name so that a future format cannot be
misinterpreted as this one.

### `engine_id`

*String. **Required.** Pattern: `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$` — 3 to 64
characters, lower-case letters, digits and hyphens, not starting or ending with
a hyphen.*

The engine's own short name. For an in-tree engine this is the id used
everywhere: in `POST /v1/solve`, in the registry, and as the manifest's
filename.

For a **federated** engine it is qualified with the owner's username on
registration, so Alice's `tabu` becomes `alice~tabu`. Two users can therefore
both call their engine `tabu`. The separator is a tilde because it needs no
escaping in a URL path and usernames cannot contain one — which also means a
registered engine can never collide with, or shadow, a built-in id.

### `display_name`

*String. **Required.** 1 to 128 characters.*

What a person reads in the engine catalogue. Prose, not an identifier:
`"MiniZinc CSP"`, not `"minizinc_csp"`.

### `description`

*String. Optional. Up to 2000 characters.*

One or two sentences on what the engine does and when to reach for it. Shown
beside the display name.

### `type`

*Enum. **Required.** `EXACT` or `HEURISTIC`.*

**This one is not cosmetic, and it is the field most worth getting right.** The
router reports feasibility as `INFEASIBLE` rather than `UNKNOWN` when an `EXACT`
engine returns no solution — because an exhaustive search finding nothing means
there is nothing to find. A heuristic that claims `EXACT` converts "I did not
find a solution" into "no solution exists", which is a wrong answer rather than
a slow one.

Declare `EXACT` only if your engine searches the whole space (or proves
optimality). Anything sampling, evolutionary, greedy or time-boxed is
`HEURISTIC`.

### `capabilities`

*Object. **Required.*** See [Capabilities](#capabilities-1).

### `instance_schema`

*JSON Schema (Draft 2020-12). **Required.*** See [The instance schema](#the-instance-schema).

### `options_schema`

*JSON Schema (Draft 2020-12). Optional, defaults to
`{"type": "object", "additionalProperties": true}`.* See [The options schema](#the-options-schema).

### `transport`

*Object. Optional — absent means in-tree.* See [Federated engines](#federated-engines-the-transport-block).

---

## Capabilities

What the engine can handle. Published verbatim by `GET /v1/engines`, with
`type` folded in.

```json
"capabilities": {
  "qos_features_supported": ["*"],
  "composition_nodes_supported": ["TASK", "SEQ", "AND", "XOR", "LOOP"],
  "objective_types_supported": ["MONO"],
  "constraints_supported": ["attribute_bound", "dependency"],
  "schema_version": "v1"
}
```

Unlike the top level, **extra keys are allowed here** — the evolutionary engine
publishes its own `algorithms_supported`, and the engines endpoint passes
whatever it finds through untouched. Use that for anything engine-specific a
client might want to see.

| Field | Required | Default | Vocabulary |
| --- | --- | --- | --- |
| `qos_features_supported` | no | `["*"]` | free — QoS feature ids, or `"*"` for any |
| `composition_nodes_supported` | **yes**, ≥1 | — | `TASK`, `ELEMENT`, `SEQ`, `AND`, `XOR`, `LOOP` |
| `objective_types_supported` | **yes**, ≥1 | — | `MONO`, `MULTI`, `MANY` |
| `constraints_supported` | no | `[]` | `attribute_bound`, `dependency`, `resource_capacity`, `latency_transition` |
| `schema_version` | no | `"v1"` | which revision of the general schema you read |

Three rules apply to the closed vocabularies:

* **`"*"` is expanded on load**, not stored. `"composition_nodes_supported": ["*"]`
  becomes all six names, so nothing downstream has to know to expand it.
* **A value outside the vocabulary fails to parse**, with a message naming both
  what you wrote and what is allowed. This is deliberate: before manifests, a
  capability dictionary was a literal in Python that nothing compared against
  the general schema, so a typo advertised a capability that did not exist.
* **Constraint families are accepted in either case.** The general schema spells
  them `ATTRIBUTE_BOUND`; `GET /v1/engines` has always published
  `attribute_bound`. A manifest author may have read either, so both work and
  both normalise to the lower-case form the endpoint publishes.

`qos_features_supported` is an open list because feature ids belong to the
instance, not to the schema. Almost every engine should leave it as `["*"]`;
narrow it only if your engine genuinely understands a fixed set.

### Choosing what to declare

The rule, in both directions: **declare only what you enforce, and enforce what
you declare.**

* A capability you advertise but do not implement produces wrong answers marked
  feasible — the gateway will route XOR instances to you if you say `XOR`.
* A capability you implement but `instance_schema` rejects is unreachable, and
  nobody will ever notice it exists.

Both have happened in this repository, which is why stage 2 of validation exists
and why the two are checked against each other in the test suite.

---

## The instance schema

A JSON Schema restricting the [general schema](../schemas/general/schema.json)
to the instances your engine will actually solve. Stage 2 of validation checks
every incoming instance against it, which is how a caller is told "this engine
does not take many-objective instances" instead of watching a solver fail.

It must be a valid Draft 2020-12 schema — checked with the same validator class
the pipeline uses, so a manifest cannot be accepted here and then fail on every
instance later.

**Write it as a restriction, not a re-description.** You are not redefining what
an instance is; you are narrowing it. Practically that means constraining the
handful of things your engine cares about and leaving the rest alone:

```json
"instance_schema": {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openbinding.score.us.es/api/v1/schemas/my-engine",
  "title": "My Engine Instance Schema",
  "type": "object",
  "properties": {
    "objective": {
      "properties": { "type": { "const": "MONO" } }
    },
    "composition": {
      "properties": { "root": { "$ref": "#/$defs/supported_node" } }
    }
  },
  "$defs": {
    "supported_node": { "...": "TASK and SEQ only" }
  }
}
```

Two practical notes:

* **Internal `$ref`s work.** `#/$defs/supported_node` resolves against the
  instance schema itself, because the gateway hands that sub-document to the
  validator as the root. You do not have to flatten anything when moving a
  schema into a manifest.
* **Keep it aligned with `capabilities`.** They are two statements of the same
  restriction and a reader will assume they agree.

An engine that accepts anything the general schema accepts can write
`{"type": "object"}` — but then every unsupported instance reaches your solver
instead of being refused with an explanation, so it is rarely what you want.

---

## The options schema

A JSON Schema for the `options` object a caller may send alongside the instance.
`SolveRequest.options` is an open dictionary in the API contract, because what
belongs in it depends entirely on the engine; this is where the engine says.

```json
"options_schema": {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "my-engine options",
  "type": "object",
  "additionalProperties": true,
  "properties": {
    "iterations_count": {
      "type": "integer",
      "minimum": 1,
      "default": 1000,
      "description": "Minimum number of bindings to evaluate."
    },
    "time_budget_ms": {
      "type": ["integer", "null"],
      "minimum": 1,
      "default": null,
      "description": "Wall-clock budget. Unset means iterations only."
    },
    "seed": { "type": "integer", "description": "Fixed so a run can be reproduced." }
  }
}
```

This one schema answers three separate questions, which is why the conventions
around `default` matter:

| What you write | What it means | Effect |
| --- | --- | --- |
| a property with `"default": <value>` | the gateway's default | sent when the caller sends nothing; appears in `GET /v1/engines/{id}/options/defaults` |
| a property with `"default": null` | exists, and is **unset** | sent as a present key holding `null` |
| a property with no `default` | accepted, never volunteered | the engine only sees it if the caller asks |
| a property not listed at all | unknown | the caller gets a warning that it will be ignored |

The `"default": null` case is not pedantry. Several engines filter their options
on "is not None", so an unset budget has to arrive as a present key rather than
not arrive — dropping it changes what reaches the engine.

`additionalProperties: true` is the honest setting for the engines here: an
unrecognised option draws a warning, not a refusal, so the schema should not
promise a strictness nobody enforces. Set it to `false` only if your engine
really does reject unknown options.

**Bounds you declare are bounds you must live within.** The test suite validates
each engine's own defaults against its own options schema, so a `minimum` that
excludes your default is a failing build. Declare bounds that are true; do not
invent them for decoration.

The option names in this schema are also the list the gateway uses to warn about
unsupported options — there is no second list anywhere to keep in step with it.

---

## Federated engines: the `transport` block

Present only for an engine the gateway does not host. Its job is to describe the
third party's API **as it is**, rather than demanding they implement ours. Nobody
rewrites a working solver's HTTP surface to get listed, and requiring it would
mean the only federated engines are ones written for this gateway — which is the
thing federation exists to avoid.

```yaml
transport:
  openapi:
    url: https://acme.example/openapi.json     # or: document: { ...inline... }
  base_url: https://acme.example               # optional, overrides servers[]
  auth:
    type: api_key                              # none | bearer | api_key
    header: X-API-Key                          # api_key only
  operations:
    solve:  { operationId: postOptimize }      # required
    job:    { operationId: getOptimizeJob }    # asynchronous engines only
    health: { operationId: getHealth }         # optional
  request_mapping:
    instance: /problem
    options:  /params
  response_mapping:
    solutions: /results
    binding:   /assignment                     # the only required mapping
    objective: /score
```

### `transport.openapi`

*Object. **Required.** Exactly one of `url` or `document`.*

Where the engine's OpenAPI document is. `url` is fetched; `document` is the
document inline. Inline exists for two reasons: an engine behind an
authenticating gateway may not serve its own spec anonymously, and an inline
manifest is self-contained and therefore reviewable on its own.

Giving both, or neither, is refused.

### `transport.base_url`

*String. Optional.*

Overrides the `servers[]` entry of the OpenAPI document. Supply it when the
document declares no server, or declares one that is wrong for your deployment
(a `localhost` left over from development is the usual case).

### `transport.auth`

*Object. Optional, defaults to `{"type": "none"}`.*

| `type` | `header` | Meaning |
| --- | --- | --- |
| `none` | must be absent | the engine is open |
| `bearer` | must be absent | the secret goes in `Authorization: Bearer …` |
| `api_key` | **required** | the secret goes in the header you name |

Naming a header for `bearer` is refused rather than ignored, because ignoring it
would leave you believing your header is being used.

**The secret is never part of the manifest.** It is supplied separately at
registration and stored as Fernet ciphertext, and no endpoint reads it back —
it can be replaced but not retrieved. That is what lets a manifest be shown to
its owner, reviewed by an administrator, or exported, without leaking a
credential.

### `transport.operations`

*Object. **Required.*** Maps the gateway's logical operations onto yours, by
`operationId` as it appears in your OpenAPI document.

| Operation | Required | What it is |
| --- | --- | --- |
| `solve` | **yes** | submit an instance |
| `job` | no | poll a previously submitted job — declaring it is what makes the engine asynchronous |
| `health` | no | liveness. Without it the engine is simply never probed, which costs it the liveness dot in the catalogue and nothing else |

`operationId` is why the gateway's own OpenAPI document has stable, explicit
operation ids: a mapping that referred to paths would break the moment either
side reorganised its routes.

### `transport.request_mapping`

*Object. Optional.* JSON Pointers into the request body being built.

| Field | Default | Meaning |
| --- | --- | --- |
| `instance` | `/instance` | where the instance goes |
| `options` | `/options` | where the options go |

`"/problem"` puts the instance under a top-level `problem` key. The empty
pointer `""` means the body **is** the instance.

### `transport.response_mapping`

*Object. **Required.*** JSON Pointers saying where our fields sit in your
response.

| Field | Required | Default | Resolved against |
| --- | --- | --- | --- |
| `solutions` | no | `/solutions` | the response body |
| `binding` | **yes** | — | one element of that list |
| `objective` | no | — | one element of that list |
| `job_id` | no | — | the response body |
| `job_status` | no | — | see below |

`solutions` points at the list; the solution-level pointers are then resolved
**inside each element of it**. That is why `binding` is `/assignment` and not
`/results/0/assignment`. When the response body is itself the array of
solutions, write `"solutions": ""`.

**`binding` is the only required mapping, and that is the entire point of the
design.** Every metric a solution carries — `aggregated_features`, `violations`,
`feasible`, the canonical objective — is recomputed here by the reference
evaluator, for every engine, built-in ones included. So the minimum a federated
engine must return is which candidate serves which task. An engine that reports
nothing else still comes back with a complete, comparable result.

`objective` is worth supplying anyway: it is kept as the engine's own figure and
compared against the canonical one in the engine report, which is how a
disagreement between your search and the reference evaluator becomes visible
instead of silent.

### `transport.response_mapping.job_status`

*Object. Optional, asynchronous engines only.*

```yaml
job_status:
  pointer: /state
  map:
    done: completed
    error: failed
    running: running
```

`pointer` says where the status is. `map` translates your vocabulary into the
gateway's — your engine is free to call a finished job `done`, `FINISHED` or
`2`. The right-hand side must be one of `queued`, `running`, `completed`,
`failed`; anything else is refused by name. Values are lower-cased on the way
in, so `COMPLETED` is fine.

---

## JSON Pointers, briefly

Every mapping is an [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)
JSON Pointer, and malformed ones are refused at parse time with the offending
field named.

| Pointer | Points at |
| --- | --- |
| `""` | the whole document |
| `/results` | the `results` key |
| `/results/0` | its first element |
| `/a~1b` | the key `a/b` (`~1` escapes `/`) |
| `/a~0b` | the key `a~b` (`~0` escapes `~`) |

A pointer either is empty or starts with `/`. `assignment` is not a pointer;
`/assignment` is.

A pointer that does not resolve at runtime yields nothing rather than an error —
an engine may legitimately omit an optional field on some answers. The one
exception is `binding`, whose absence means there is no solution to read.

---

## What is checked, and when

**At parse time** — whenever a manifest is loaded or submitted, with no network
involved:

* every field's type, length and pattern; unknown top-level keys refused
* `manifest_version` is one this gateway reads
* capability vocabularies, with `"*"` expanded
* `instance_schema` and `options_schema` are valid Draft 2020-12 schemas
* every JSON Pointer is well-formed
* **exactly one** of `openapi.url` / `openapi.document`
* `auth.header` present for `api_key`, absent otherwise
* **asynchrony is all or nothing** — `operations.job` and
  `response_mapping.job_id` must both be present or both absent, and
  `job_status` requires `operations.job`. Half an async engine fails later, on
  somebody's real instance, with a message about a missing field; failing here
  costs one line of feedback instead
* job-status targets are among the four states the gateway has

**At registration** — for a federated engine, once the registration pipeline
lands: that each mapped `operationId` actually exists in the document, that the
mapped schemas are compatible with the pointers, that `instance_schema` is a
genuine restriction of the general schema, and a live conformance probe against
known-good micro-instances. Plus the SSRF guard on the declared host.

---

## Initializing a manifest

### For an in-tree engine

**A manifest on disk is the whole registration.** There is no settings field to
add, no dictionary to extend, and no `register()` line to write. The gateway
finds `schemas/manifests/*.manifest.json` at startup and reads
`ENGINE_<ID>_URL` for the address — so `my-engine` reads `ENGINE_MY_ENGINE_URL`.

```bash
python openbinding-gateway/tools/new_engine.py my-engine \
    --display-name "My Engine" \
    --type HEURISTIC \
    --nodes TASK SEQ XOR \
    --objectives MONO \
    --constraints attribute_bound dependency \
    --option "iterations_count:integer:1000" \
    --option "seed:integer" \
    --option "time_budget_ms:integer:null"
```

That writes `schemas/manifests/my-engine.manifest.json`, validated before it is
written — a mistyped capability is a message now rather than a missing engine
later. Add `--print` to see it without writing, and `--plugin` to get a Python
stub as well.

Then:

1. Set `ENGINE_MY_ENGINE_URL` to where the engine listens.
2. Narrow `instance_schema` from `{"type": "object"}` to the instances you
   actually accept.
3. Write a plugin **only** if your engine does not speak the contract in
   `schemas/engine-contract.openapi.yaml`, or enforces something a JSON Schema
   cannot express. Otherwise there is nothing else to do.

Check it loaded:

```bash
curl -s localhost:8000/v1/engines/my-engine/manifest
curl -s localhost:8000/v1/engines/my-engine/options/defaults
```

### For a federated engine

**Let the gateway read your spec first.** `POST /v1/engines/draft` works out
which operation solves, where the instance goes in your request body, which
field of a solution is the binding, and whether you are asynchronous — and says
what each guess was based on:

```bash
curl -s -X POST localhost:8000/v1/engines/draft \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"openapi_url": "https://acme.example/openapi.json", "engine_id": "tabu"}'
```

```jsonc
{
  "manifest": { /* ...a complete manifest... */ },
  "notes": [
    "the only POST operation is /optimize",
    "the instance goes in the request's 'problem' property",
    "'assignment' looks like the task-to-candidate map - the one mapping that is required"
  ],
  "unresolved": [
    "Capabilities are guessed narrowly on purpose. Widen them to what the engine really supports."
  ],
  "ready": true
}
```

Correct the guesses — `notes` tells you what to check, `unresolved` what the
document could not answer — then submit:

```bash
curl -s -X POST localhost:8000/v1/engines \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"manifest": {...}, "credential": "sk-live-...", "publish": false}'
```

Registration runs the checks immediately and answers with a **conformance
report**: the operations are looked up in your document, and a two-task problem
with four possible bindings is sent to your engine and read back through your
mapping. An engine that fails is still registered, with the report attached and
each finding naming the field to change — so the loop is correct-and-retry
(`POST /v1/engines/registered/{id}/verify`) rather than resubmit-and-hope.

The engine is private until you ask for it to be published and an administrator
approves. Only an engine that passes its checks can ask.

Two things to be aware of before pointing the gateway at your service:

* solving on a federated engine **sends the instance to your endpoint**, and the
  interface says so to whoever selects it;
* federated results carry `provenance.federated = true`, so that they are never
  quietly mixed into a benchmark with in-tree results.

Two things to be aware of before pointing the gateway at your service:

* solving on a federated engine **sends the instance to your endpoint**, and the
  interface says so to whoever selects it;
* federated results carry `provenance.federated = true`, so that they are never
  quietly mixed into a benchmark with in-tree results.

---

## Checklist

- [ ] `engine_id` matches the filename, and the pattern
- [ ] `type` is `EXACT` only if the search really is exhaustive
- [ ] every declared capability is enforced, and every enforced one is declared
- [ ] `instance_schema` accepts what `capabilities` claims and refuses the rest
- [ ] every option the engine reads is in `options_schema`
- [ ] every default validates against the bounds declared next to it
- [ ] *(federated)* `response_mapping.binding` verified against a real response
- [ ] *(federated)* asynchronous engines map the job operation, id and status
- [ ] *(federated)* no credential anywhere in the document
