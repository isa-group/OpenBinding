# OpenBinding Demo Examples

This directory contains a set of 12 diverse composition problems designed to demonstrate the various features and capabilities of the OpenBinding framework, including different composition structures, constraints, and objectives.

## Core Concepts (JSON Model)

Each example is a JSON file that defines a service composition problem. The key components are:

*   **`metadata`**: General information about the problem (ID, name, description).
*   **`features`**: The Quality of Service (QoS) attributes to be optimized or constrained (e.g., Latency, Cost, Availability).
    *   Defines `direction` (minimize/maximize), `unit`, `scale`, and `valid_range`.
*   **`providers`**: The entities offering services.
*   **`tasks`**: The abstract steps in the workflow that need to be performed.
*   **`candidates`**: Concrete service implementations. Each candidate has specific `features`
    values and lists under `task_ids` every task it can implement - one candidate can serve
    several tasks, and may end up selected for more than one of them at once.
    *   **`sharing`** (declared on a feature): what happens when it does. `DIVIDE` splits the
        value between the tasks sharing the candidate, because they are paying for one thing;
        anything else charges each of them in full.
*   **`composition`**: The structural definition of the workflow.
    *   **`SEQ`**: Sequential execution.
    *   **`AND`**: Parallel execution.
    *   **`XOR`**: Conditional branching (probabilistic).
    *   **`LOOP`**: Repeated execution.
*   **`aggregation_policies`**: Rules for how feature values are aggregated across the composition structure (e.g., Sum of costs, Max of latencies).
*   **`constraints`**: Restrictions on valid solutions.
    *   **`ATTRIBUTE_BOUND`**: Limits on QoS values (Global or Local).
    *   **`DEPENDENCY`**: What two or more tasks must agree on, or differ in: their provider
        (`SAME_PROVIDER` / `DIFFERENT_PROVIDER`), the pool hosting them (`SAME_POOL` /
        `DIFFERENT_POOL`), or the candidate itself (`SAME_CANDIDATE` / `DIFFERENT_CANDIDATE`).
*   **`objective`**: The goal of the optimization.
    *   **`MONO`**: Optimize one feature (or a weighted sum of multiple features).
    *   **`MULTI`**: Optimize multiple features (Negative test for now).
    *   **`MANY`**: Optimize many features (3+) for Pareto Front.

## Example Guide

Here is a guide to the included examples and their specific intent:

| File | Intent / Key Feature | Description |
| :--- | :--- | :--- |
| **`01_simple_seq.json`** | **Basic Sequence** | A minimal example of a sequential workflow. Good for verifying basic connectivity and solving. |
| **`02_parallel.json`** | **Parallel Flow (AND)** | Demonstrates parallel execution. Shows how `MAX` aggregation (for latency) works differently from `SUM`. |
| **`03_xor_choice.json`** | **Probabilistic Branching (XOR)** | Uses `XOR` nodes with probabilities. The objective is expected availability. |
| **`04_conflict.json`** | **Infeasibility** | A problem designed to be unsolvable due to conflicting constraints. Use this to test error handling or "No Solution" responses. |
| **`05_multi_obj.json`** | **Weighted Sum (MONO)** | A Cost+Latency trade-off encoded as a `MONO` weighted-sum objective (supported by current engines). |
| **`06_loops.json`** | **Loops** | Demonstrates the `LOOP` structure. Aggregation uses `expected_iterations` to estimate QoS. |
| **`07_soft_constraints.json`** | **Soft Constraints** | Includes a constraint marked `hard: false`. Violations should be penalized but allowed. |
| **`08_dependencies.json`** | **Provider Dependencies** | Forces two independent tasks to select services from the `SAME_PROVIDER`. |
| **`09_mixed.json`** | **Complex/Mixed** | Combines multiple structures (Seq, XOR) and constraints. A more realistic scenario. |
| **`10_large_scale.json`** | **Scale/Performance** | A larger composition (10 sequential tasks) with more candidates, used to test solver performance. |
| **`11_multi_obj_negative.json`** | **Multi-Objective (Negative)** | A problem with 2 objectives. Used to verify that engines correctly reject "Multi" objectives (at the moment there are no engines that support this type of objective). |
| **`12_many_obj_pareto.json`** | **Many-Objective (Pareto)** | A problem with 3 objectives. The **Many-Heuristic** engine should return a set of Pareto-optimal solutions for this input. |
| **`13_fms.json`** | **Feature Model** | A composition derived from a feature model. |
| **`14_shared_candidates.json`** | **Shared Candidates** | One candidate able to serve three tasks. Shows a `DIVIDE` cost being split when it is selected for two of them, a hard `SAME_CANDIDATE` and a soft `DIFFERENT_CANDIDATE`. |

## Usage

You can send these examples to the OpenBinding Gateway using `curl`.

**Prerequisite**: Ensure the gateway is running at `http://localhost:8000`.

### Example Command

To solve the **Simple Sequence** example using the **Random Search** engine:

```bash
curl -X POST "http://localhost:8000/v1/solve" \
    -H "Content-Type: application/json" \
    -d @<(jq -n --argfile inst 01_simple_seq.json '{engine_id:"random-search", instance:$inst, options:{iterations_count:1000}, verbose:false}')
```

To solve the **Many-Objective** example using the **Many-Heuristic** engine:

```bash
curl -X POST "http://localhost:8000/v1/solve" \
    -H "Content-Type: application/json" \
    -d @<(jq -n --argfile inst 12_many_obj_pareto.json '{engine_id:"many-heuristic", instance:$inst, options:{iterations_count:1000, archive_size:20}, verbose:false}')
```

**Note**: Ensure you are in the `examples/demo` directory when running these commands, or provide the full path to the JSON file.
