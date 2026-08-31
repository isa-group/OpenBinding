# Authoring BIM v1 packages

A BIM instance is a readable directory in Git and a deterministic `.bim.zip`
when transported. The root is `instance.json`. The root selects a Profile;
that Profile determines which roles and source languages may appear in the
package.

## 1. Select the problem Profile

The only executable Profile shipped in v1 is deterministic QoS binding:

```json
{
  "apiVersion": "bim/v1",
  "kind": "Instance",
  "metadata": {"name": "checkout"},
  "spec": {
    "profile": "qos-binding/v1",
    "resources": {
      "application": {"application": "application.json"},
      "candidateCatalog": {"catalog": "candidates.json"},
      "optimization": {"goal": "optimization.json"}
    }
  }
}
```

`spec.profile` is a compact id, not an embedded schema or implementation. The
compiler resolves its installed `Profile` manifest, including role
cardinalities, output IR, capability vocabulary, and adapter digest. An
uninstalled Profile is non-executable.

## 2. Compose resources under Profile roles

A typical QoS-binding package is:

```text
checkout/
  instance.json
  application.json
  candidates.json
  constraints.json     # optional
  optimization.json
  routing.json         # optional
  placement.json       # optional installed Dialect
  workflow.bpmn        # optional workflow notation
```

For `qos-binding/v1`, `spec.resources` uses four roles declared by that
Profile:

```json
{
  "profile": "qos-binding/v1",
  "resources": {
    "application": {
      "application": "application.json",
      "routes": "routing.json",
      "placement": "placement.json"
    },
    "candidateCatalog": {
      "primary": "candidates.json"
    },
    "constraintSet": {
      "policy": "constraints.json"
    },
    "optimization": {
      "goal": "optimization.json"
    }
  }
}
```

These role names are not hard-coded by the BIM container. The installed
Profile declares them, their base resource types, and their cardinalities:
exactly one Application, one or more CandidateCatalogs, zero or more
ConstraintSets, and exactly one Optimization. RoutingOverlay and BPMN are
additional base types in `application`. Placement is an installed compatible
Dialect resource type in that same role.

Every declared JSON source uses a strict envelope, but its identity belongs to
its sublanguage:

```json
{
  "apiVersion": "qos-binding/v1",
  "kind": "Application",
  "metadata": {"name": "checkout-application"},
  "spec": {
    "tasks": {"checkout": "payment"},
    "metrics": {},
    "workflow": {
      "task": {"resource": "application", "id": "checkout"}
    }
  }
}
```

Use `qos-binding/v1` for Application, CandidateCatalog, ConstraintSet,
Optimization, and RoutingOverlay. Use `qos-binding-placement/v1` for Placement.
BPMN remains BPMN 2.0.2 XML; its installed Dialect recognizes the normative
root QName. `bim/v1` is reserved here for the Instance and other BIM control
resources, not for all domain documents.

Use local POSIX paths, declare every package entry, and reuse neither a
resource id nor a path. References within resources are exact
`{"resource":"application","id":"checkout"}` objects. `resource` is the
id in the Instance index; `id` is the selected resource's local symbol.

## 3. Author the QoS-binding modules independently

Define service and local tasks, capability types, metric definitions, and the
workflow in Application. A service task requires a binding; a local task does
not and contributes the declared or compiler-materialized neutral for each
evaluated metric. Source workflow blocks are compact keyed forms such as
`{"task":{"resource":"application","id":"charge"}}` and
`{"sequence":[...]}`; authors do not write the IR-only `kind` field.

CandidateCatalog resources advertise capabilities, typed properties,
providers, and finite scalar metric slots. They never list task ids. Connect
catalog-local slot names to Application metrics with `metricBindings`.
Capability matching and an optional typed predicate construct eligibility
before optimization.

Put policy in ConstraintSet and decision strategy in Optimization. Constraints
use safe CEL or JSON AST. Every soft assertion has a non-negative penalty and
must be referenced explicitly by the Optimization. Choose `satisfy`,
`weighted`, `lexicographic`, or `pareto`; normalize terms explicitly when units
differ.

Keep XOR probabilities in a RoutingOverlay. Supply every branch probability or
none, make supplied values sum exactly to one, and request uniform routing with
`uniform: true`. Never combine a condition and a probability on the same flow.
Use `repeat.count` for an exact count and `repeat.expectedCount` for a
deterministic mean. BPMN supports exact repetition only through a static
sequential multi-instance cardinality.

When adding Placement, choose `networkMode: directed|symmetric` deliberately.
Co-location alone has an implicit zero latency. Capacity scope, transition
enforcement, and global-latency aggregation remain explicit policy choices.

## 4. Reuse registered resources without remote imports

A target may replace its local path with an immutable reference:

```json
{
  "namespace": "example.team",
  "name": "production-catalog",
  "version": "3.1.0",
  "digest": "sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Register the complete JSON or BPMN resource through `/v1/resources`, wait for
publication when approval is required, and copy the returned four-field
reference. Never omit the digest, use a mutable tag, or place a registry URL in
the package. Registered JSON `metadata.name` and `metadata.version` must match
the registered identity. Content changes create a new version.

## 5. Extend through installed Dialects

Do not add an ad hoc semantic field to a closed `spec`. A Dialect supplies one
of two explicit extension forms:

- a complete resource type identified by `apiVersion` + `kind` (or XML root
  QName), assigned to an open Profile role; or
- a payload under an `extensions` map at a Dialect-declared JSON Pointer.

For an inline payload, the key is the versioned Dialect id. The Dialect must
pin the target identity, pointer, payload schema digest, emitted IR features,
installed adapter, and an explicit deterministic lowering callable for that
exact point. Validation alone is insufficient: compilation rejects a point
without lowering and never copies its raw payload into IR. Successful lowering
is retained at
`BindingProblem.spec.extensions[dialectId].inline[resourceId:pointer]`.
Unknown extensions may survive editor round-trips, but
analysis and solving stop until the exact contract is installed. Package data
can never install code or fetch a remote schema.

A whole-resource Dialect is executable only when the gateway has installed an
exact schema and deterministic lowering callable for every declared resource
identity. Its canonical output is retained under that Dialect id in the
compiled IR and advertised through `irExtensions`, so engine selection remains
explicit and fail-closed.

Prefer a whole resource when the domain term has its own lifecycle or can be
reused independently. Prefer an inline extension only when it genuinely
qualifies one existing term. If the addition changes role semantics, output
IR, or decision meaning rather than merely adding a vocabulary, define a new
Profile instead of overloading `qos-binding/v1`.

Placement is the one Profile-native Dialect in the executable QoS Profile. Its
source remains an independently installed `qos-binding-placement/v1` resource,
while canonical data is lowered into the closed `spec.placement` IR field.
`irExtensions=qos-binding-placement/v1` declares the required Engine
capability; authors must not duplicate Placement under `spec.extensions`.

## 6. Analyze and export reproducibly

Start from `examples/demo/01_simple_seq`, then analyze the complete directory
in the Playground. Compilation is all-or-nothing and diagnostics point to the
resource and JSON Pointer, CEL span, or BPMN element.

Every eligible candidate must provide each metric read by policy,
optimization, or selected Placement policy; the deterministic Profile never
imputes QoS values. Public source-upload endpoints accept complete ZIP bytes,
not a standalone `instance.json` or JSON virtual-filesystem object.

Export uses RFC 8785 canonical JSON, UTF-8/LF, sorted POSIX paths, fixed ZIP
timestamps, `STORE`, and SHA-256 digests. The same semantic source must produce
the same package, Instance, and BindingProblem digests. `fileDigests` keys are
ZIP paths; `resourceDigests` keys are logical Instance resource ids and also
cover registered resources outside the ZIP.
