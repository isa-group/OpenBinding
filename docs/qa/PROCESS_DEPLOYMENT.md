# bim-service with worker processes in the lab (`BIM_SERVICE_EXECUTOR=process`)

Two alternative manifests run the real demo with `bim-service` in **process** mode inside its unchanged 256 MiB
container. `compose.lab.json` (thread executor) is not modified and is the rollback.

| File | Executor | Worker processes (N) | Largest body (L) | Use |
| --- | --- | --- | --- | --- |
| `compose.lab.json` | `thread` (default) | 2 threads | 16 MiB | current demo, **rollback** |
| `compose.lab-process-n2.json` | `process` | 2 | 2 MiB | alternative; historical profile of `ce7229b2` |
| `compose.lab-process.json` | `process` | 1 | 6 MiB | **profile in force (N1)** |

**Status (2026-10-14, head `c2d46151`): the human decided on N1; `compose.lab-process.json` (1 process, body up to 6 MiB, the
256 MiB container intact) is the profile in force in the demo.** N2 (`compose.lab-process-n2.json`) stays as an alternative and
as history, with its measurements tied to `ce7229b2`. The manifests and the arithmetic below were also checked statically by
`lab/tests/test_lab_process_profiles.py`. The text of the sections that recommend N2 first ("Which one first, and why") is the
reasoning that preceded the decision and is **superseded**; it is kept for its figures.

## Result of the real deployment of N1 (head `c2d46151`)

Profile: `compose.lab-process.json` (body 6291456 B, 1 slot, budget 50331648 B, pending 12582912 B, acquire 3000 ms,
per-tenant 0). Container unchanged: `mem_limit` 256 MiB, 1.5 CPUs, `pids_limit` 256; the sum of `mem_limit` stays 4032 MiB.

* **First run on `bef53047` failed, and why.** Smoke 6/9 (`422 contract_not_installed`) and Playwright 29 passed / 1 failed.
  The IR cut-over had left snapshots seeded with compiler 0.1.0. That was fixed by task M (`9bbc189f`: explicit recompilation
  of snapshots and an idempotent seed) and re-verified at `c2d46151`. It is not a defect of the profile.
* **At `c2d46151`:** the seed is idempotent (it created the revision `simple-seq:2`; one old snapshot could not be recompiled,
  `invalid_instance`, reported in `recompileFailed`); smoke **9/9** in 6.0 s; Playwright **30 passed, 0 failed, 0 skipped**
  (summary 2026-10-14T13:41:20Z).
* **Probe** (`process_probe.py`, `c2d46151`, N1 figures: `--expect-max-body-bytes 6291456 --expect-concurrency 1
  --expect-memory-budget-bytes 50331648 --expect-pending-body-bytes 12582912 --expect-acquire-timeout-ms 3000`, **without** the
  timeout step): exit 0, `ok=true`. Steps in [PROCESS_PROBE.md](PROCESS_PROBE.md): `capabilities` 16 checks, `valid_operations`
  84, `hostile_small` 55, `large_bodies` 13, `saturation` 9, `healthz_under_load` 116/116 in 200.
* **Fit rule with the conservative figures** (table below): required 265918873 B of 268435456 B, headroom **2516583 B (2.4 MiB):
  little room.**
* **Memory** (`lab_compose metrics`, decimal MB; `c2d46151`):

| Moment | Parent RSS | Worker RSS | cgroup `memory.current` / `memory.max` | `oom_kill` |
| --- | --- | --- | --- | --- |
| During Playwright | 59.9 MB | 54.7 MB | 92.5 MB (value as reported) | not recorded |
| After the probe | 68.1 MB (peak 84.0) | 68.4 MB (peak 72.2) | 116899840 / 268435456 | 0 |

* **PENDING, no evidence yet:** the real timeout and replacement **with one slot** has not been exercised in the N1 container.
  Only N2 (probe at `ce7229b2`, below) and tests with real processes did it. It will be done with
  `compose.lab-process-n1-probe.json` (task P, in progress). Until that evidence exists, nothing here claims it for N1.
* Not reached by the N1 probe either (not claimed): 413 `pending_body_too_large`, 413 `memory_budget_exceeded`, a worker killed
  from outside and a client disconnect in the demo.
* **Rollback:** `lab_compose up file=compose.lab.json` (thread mode, unchanged file).

## Result of the real deployment of N2 (history, `ce7229b2`)

Code deployed: `ce7229b2` (with the tests and documents of that moment); the code of `bim-service` is that of `67e8e878`
(worker fix `c67116ba`). Container: the real demo, `mem_limit` 256 MiB, 1.5 CPUs, `pids_limit` 256, unchanged; the sum of
`mem_limit` stays 4032 MiB. Profile: `compose.lab-process-n2.json` (body 2 MiB, 2 slots, budget 16 MiB, pending 4 MiB, acquire
2000 ms, per-tenant 0). At that time the recommendation of this page was N2 first, and N1 was not deployed; that was later
superseded by the decision for N1 (above).

* **Start.** Correct. The service validated its own fit rule: required 261724569 of 268435456 bytes, headroom 6710887 bytes,
  with the conservative figures of the probe (the same as the conservative column below). `GET /bim/v1/capabilities` published
  the profile honestly.
* **Smoke.** 9/9 in process mode (code `67e8e878`, seed operation of `lab_compose`).
* **Memory** (`lab_compose metrics`):

| Moment | Parent (PID 1) RSS | Workers RSS | cgroup `memory.current` / `memory.max` | `oom_kill` | pids |
| --- | --- | --- | --- | --- | --- |
| Before the load | 61.6 MB | 54.7 and 54.1 MB (pids 10 and 11) | 127156224 / 268435456 | 0 | not recorded |
| After the probe | 67.6 MB (peak 68.9 MB) | 53.8 and 53.5 MB (pids 45 and 47: replaced by the real timeout) | 133955584 / 268435456 | 0 | 6 |

  `lab_compose metrics` reports bytes (`rss_bytes`); "MB" above is decimal MB. The parent grew from 61.6 MB before the load
  to 67.6 MB (67604480 B = 64.5 MiB; peak 68.9 MB) after the probe, i.e. above the conservative `P` of 62914560 B (60 MiB)
  used by the fit rule, which was checked at start. Recomputed with P = 67604480 B the fit rule requires 266414489 B, below
  268435456 B (headroom about 2.0 MB), so it still fits. The cgroup stayed at 133955584 of 268435456 bytes with `oom_kill` 0.
* **Probe** (`openbinding-gateway/tools/process_probe.py`, code `ce7229b2`, profile `compose.lab-process-n2-probe.json` = N2 with
  operation timeout 3 s): exit 0, `ok=true`, 24.3 s in total. Details in [PROCESS_PROBE.md](PROCESS_PROBE.md).
* **Not reached in N2 by the probe** (stated as is): 413 `pending_body_too_large` and 413 `memory_budget_exceeded` (they cannot
  happen in N2), a worker killed from outside, and a client disconnect in the demo. They are covered by tests with real
  processes (`bim-toolchain/packages/bim-service/tests/test_process_executor.py`), not by the probe in the container.
* **Rollback:** `lab_compose up file=compose.lab.json` (thread mode, unchanged file).

### Operational incident during this work (own mistake)

**Historical incident, with a behaviour that has since been superseded.** At the time, `lab_compose up` with an `environment`
**replaced** the private environment stored from the earlier `up`; it did not merge it. A partial set sent with `up` lost the
synthetic PostgreSQL password (`DEMO_PG_PASSWORD`) of `lab-pg-3`. It was recovered
without data loss with the one-shot manifest `compose.lab-pgreset.json` (commit `08851b00`; `ALTER ROLE` through the local
socket, procedure in [PG_ROLE_RESET.md](PG_ROLE_RESET.md)) and the stack was started again with the complete set of
variables. The BIM token variable must be at least 32 characters. The other services were healthy after the restart. No value
is recorded here, only variable names. The rule written then, "always send the complete `environment` with `up`, or none", **is
no longer needed**: the `environment` of `lab_compose` is now a PATCH (merge) over the stored variables. Omitted or `{}` keeps
all of them, only the keys sent explicitly are replaced, and `validate` uses the same semantics. Sending the complete set is
still valid. That the new semantics prevent a repeat of this incident is the description of the tool as given to this work; this
document does not record a run that exercised it.

Both process manifests are `compose.lab.json` with a different environment for `bim-service` and nothing else: the same
project name, volumes, passwords, users, authentication, the other ten services and the sum of `mem_limit`
(**4032 MiB**, unchanged; `bim-service` keeps `mem_limit` 256m, `cpus` 1.5 and `pids_limit` 256). Neither the 256 MiB, the
4 GiB of the demo nor the 9 GiB are enlarged. The `command` is unchanged too.

## What changes in the environment of `bim-service`

| Variable | `compose.lab.json` | `compose.lab-process-n2.json` | `compose.lab-process.json` |
| --- | --- | --- | --- |
| `BIM_SERVICE_EXECUTOR` | (unset: `thread`) | `process` | `process` |
| `BIM_SERVICE_MAX_BODY_BYTES` (L) | 16777216 (16 MiB) | 2097152 (2 MiB) | 6291456 (6 MiB) |
| `BIM_SERVICE_MAX_CONCURRENCY` (N) | 2 | 2 | 1 |
| `BIM_SERVICE_MEMORY_BUDGET_BYTES` (B) | 134217728 (128 MiB) | 16777216 (16 MiB) | 50331648 (48 MiB) |
| `BIM_SERVICE_MAX_PENDING_BODY_BYTES` (Q) | 33554432 (32 MiB) | 4194304 (4 MiB) | 12582912 (12 MiB) |
| `BIM_SERVICE_ACQUIRE_TIMEOUT_MS` | (unset: 250) | 2000 | 3000 |
| `BIM_SERVICE_MAX_CONCURRENCY_PER_TENANT` | (unset: none, one tenant) | 0 (none) | 0 (none) |

Why these values:

- **B = 8 L.** A request is charged 8 times its body (`BODY_MEMORY_FACTOR`); with B = 8 L a request at the advertised limit
  is admissible and a second one at the limit is refused (429 `memory_budget`), because the container cannot hold two.
  A smaller B would answer 413 `memory_budget_exceeded` to a body the service advertises.
- **Q = 2 × (B ÷ 8) = 2 L**, the value the service derives itself: as many body bytes may wait as may run (429
  `pending_body_bytes` beyond that). It is never smaller than L.
- **Acquire timeout.** The gateway does not retry a 503 (`integrations/bim.py` maps it to `503 bim_unavailable`), and
  gateway, worker (2 threads) and seed call at once. With one slot a queue is normal, and after a timeout the replacement worker
  needs up to 0.5 s of refill delay plus about 0.3 s of start. 250 ms (the default) would show 503 `service_busy` in both
  cases; 3 s (N=1) and 2 s (N=2) absorb them. Waiting bodies stay bounded by Q, so the longer wait costs no memory.
- **Per-tenant share 0.** Gateway, worker and seed share one token, i.e. one tenant. A share equal to N would turn waiting
  for a slot into an immediate 429 (the share is checked before the slot); 0 keeps the slots, B and Q as the only limits and
  does not depend on how many tenants the tokens file names.
- `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` stays 60 (default) and no other variable is set.

## The fit rule and the numbers

`WorkerPool.start` (called by the lifespan, so by `uvicorn`) checks, after all N workers report `READY`:

```
P + Q + N*C + B + N*(L + R) + margin <= M
```

`M` = `/sys/fs/cgroup/memory.max` = 268435456 (256 MiB); `margin` = 10% of M = **26843545**; `P` = resident size of the
parent; `Q` = `BIM_SERVICE_MAX_PENDING_BODY_BYTES`; `C` = resident size of the largest worker when ready; `B` = the memory
budget; `L` = the body limit; `R` = the allowance = 8 × L (`worker_allowance_bytes`, also the largest answer). When it does
not hold the service raises `ServiceConfigError` and exits (it never reduces N by itself): the container is not healthy
and `logs bim-service` shows the terms. It is arithmetic on a model, not a measurement of the running service.

Figures:

- **Measured** (`bim-toolchain/docs/SERVICE.md`): `C` = 51564544 (49.2 MiB, a worker when ready, the same in three starts);
  `P` = 55451648, the resident size of PID 1 of the lab container **in thread mode**.
- **Conservative** (used by the tests to prove headroom; *assumptions*): `P` = 62914560 (60 MiB; the parent of a process-mode
  service was never measured in this container and also holds the I/O threads and sockets) and `C` = 56623104 (54 MiB,
  about 10% above the measurement).

### `compose.lab-process-n2.json` (N=2, L=2 MiB)

R = 16777216, N × (L + R) = 2 × (2097152 + 16777216) = 37748736, Q = 4194304, B = 16777216.

| Term | Measured | Conservative |
| --- | --- | --- |
| P | 55451648 | 62914560 |
| Q | 4194304 | 4194304 |
| N × C | 103129088 | 113246208 |
| B | 16777216 | 16777216 |
| N × (L + R) | 37748736 | 37748736 |
| margin (10% of M) | 26843545 | 26843545 |
| **Required** | **244144537** | **261724569** |
| Headroom against 268435456 | 24290919 (23.2 MiB) | 6710887 (6.4 MiB) |

The measured column reproduces the figure of `SERVICE.md` (244144537).

### `compose.lab-process.json` (N=1, L=6 MiB)

R = 50331648, N × (L + R) = 6291456 + 50331648 = 56623104, Q = 12582912, B = 50331648.

| Term | Measured | Conservative |
| --- | --- | --- |
| P | 55451648 | 62914560 |
| Q | 12582912 | 12582912 |
| N × C | 51564544 | 56623104 |
| B | 50331648 | 50331648 |
| N × (L + R) | 56623104 | 56623104 |
| margin (10% of M) | 26843545 | 26843545 |
| **Required** | **253397401** | **265918873** |
| Headroom against 268435456 | 15038055 (14.3 MiB) | 2516583 (2.4 MiB) |

The measured column reproduces the figure of `SERVICE.md` (253397401).

For contrast, the settings of `compose.lab.json` (N=2, L=16 MiB, B=128 MiB, Q=32 MiB) would need 655186329 bytes in process
mode against 268435456: they do not fit, which is why the thread laboratory is not simply switched.

### Which one first, and why (historical, superseded by the decision for N1 of 2026-10-14)

This was the reasoning before the decision: it recommended `compose.lab-process-n2.json`. It is not the current instruction;
the profile in force is `compose.lab-process.json` (N1). The points below remain true as trade-offs (N1 has one slot and the
least headroom).

1. Two slots: the gateway, the worker (2 threads) and the seed call concurrently, and the gateway does not retry a 503. With
   one slot, two simultaneous calls queue up to the acquire timeout; with two, they run in parallel (the lab has `cpus: 1.5`).
2. Fault isolation is visible: when one worker is killed after a timeout, the other slot keeps serving while it is replaced.
   With N=1 every timeout makes the whole service wait for the replacement (up to about 0.8 s).
3. More headroom: 6.4 MiB with conservative figures against 2.4 MiB, and 23.2 MiB against 14.3 MiB with measured ones. Each
   MiB that `C` is larger than assumed costs N=2 two MiB, so it tolerates +3.2 MiB of `C` (conservative), N=1 +2.4 MiB.
4. The demo case (`examples/demo/01_simple_seq`: four JSON files) is expected to be well below 2 MiB. *Assumption:* the size
   of the packages and requests that gateway and worker send was not measured here; check the seed and the smoke.

`compose.lab-process.json` (6 MiB) was chosen to show a larger body. Its price is one slot and 2.4 MiB of conservative
headroom, which the memory measurements of N1 above accept (cgroup 116899840 of 268435456 B after the probe). If neither fits in the real container, do not enlarge anything: lower L (a
new manifest) or go back to thread mode.

## How to activate and how to go back

Activate the profile in force, N1 (the controller rebuilds and recreates what changed; only `bim-service` differs):

```
lab_compose validate file=compose.lab-process.json
lab_compose up file=compose.lab-process.json
```

or, for the alternative 2 MiB profile (N2):

```
lab_compose validate file=compose.lab-process-n2.json
lab_compose up file=compose.lab-process-n2.json
```

The variables (`DEMO_*`, private ones) are the same as in `docs/DEMO.md`. Volumes are
shared: the project name is the same in all three files, so data survives the switch.

**Rollback to thread mode:** `lab_compose up file=compose.lab.json`. Nothing else is needed: that file is unchanged and its
`bim-service` has no `BIM_SERVICE_EXECUTOR`, so it runs threads, with the 16 MiB body, B 128 MiB and Q 32 MiB. To go from one
process profile to the other, `up` with the other file.

## What the real demo must verify

(The checklist applies to either profile. N1 evidence is in "Result of the real deployment of N1"; its item 5, the real timeout
with one slot, is still **pending**.)

1. **Start.** `status`: `bim-service` healthy. `logs bim-service`: no `ServiceConfigError`; if the fit rule fails, the message
   lists `P`, `Q`, `N*C`, `B`, `N*(L+R)` and the margin: copy it into the report and switch profile or roll back.
   `READY`: every worker reported it (the start waits for all N); `/healthz` 200 (always) and `/readyz` 200 (503 `not_ready`
   while every slot backs off). The gateway becomes healthy and `seed`/`smoke` pass.
2. **Capabilities.** `GET /bim/v1/capabilities` (`limits.service`) must publish exactly these values, in particular the
   largest body, because the lab must not advertise what the container cannot hold.

   N=2, `compose.lab-process-n2.json`:

   ```json
   {
     "executor": "process",
     "maxBodyBytes": 2097152,
     "maxConcurrentOperations": 2,
     "maxConcurrentOperationsPerTenant": 0,
     "acquireTimeoutMs": 2000,
     "memoryBudgetBytes": 16777216,
     "maxPendingBodyBytes": 4194304
   }
   ```

   N=1, `compose.lab-process.json`:

   ```json
   {
     "executor": "process",
     "maxBodyBytes": 6291456,
     "maxConcurrentOperations": 1,
     "maxConcurrentOperationsPerTenant": 0,
     "acquireTimeoutMs": 3000,
     "memoryBudgetBytes": 50331648,
     "maxPendingBodyBytes": 12582912
   }
   ```

3. **Hostile requests** (the corpus of `SERVICE.md`: deep nesting, a ZIP bomb, XXE, billion laughs, bad base64, too many
   resources or bindings): each gets the same status as in thread mode (4xx, `limit_exceeded`), the container stays up and
   `oom_kill` does not grow.
4. **413 and 429.** A body above L: 413 `payload_too_large`, without reading it. At the limit: accepted. A second request at
   the limit while one runs: 429 `memory_budget` or `pending_body_bytes` with `Retry-After`. N+1 simultaneous small requests:
   they wait up to the acquire timeout, then 503 `service_busy`.
5. **Timeout and replacement.** An operation over `BIM_SERVICE_OPERATION_TIMEOUT_SECONDS` (60 s) gives 503
   `operation_timeout`, the worker is killed and reaped, and the next request is served by the replacement (N=2: the other
   slot serves meanwhile). A worker killed from outside gives 500 `internal_error` with `correlationId` and is replaced.
   `status`: still healthy, no zombies, never more than N children.
6. **Memory.** `lab_compose metrics` during idle, under the smoke and under a request at the limit: the resident size of the
   parent and of each worker, `memory.current` against `memory.max` (268435456), `memory.peak`, and **`oom_kill`** in
   `memory.events` of the container (must stay 0; a worker is the first victim, `oom_score_adj` 1000, and shows as a 500).
   Also the number of pids against `pids_limit` 256 (N+1 processes plus threads).

## Assumptions to confirm with `lab_compose metrics`

- `C`, the resident size of a worker when ready: 51564544 was measured on a development machine with the files cached, not in
  this container. The conservative column assumes 56623104.
- `P`, the resident size of the parent after the workers are ready: in process mode it was later measured (N2: 67.6 MB at
  `ce7229b2`; N1: 59.9 MB during Playwright and 68.1 MB, peak 84.0, after the probe at `c2d46151`; the peak is above the
  conservative `P`). The conservative column assumes 62914560 (about 60 MB were expected). The coordinator chooses the profile from the real values:
  recompute with the table above (`required = P + Q + N*C + B + N*(L+R) + 26843545`, must be at most 268435456).
- `pids_limit` 256 with N+1 processes and their threads was not measured.
- The size of the requests that gateway and worker really send to `bim-service` was not measured.
- The gateway's own `MAX_JSON_BODY_BYTES` (16 MiB) is not changed by these manifests: a body between L and 16 MiB passes the
  gateway and is refused by `bim-service` with 413, which the gateway maps. The smoke step `body_limit` (gateway, over 16 MiB)
  is unaffected.

## Difference with thread mode

- **6 MiB does not admit 16 MiB or 32 MiB, and neither does 2 MiB.** The thread laboratory advertises 16 MiB; the 32 MiB
  default of the service cannot run in 256 MiB at all (one request at that limit needs about 268 MiB). A process profile
  advertises L = 2 MiB (N=2) or 6 MiB (N=1): a 16 MiB or 32 MiB request is a 413 here and succeeds (16 MiB) in thread mode.
  Anything that depends on the larger bodies stays on `compose.lab.json`.
- In thread mode a timed-out operation cannot be stopped and keeps its slot; in process mode the worker is killed, reaped
  and replaced, and a runaway parse no longer stalls the event loop (`/healthz` stays fast).
- Process mode costs memory: each worker holds `C` at rest, so N workers are N times `C` more than N threads; it limits the
  address space of a worker, not its resident memory (`RLIMIT_AS`), and does not make a single request faster.
- A `MemoryError` while a body is parsed is a 500 in both executors.
