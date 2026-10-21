# Multi-objective heuristic engine

This is the federated counterpart of `many-heuristic`. It uses the same seeded
sampling and bounded non-dominated archive, but accepts only canonical
`BindingProblem` IR whose request asks for the execution optimization
`type: MULTI` with `scalarization: pareto-front` (IR 0.2.0 stores only
`criteria` and `penalties`; the objective type and scalarization travel in the
request) over two or three criteria. Placement remains optional in the IR; when
present the shared `binding-core` evaluator applies it to every sampled decision.

The synchronous deployment implements `bim-engine/v1` at
`POST /internal/v1/binding-problems`, plus `GET /health` and a protocol-pinned
`GET /openapi.json`. Options are `iterations`, `archive_size`, `seed`, and
`time_budget_ms`. Successful runs terminate as `FEASIBLE`; an empty feasible
archive terminates as `UNKNOWN`.

## Asynchronous mode (opt-in)

By default the service is synchronous, listens on `PORT` (default `8080`) and
serves the pinned `openapi.json` byte for byte. With `ENGINE_JOB_MODE=async` the
same POST answers `202` with a job id, `GET /internal/v1/jobs/{id}` reads the job
and `DELETE` cancels it (the job is reported `cancelled` only once the solver
thread has returned), and `/openapi.json` becomes that same document plus the job
endpoints and `extensions.cancellation = {supported: true, idScope: "attempt"}`.
`ENGINE_AUTH_TOKENS=tenant=token,...` makes jobs private to the tenant that
submitted them. See
[`docs/qa/ENGINE_CANCELLATION_JAVA.md`](../../docs/qa/ENGINE_CANCELLATION_JAVA.md).
The pinned file is not edited: the extension is added when the document is served.

Unlike the engines in `schemas/bim/v1/manifests`, this one is not installed by
the gateway. Build it with the JVM reactor or start the standalone example:

```bash
docker compose --profile federated-example up --build engine-multi-heuristic
```

The Compose port is plain HTTP on `localhost:8081` for local inspection. A real
federated registration must expose it through an HTTPS origin. The complete
publication example is in
[`examples/federation/multi-heuristic`](../../examples/federation/multi-heuristic).
