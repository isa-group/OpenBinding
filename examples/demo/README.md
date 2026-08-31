# BIM v1 examples

These examples are portable `Instance` packages written in the modular BIM v1
language. Each directory contains `instance.json` plus the application,
candidate catalogue, optional constraints, and optimization resources.

## Core concepts

Each example is a directory of BIM resources that defines one binding problem.
The root `Instance.spec.resources` groups resource ids under `application`,
`candidateCatalog`, optional `constraintSet`, and `optimization`.

* `Application.spec.tasks` distinguishes `service` tasks (which need a
  candidate) from `local` tasks. Workflow task references are explicit
  `{ "resource": "application", "id": "..." }` objects.
* `CandidateCatalog.spec.candidates` publishes exact capability types and
  finite scalar QoS metrics. There is no task-to-candidate list.
* `ConstraintSet` contains CEL or JSON-AST assertions. Soft constraints carry
  an explicit penalty and are referenced by `Optimization.spec.penalties`.
* `Optimization` supports `satisfy`, weighted, lexicographic, and Pareto modes.

## Example Guide

Here is a guide to the included examples and their specific intent:

| File | Intent / Key Feature | Description |
| :--- | :--- | :--- |
| **`01_simple_seq/`** | **Basic Sequence** | A minimal example of a sequential workflow. Good for verifying basic connectivity and solving. |
| **`02_parallel/`** | **Parallel Flow (AND)** | Demonstrates parallel execution and aggregation. |
| **`03_xor_choice/`** | **Probabilistic Branching (XOR)** | Uses a separate routing overlay with explicit probabilities. |
| **`04_conflict/`** | **Infeasibility** | A problem designed to be unsolvable due to conflicting constraints. |
| **`05_multi_obj/`** | **Weighted Sum** | A cost and latency trade-off encoded as a v1 weighted objective. |
| **`06_loops/`** | **Loops** | Demonstrates `repeat` with an exact or expected count. |
| **`07_soft_constraints/`** | **Soft Constraints** | Includes a soft constraint with an explicit optimization penalty. |
| **`08_dependencies/`** | **Provider Properties** | Demonstrates typed capability matching and provider properties. |
| **`09_mixed/`** | **Complex/Mixed** | Combines sequence, XOR and constraints. |
| **`10_large_scale/`** | **Scale/Performance** | A larger composition used to test solver performance. |
| **`11_multi_obj_negative/`** | **Multi-Objective** | A two-term objective used for normalization and compatibility tests. |
| **`12_many_obj_pareto/`** | **Many-Objective (Pareto)** | A Pareto optimization example. |
| **`13_fms/`** | **Feature Model** | A composition derived from a feature model. |
| **`14_shared_candidates/`** | **Shared Candidates** | One candidate serves multiple tasks with explicit selected-candidate scope. |
| **`15_bpmn_complete/`** | **Complete BPMN** | Combines nested AND/XOR gateways, sequence-flow routing, exact sequential multi-instance work, constraints, four normalized objectives, and edge/fog/cloud placement. |
| **`16_json_complete/`** | **Native JSON Twin** | Encodes the exact same workflow and resources as example 15 without BPMN; their compiled IR digest and every engine result must match. |

## Usage

Export an example directory as a deterministic `.bim.zip` in the Playground or
repository build, then send that package to the OpenBinding gateway.

The repository build validates and compiles every source before writing the
portable artifact. With no source arguments it builds the complete corpus;
paths can be supplied to build a subset:

```bash
openbinding-gateway/.venv/bin/python tools/build_bim_packages.py \
  --output build/bim examples/demo/01_simple_seq examples/demo/03_xor_choice
```

**Prerequisite**: Ensure the gateway is running at `http://localhost:8000`.

### Example Command

To submit the **Simple Sequence** package using the default Random Search mode:

```bash
curl -X POST "http://localhost:8000/v1/jobs" \
    -H "Content-Type: application/vnd.bim+zip" \
    -H "Idempotency-Key: demo-01" \
    --data-binary @01_simple_seq.bim.zip
```

To select an Engine mode or supply options, first create an immutable snapshot
from the ZIP and then create a job from that snapshot. For the
**Many-Objective** example:

```bash
snapshot_id="$(
  curl -sS -X POST "http://localhost:8000/v1/instances" \
    -H "Content-Type: application/vnd.bim+zip" \
    --data-binary @12_many_obj_pareto.bim.zip | jq -r .id
)"

jq -n --arg snapshot "$snapshot_id" \
  '{snapshot:$snapshot, engine:"many-heuristic", mode:"pareto-sampling", options:{iterations:1000}}' |
  curl -sS -X POST "http://localhost:8000/v1/jobs" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: demo-12" \
    --data-binary @-
```

Both job forms return `202 Accepted`. A JSON job body accepts a `snapshot`; it
does not accept an inline root document in place of the complete BIM package.

The two-objective package in `11_multi_obj_negative/` can be routed to the
federated `multi-heuristic` after following the
[`EngineRegistration` example](../federation/multi-heuristic/README.md).
