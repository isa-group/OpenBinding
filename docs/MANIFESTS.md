# BIM v1 manifests

BIM uses `apiVersion: bim/v1` control resources to keep the container,
sublanguages, and execution infrastructure independently versioned. The
control kinds are `Instance`, `Profile`, `Dialect`, `Engine`, and
`EngineRegistration`. `BindingProblem` is the current Profile output IR, not a
source authoring document.

`Profile`, `Dialect`, `Engine`, and `EngineRegistration` require
`metadata.namespace`, `metadata.name`, and a SemVer `metadata.version` whose
major version is at least one. `Instance` instead needs only its portable
`metadata.name` and may carry an informative version. A public Profile or
Dialect id is derived as `name/v<major>`; there is no duplicate mutable
`spec.id`. Engine and Registration revisions retain their full
`namespace`/`name`/`version` identity.

## Instance

`Instance` is the small portable index. Its `spec.profile` selects one
installed Profile by versioned id, and `spec.resources` maps that Profile's
role names to package-wide resource ids and local or immutable registered
targets. BIM core does not prescribe application/candidate/constraint roles;
the selected Profile does.

## Profile

`Profile` defines one coherent family of binding problems and its compilation
boundary:

| Field | Contract |
| --- | --- |
| `spec.deterministic` | Whether Profile semantics are deterministic. |
| `spec.roles` | Named roles and their base resource-type cardinalities. |
| `role.resourceTypes[]` | `apiVersion`, `kind`, `minimum`, and optional `maximum`. |
| `role.extensionTypes` | `none` or `installed`; never an implicit wildcard. |
| `spec.output` | Output IR `apiVersion`, `kind`, schema digest, and Engine protocol. |
| `spec.capabilityVocabulary.dimensions` | Legal feature dimensions; each has known `values` and `openValues`. |
| `spec.limitVocabulary` | Limit names understood by the Profile. |
| `spec.adapter` | Installed adapter id, version, and binary digest. |

The Profile is the WS-Agreement-like semantic frame: it states what kinds of
terms may be composed and what they mean collectively, but delegates their
concrete syntax to compatible Dialects. A Profile document contains no code,
installer URL, or remote schema reference. `/v1/profiles` exposes Profiles
already backed by deployed adapters; placing a Profile manifest in a package
cannot make it executable.

Host installation is atomic: the adapter and the exact output JSON Schema at
`spec.output.schemaDigest` must both be present. At compile time the BIM core,
not the Profile adapter, resolves the root, roles, cardinalities, local and
registered resources, Dialect identities, and source schemas. The adapter
receives that resolved context and owns only domain lowering. Its result must
use the declared output `apiVersion` and `kind` and pass the pinned output
schema before it is admitted as canonical IR.

The only executable Profile in v1 is `qos-binding/v1`. It declares four roles,
outputs `bim/v1` `BindingProblem`, uses `bim-engine/v1`, and defines capability
dimensions for workflow nodes, aggregations, metric scopes, constraints,
optimization, expressions, placement, and open `irExtensions`.

## Dialect

`Dialect` declares one independently versioned source sublanguage. Its exact
shape is:

- `compatibleProfiles`: non-empty list of Profile ids;
- `resourceTypes`: zero or more complete resource contracts;
- `extensionPoints`: zero or more schema-pinned inline payload contracts;
- `irFeatures`: feature values emitted by lowering;
- `adapter`: installed validator/lowering id, version, and binary digest.

At least one of `resourceTypes` or `extensionPoints` must be non-empty. This
allows a Dialect to contribute only an inline vocabulary without inventing a
standalone resource type.

A resource-type entry contains `apiVersion`, `kind`, allowed `roles`,
`mediaType`, and `schemaDigest`. XML types additionally use `xmlRoot` with
`namespace` and `localName`, so external languages retain their normative
QName rather than receiving a fabricated JSON envelope.

An inline extension-point entry has this shape:

El bloque `openapi` siguiente está abreviado para mantener legible el ejemplo;
el documento que se envía debe ser completo. Véase el
[`registration.json` ejecutable](../examples/federation/multi-heuristic/registration.json)
para una revisión íntegra.

```jsonc
{
  "target": {
    "apiVersion": "domain.example/v1",
    "kind": "ServiceTerm"
  },
  "pointer": "/spec/policy",
  "schemaDigest": "sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The target identity, RFC 6901 pointer, and payload schema digest must all match
the installed validator. The containing Profile role must permit installed
extension types. `irFeatures` uses generic `{dimension,value}` pairs and every
dimension/value must be legal in the Profile capability vocabulary. A Dialect
that produces an additional IR namespace declares it in the open
`irExtensions` dimension.

Publishing a Dialect never installs an adapter. Publication succeeds only when
its complete resource schemas, extension schemas, feature declarations, and
adapter digest match an implementation already deployed in the gateway.
Revisions are immutable and approval does not transfer to changed content.

Installing a complete JSON resource contract also requires one deployed pure
lowering callable for every exact `apiVersion`/`kind`/`mediaType` identity. The
callable receives only a defensive copy of the validated document and pinned
context, must return an RFC 8785-compatible JSON object, and must produce the
same canonical bytes when invoked repeatedly. Its output is retained in the
Profile IR under the Dialect id, so accepting and then silently discarding an
installed resource is not a legal implementation. A QoS-compatible resource
Dialect therefore declares its own id in `irExtensions`; mode compatibility
fails closed unless the selected Engine explicitly supports that value.

Every inline extension point likewise requires both its exact installed schema
and an explicit deployed lowering callable. The callable receives defensive
copies of the validated payload and pinned context, returns a JSON object, and
must be deterministic under RFC 8785 canonicalization. The output is retained
at `spec.extensions[dialectId].inline[resourceId:pointer]`; raw source payloads
are never passed through merely because they validate.

The bundled base QoS, BPMN, and Placement Dialects currently compose complete
resources. Their `extensionPoints` arrays are empty; custom installed Dialects
may use the inline contract without changing the BIM core.

Placement is a deliberate Profile-native lowering in the sole executable QoS
Profile: its installed Dialect is still independently identified, schema- and
adapter-pinned, but its canonical data occupies the closed
`BindingProblem.spec.placement` field. Its `irExtensions` declaration is the
required capability marker for Engine compatibility, not a duplicate payload
under `spec.extensions`.

## Engine

`Engine` is the portable public execution declaration; deployment and secrets
live elsewhere. Each `spec.modes[]` entry declares:

- `id`, `profile`, and `algorithm`;
- `ir` as the exact `{apiVersion,kind}` output identity;
- a generic `capabilities` map whose keys come from the selected Profile;
- a closed `optionsSchema`;
- named `limits` from the Profile limit vocabulary; and
- truthful `guarantees`.

Every capability value is one unambiguous selector:

```json
{"selector": "none"}
{"selector": "all"}
{"selector": "only", "values": ["weighted", "pareto"]}
```

`only` requires a non-empty unique list. Empty lists and implicit wildcards
have no meaning. `all` means every value in a **closed** Profile dimension; it
is rejected for a dimension whose `openValues` is true because no Engine can
truthfully promise support for future, unnamed values. Generic capability keys
let future Profiles define their own feature vocabularies without revising the
Engine schema. The gateway compares a lowered problem's actual IR features
with these selectors. It does not equate a source Dialect name with execution
support.

`irExtensions` is therefore critical: a mode with `none` cannot receive any
extension namespace, while `only` accepts only the named IR extensions. The
installed QoS Profile deliberately keeps this dimension open, so `all` is not
a legal claim. The bundled Placement Dialect emits
`qos-binding-placement/v1` in this dimension as well as its closed
`placement=placement` feature. Placement-aware bundled modes therefore use
`irExtensions: {"selector":"only","values":["qos-binding-placement/v1"]}`.

`optionsSchema` is a closed object schema with `type: object`, `properties`,
and `additionalProperties: false`. `limits` are finite positive ceilings.
`guarantees.termination` lists only states the mode can actually establish;
`exact`, determinism without a time budget, and complete Pareto-front claims
are separate facts. An algorithm class alone never implies `INFEASIBLE` or
`OPTIMAL`.

## EngineRegistration

`EngineRegistration` is private deployment data. It pins an immutable Engine
revision, production-HTTPS endpoint, `bim-engine/v1` protocol and OpenAPI digest,
declarative same-origin paths, and an authentication scheme. Credentials live
in the secret store and are never serialized.

The schema accepts `http` so the same contract can describe a local deployment,
but runtime policy is fail-closed. Bundled registrations may use their installed
internal origin. Production keeps `FEDERATION_REQUIRE_HTTPS=true`; only an
explicit development setting permits external HTTP, and then only to a safe
private-network destination such as a Compose service.

```json
{
  "apiVersion": "bim/v1",
  "kind": "EngineRegistration",
  "metadata": {
    "namespace": "example.team",
    "name": "solver-production",
    "version": "1.0.0"
  },
  "spec": {
    "engine": {
      "namespace": "example.team",
      "name": "solver",
      "version": "1.0.0",
      "digest": "sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "endpoint": "https://solver.example.org",
    "protocol": {
      "id": "bim-engine/v1",
      "mediaType": "application/json",
      "digest": "sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    },
    "mappings": {
      "request": "/internal/v1/binding-problems",
      "health": "/health",
      "openapi": "/openapi.json"
    },
    "auth": {"scheme": "bearer"},
    "openapi": {
      "openapi": "3.1.0",
      "x-bim-protocol": "bim-engine/v1",
      "x-bim-protocol-digest": "sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "info": {"title": "Solver deployment", "version": "1.0.0"},
      "paths": {"...": "complete solve, health and optional job operations"},
      "components": {"...": "complete schemas and security schemes"}
    }
  }
}
```

The `engine` member is an immutable
`{namespace,name,version,digest}` reference. `mappings.request`,
`mappings.health`, `mappings.openapi`, and optional `mappings.job` are
same-origin absolute paths, not URLs or JSON Pointers. `auth.scheme` is
`none`, `bearer`, or `basic`. Engine and Registration revisions are immutable;
material changes require new versions, verification, and publication.
An asynchronous deployment adds a `job` path containing `{id}` and describes
both operations in its pinned OpenAPI document. The credential is uploaded
through the separate credential endpoint; it never appears in this JSON.

Creation records the authenticated caller as owner and starts `private` and
inactive. Only the owner can discover it, store its encrypted credential, and
activate or deactivate it for that account. Activation checks the pinned live
OpenAPI document, the solve/health/optional-job authentication declarations,
the canonical request and response schemas, health, and a deterministic solve.

Nothing is sent to moderation automatically. The owner explicitly calls
`publication-request` on an active revision; only then does it become
`pending_review` and visible to administrators. An administrator re-runs the
verification and either `approve`s it as `published` for every authenticated
account or `reject`s it back to owner-only visibility. Administrators cannot
discover private or rejected revisions and cannot activate, deactivate, or
change their credentials. Owner activation is independent from publication:
deactivating a published deployment disables it only for its owner. A
published credential is immutable; rotate it in a new revision.

## Registered source resources

A registered source is an immutable registry revision, not a manifest kind and
not an installation mechanism. It stores a validated JSON or BPMN resource
under a Profile role together with `namespace`, `name`, `version`, media type,
and canonical digest. Only published revisions resolve. Instance snapshots
retain the resolved source content and identity; engines never fetch it.

## Options, compatibility, and provenance

Options follow one lifecycle: schema defaults, caller merge, closed validation,
effective-limit calculation, then persistence. Unknown options are errors.

Every job pins file and logical resource digests, Profile and adapter, selected
Dialects and adapters, compiler and evaluator, output IR, Engine and
Registration, algorithm, mode, effective options, and limits. `fileDigests`
records canonical ZIP paths; `resourceDigests` records Instance resource ids,
including registered resources outside the archive.
