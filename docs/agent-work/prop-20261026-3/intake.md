# Intake: P-20261026-3, measure the O9 interactive-latency targets in the lab

- Kind: reliability, size M, risk low, owner-approved · Base: `task/d56d175505c04128` at `212b9662`
- INTENT objective: **O9, interactive latency**. Target: "p95 of `POST /v1/jobs` (accept) ≤ 500 ms and of
  `POST /v1/validate` ≤ 2 s for corpus-size packages in the lab". Status: "not measured" (`INTENT.md:170`; the
  proposal cites line 169, but the row is at 170). The owner confirms these targets through D7 (`INTENT.md:251`).
- Rule this work serves: "Latency targets are INTENT O9; they are measured in the lab before a release"
  (`constitution.md:150`). Hot-path changes "MUST include a measurement" (`constitution.md:149`).

## 1. Objective

Turn O9 from "not measured" into dated p50/p95 figures for the two routes, measured in the lab, so the owner can
confirm or change the D7 targets. The same tool can then measure later hot-path changes.

## 2. Evidence checked against the code at `212b9662`

| # | Fact | Evidence |
|---|---|---|
| F1 | The only p95 measurement in the repo is `/healthz` under load in the bim-service probe | `openbinding-gateway/tools/process_probe.py:683,1408,1419`; `docs/qa/PROCESS_PROBE.md:28,50,129` |
| F2 | That probe calls the bim-service, not the gateway: `VALIDATE = f"{API}/validate"` with `API = "/bim/v1"` | `process_probe.py:71,74`; "No call to the gateway" `PROCESS_PROBE.md:60-61` |
| F3 | `percentile()` is nearest-rank, 0.0 for no values | `process_probe.py:161-167` |
| F4 | Importing `process_probe` also imports `bim_client` and `bim_core` at module load | `process_probe.py:62-63` |
| F5 | `POST /v1/validate` (`validateInstance`) takes a package, needs `solve_caller` and asks SPACE for the plan's caps | `routes/v1.py:1005-1020`; `services/instances.py:175,190,193` |
| F6 | `POST /v1/jobs` answers 202. It takes either `{"snapshot": ...}` JSON or a ZIP / multipart package. The package form compiles and persists a snapshot inside the accept | `routes/v1.py:1080-1093,1140-1172` |
| F7 | The accept checks the plan's caps, usage counters and the per-account concurrency limit inside its transaction, then dispatches | `services/job_submission.py:511-530,655-668`; `jobs/limits.py:50-74`; `routes/v1.py:1135-1136` |
| F8 | The lab seed container has `MAX_CONCURRENT_JOBS_PER_USER=3` | `compose.lab.json:397` |
| F9 | Lab tools run as `python tools/${DEMO_SEED_TOOL}` in the gateway image, which copies `openbinding-gateway/tools/` to `/app/tools` | `compose.lab.json:365`; `openbinding-gateway/Dockerfile:19,65`; `docs/DEMO.md:197` |
| F10 | The seed container mounts only an artifacts volume and a tmpfs. A tool there cannot write into the repository's `docs/qa/` | `compose.lab.json:408-421` |
| F11 | `smoke_lab.py` already signs in the seeded synthetic users through the proxy (`/api/v1/auth/login`). It uploads a snapshot, launches a `random-search` job and drains/cancels jobs with httpx. It reports a SPACE `503 pricing_unavailable` as `blockedByRemote` (exit 3) | `tools/smoke_lab.py:5-16,59-69,376-475,93-98` |
| F12 | Examples come from `GET /v1/examples` (directories under `examples/` that hold a `bim/v1` Instance) and `GET /v1/examples/{path}` | `routes/v1.py:650-661`; `services/discovery.py:171-186` |
| F13 | The "checked-in corpus" of O1 is wider than `examples/`: `tools/check_bim_corpus.py` walks the whole repository for `instance.json` | `tools/check_bim_corpus.py:25-40`; `.agentic/project.yaml:51` |
| F14 | `gateway-unit` runs `pytest` with `testpaths = ["tests"]`, so tests under `openbinding-gateway/tools/tests/` do not run in it. `test_process_probe.py` lives in `openbinding-gateway/tests/` and loads the tool with `spec_from_file_location` | `.agentic/project.yaml:44`; `openbinding-gateway/pyproject.toml:79-81`; `tests/test_process_probe.py:30,47` |
| F15 | `openbinding-gateway/tools/**`, `openbinding-gateway/tests/test_latency_*` and `docs/qa/**` match no risk-area glob | `.agentic/project.yaml:105-139` |
| F16 | Raw campaign results are a non-goal in Git | `INTENT.md:189` |

Proposal evidence not confirmed: it says `docs/DEFINITION_OF_DONE.md` mentions O9. A search for
`O9|latenc|p95|measure` in that file finds nothing. Only `INTENT.md:170` and `constitution.md:150` mention O9.

## 3. Scope

In scope:

- A lab-only measurement tool, `openbinding-gateway/tools/latency_probe.py`, run through the seed container (F9). The
  proposal says `tools/latency_probe.py`. A file in the root `tools/` would not be in the gateway image, so it would not run
  through `lab_compose seed`.
- Its unit test of the report format and the percentile and verdict logic, with injected durations (no wall-clock
  assertions).
- One lab run and a dated report under `docs/qa/` with p50/p95 per route against the O9 targets.

Non-goals:

- Any product behaviour change: no gateway route, service, limit, compose file, CI or OpenAPI change (`routes/**` is R3,
  `jobs/**` is R5, `compose.*.json` and `.github/**` are R10, `project.yaml:114,120,136`).
- Editing `INTENT.md` (the O9 "Today" cell) or D7: those are R11 / owner (`INTENT.md:234`). The report gives the figures,
  and the owner updates the cell.
- Changing `seed_lab.py` to add a dedicated probe user (see Q3), or a CI job or registered gate that fails on O9.
- Optimising either route if the targets are missed: that becomes a followup with the report as its evidence.
- Measuring under concurrent load (O9 is interactive latency; see CRP-1 c).
- The backlog items of the proposal (`seed_analysis` links, M2.4 dead code, ProjectOverview failure, retired-entry
  parser).

## 4. Slices

Two slices, in order. No feature flag: nothing runs in the product. The tool is only run by hand through the seed
container, and S1 stands alone as a usable tool. No interface contract (OpenAPI or JSON Schema delta) is needed: the probe
only calls existing public routes.

| # | Slice | Role | Owned files | Read-only context | Est. diff | Risk | Depends on |
|---|---|---|---|---|---|---|---|
| S1 | O9 latency probe tool and its unit test | implementer, default model, medium effort, about 40 turns | `openbinding-gateway/tools/latency_probe.py`, `openbinding-gateway/tests/test_latency_probe.py` | `tools/process_probe.py` (F3, F4), `tools/smoke_lab.py` (F11), `routes/v1.py:650-661,1005-1172`, `services/instances.py`, `services/job_submission.py`, `jobs/limits.py`, `compose.lab.json:359-426`, `docs/qa/PROCESS_PROBE.md`, `tests/test_process_probe.py`, `tools/tests/fakes.py` | tool about 220-280 lines; test about 120-200 lines (tests are outside the 300-line limit, `project.yaml:14`) | **low**: new lab-only files that match no risk glob (F15). Nothing imports them, and the gateway image only copies them | CRP-1 answered (or its defaults accepted) before the contract is frozen |
| S2 | Lab run and dated O9 report | coordinator runs the lab; doc-steward writes the report, default model, low effort, about 20 turns | `docs/qa/LATENCY_O9.md`, `docs/qa/latency/o9-<YYYY-MM-DD>.json` (summary only, see Q2), one row in `docs/DEMO.md` (the `DEMO_SEED_TOOL` row, `docs/DEMO.md:197`) | the stored output of the lab run, S1's tool docstring, `INTENT.md:170,251`, `constitution.md:150` | about 60-120 lines | **low**: documentation only. It records a measurement and changes no target | S1 merged into `develop` and the lab image rebuilt from it |

S1 content (for the contract; the defaults are recommended, and CRP-1 can change them):

1. Configuration: `--base-url` (default `$SMOKE_BASE_URL` or `http://web:8080`, through the proxy as the browser,
   F11), `--user` (default a seeded synthetic user, Q3), password from `DEMO_SEED_PASSWORD` (never printed),
   `--samples N` (default 40), `--warmup W` (default 3, not counted), `--examples a,b|all` (CRP-1 b),
   `--jobs-target-ms 500`, `--validate-target-ms 2000`, `--markdown` (print the Markdown report instead of JSON).
2. Sign in once (`/api/v1/auth/login`). Fetch each package with `GET /v1/examples/{path}` (F12).
3. `POST /v1/validate`: the requests run one after another, one client. Only the request is timed (`time.perf_counter`
   around the call, passed in as a clock so the test can inject it). A non-200 answer is counted and reported, never
   timed into the percentiles.
4. `POST /v1/jobs`: the same, with `random-search`, the smoke's minimal options (`smoke_lab.py:81-86`) and a unique
   `Idempotency-Key`. Each accepted job is cancelled and drained before the next accept, so the limit of 3
   (F8) never answers 429. Only the accept is timed. The variant follows CRP-1 a.
5. Report: one JSON on stdout: `{"tool", "ok", "measuredAt" (UTC ISO 8601), "baseUrl", "gatewayVersion"` (from
   a public route if one gives it, otherwise null) `, "config", "routes": [{route, variant, package, samples,
   errors, p50Ms, p95Ms, maxMs, targetMs, meetsTarget}]}`. p50/p95 come from `percentile()` imported from `process_probe`
   (the proposal's choice). The JSON has no per-sample arrays (Q2) and no token or password. Exit 0 when every
   route meets its target, 1 when any misses it, 2 on a configuration error, 3 when SPACE blocks (as `smoke_lab.py:10-16`).
   A miss is a measurement, not a defect of the tool.
6. Test (`tests/test_latency_probe.py`): an httpx `MockTransport` or the existing fakes, and an injected clock. It checks
   the nearest-rank p50/p95 on known durations, the target verdict at and just over the target, that errors are not
   timed, the cancel-before-next-accept order, the exit codes 0/1/2/3, the JSON keys and the Markdown table, and that
   no secret appears in the output. It makes no wall-clock assertion, because the timing tests of B8 are recorded as
   flaky (`docs/qa/FLAKY_TESTS.md`).

S2 content: the coordinator runs `lab_compose up file=compose.lab.json` with `DEMO_SEED_TOOL=latency_probe.py`
`DEMO_SEED_ARGS=...`, then `lab_compose seed` (the procedure of `PROCESS_PROBE.md:75-91`), and stores the stdout. The
doc-steward writes `docs/qa/LATENCY_O9.md` with: date, lab profile and limits, gateway commit, how to run, the result
table against O9, what the figures include (the SPACE caps round trip, F5/F7) and exclude (engine time, concurrency),
and "not claimed" items. The S2 PR does not touch `INTENT.md`. The owner updates the O9 cell.

### Proposed checks (none are registered for this proposal; `cwd: openbinding-gateway`)

S1:

1. `["uv", "sync", "--locked", "--extra", "test"]`
2. Red-before (G3), with an overlay of the new test only:
   `{"argv": ["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "tests/test_latency_probe.py"], "type": "red_before", "expect_exit": [1], "expect_pattern": "latency_probe.py", "overlay": ["openbinding-gateway/tests/test_latency_probe.py"]}`.
   On the base the tool is missing. The test's loader must therefore **assert** the file exists
   (`assert TOOL.is_file(), "tools/latency_probe.py"`) instead of failing at import, otherwise red_before rejects it as
   a collection error.
3. `["uv", "run", "--locked", "--extra", "test", "pytest", "-q", "tests/test_latency_probe.py", "tests/test_process_probe.py"]`
   (the second file shows that importing `percentile` did not break the existing probe).
4. G9: `["uv", "run", "--locked", "--extra", "test", "ruff", "check", "tools/latency_probe.py", "tests/test_latency_probe.py"]`.
   `ruff-gateway` checks only `src tests` (`project.yaml:76`).
5. G5: the registered `gateway-unit` (`project.yaml:44`), check timeout about 1200 s.

S2: `["git", "diff", "--check"]` (G9 stand-in, `cwd: .`). The lab run itself is evidence that the coordinator
attaches. It is not a worker check (workers have no lab access).

## 5. Gates per slice

| Gate | S1 (tool + test) | S2 (report) |
|---|---|---|
| G1 spec | applies if the coordinator opens an OpenSpec change. `openspec-validate` is `todo: true` (`project.yaml:34`), so it is reported NOT EXECUTED | same change, no new delta |
| G2 EPIC | with G1, by spec-auditor (threshold 2) | n/a |
| G3 red-before | yes, check 2 | n/a (no test) |
| G4 acceptance frozen | trivially (no `acceptance/**` unless the coordinator asks test-designer for one) | trivially |
| G5 green-after | checks 3 and 5 | n/a (docs only) |
| G6 trace | tag `[impl->req~...]` / `[utest->req~...]` if G1 gives a requirement id. `oft-trace` is `todo: true` (`project.yaml:62`) | n/a |
| G7 contracts | n/a: no route, model or schema changes; `docs/openapi.json` untouched | n/a |
| G8 mutation | n/a: every mutation check is `todo: true` (`project.yaml:71-74`) | n/a |
| G9 quality | check 4 | `git diff --check` |
| G10 secrets/ownership | yes: the token and password are never printed (test), no forbidden or R11 path (`project.yaml:89-90,139`) | yes: the JSON has no credentials and no raw samples |
| G11 review | low panel `[reviewer]` (`project.yaml:142`). The reviewer checks that the probe calls only public routes and measures only the request | low panel `[reviewer]`. Every figure must match the stored lab output |
| G12 lab/UI | partly: S1 changes no runtime. A smoke run of the tool in the lab (`--samples 3`) is the coordinator's evidence that it runs in the seed container | **yes**: the lab run is the slice's evidence |
| G13 review package | n/a with a `how_to_review` (lab-only tool, no UI or product API change): read the tool, then the test | n/a with a `how_to_review`: the report table against the stored output |

## 6. Feature flags

None. The capability spans two slices, but neither changes product behaviour. S1 is complete and harmless alone
(a tool nobody runs automatically), and S2 only records its output.

## 7. Open questions

Needs a CRP (the meaning of an INTENT target is the owner's, D7 `INTENT.md:251`; R11 `INTENT.md:234`):

- **CRP-1: what exactly O9 measures.** One CRP with three parts. S1 can be built with the defaults, and its options
  keep the other choices open.
  - a) **Which `POST /v1/jobs` accept.** Options: (1) snapshot JSON (the package is already stored; the accept checks
    plans, limits and persists, F6/F7); (2) ZIP upload (compile and snapshot inside the accept, F6); (3) both, reported
    separately, each against 500 ms. Recommended: (3). The verdict for O9 uses the variant the owner names.
  - b) **What "corpus-size packages" means.** Options: (1) every example of `GET /v1/examples` (F12); (2) the largest
    examples by ZIP size, e.g. the top 3; (3) the largest package of the whole O1 corpus (F13), which is not served by
    the gateway, so it would have to be uploaded. Recommended: (2), with the package names and byte sizes in the report.
  - c) **Under which conditions.** Options: (1) one client, requests in sequence, the lab otherwise idle; (2) also
    under a fixed background load. Recommended: (1). The report states that SPACE's caps round trip is included (F5/F7).

For the coordinator (no owner decision):

- Q1: sample size and warm-up. Recommended: `--samples 40 --warmup 3`. With nearest-rank, p95 of 40 is the 38th value.
- Q2: the dated JSON under `docs/qa/`. Raw campaign results are a non-goal in Git (`INTENT.md:189`), so the JSON should
  hold the summary only (config, per-route p50/p95/max, counts), no per-sample arrays. Recommended: summary JSON plus
  Markdown.
- Q3: which synthetic user. A dedicated user would need `seed_lab.py`, which is out of scope. Recommended: `lab-member`
  through `--user`, so the owner's history used by `smoke_lab.py` (`smoke_lab.py:425-436`) stays clean. Jobs it
  starts are cancelled at once. Check that the member's plan allows `solve`. Otherwise use `lab-owner`.
- Q4: reuse `percentile()` by import (the proposal; it pulls `bim_core`/`bim_client` in at import, F4, both present in
  the gateway image) or copy its seven lines. Recommended: import. Check 3 also reruns `test_process_probe.py`.
- Q5: `MAX_CONCURRENT_JOBS_PER_USER=3` is read from the seed container's environment (F8). The gateway service's value
  was not checked. The cancel-and-drain order makes it irrelevant to the figures.
