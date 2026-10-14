# Acceptance probe of `bim-service` in process mode, in the real demo

`openbinding-gateway/tools/process_probe.py` checks, from inside the lab network, that `bim-service` running with
`BIM_SERVICE_EXECUTOR=process` (profile N2 of `compose.lab-process-n2.json`: body 2 MiB, 2 slots, memory budget 16 MiB,
pending bodies 4 MiB, acquire timeout 2000 ms; `docs/qa/PROCESS_DEPLOYMENT.md`) behaves in the container as its
documentation says. It is a tool of the gateway image, so it runs with `lab_compose seed` and needs nothing new installed.

**Status: written and tested against an in-process service, not yet run in the real demo.** The tests
(`openbinding-gateway/tests/test_process_probe.py`) serve a real `bim_service` application with uvicorn on a loopback
port, once with the thread executor and a costly operation replaced by a sleep, and twice with real worker processes
(including a run of every step plus the timeout probe with the N2 figures). Nothing was measured in a 256 MiB container
with 1.5 CPUs; the figures that depend on that are for the coordinator to read from the report and from
`lab_compose metrics`.

What it touches: only `bim-service`, only its public routes, limits and inputs, with synthetic data. No call to the
gateway, the database, SPACE or SPHERE; no test hook of the service; nothing is written anywhere. The bearer token is
read from `BIM_SERVICE_TOKEN_FILE` (`/run/bim/token`, written by the `seed` command) and never printed.

## Files

| File | What |
| --- | --- |
| `openbinding-gateway/tools/process_probe.py` | the probe (stdlib `http.client`; `bim_core` and `bim_client` of the image to build and check the synthetic data) |
| `compose.lab-process-n2-probe.json` | `compose.lab-process-n2.json` byte for byte plus `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS=3` for `bim-service` |
| `lab/tests/test_lab_process_probe_profile.py` | static checks of that manifest (the rules of the process profiles, and "N2 plus one line") |
| `openbinding-gateway/tests/test_process_probe.py` | tests of the probe |

## How to run it

The `seed` service runs `python tools/${DEMO_SEED_TOOL} ${DEMO_SEED_ARGS}` in the gateway image. **`lab_compose seed` uses
the environment saved by the last `up`** (`docs/DEMO.md`): to change `DEMO_SEED_TOOL` or `DEMO_SEED_ARGS`, repeat `up`
with the new values and then run `seed`. `DEMO_SEED_ARGS` is split by the shell: write the options separated by spaces,
without quotes inside.

Acceptance of the N2 profile (everything except the timeout; the figures of N2 are the defaults of the probe):

```
lab_compose validate file=compose.lab-process-n2.json
lab_compose up file=compose.lab-process-n2.json      # with DEMO_SEED_TOOL=process_probe.py DEMO_SEED_ARGS=--summary
lab_compose seed
lab_compose metrics
```

With the real timeout and replacement (the probe manifest shortens the time budget of an operation from 60 s to 3 s;
everything else is N2):

```
lab_compose validate file=compose.lab-process-n2-probe.json
lab_compose up file=compose.lab-process-n2-probe.json  # DEMO_SEED_TOOL=process_probe.py DEMO_SEED_ARGS="--timeout-probe --hold 20 --summary"
lab_compose seed
lab_compose metrics
```

Go back to the demo's normal profile with `lab_compose up file=compose.lab-process-n2.json` (or `compose.lab.json` for the
thread laboratory). Only `bim-service` differs between the two N2 files; the volumes and the data are shared.

Options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `--steps a,b,c` / `all` / `none` | `all` | which steps to run (names below); `none` needs `--timeout-probe` |
| `--timeout-probe` | off | also run `timeout_replacement`; the service must have `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS=3` |
| `--hold SECONDS` | 0 | pause between steps and between the phases of the timeout step, to sample `lab_compose metrics` |
| `--summary` | off | stdout is ONE compact JSON line (failed checks, key figures, timeline); the full report goes to stderr |
| `--repeat N` | 2 | times each valid operation is repeated; the answers must be identical |
| `--expect-executor`, `--expect-max-body-bytes`, `--expect-concurrency`, `--expect-tenant-limit`, `--expect-acquire-timeout-ms`, `--expect-memory-budget-bytes`, `--expect-pending-body-bytes`, `--expect-operation-timeout` | N2 (60 s, or 3 s with `--timeout-probe`) | the profile under test; each also reads `PROBE_EXPECT_<NAME>` (for example `PROBE_EXPECT_MAX_BODY_BYTES`) |
| `--container-memory-bytes` | 268435456 | `memory.max` of `bim-service`, for the fit rule |
| `--cost-seconds`, `--load-seconds` | 1.0, 6.0 | solo duration aimed at for the costly request; how long `/healthz` is sampled under load |
| `--cost-body-fraction` | 0.7 | the costly request may use this fraction of the body limit |
| `--healthz-p95-ms`, `--healthz-max-ms` | 500, 2500 | limits for `/healthz` under load (the lab healthcheck times out at 3000 ms) |
| `--no-at-limit` | off | do not send a body of exactly the advertised limit |
| `--url`, `--token-file` | `$BIM_SERVICE_URL` or `http://bim-service:8080`; `$BIM_SERVICE_TOKEN_FILE` or `/run/bim/token` | |

To test another profile, give its figures (for the 6 MiB profile: `--expect-max-body-bytes 6291456 --expect-concurrency 1
--expect-memory-budget-bytes 50331648 --expect-pending-body-bytes 12582912 --expect-acquire-timeout-ms 3000`).

## What it verifies

Each step is independent (a failure never stops the next) and is a list of checks, each with what was **expected** and what
was **observed**.

| Step | Expected |
| --- | --- |
| `capabilities` | `GET /bim/v1/capabilities`: `limits.service.executor` is `process` and `maxBodyBytes`, `maxConcurrentOperations`, `maxConcurrentOperationsPerTenant`, `acquireTimeoutMs`, `memoryBudgetBytes`, `maxPendingBodyBytes`, `operationTimeoutSeconds` are the profile's. It advertises no larger body than the profile, a budget that admits a request at the limit (8 x body) and limits that fit the container by the fit rule with the conservative parent (60 MiB) and worker (54 MiB) sizes of `PROCESS_DEPLOYMENT.md` (N2: 261724569 of 268435456 bytes). `/healthz` and `/readyz` are 200 without a token. |
| `valid_operations` | compile, validate (valid and with a diagnostic), compatibility, optimization, evaluate, re-evaluate (agreement and discrepancy), validate-result, neighborhood, engine and resource validation and XML root, on the synthetic package of the consumer contract. Status as in the contract, **identical answers in every repetition**, the digests the contract records (`packageDigest`, `instanceDigest`, `inputDigest`, semantic digest of the IR) and every answer equal to what `bim_core` of the probe's image computes (`irDigest`, `compilationDigest` and `toolchain` are left out, as the contract does). |
| `hostile_small` | invalid JSON, empty body, NaN, Infinity, an unknown member, 20000 levels of nesting, invalid UTF-8, a truncated and a garbage ZIP, XML with a DTD, entity expansion and malformed XML, invalid base64, `text/plain`, a multipart without boundary, no token (also with a body), a wrong token, an unknown route, a wrong method, an unknown schema: the status and `code` of thread mode (`422 request_invalid`, `422 package_error`, `400 http_error`, `415`, `401`, `404`, `405`), as `application/problem+json` without a traceback (`WWW-Authenticate` on 401, `Allow` on 405). Then the service is still healthy and serves a normal operation. |
| `large_bodies` | `Content-Length` of limit + 1 and of 1 GiB: `413 payload_too_large` with the connection closed, in under 5 s, **without a byte of the body sent**; a chunked body that crosses the limit: `413 payload_too_large`; a chunked body under it: 200; a body of exactly the limit: 200; as many bodies in flight (declared, half sent, held open) as `maxPendingBodyBytes` allows plus one more declared: `429 pending_body_bytes` with `Retry-After`; the held bodies then finish with 200, `429 memory_budget` or `503 service_busy`; and the bytes were given back (the same body alone is served). Then healthy again. |
| `saturation` | 8 x slots concurrent costly valid requests: some are refused with `503 service_busy` or `429` (`memory_budget`, `pending_body_bytes`, `rate_limited`) carrying `Retry-After`, some are served, and **nothing else** happens (no other 5xx, no timeout, no dropped connection); then a normal request is served. |
| `healthz_under_load` | for `--load-seconds`, 2 x slots clients keep costly valid requests running while `/healthz` is requested every 50 ms: every answer 200, p95 and max under the limits, `/readyz` 200, the load really ran. The report gives the samples, p50, p95 and max. |
| `timeout_replacement` | (`--timeout-probe`) see below. |

Not verified, and why: `413 pending_body_too_large` and `413 memory_budget_exceeded` cannot happen in N2 (the pending limit is
not below the body limit and the budget is exactly 8 x body); `429 memory_budget` is accepted where bodies overlap but not
forced; a worker killed from outside (500 `internal_error`) and a client that goes away mid-request need access to the
container and are for the coordinator.

### The costly valid operation, and the timeout step

The probe needs a valid request that costs CPU in proportion to its size. It sends `POST /bim/v1/neighborhood` with
`limit` 128 on a synthetic IR that it compiles with the `bim_core` of its own image: a chain of N service tasks, two
candidates and four features each. The service re-validates the whole IR against its schema and then evaluates up to 128
one-task alternatives, so the duration grows with N. The probe **measures** a request alone and grows N until it lasts as
long as the step needs, or until the body would pass `--cost-body-fraction` of the body limit (it never sends more).
For the saturation and `/healthz` steps the target is `--cost-seconds` (`seconds` of the request is the same, so the
evaluation stops there); for the timeout step the request carries `seconds` 10, the ceiling of the service, and N grows until
the first `503 operation_timeout`. The calibration is in `observations.calibration` and `observations.timeoutCalibration`
(each request, its size and its duration). If the calibration cannot reach the budget within the body cap, the step says so
and fails; raise `--cost-body-fraction` (up to 0.95) at the price of more memory in the worker (the memory budget charges
8 x the body).

Figures from the development machine, with the N2 limits and real workers (16 CPUs, not the lab container): N = 60 gave a
70 KB body and 0.16 s; N = 361 a 393 KB body and 1.6 s; N = 996 a 1.07 MB body and `503 operation_timeout` after 3.01 s.
The container has 1.5 CPUs, so it should be slower per byte, never faster.

`timeout_replacement` (the service must publish `operationTimeoutSeconds` 3):

1. `timeout:baseline`: a normal request is served.
2. `timeout:calibrate:*`: the ladder above. **It may itself cause one timeout** (its last request is the first that exceeds
   the budget); the timeline shows it. Then, if `--hold` is given, `hold:timeout:before-request:*`.
3. `timeout:request:*`: the request over the budget is sent again. Expected: `503 operation_timeout` as
   `application/problem+json` after about 3 s (accepted: 2.7 to 6 s); `/healthz` sampled every 100 ms during it is 200 every time;
   with two slots or more, normal requests every 0.5 s during it are served by the other slot.
4. `timeout:replacement:*` (after `hold:timeout:after-request:*`): the next normal request succeeds (a replacement worker
   serves it), ten more do, and a real operation (`validate` of the demo package) does. Then `/healthz`, `/readyz` and a
   normal request.

`observations.timeline` (and the `PHASE` lines on stderr) hold `monotonic` (`time.monotonic()` of the seed container) and
`epoch` seconds of every phase, and `details.timeout` those of the request itself, so that the coordinator can place the
samples of `lab_compose metrics` against them.

## Reading the output

Full mode: one JSON document on stdout, `{"tool", "ok", "baseUrl", "steps": [...], "observations": {...}}`. Every step has
`name`, `ok`, `failed` (the names of the failed checks), `checks` (`name`, `ok`, `expected`, `observed`), `details` (figures: outcomes
of the burst, `/healthz` p50/p95/max, the fit rule, the timeout) and its `startedMonotonic`, `startedEpoch` and `elapsedMs`.
`observations` has the published limits, what was expected, the steps skipped, the calibration, the timeline, whether the
`bim_core` of the probe has the same compiler digest as the service (`toolchainMatchesProbe`; if not, the digests of
`irDigest` differ and the comparison with `bim_core` is of another toolchain) and the elapsed seconds.

`--summary`: the last (only) line of stdout is the same without the passing checks (at most 8 failed checks per step, with
`expected` and `observed` shortened), and the timeline as `[label, epoch]` plus `timelineEpochMinusMonotonic`
(`monotonic = epoch - that`); `hold:before:<step>:*` is left out because it is the end of the previous step and the start of
`<step>`. The full report is on stderr after the `PHASE` lines. Use it when the runner keeps only the tail of the output
(about 5000 characters; a test requires the compact line of a complete run with the timeout step to be under 5000).

**Exit code**: 0 when every step that ran met every expectation, 1 when any did not, 2 on a configuration error (no token,
a wrong option; a JSON with `error` is printed).

## Criterion of success

The acceptance of the profile in the demo is:

1. Exit code 0 and `"ok": true`, with no step skipped that was asked for (`observations.skipped` lists the rest). For the
   timeout, run the probe manifest with `--timeout-probe` and the same condition.
2. In `lab_compose metrics`, around the phases of the timeline: `oom_kill` in `memory.events` of the `bim-service` container still
   0; `memory.peak` below `memory.max` (268435456); never more than 2 worker children plus the parent, no zombies; the
   container healthy (`status`) and the same parent PID before and after. The probe cannot see these.
3. After the timeout step, the worker that was killed is gone and the pool is back to 2 children; `logs bim-service` shows
   a `worker_exit` line for it (the format is in `bim-toolchain/docs/SERVICE.md`) and no `ServiceConfigError`.

A check that fails is information about the container, not necessarily a defect of the service: read `expected` against
`observed` and the figures in `details` before concluding. For example a `/healthz` p95 over its limit under load is a
measurement of the container, and the limits are options.

## Assumptions

- The gateway image's `bim_core` is the one `bim-service` was built from (same repository); `toolchainMatchesProbe` says
  whether it is.
- The files of `bim-toolchain/contracts/consumers/openbinding/` are not in the gateway image, so the probe carries the demo
  package and the Engine manifest of the contract in its source and pins the four digests; `test_process_probe.py` fails if
  they stop being the contract's.
- The fit rule uses the conservative sizes of `PROCESS_DEPLOYMENT.md`, which are assumptions; the real ones are in
  `lab_compose metrics`.
