# Engine integration guide

This guide explains how to add a new engine to the OpenBinding gateway. It covers schema specialization, validation hooks, routing, and tests.

## Overview

The gateway validates incoming instances in stages and then routes them to the selected engine.

Validation stages:
1. General schema
2. Specialization schema
3. General semantic rules
4. Engine semantic rules

Engines integrate through the gateway plugin interface and a specialization schema.

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

**Declare only what you enforce, and enforce what you declare.** Capabilities
and the specialization schema are a contract in both directions: a capability
you advertise but do not enforce returns wrong answers marked feasible, and one
you enforce but the schema rejects is unreachable. Both have happened here.

## Required artifacts

1. Engine plugin (gateway): implement `EngineValidationPlugin`. Set `engine_id`;
   the base class then resolves your specialization schema path and provides the
   `/health` check.
2. Specialization schema: `schemas/specializations/<engine-id>.schema.json`.
3. Specialization model (recommended): `schemas/specializations/<engine-id>.schema.mermaid`.
4. Engine URL in registry + env wiring.
5. Tests: unit tests for your search, and your engine id in the integration
   suite's engine list (`tests/integration/conftest.py`), where tests skip
   themselves for objective types you do not claim to support.

## Step-by-step

### 1) Add a specialization schema

Create a specialization schema under `schemas/specializations/`.

### 1.1) Add a specialization model (recommended)

To enable visual exploration in the frontend **Schema Explorer** (`JSON | Model` tabs), add a Mermaid model next to your specialization schema:

- Path: `schemas/specializations/<engine-id>.schema.mermaid`
- Naming must match your engine id exactly (`<engine-id>`)

The Mermaid model is optional, but strongly recommended for maintainability and onboarding.

If the file is missing, the frontend will show **Model not available** while keeping JSON schema validation and all engine workflows fully operational.

#### Good practices

- Keep JSON and Mermaid aligned conceptually (same constraints/capabilities).
- Keep node/edge labels stable and meaningful across versions.
- Prefer modular Mermaid subgraphs for large models.
- Update both files in the same PR when constraints change.
- Avoid changing `<engine-id>` naming once released, to prevent schema/model mismatch.


## Engine options defaults (Playground)

The frontend Playground can prefill the `options` object depending on the selected engine.
To support this, the gateway exposes engine-level defaults at:

- `GET /v1/engines/{engine_id}/options/defaults`

If the engine has no options, the endpoint returns an empty JSON object: `{}`.

### How to define defaults

Defaults are defined in the gateway engine plugin by implementing `get_default_options()`.
Example:

- Return `{}` if your engine does not accept any options.
- Return a JSON object with the gateway defaults (e.g. `{ "iterations_count": 1000 }`) if your engine supports options.

### 2) Implement the engine plugin

Create a new plugin in `openbinding-gateway/src/openbinding_gateway/validation/engine_plugins/`:

```python
from typing import Any, Dict, List, Tuple
import httpx
from .base import EngineValidationPlugin
from ...models.api import ValidationViolation

class MyEnginePlugin(EngineValidationPlugin):
    async def check_engine_health(self, base_url: str, client: httpx.AsyncClient) -> bool:
        resp = await client.get(f"{base_url.rstrip('/')}/health")
        return resp.status_code == 200

    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": ["TASK", "SEQ"],
            "objective_types_supported": ["MONO"],
            "constraints_supported": ["attribute_bound"],
            "type": "HEURISTIC", # or "EXACT" depending on your engine's nature
            "schema_version": "v1",
        }

    def get_specialization_schema_path(self) -> str:
        # Uses SCHEMAS_DIR if available
        # e.g. /app/schemas/specializations/my-engine.schema.json
        ...

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations: List[ValidationViolation] = []
        # Add engine-specific invariants here
        return violations

    def transform_request(self, instance: Dict[str, Any], options: Dict[str, Any] = {}) -> Tuple[Dict[str, Any], List[str]]:
        # Map general instance to engine request payload
        return {"instance": instance, "options": options}, []

    def transform_response(self, engine_response: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
        # Map engine response to gateway solution format
        return engine_response
```

### 3) Register the plugin and URL

Add the plugin to `EngineRegistry`:

- File: `openbinding-gateway/src/openbinding_gateway/registry/engine.py`
- Add env var for the engine URL (e.g. `ENGINE_MY_ENGINE_URL`).
- Register the plugin in the initialization block.

Example:

```python
from ..validation.engine_plugins.my_engine import MyEnginePlugin

_engine_urls = {
    "my-engine": os.getenv("ENGINE_MY_ENGINE_URL", "http://engine-my:1234"),
}

EngineRegistry.register("my-engine", MyEnginePlugin())
```

### 4) Ensure schema endpoints work

The gateway exposes:

- `/v1/schemas/general`
- `/v1/schemas/general/model`
- `/v1/schemas/<engine-id>`
- `/v1/schemas/<engine-id>/model`

Your specialization schema must exist and be discoverable via `SCHEMAS_DIR`.
Your specialization model should follow the same directory and naming convention to be discoverable by the `/model` endpoint.

### 5) Add tests

Recommended tests:

- Schema and semantic validation: `openbinding-gateway/tests/test_validation_comprehensive.py`
- Plugin request/response transformation: `openbinding-gateway/tests/test_plugin_transformation.py`
- Integration tests via docker compose (if the engine is available)

### 6) Wire docker compose (if needed)

Add the engine service to `docker-compose.yml` and expose the engine URL to the gateway:

```yaml
environment:
  - ENGINE_MY_ENGINE_URL=http://engine-my:1234
```

## Validation expectations

The gateway uses schema defaults and semantic checks before engine-specific validation. If your engine depends on implicit rules, enforce them in `validate_semantics`.

Common checks:

- Unsupported composition nodes
- Unsupported constraint types or objective types
- Missing candidates or missing QoS values
- Attribute bounds on missing features

## Troubleshooting

- Check `/v1/engines` to confirm the engine is registered and reachable.
- Use `/v1/analyze` for validation errors and warnings.
- Ensure `SCHEMAS_DIR` resolves to the folder containing your specialization schema.
- If the Model tab shows unavailable, confirm `<engine-id>.schema.mermaid` exists under `schemas/specializations/` and matches engine id naming exactly.
