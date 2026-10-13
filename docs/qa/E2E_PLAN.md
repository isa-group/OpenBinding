# End-to-end plan: API smoke test of the lab demo

**Status: `tools/smoke_lab.py` ran once against the lab (stack healthy, web OK); the corrected version has not.**
It was written without a Docker daemon and tested against a simulated gateway
(`tools/tests/test_smoke_lab.py`, `httpx.MockTransport`). The first real run passed `proxy_and_spa`, `cors`,
`body_limit` and `login_throttle` and failed the rest, for two reasons, both now handled:

- **`GET /v1/users/me` answered 503 for all five users.** The profile reads the plan through
  `get_gate().caps()` (`routes/users.py`); `SpacePricingGate.caps()` raises `PricingUnavailable` when SPACE gives
  no entitlements token or no contract, and the route turns it into `503 pricing_unavailable`. This is the
  intended fail-closed behaviour (`space_client/gate.py`), not a bug, and the real SPACE had no service or
  contract for the synthetic users. The smoke now reports such a step as `ok: false, blockedByRemote: true`
  (reason: "SPACE has no service/contract for the synthetic users; run seed_lab --space-contracts after
  remote_provision --apply") and counts it under `blocked`, apart from `failed`; exit code 3.
- **`POST /v1/jobs` answered 422 `optimization_required` and the study creation 422 `validation_error`.** The
  package `examples/demo/01_simple_seq` is fine (its `optimization.json` declares the criterion `latency`). What
  was missing is the *execution-time* selection the request must carry: `"mode": "seeded"` and
  `"optimization": {"type": "SINGLE", "scalarization": "weighted-sum"}` (equal weights are filled in by the
  toolchain). A study needs the same two fields inside every `definition.engines[]` item. The smoke sends them.
  The gateway resolves the optimization before it reads the plan, so once the 422 was fixed the next answer for
  a user without a contract is the 503 above.

## What the smoke covers

One run goes through the nginx proxy (`web`, port 8080 inside the lab network) the way the browser does,
using only the users `tools/seed_lab.py` created (names and roles in `docs/DEMO.md`). It prints **one JSON
document** with `{name, ok, blockedByRemote, detail}` per step and exits 0 (all passed), 1 (a step failed),
2 (configuration: no `DEMO_SEED_PASSWORD`) or 3 (nothing failed, but at least one step was blocked by the
remote, see below). A failing step never stops the next one. It prints no password, token or header.

`blockedByRemote: true` means the step met `503 pricing_unavailable` (the gateway could not read the account's
plan) and could not be judged; `ok` stays `false`. The summary has `failed` (real failures), `blocked` and
`blockedSteps`. Steps that need a plan (2 `login`, 3, 4, 5, 6 and 10) are the ones that can be blocked; what in
them does not depend on the plan is still checked, and a real failure in the same step makes it a failure, not a
block. The 503 text cannot tell "no contract" from "SPACE unreachable" (`SpacePricingGate._call` wraps both), so
the detail carries the server's message and `remote_probe.py` settles it.

| # | Step | What is asserted |
| --- | --- | --- |
| 1 | `proxy_and_spa` | `GET /healthz` is `ok`; `GET /` is the SPA's HTML; a made-up deep route returns the same index (SPA fallback); `GET /api/health/ready` is 200 `ready` |
| 2 | `login` | `POST /api/v1/auth/login` for admin, owner, member, viewer, outsider returns a Bearer token; `GET /api/v1/users/me` shows the username and the platform role (`admin` / `user`) |
| 3 | `owner_job` | owner profile; `lab-main` shows `OWNER`; project `bim-demo` visible; a `random-search` job (`mode: seeded`, `optimization` SINGLE / weighted-sum, 10 iterations, seed 1) on the **seeded** snapshot of case `simple-seq` reaches `completed` within 120 s; result has `termination`, and per solution `decision.binding`, `features`, `objectives`, `penalties`, `violations`; the provenance names `bim-reference-evaluator` with its digest and pins compiler and IR; `engineReported` is kept apart from the authoritative values; if the provenance has a field with "toolchain" in its name it is reported |
| 4 | `idempotency` | same `Idempotency-Key` and body: 202 with the same id and `idempotent: true`; same key, other body: 409 `idempotency_conflict`; the same key from `lab-member` (with the member's own snapshot): a different job, not marked idempotent, and the member cannot read the owner's job |
| 5 | `authorization` | no token: 401 on profile, organizations, job read, launch, project jobs and admin; the viewer cannot launch (403/404) nor start a study run; the viewer **does** read the project's job (state and result) and its `options`, `original_request` and provenance are redacted (allow-listed option names only, no credential- or address-like keys, registration only as a pinned reference); the outsider cannot read organization, project, project jobs (403/404) or the owner's job (404); owner, member, viewer and outsider get 403 on `/api/v1/admin/overview`, the admin gets 200 |
| 6 | `concurrency_limit` (optional) | 5 simultaneous launches with different keys and slow options (1,000,000 iterations, 20 s budget): at most `--max-concurrent` (3) are accepted, at least one is a 429 `concurrency_limit_exceeded` with `Retry-After`; the accepted jobs are cancelled and awaited, and a new launch is accepted again |
| 7 | `cors` (optional) | preflight from `http://localhost:18100` is allowed (`Access-Control-Allow-Origin` echoes it); from `http://evil.example` no allow-origin is returned, for the preflight and for a simple request |
| 8 | `body_limit` (optional) | a JSON body of 16 MiB + 1 KiB is answered **413** `application/problem+json` (`payload_too_large`) within 30 s, without hanging |
| 9 | `login_throttle` (optional) | up to 12 failed logins of `lab-throttle-probe` (never seeded): 401 until the limit, then 429 with `Retry-After` |
| 10 | `plan_usage` (`--with-space`) | `GET /api/v1/users/me/usage` of the owner returns a plan name, `features` and `capabilities` (numbers or null) and no key that looks like a usage counter |

Order of execution: 1 to 8, then 10, then 9. The login throttle runs last on purpose: it counts per client
address **and** identifier (`authrl:login:id:<address>:<hash of the identifier>`) and, with a ten times larger
budget, per address alone (`core/ratelimit.py`; defaults: 10 attempts per identifier per 300 s window). It uses
an identifier no other step uses, so the users of the other steps are not the ones blocked, but it still
spends part of the per-address budget until the window ends; running the smoke again within five minutes
makes step 9 answer 429 from the first attempt (it still passes).

Steps 6 to 9 are dropped with `--skip` (numbers or names: `--skip 6,7` or `--skip concurrency_limit,cors`).
Steps 1 to 5 cannot be skipped. Step 10 only runs with `--with-space`.

### What the smoke changes in the lab

- It launches jobs for `lab-owner` (steps 3, 4, 6) and `lab-member` (step 4) and uploads the example package
  `demo/01_simple_seq` as the member's snapshot (`POST /api/v1/instances`).
- Jobs that belong to a project only come from study runs (`POST /v1/jobs` stores no project). If the project
  has no completed job, step 5 creates the study `smoke-lab` in `lab-main/bim-demo` (one case revision, one
  engine, one parameter set, one seed) and runs it once. Later runs reuse that job and create nothing.
- It does **not** register users, does not call SPACE or SPHERE, and does not delete anything.

## What it does not cover

- **Anything in a browser.** No rendering, no JavaScript errors, no routing in the SPA beyond "the proxy
  serves the index". The Playwright specs in `frontend/e2e` (`s1a`..`s9b`, `routes-smoke`, `responsive`,
  `visual-*`, `qa-gallery`, `analysis-live`, `pricing`) need a browser; most of them run against the Vite dev
  server with mocked API (`helpers/mockApi.ts`), and `analysis-live.spec.ts` with `ANALYSIS_LIVE=1` against
  a live frontend. They stay for an execution with a browser and the SSH tunnel to `127.0.0.1:18100`.
- **Mobile and desktop visual checks** (390 x 844 and 1440 x 900 in `docs/DEMO.md`) and the **screenshot
  plan**: the capture specs (`visual-foundations`, `visual-shell`, `responsive`, `qa-gallery`) produce images
  and are judged by eye.
- Token refresh, logout, password reset, registration, CAS, API keys, notifications, organization invitations,
  artifacts/library, reports and publications, the other three engines, `many-heuristic`, `minizinc`,
  `evolutionary-heuristics`, engine registration, public (anonymous) pages.
- Load and timing: step 6 proves the limit, not throughput; step 8 proves the refusal, not the latency.
- The SPACE/SPHERE side: step 10 only reads what the gateway reports for the owner.

## Running it with lab_compose

Preconditions: the stack is up and healthy, and the users exist (`seed_lab.py` ran; see `docs/DEMO.md`). With
`SPACE_ENABLED=true` the gateway asks SPACE for the plan of every account, so the synthetic users need a
contract on the development service (`seed_lab.py --space-contracts`, see `docs/qa/REMOTE_TOOLS.md`; the
`seed` service gets the service, plan and version from `DEMO_SPACE_DEV_SERVICE`, `DEMO_SPACE_DEV_PLAN` and
`DEMO_SPACE_PRICING_VERSION`). Without one the gateway answers 503 `pricing_unavailable` and the steps that
need a plan (2, 3, 4, 5, 6, 10) are reported as blocked by the remote, not as failures. The gateway, the worker
and `seed` all name the same development service (`DEMO_SPACE_DEV_SERVICE`, passed as `SPACE_SERVICE_NAME`), so
the seeded contracts are the ones the gateway reads and the production service `openbinding` is never
touched; see `docs/DEMO.md`.

The smoke is a seed tool: it runs in the `seed` service, inside the lab network, so `web` resolves.

```sh
# 1. users (once; idempotent)
DEMO_SEED_TOOL=seed_lab.py DEMO_SEED_ARGS='--space-contracts' docker compose run --rm --no-deps seed
# 2. the smoke
DEMO_SEED_TOOL=smoke_lab.py DEMO_SEED_ARGS='--with-space' docker compose run --rm --no-deps seed
# without SPACE, and without the optional steps
DEMO_SEED_TOOL=smoke_lab.py DEMO_SEED_ARGS='--skip 6,7,8,9' docker compose run --rm --no-deps seed
```

With `lab_compose` the same two `seed` runs are made by setting `DEMO_SEED_TOOL` / `DEMO_SEED_ARGS` as in
`docs/DEMO.md`. The password must be the same `DEMO_SEED_PASSWORD` value for both runs. The smoke reads it
from the environment only (never from the command line) and the base URL from `SMOKE_BASE_URL` or
`--base-url` (default `http://web:8080`).

Options: `--base-url`, `--skip`, `--with-space`, `--origin` (default `http://localhost:18100`),
`--evil-origin` (default `http://evil.example`), `--job-timeout` (default 120), `--max-concurrent` (default 3,
the lab's `MAX_CONCURRENT_JOBS_PER_USER`).

Reading the result: `ok` and the exit code are the verdict; `steps[].detail` says `N checks passed [notes]`
or `FAILED k/n: <the failed expectations>` or `BLOCKED BY REMOTE: <reason>. Cause: <server message>. Blocked
at: <requests>`, at most 500 characters, with every secret and token-shaped string replaced by `***`. Run the unit tests with `cd openbinding-gateway && uv run pytest tools/tests/test_smoke_lab.py`.

## Assumptions not verified

1. **Compose environment.** *Resolved:* `compose.lab.json` passes `DEMO_SEED_PASSWORD`, `SMOKE_BASE_URL` and
   the three `SPACE_DEV_*` variables to `seed` only, as references to `DEMO_*` variables the supervisor supplies.
2. **`httpx` in the gateway image.** It is a runtime dependency in `pyproject.toml`; not confirmed inside the
   built image. `tools/` is bind-mounted, so the script runs from the checkout.
3. **Example package.** Members upload the package served by `GET /api/v1/examples/demo/01_simple_seq`. It
   assumes `examples/` is inside the image (the endpoint reads it from the source tree).
4. **Seeded snapshot.** The owner's job uses `source_snapshot_id` of the latest revision of `simple-seq`; if
   that snapshot cannot be read it falls back to uploading the example package.
5. **Study entitlement.** The viewer's read needs a project job, which needs the `studies` feature on the
   owner's plan (and on the sponsor's capacity). If the plan refuses it, step 5 fails with "no project job to
   read as viewer" and the code of the refusal; nothing else in the step is skipped. A study run is accepted
   (202) even when the plan cannot be read and then stays queued, so step 5 reads the owner's profile first and
   reports the block at once instead of waiting `--job-timeout`.
6. **Slow options.** Step 6 assumes the plan's caps do not clamp `iterations`/`time_budget_ms` so far that a
   job ends before the five launches have arrived. If it does, no 429 appears and the step fails; lower
   `--max-concurrent` does not help, raise the budget in `SLOW_OPTIONS`.
7. **Status codes.** Where the matrix is ambiguous the smoke accepts 403 or 404 (viewer launch, outsider reads).
   Anonymous requests must be 401 and non-admins 403 on `/api/v1/admin/*`; the outsider reading the owner's
   job through `/api/v1/jobs/{id}` must be 404.
8. **BIM provenance.** `BIM_MODE=http` is not read by the gateway yet (`docs/DEMO.md`). The smoke therefore
   checks the reevaluation by `evaluator`/`evaluatorDigest`/`compilerDigest` in the provenance and only
   *reports* a toolchain field if one exists; it cannot prove that the request went to `bim-service`.
   Check `logs bim-service` once for that.
9. **CORS preflight.** Expected 200 with an echoed origin for the allowed one and no allow-origin header for
   the other (Starlette answers 400). `Access-Control-Allow-Methods` must contain `GET`.
10. **413 through nginx.** `client_max_body_size` is 512m, so the gateway's `BodyLimitMiddleware` (16 MiB
    JSON) answers. The oversized request goes to `/api/v1/auth/login`, which is refused before the password
    or the throttle are looked at, so it spends no login attempt.
11. **Usage counters.** Step 10 flags any key under `/v1/users/me/usage` containing `used`, `usage`,
    `consumed`, `counter`, `remaining` or `spent`; a capability legitimately named like that would fail it.
