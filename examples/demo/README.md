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

A run names a revision of a problem, and a problem belongs to an organization
you are a MEMBER of. Upload the package as a problem first, then submit a job
for its revision. For the **Many-Objective** example (`$TOKEN` is a session
token or an API key; `my-lab` is your organization):

```bash
revision_id="$(
  curl -sS -X POST "http://localhost:8000/v1/organizations/my-lab/problems" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/vnd.bim+zip" \
    --data-binary @12_many_obj_pareto.bim.zip | jq -r .revision.id
)"

jq -n --arg revision "$revision_id" \
  '{revision:$revision, engine:"many-heuristic", mode:"pareto-sampling", options:{iterations:1000},
    optimization:{type:"MANY", scalarization:"pareto-front"}}' |
  curl -sS -X POST "http://localhost:8000/v1/organizations/my-lab/runs" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: demo-12" \
    --data-binary @-
```

The run is accepted with `202 Accepted`. To check a package without storing it, post it
to `POST /v1/bim/validate`, which needs no account and answers its digests,
analysis and compatible Engine modes.

The two-objective package in `11_multi_obj_negative/` can be routed to the
federated `multi-heuristic` after following the
[`EngineRegistration` example](../federation/multi-heuristic/README.md).

### Interactive analysis examples

- `17_analysis_tradeoffs`: two tasks × six candidates; 36 bindings with cost/latency trade-offs, duplicate metrics and dominated alternatives.
- `18_analysis_constraints`: adds maximized quality, a hard cost bound and a soft latency penalty.
- `19_analysis_journey`: weighted version for scalar-objective solver replay and priority sensitivity.

Run a compatible engine from Playground to solve them. The `--analysis-only` seeder option and the **Binding Analysis Gallery** it filled were removed by M9.6; [the analysis guide](../../docs/analysis/binding-analysis-upgrade.md#development-gallery-and-how-to-try-it) keeps them as history.
