# Multi-objective heuristic engine

This is the federated counterpart of `many-heuristic`. It uses the same seeded
sampling and bounded non-dominated archive, but accepts only canonical
`BindingProblem` IR with `optimization.type: MULTI`, `mode: pareto`, and two or
three objective terms. Placement remains optional in the IR; when present the
shared `binding-core` evaluator applies it to every sampled decision.

The synchronous deployment implements `bim-engine/v1` at
`POST /internal/v1/binding-problems`, plus `GET /health` and a protocol-pinned
`GET /openapi.json`. Options are `iterations`, `archive_size`, `seed`, and
`time_budget_ms`. Successful runs terminate as `FEASIBLE`; an empty feasible
archive terminates as `UNKNOWN`.

Unlike the engines in `schemas/bim/v1/manifests`, this one is not installed by
the gateway. Build it with the JVM reactor or start the standalone example:

```bash
docker compose --profile federated-example up --build engine-multi-heuristic
```

The Compose port is plain HTTP on `localhost:8081` for local inspection. A real
federated registration must expose it through an HTTPS origin. The complete
publication example is in
[`examples/federation/multi-heuristic`](../../examples/federation/multi-heuristic).
