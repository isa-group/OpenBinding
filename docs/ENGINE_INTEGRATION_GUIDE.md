# Engine integration guide

This guide explains how to add an engine to the OpenBinding gateway. It covers
the engine manifest, the plugin interface, routing, and tests.

There are two ways to add an engine, and they share a document:

* **In-tree** — the engine ships with the gateway. You write a manifest and a
  plugin, and the gateway is redeployed. This is what the four engines in
  `engines/` are, and it is what most of this guide is about.
* **Federated** — somebody else's solver, registered at runtime through the API
  with a manifest that also describes their HTTP surface. No deployment, and no
  code in this repository. See "Federated engines" at the end.

## Overview

The gateway validates an incoming instance in stages and then routes it to the
selected engine.

1. General schema
2. **Engine manifest** — the instance schema the chosen engine declares
3. General semantic rules
4. Engine semantic rules

Stage 2 is why a caller is told "this engine does not take many-objective
instances" rather than watching a solver fail.

## The manifest

Everything the gateway believes about an engine comes from one document:

```
schemas/manifests/<engine-id>.manifest.json
```

**[ENGINE_MANIFEST.md](ENGINE_MANIFEST.md) is the field-by-field reference** —
what every key means, what it defaults to, what is checked and when, and how to
initialize one for either kind of engine. What follows here is the short version.

```jsonc
{
  "manifest_version": "1",
  "engine_id": "my-engine",
  "display_name": "My Engine",
  "description": "One sentence a person reads in the catalogue.",
  "type": "HEURISTIC",              // or EXACT — this one is not cosmetic
  "capabilities": {
    "qos_features_supported": ["*"],
    "composition_nodes_supported": ["TASK", "SEQ"],
    "objective_types_supported": ["MONO"],
    "constraints_supported": ["attribute_bound", "dependency"],
    "schema_version": "v1"
  },
  "options_schema": {               // what may go in `options`
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "iterations_count": { "type": "integer", "minimum": 1, "default": 1000 }
    }
  },
  "instance_schema": { /* a JSON Schema restricting the general schema */ }
}
```

The manifest is the **only** declaration. The plugin restates none of it:

| The gateway needs                       | Comes from                            |
| --------------------------------------- | ------------------------------------- |
| `GET /v1/engines` capabilities          | `capabilities` + `type`               |
| `GET /v1/schemas/{engine-id}`           | `instance_schema`                     |
| `GET /v1/engines/{id}/options/schema`   | `options_schema`                      |
| `GET /v1/engines/{id}/options/defaults` | the `default` of each declared option |
| `GET /v1/engines/{id}/manifest`         | all of it                             |

Three things about writing one:

**`type` is not cosmetic.** The router reports `INFEASIBLE` rather than
`UNKNOWN` when an `EXACT` engine returns no solution. A heuristic that claims
`EXACT` turns "I did not find one" into "there is none".

**Vocabularies are checked.** `composition_nodes_supported` must be drawn from
`TASK, ELEMENT, SEQ, AND, XOR, LOOP`; objectives from `MONO, MULTI, MANY`;
constraint families from `attribute_bound, dependency, resource_capacity,
latency_transition` (the schema's upper-case spelling is accepted too). `"*"`
means all of them and is expanded on load. A manifest that invents a capability
fails to parse, rather than advertising something that does not exist.

**Defaults live in `options_schema`.** A property with a `default` is one the
gateway sends when the client sends nothing. A property with `"default": null`
is one that exists and is unset — not the same as absent, since several engines
filter their options on "is not None". A property with no `default` is accepted
but never sent unprompted.

An engine's own defaults are validated against its own `options_schema` in the
test suite, so a bound you declare is a bound you have to live within.

## Required artifacts

1. **Manifest**: `schemas/manifests/<engine-id>.manifest.json`.
2. **Plugin**: implement `EngineValidationPlugin`, setting `engine_id`. The base
   class finds the manifest and derives everything above from it.
3. Engine URL in the registry + env wiring.
4. **Tests**: unit tests for your search, and your engine id in the integration
   suite's engine list (`tests/integration/conftest.py`), where tests skip
   themselves for objective types you do not claim to support.

## Five things to know before you start

**The instance travels whole, and in its canonical form.** The gateway sends
`{"instance": ..., "options": ...}` and nothing else. It does not pre-digest the
problem: an engine reads the composition, the constraints and the optional
`resource_model` / `latency_model` blocks itself. The one thing it does do is
expand the authoring shorthands (specification §12) before anything else sees
the instance, so an engine never has to handle a bare task id where a node
belongs, a missing XOR probability or a candidate that states its own placement.
Write your fixtures with `python openbinding-gateway/tools/bim_desugar.py`
rather than copying an example verbatim. If your engine runs on the JVM,
`engines/binding-core` already does the reading, and using it is how your
results stay comparable with the others'.

**A candidate may serve several tasks.** `candidates[*].task_ids` lists every
task a candidate can implement, so it belongs to the market of each of them and
two tasks can end up on the very same candidate. When k tasks do, three things
follow, and an engine that gets any of them wrong reports a solution the gateway
then scores differently:

* a feature declared `"sharing": "DIVIDE"` is worth `v/k` to each of those tasks,
  and every other feature is still worth `v` to each;
* the candidate's resource `demand` is taken up **once** on its pool, not k times;
* `SAME_CANDIDATE` / `DIFFERENT_CANDIDATE` compare the selected candidate ids.

k is counted over the binding as a whole, including tasks under a branch that
does not run.

**Placement is not a separate problem.** `resource_model` and `latency_model`
are optional blocks of the same instance. An engine that supports them derives
its placement view with `PlacementAdapter.from(instance)`; an instance without
them yields an empty view, so the same code path serves both. There is no
placement mode to branch on.

**Your reported metrics are overwritten - but kept, and compared.** Every
solution goes through `semantics.canonicalization`, which re-derives
`aggregated_features`, `violations` and `feasible` with the reference evaluator.
Do not compute them in your plugin: four separate copies of that arithmetic is
exactly what this architecture exists to avoid. Return the binding and, if you
have one, your own objective value.

Nothing you report is discarded. A caller who sends
`"include_engine_report": true` gets an `engine_report` beside the canonical
result, carrying your solutions exactly as you reported them, your provenance,
your untransformed response body, and a **divergence summary**: which solutions
you and the reference evaluator disagree about, how far apart the objectives
are, and which aggregated features differ.

That summary is the fastest way to find a bug while building an engine. If it
says your feasibility disagrees with the reference, your constraint handling is
wrong; if the objective drifts, check whether the instance declares
normalization. It is also how the same divergence gets noticed later, in a
benchmark, without anybody having to compare two lists by eye.

**Declare only what you enforce, and enforce what you declare.** The manifest is
a contract in both directions: a capability you advertise but do not enforce
returns wrong answers marked feasible, and one you enforce but `instance_schema`
rejects is unreachable. Both have happened here.

## Step-by-step

### 1) Write the manifest

Create `schemas/manifests/<engine-id>.manifest.json` as described above. The
quickest start is to fetch a comparable engine's and edit it:

```bash
curl -s localhost:8000/v1/engines/random-search/manifest > my-engine.manifest.json
```

### 2) Implement the engine plugin

Create a plugin in
`openbinding-gateway/src/openbinding_gateway/validation/engine_plugins/`. Note
what is **not** in it: capabilities, defaults, schema paths and the list of
accepted option names all come from the manifest.

```python
from typing import Any, Dict, List, Tuple

from .base import EngineValidationPlugin
from ...models.api import ValidationViolation


class MyEnginePlugin(EngineValidationPlugin):
    engine_id = "my-engine"

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        # Stage 4: the invariants a JSON Schema cannot express.
        # Anything a schema *can* express belongs in the manifest instead.
        return []

    def transform_request(
        self, instance: Dict[str, Any], options: Dict[str, Any] = {}
    ) -> Tuple[Dict[str, Any], List[str]]:
        # unsupported_option_warnings() reads the option names the manifest
        # declares, so there is no second list to keep in step with it.
        return {"instance": instance, "options": options}, self.unsupported_option_warnings(options)

    def transform_response(
        self, engine_response: Dict[str, Any], original_request: Dict[str, Any]
    ) -> Dict[str, Any]:
        # Map your engine's response to the general shape. `binding` is the only
        # field required of a solution; the reference evaluator derives the rest.
        return engine_response
```

Both `transform_request` and `transform_response` default to the identity, so an
engine that already speaks the contract in
`schemas/engine-contract.openapi.yaml` needs neither. Override
`check_engine_health` only if your engine does not expose `GET /health`.

### 3) Register the plugin and URL

- File: `openbinding-gateway/src/openbinding_gateway/registry/engine.py`
- Add an env var for the engine URL (e.g. `ENGINE_MY_ENGINE_URL`) in
  `core/settings.py`.
- Register the plugin in the initialization block:

```python
from ..validation.engine_plugins.my_engine import MyEnginePlugin

EngineRegistry.register("my-engine", MyEnginePlugin())
```

### 4) Check the endpoints

The gateway exposes:

- `/v1/engines` — capabilities and liveness
- `/v1/engines/<engine-id>/manifest`
- `/v1/engines/<engine-id>/options/schema` and `/options/defaults`
- `/v1/schemas/general` — the general schema, bundled into one document
- `/v1/schemas/<engine-id>` — your instance schema
- `/v1/schemas/engine-contract` — what the gateway asks of an engine

Your manifest must be discoverable via `SCHEMAS_DIR`.

### 5) Add tests

- Schema and semantic validation: `openbinding-gateway/tests/test_validation_comprehensive.py`
- Plugin request/response transformation: `openbinding-gateway/tests/test_plugin_transformation.py`
- Manifest sanity is already generic: `tests/test_plugin_schema_interface.py`
  parametrises over every built-in engine, so a new one is covered by adding its
  id to that list.
- Integration tests via docker compose (if the engine is available)

### 6) Wire docker compose (if needed)

Add the engine service to `docker-compose.yml` and expose the engine URL to the
gateway:

```yaml
environment:
  - ENGINE_MY_ENGINE_URL=http://engine-my:1234
```

## Validation expectations

The gateway applies schema defaults and general semantic checks before
engine-specific validation. If your engine depends on implicit rules, enforce
them in `validate_semantics`.

Common checks:

- Unsupported composition nodes
- Unsupported constraint types or objective types
- Missing candidates or missing QoS values
- Attribute bounds on missing features

## Federated engines

A federated engine is the same manifest with a `transport` block, submitted
through the API instead of committed here. It describes the third party's own
HTTP surface rather than requiring them to implement ours: their OpenAPI
document, which of their operations means "solve" and which means "poll a job",
and JSON Pointers saying where in their payloads our fields sit.

> The manifest format below is implemented and validated. The endpoints that
> *register* one are the next piece of work, so a `transport` block is currently
> a document the gateway checks rather than one it can route through.

```yaml
transport:
  openapi: { url: https://acme.example/openapi.json }   # or an inline document
  base_url: https://acme.example                        # overrides servers[]
  auth: { type: api_key, header: X-API-Key }            # the secret travels separately
  operations:
    solve:  { operationId: postOptimize }
    job:    { operationId: getOptimizeJob }             # asynchronous engines only
    health: { operationId: getHealth }                  # optional
  request_mapping:
    instance: /problem
    options:  /params
  response_mapping:
    solutions: /results          # "" when the body itself is the array
    binding:   /assignment       # within one solution — the only required mapping
    objective: /score            # optional, kept for the divergence report
```

`binding` is the only required mapping, and that is the point: the reference
evaluator recomputes every metric, so a Task → Candidate map is a complete
answer. An engine that returns nothing else still comes back with full
`aggregated_features`, `violations` and `feasible`.

Two rules are enforced when the manifest is parsed. Asynchrony is all or
nothing: declaring `operations.job` without `response_mapping.job_id`, or the
reverse, is refused rather than failing later on a real instance. And a
credential is never part of the manifest — it is supplied separately and stored
encrypted, so a manifest can be shown to its owner or reviewed without leaking
one.

Solving on a federated engine **sends the instance to a third-party endpoint**,
and results carry `provenance.federated = true` so they are never quietly mixed
into a benchmark with in-tree results.

## Troubleshooting

- Check `/v1/engines` to confirm the engine is registered and reachable.
- Use `/v1/analyze` for validation errors and warnings.
- Ensure `SCHEMAS_DIR` resolves to the folder containing `manifests/`.
- A capability that "does not work" is usually declared in the manifest and not
  enforced by the engine, or enforced and rejected by `instance_schema`.
