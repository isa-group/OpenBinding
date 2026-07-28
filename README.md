# OpenBinding

OpenBinding is a QoS-aware service composition gateway and solver engine framework. It provides a unified interface to model and solve service composition problems using various underlying optimization engines.

> Looking for **OpenBinding4Placement**? See the full documentation and experimental pipeline in [`experimentation/icsoc/README.md`](experimentation/icsoc/README.md).

## 🏗️ Architecture

```mermaid
flowchart TD
    U[User / Frontend]:::client

    U -->|HTTP POST /v1/solve| G[OpenBinding Gateway]:::gateway

    G --> V0[Validate request envelope]:::step
    V0 --> V1[Validate basic composition schema]:::schema
    V1 --> R{Root router: route by engine_id}:::router

    R -->|minizinc-csp| SZ_MZ[Validate specialization schema: MiniZinc]:::schema
    R -->|random-search| SZ_RS[Validate specialization schema: Random Search]:::schema
    R -->|many-heuristic| SZ_MH[Validate specialization schema: Many-Heuristic]:::schema

    SZ_MZ --> MZ[MiniZinc CSP engine]:::engine
    SZ_RS --> RS[Random Search engine]:::engine
    SZ_MH --> MH[Many-Heuristic engine]:::engine

    MZ -->|solve| SOL[(Solution)]:::solution
    RS -->|solve| SOL
    MH -->|solve| SOL

    SOL --> G
    G -->|HTTP 200 result| U
```

## 🧩 Components

1.  **OpenBinding Gateway** (`openbinding-gateway`):
    *   Python FastAPI service acting as the central entry point.
    *   Handles schema validation (General & Specialization).
    *   Routes requests to appropriate engines.
    *   Provides analysis and diagnostics tools.

2.  **MiniZinc CSP Engine** (`engines/minizinc-csp`):
    *   TypeScript/Node.js service.
    *   Transforms problems into MiniZinc models.
    *   Solves using the Gecode constraint solver.
    *   Best for exact solutions to smaller/medium problems.

3.  **Random Search Engine** (`engines/random-search`):
    *   Java service.
    *   Uses random search (seeded and reproducible on the BIM′ path).
    *   Best for exploring large solution spaces; serves as the experimental baseline.

4.  **Many-Heuristic Engine** (`engines/many-heuristic`):
    *   Java service (extends Random Search).
    *   Specialized for **Many-Objective** problems (3+ objectives).
    *   Returns a **Pareto front** of non-dominated solutions.

5.  **Evolutionary Heuristics Engine** (`engines/evolutionary-heuristics`):
    *   Java service built on jMetal (NSGA-II / NSGA-III).
    *   MONO mode folds Deb's feasibility rules into the scalar objective and
        tracks the best individual ever evaluated (anytime behavior).

6.  **Frontend** (`frontend`):
    *   React + Vite web UI for modeling and submitting problems.
    *   Multi-page SPA with professional design inspired by modern developer tools.
    *   **Features**:
        - **Home**: Landing page showcasing OpenBinding features and engines
        - **Playground**: Interactive workspace with JSON editor, engine selector, and result visualization
        - **Engines Explorer**: Browse and compare solver engines with capabilities
        - **Schema Explorer**: Interactive JSON schema viewer with search and navigation
        - **Light/Dark Theme**: System-aware theme with persistence

## 📐 Schemas & Specification

OpenBinding validates incoming requests against two schema layers:

1. **General schema** (engine-agnostic):
    - JSON Schema (structural validation): `schemas/general/schema.json`
    - Visual model (Mermaid): `schemas/general/schema.mermaid`
    - Specification / semantics (human-readable): `schemas/general/schema.specification.md`

    The specification document explains the intent and semantics behind the JSON Schema, including:
    - The instance model (tasks, candidates, providers, features)
    - Workflow modeling (`composition` as structured tree or DAG)
    - QoS aggregation and normalization (`aggregation_policies`)
    - Constraints and objectives, plus invariants that require a second validation pass

2. **Specialization schemas** (engine-specific constraints):
    - `schemas/specializations/minizinc-csp.schema.json`
    - `schemas/specializations/random-search.schema.json`
    - `schemas/specializations/many-heuristic.schema.json`

   Specializations can also include a visual model in Mermaid format (recommended):
    - `schemas/specializations/minizinc-csp.schema.mermaid`
    - `schemas/specializations/random-search.schema.mermaid`
    - `schemas/specializations/many-heuristic.schema.mermaid`

   Mermaid models are used by the frontend **Schema Explorer** in the **Model** tab. If a specialization does not provide `.schema.mermaid`, the JSON schema workflow remains fully functional.

Example payloads that follow these schemas live in `examples/`.

### Placement extension (OpenBinding4Placement)

**OpenBinding4Placement** is the placement-aware extension of OpenBinding used to solve
**CLASP-FaaS** — the Cost- and Latency-Aware Secure Placement of FaaS Compositions — by
formulating it as a placement-aware QACO problem (QACO′).

Placement is **not a separate problem or a separate schema**: `resource_model` and
`latency_model` are optional blocks of the general schema. An instance that omits them is a
plain binding problem; an instance that provides them adds constraints over the very same
decisions, and engines that support them take them into account natively. The blocks add
**placement semantics** for FaaS-orchestration binding over the Cloud-Edge continuum:

- **`resource_model`** — infrastructure pools with capacities, per-candidate pool bindings and
  resource demands, and `RESOURCE_CAPACITY` constraints (cumulative bin-packing per node).
- **`latency_model`** — a pool-to-pool latency matrix, event generators, pairwise transition
  latency bounds, and an end-to-end latency attribute defined as the **expected makespan over the
  XOR scenarios** of the composition (critical-path scheduling on the precedence DAG).
- **Canonical normalization** — per-feature min–max bounds embedded in the instance
  (`aggregation_policies.<id>.normalize`), so every engine optimizes and reports the same
  normalized weighted objective. Declaring it for every objective target is what selects the
  canonical objective — a weighted mean of per-feature losses, lower is better — independently
  of whether the instance carries placement blocks. Instances that declare none keep the plain
  weighted sum of normalized goodness, where higher is better.
- **Dependency extensions** — `SAME_POOL` / `DIFFERENT_POOL` co-location constraints, which
  require a `resource_model` declaring pools.

The reference implementation of these semantics lives in the gateway
(`openbinding_gateway/validation/engine_plugins/reference_evaluator.py`); solutions of instances
that declare canonical normalization are re-evaluated against it. All engines support shared **wall-clock time budgets** (`time_budget_ms`) with anytime
best-so-far traces; the exact engine additionally reports its incumbent trace and completion status
(`OPTIMAL` / `SATISFIED` / `UNSATISFIABLE` / `UNKNOWN`).

## 🔬 Experimentation

The OpenBinding4Placement experimental campaign — solving CLASP-FaaS as QACO′ (dataset
transformation, priced BIM′ corpus, campaign runner and evaluation notebooks) — is documented in
[`experimentation/icsoc/README.md`](experimentation/icsoc/README.md), supporting the paper
*QoS-aware Placement of FaaS Compositions in the Cloud-Edge Continuum*.

## 🚀 Getting Started

### Prerequisites

*   **Docker** and **Docker Compose**
*   (Optional) Python 3.11+ for local development

### Installation & Running

1.  **Configure environment variables**:
    ```bash
    cp .env.example .env
    ```

2.  **Start development stack**:
    ```bash
    COMPOSE_PROFILES=dev docker compose up --build
    ```

    Development services:
    *   **Nginx (local)**: [http://localhost:80](http://localhost:80)
    *   **Frontend dev server**: [http://localhost:5173](http://localhost:5173)
    *   **Gateway API docs**: [http://localhost:8000/docs](http://localhost:8000/docs)

3.  **Start production stack**:
    ```bash
    COMPOSE_PROFILES=prod docker compose up --build -d
    ```

    Production notes:
    *   **Nginx** listens on ports **80/443**.
    *   `frontend-prod` generates static assets; only Nginx serves them publicly.
    *   Place TLS files in `nginx/ssl/` (or override `NGINX_SSL_DIR`) with names:
        - `fullchain.pem`
        - `privkey.pem`
    *   Gateway is exposed only internally behind Nginx.
    *   Take into account that the production environment is currently configured for `openbinding.score.us.es` and `openbinding.us.es` domains (the domains where we are hosting the service in production). You may need to manually adjust nginx and docker compose configurations for your own domain or local testing.

4.  **Stop the Stack**:
    ```bash
    docker compose down
    ```

### 💻 Local Development (No Docker)

If you have the necessary runtimes installed (Python 3.11+, Node.js 20.19+, Java 17+, and Maven), you can run the components locally for faster development:

1.  **Gateway** (Python):
    ```bash
    cd openbinding-gateway
    # Install dependencies with 'test' extras
    uv pip install -e ".[test]"
    # Run the gateway
    uvicorn openbinding_gateway.main:app --host 0.0.0.0 --port 8000
    ```

2.  **Frontend** (React + Vite):
    ```bash
    cd frontend
    # Install dependencies (requires Node.js 20.19+ or 22.12+)
    pnpm install
    # Set API URL (optional, defaults to http://localhost:8000)
    echo "VITE_API_BASE_URL=http://localhost:8000" > .env
    # Run development server
    pnpm run dev -- --host 0.0.0.0 --port 80
    ```
    The frontend will be available at [http://localhost:5173](http://localhost:5173)

3.  **MiniZinc CSP Engine** (Node.js + MiniZinc):
    - Requirements: [MiniZinc](https://www.minizinc.org/) installed and in system PATH.
    ```bash
    cd engines/minizinc-csp
    npm install
    npm run dev
    ```

4.  **Random Search Engine** (Java + Maven):
    ```bash
    cd engines/random-search
    # Build and run
    mvn compile exec:java -Dexec.mainClass="es.us.isa.qosawarewsbinding.Controller"
    ```

---

## 🛠️ Validation & Testing

OpenBinding implements a rigorous multi-stage validation process:
1.  **General Schema**: Ensures the input adheres to the simplified QoS specification structure.
2.  **Specialization Schema**: Enforces engine-specific constraints (e.g., supported composition types, constraints).
3.  **Semantic/Logic**: Checks for consistency (e.g., undefined tasks, valid IDs).
4.  **Analysis**: Computes binding space cardinality and generates warnings for potential issues.

### Enhanced Validation Responses

The gateway now returns structured validation errors and warnings:

- **`/v1/analyze`**: Returns detailed warnings with `code`, `message`, and `details` (including `path`, `constraint_id`, `stage`)
- **`/v1/solve`**: Returns HTTP 422 on validation failure with structured violations in the same format

### Running Tests (Docker)

To run the complete test suite in the Docker environment:

```bash
# 1. Ensure stack is running
COMPOSE_PROFILES=dev docker compose up -d

# 2. Run all tests
docker compose exec gateway-dev test

# 3. Run specific test file
docker compose exec gateway-dev test tests/test_analysis.py -v
```

### Running Tests (Local)

If running **locally** without Docker:

```bash
cd openbinding-gateway
pytest
# Or run with verbose output
pytest -v
# Or run specific tests
pytest tests/test_validation_comprehensive.py -v
```

**Test Coverage**: 60 tests covering validation, analysis, routing, and integration with engines.

## 📝 Usage Example

Submit a problem to the MiniZinc engine:

```bash
curl -X POST "http://localhost:8000/v1/solve" \
     -H "Content-Type: application/json" \
     -d '{
           "engine_id": "minizinc-csp",
           "verbose": true,
           "instance": { ... JSON content ... }
         }'
```

See `examples/` directory for sample payloads.

## 🧭 Engine Integration Guide

If you are adding a new engine, see [docs/ENGINE_INTEGRATION_GUIDE.md](docs/ENGINE_INTEGRATION_GUIDE.md).

## 🤝 Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for branch and PR rules.

## 📄 License

This project is licensed under the **Creative Commons Attribution 4.0 International (CC BY 4.0)**.
See the [LICENSE](LICENSE) file for details.