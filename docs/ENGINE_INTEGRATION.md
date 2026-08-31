# Integrating a BIM v1 Engine

An Engine integrates at a Profile's output boundary. It is neither a BIM
source parser nor a Dialect adapter: the gateway resolves and validates the
package, runs the installed Profile/Dialect adapters, and sends only the
declared output IR.

## Declare an exact mode contract

An Engine publishes an immutable `bim/v1` `Engine` document. For the bundled
deterministic QoS Profile, each mode declares:

```json
{
  "id": "seeded",
  "profile": "qos-binding/v1",
  "ir": {"apiVersion": "bim/v1", "kind": "BindingProblem"},
  "algorithm": "seeded-random-search",
  "capabilities": {
    "workflowNodes": {"selector": "all"},
    "aggregations": {"selector": "all"},
    "metricScopes": {"selector": "all"},
    "constraints": {"selector": "all"},
    "optimization": {"selector": "all"},
    "expressions": {"selector": "all"},
    "placement": {"selector": "all"},
    "irExtensions": {
      "selector": "only",
      "values": ["qos-binding-placement/v1"]
    }
  }
}
```

The complete mode also contains a closed `optionsSchema`, Profile-defined
resource `limits`, and truthful `guarantees`. Defaults are applied before
caller options are merged and validated; unknown options are errors.

Capability keys are not fixed QoS fields in the generic Engine schema. They
come from the selected Profile's `capabilityVocabulary`. Each value is
`none`, `all`, or non-empty `only`. `all` is valid only for a closed dimension;
an open dimension requires `none` or an explicit `only` list. The gateway
derives the actual feature set from the canonical IR and compares every
Profile dimension with the mode.

This distinction matters for extensibility. Dialects announce emitted
`irFeatures`, including names in the open `irExtensions` dimension. An Engine
does not become compatible merely because it recognizes a Dialect name or
accepts the base IR kind. It must truthfully select every feature present in
the lowered problem. A mode declaring `irExtensions: none` is protected from
receiving extension data it cannot interpret; a mode declaring `only` is
protected from every extension not named in that list.

## Consume the Profile-declared IR only

For `qos-binding/v1`, the request payload is a closed `bim/v1`
`BindingProblem`. It contains canonical workflow, candidate eligibility,
finite scalar metrics, expression IR, constraints, optimization, optional
placement/extension data, and the source map required for diagnostics. The IR
also pins the selected Profile and each selected Dialect/adapter revision.

Placement is represented in the closed `spec.placement` field because it is a
native lowering of the executable QoS Profile. Its independently installed
Dialect still emits `irExtensions=qos-binding-placement/v1`; treat that value
as a required compatibility marker, not as a promise of duplicate data under
`spec.extensions`.

Do not accept `.bim.zip`, source documents, a registered-resource URL, or an
unlowered extension. Do not fetch a schema or Dialect at solve time. Source
validation and lowering belong to installed adapters; decision search belongs
to the Engine.

The semantic IR digest deliberately excludes source representation,
source-map and source provenance, so equivalent source languages can produce
the same problem identity. Job provenance separately pins the Profile,
Dialects, adapters, compiler/evaluator, files, logical resources, Engine,
Registration, algorithm, options, and limits.

## Return evidence, not inferred claims

The result envelope states one of `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, or
`UNKNOWN`. It returns decisions in the common IR form plus any Engine-reported
metadata permitted by the protocol. The gateway authoritatively reevaluates
every decision and discards invalid or incomplete solutions.

An algorithm class never implies `INFEASIBLE` or `OPTIMAL`. Advertise only
termination evidence and exactness the concrete mode can establish. If a time
budget changes determinism or completeness, say so independently in
`guarantees`.

## Register deployment separately

`EngineRegistration` is an immutable private deployment revision. It stores:

- the exact `{namespace,name,version,digest}` Engine reference;
- an HTTPS origin in production (a development gateway may explicitly allow a
  private-network HTTP origin);
- `bim-engine/v1`, JSON media type, and the pinned protocol/OpenAPI digest;
- same-origin absolute request, health, OpenAPI, and optional asynchronous-job
  paths; and
- an authentication scheme, never the secret itself.

Bundled Engines use registrations in the reserved `bim.builtin` namespace and
may pin their internal HTTP service origin. Production keeps
`FEDERATION_REQUIRE_HTTPS=true`. A development gateway may set it to `false`
to verify and dispatch an external registration on a trusted private Compose
network; public or otherwise unsafe HTTP destinations remain invalid.

The registrant owns each revision. Creation is `private` and inactive: no
administrator can discover it. The owner stores any credential separately and
may activate or deactivate the deployment for that account; activation runs
the pinned OpenAPI, solve/health/optional-job authentication, health, and
deterministic conformance checks.

Moderation starts only when the owner explicitly sends `publication-request`.
That exact revision becomes `pending_review` and visible to administrators,
who reverify and either `approve` it as `published` for every authenticated
account or `reject` it back to owner-only visibility. Administrators cannot
inspect private or rejected revisions and cannot operate them. Activation and
publication are independent, so owner deactivation does not withdraw a
published deployment from other accounts. Published credentials are immutable;
material Engine, deployment, or credential changes require a new revision.

The repository's `multi-heuristic` is intentionally not bundled. Its
[`Engine` and `EngineRegistration` example](../examples/federation/multi-heuristic/README.md)
uses the same runtime publication, review, OpenAPI verification, health probe,
and immutable deployment selection as any external solver. Its Compose service
exists only to run the remote process; it has no `ENGINE_*_URL`, so the gateway
does not synthesize a built-in registration for it.

## Bundled mode coverage

| Bundled Engine | Modes | `irExtensions` | Placement |
| --- | --- | --- | --- |
| `random-search` | `seeded` | `only: qos-binding-placement/v1` | `all` |
| `many-heuristic` | `pareto-sampling` | `only: qos-binding-placement/v1` | `all` |
| `evolutionary-heuristics` | `elitist-genetic`, `pareto-genetic` | `only: qos-binding-placement/v1` | `all` |
| `minizinc-csp` | `exact-weighted` | `only: qos-binding-placement/v1` | `all` |

The four supporting Engine families accept exactly the Placement IR extension
currently implemented; they do not claim future extension namespaces. Their
`placement: all` selector covers every value in that closed dimension.
The gateway still reevaluates every returned binding.

The federated example publishes `multi-heuristic/pareto-sampling` with
`objectiveTypes: only MULTI`, `minObjectives: 2`, and `maxObjectives: 3`.
Because it is registered at runtime, it does not appear in the bundled table.

All bundled modes target the sole executable Profile,
`qos-binding/v1`. Scheduling, QoS uncertainty, distributions, risk, and
runtime rebinding require other Profile/IR contracts and are not accepted by
these modes.
