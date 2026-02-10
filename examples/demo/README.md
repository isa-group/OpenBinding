# OpenBinding Demo Examples

This directory contains a set of 10 diverse composition problems designed to demonstrate the various features and capabilities of the OpenBinding framework, including different composition structures, constraints, and objectives.

## Core Concepts (JSON Model)

Each example is a JSON file that defines a service composition problem. The key components are:

*   **`metadata`**: General information about the problem (ID, name, description).
*   **`features`**: The Quality of Service (QoS) attributes to be optimized or constrained (e.g., Latency, Cost, Availability).
    *   Defines `direction` (minimize/maximize), `unit`, `scale`, and `valid_range`.
*   **`providers`**: The entities offering services.
*   **`tasks`**: The abstract steps in the workflow that need to be performed.
*   **`candidates`**: Concrete service implementations available for each task. Each candidate has specific `features` values.
*   **`composition`**: The structural definition of the workflow.
    *   **`SEQ`**: Sequential execution.
    *   **`AND`**: Parallel execution.
    *   **`XOR`**: Conditional branching (probabilistic).
    *   **`LOOP`**: Repeated execution.
*   **`aggregation_policies`**: Rules for how feature values are aggregated across the composition structure (e.g., Sum of costs, Max of latencies).
*   **`constraints`**: Restrictions on valid solutions.
    *   **`ATTRIBUTE_BOUND`**: Limits on QoS values (Global or Local).
    *   **`DEPENDENCY`**: Constraints between providers (e.g., `SAME_PROVIDER` for two tasks).
*   **`objective`**: The goal of the optimization.
    *   **`SINGLE`**: Optimize one feature (or a weighted sum of multiple features).
    *   **`MULTI`**: Optimize multiple features (Pareto frontier).
    *   **`MANY`**: Optimize many features (intended for Many-Objective algorithms).

## Example Guide

Here is a guide to the included examples and their specific intent:

| File | Intent / Key Feature | Description |
| :--- | :--- | :--- |
| **`01_simple_seq.json`** | **Basic Sequence** | A minimal example of a sequential workflow. Good for verifying basic connectivity and solving. |
| **`02_parallel.json`** | **Parallel Flow (AND)** | Demonstrates parallel execution. Shows how `MAX` aggregation (for latency) works differently from `SUM`. |
| **`03_xor_choice.json`** | **Probabilistic Branching (XOR)** | Uses `XOR` nodes with probabilities. The objective is expected availability. |
| **`04_conflict.json`** | **Infeasibility** | A problem designed to be unsolvable due to conflicting constraints. Use this to test error handling or "No Solution" responses. |
| **`05_multi_obj.json`** | **Multi-Objective** | Optimizes for both Cost and Latency. Should return a set of Pareto-optimal solutions rather than a single best one. |
| **`06_loops.json`** | **Loops** | Demonstrates the `LOOP` structure. Aggregation uses `expected_iterations` to estimate QoS. |
| **`07_soft_constraints.json`** | **Soft Constraints** | Includes a constraint marked `hard: false`. Violations should be penalized but allowed. |
| **`08_dependencies.json`** | **Provider Dependencies** | Forces two independent tasks to select services from the `SAME_PROVIDER`. |
| **`09_mixed.json`** | **Complex/Mixed** | Combines multiple structures (Seq, XOR) and constraints. A more realistic scenario. |
| **`10_large_scale.json`** | **Scale/Performance** | A larger composition (10 sequential tasks) with more candidates, used to test solver performance. |

## Usage

You can send these examples to the OpenBinding Gateway using `curl`.

**Prerequisite**: Ensure the gateway is running at `http://localhost:8000`.

### Example Command

To solve the **Simple Sequence** example using the **Random Search** engine:

```bash
curl -X POST "http://localhost:8000/v1/solve?engine=random-search" \
     -H "Content-Type: application/json" \
     -d @01_simple_seq.json
```

To solve the **Multi-Objective** example using the **MiniZinc** engine:

```bash
curl -X POST "http://localhost:8000/v1/solve?engine=minizinc-csp" \
     -H "Content-Type: application/json" \
     -d @05_multi_obj.json
```

**Note**: Ensure you are in the `examples/demo` directory when running these commands, or provide the full path to the JSON file.
