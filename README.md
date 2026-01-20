# OpenBinding

OpenBinding is a QoS-aware service composition gateway and solver engine.

## Structure

- `openbinding-gateway/`: Python FastAPI gateway services.
- `engines/minizinc-csp/`: TypeScript/Node.js MiniZinc CSP solver engine.
- `schemas/`: JSON Schemas for problem instances and engine specializations.
- `examples/`: Example JSON payloads.

## usage

### Prerequisites

- Docker & Docker Compose

### Running

```bash
docker compose up --build
```

### API

- **Solve**: `POST /v1/solve`

```bash
curl -X POST -H "Content-Type: application/json" -d @examples/minimal-1task.json http://localhost:8000/v1/solve
```