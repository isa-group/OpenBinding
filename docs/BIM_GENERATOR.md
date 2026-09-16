# OpenBinding QACO BIM v1 Generator & Calibration Architecture

The OpenBinding Generator framework bridges legacy Quality-Aware Service Composition (QACO) problem synthesis with the **BIM v1** standard. It features multi-engine capability validation, witness-based feasibility control, platform persistence, and empirical surrogate calibration for the MAPE-K self-adaptive autorouter.

## Architecture

```
                                +---------------------------+
                                | Legacy Problem Synthesizer|
                                | (bim-generator / Python)  |
                                +-------------+-------------+
                                              |
                                              v
+------------------------+      +---------------------------+
| Multi-Engine Manifests | ---> | Compatibility Resolver    |
+------------------------+      +-------------+-------------+
                                              | (Capability Intersection)
                                              v
                                +---------------------------+
                                | BIM v1 Postprocessor      |
                                | - 6-Resource Assembly     |
                                | - Empty Branch Repair     |
                                | - Probability Normalizing |
                                | - Witness Feasibility (τ) |
                                +-------------+-------------+
                                              |
                                              v
                                +---------------------------+
                                | BIM v1 Package Compiler   |
                                +-------------+-------------+
                                              |
                                              v
                   +--------------------------+-------------------------+
                   |                                                    |
                   v                                                    v
      +-------------------------+                          +--------------------------+
      | Platform Persistence    |                          | MAPE-K Autorouter        |
      | - InstanceSnapshot      |                          | - Feature Vector x(P)    |
      | - BindingCase / Revision|                          | - Hypervolume / HVR      |
      | - Collection / Items    |                          | - Surrogate Calibration  |
      +-------------------------+                          +--------------------------+
```

## API Endpoints

All endpoints are mounted under `/v1/generator`.

### 1. `POST /v1/generator/instances`
Generates a single valid BIM v1 instance package.

- **Request Body (`GenerateInstanceRequest`)**:
  - `tasks`: Number of abstract tasks (default: 10, min: 2, max: 1000).
  - `candidates`: Concrete candidates per task (default: 5, min: 2, max: 100).
  - `control_flow`: Percentage of control flow structures (0-90%).
  - `loops`, `branches`, `parallel`: Relative percentages of control flow types.
  - `max_nesting`: Max control structure nesting depth (1-10).
  - `iterations_per_loop`: Average loop iterations.
  - `qos_properties`: Number of QoS dimensions (1-5).
  - `constraints`: Number of global constraints.
  - `target_engines`: List of target engine IDs (e.g. `["minizinc-csp"]`, `["many-heuristic"]`).
  - `optimization_mode`: Explicit override (`weighted` or `pareto`).
  - `guarantee_feasibility`: Ensure at least one feasible solution exists (default: `true`).
  - `tension`: Feasibility tension factor $\tau \in [0, 1]$ (default: 0.7).
  - `persist`: Persist as `InstanceSnapshot` in DB (requires authentication).
  - `project_id`: Project UUID to create a `BindingCase`.
  - `use_legacy_engine`: Flag to invoke the Java `bim-generator` CLI.

- **Engine Compatibility**:
  If specified engines have disjoint capabilities (e.g. `minizinc-csp` requiring mono-objective `weighted` vs `many-heuristic` requiring `pareto`), the request fails with HTTP 422 and error code `incompatible_target_engines` with explicit conflict diagnostics.

- **Response (`InstanceGeneratedResponse`)**:
  Contains `name`, `package_digest`, `instance_digest`, `compilation_digest`, `workload_features`, `snapshot_id`, `case_id`, and the complete JSON documents for the 6 BIM v1 resources.

### 2. `POST /v1/generator/corpus`
Synthesizes a corpus of instances across parameter sweeps.

- **Request Body (`GenerateCorpusRequest`)**:
  - `count`: Number of instances to generate.
  - `base_config`: Template `GenerateInstanceRequest`.
  - `as_archive`: If true, returns an `application/zip` stream of `.bim.zip` packages.
  - `persist`: Persist as a `Collection` with `CollectionRevision` and `CollectionItem`s.
  - `project_id`: Project UUID for collection.

### 3. `POST /v1/generator/convert-legacy`
Converts legacy raw text format (e.g. `pruebatonta.txt`) into a BIM v1 package.

- **Request Body (`ConvertLegacyRequest`)**:
  - `raw_text`: Legacy problem definition text.
  - `guarantee_feasibility`: Witness feasibility enforcement.
  - `tension`: Constraint tension parameter $\tau$.
  - `repair_empty_branches`: Automatic empty branch repair.

### 4. `POST /v1/generator/calibrate-engine`
Calibrates empirical surrogate models for black-box or federated engines.

- **Request Body (`CalibrateEngineRequest`)**:
  - `engine`: Solver identifier.
  - `mode`: Solver mode.
  - `observations`: Historical run observations with `workload_features`, `latency`, `quality` (hypervolume), and `success`.

- **Calibration Computation**:
  - Computes exact 2D or Monte Carlo $M$-D hypervolume and Hypervolume Ratio (HVR).
  - Performs OLS regression with Tikhonov regularization on log-latency ($\log \hat{L}$), quality ($\hat{Q}$), and failure risk ($\hat{F}$).
  - Persists fitted models in `v1_engine_profile_surrogates`.
  - Injects calibrated surrogates into `EngineProfiler` to override static default estimates in the MAPE-K autorouter loop.

## Witness Feasibility Formulation

Given a synthesized instance with candidates $C_i$ for task $i$, a witness configuration $b^*$ is selected. For each constrained metric $m$ with domain $[d_{min}, d_{max}]$ and aggregated witness value $v_{witness} = \mathcal{A}(b^*, m)$:

- If metric $m$ is minimized:
  $$\text{bound} = v_{witness} + (1 - \tau) \cdot (\max(d_{max} \cdot |T|, 1.5 \cdot v_{witness}) - v_{witness})$$
  Constraint: $\text{metrics}.m \le \text{bound}$
- If metric $m$ is maximized:
  $$\text{bound} = v_{witness} - (1 - \tau) \cdot (v_{witness} - \min(d_{min}, 0.5 \cdot v_{witness}))$$
  Constraint: $\text{metrics}.m \ge \text{bound}$

Setting $\tau = 1.0$ produces the tightest feasible bound matching the witness solution, while $\tau = 0.0$ relaxes the constraint to maximum slack.
