# Engines × mode × result (normalized IR, `bim_core` 0.2.0)

What each engine does with the normalized `BindingProblem` IR, how its result is re-evaluated, and what has really been
run. "Worker" is the development container (node, java, mvn, uv; **no `minizinc`, no network for Maven**); "lab" is
`lab_compose`. Nothing is marked executed that was not.

## Current view (head `31b7de6f`, 2026-10-14)

Figures reported by the controller from the real laboratory; this document did not re-run them. The matrix and tables below
this view are the worker-time record (fake MiniZinc, no Docker); where they say `pendiente lab real` or `pendiente C2`, that is
**superseded** by this section.

| Engine | Transport | Remote cancel | Lab (real) | SHA |
| --- | --- | --- | --- | --- |
| `minizinc-csp` | asynchronous: `202` + `GET /internal/v1/jobs/{id}` | `DELETE` implemented and sent by the gateway for running jobs (G2) | MiniZinc 2.6.4 (`compose.lab-engines.json`): `engine-real-tests` **44/44, 0 skipped**; `seed` (`engine_e2e.py --url http://engine:3000 --scenario all --expect optimal`) **16 PASS, 1 NO EJECUTADO** (process checks in `--url` mode, the solver being in another container; the real tests cover them), `engine_e2e: ok`, result re-evaluated with `bim_core.reevaluate` and classified `optimal`. End to end in the N1 demo: `cancel_probe.py` `passed` ([ENGINE_CANCELLATION_E2E.md](ENGINE_CANCELLATION_E2E.md)) | `59ef9749`, probe `31b7de6f` |
| `random-search`, `many-heuristic`, `multi-heuristic`, `evolutionary-heuristics` (Java) | synchronous `POST` → 200 by default; `ENGINE_JOB_MODE=async` is opt-in | engine-level `DELETE` in async mode only; the bundled registrations declare the capability only for names in `BUILTIN_CANCELLATION` (`minizinc-csp`) or `ENGINE_CANCELLATION_BUILTIN` | JUnit in Docker (`compose.lab-engines-java.json`): `binding-core` 56, `random-search` 12, `many-heuristic` 11, `multi-heuristic` 12, `evolutionary-heuristics` 13, 0 Failures/Errors/Skipped (JDK 8 and JDK 21). **Async mode behind the gateway: NO EJECUTADO** | `31b7de6f` |
| `bim-generator` | CLI (`BimGeneratorCli`), not an engine | n/a | n/a | n/a |

Open: the first lab run of the MiniZinc tests at `ea955411` gave 43/44 (a race of the test "kills a grandchild that outlives
the leader", fixed at `59ef9749`); the Java builder images failed with `cp: Permission denied` until `RUN chmod -R a+rX /app`
(`31b7de6f`). Details: [FINAL_VALIDATION.md](FINAL_VALIDATION.md), [ENGINES_JAVA_IR02.md](ENGINES_JAVA_IR02.md).

## Matrix (worker-time record; superseded where marked)

| Engine | Transport | Mode | Remote cancel | Result path | Worker (fake) | Lab (real) |
| --- | --- | --- | --- | --- | --- | --- |
| `minizinc-csp` | asynchronous: `202` + `GET /internal/v1/jobs/{id}` | `exact-weighted` (SINGLE weighted sum, Gecode) | `DELETE` implemented (`docs/qa/ENGINE_CANCELLATION.md`) | `engine_e2e.py`: compile → submit → poll → `bim_core.reevaluate` → classify | **executed** with `tests/fake_minizinc.mjs` (real processes): solve, registration, cancel, races, tenants | ~~pendiente lab real~~ (superseded: executed, see above): 5 `MINIZINC_REAL=1` tests + `engine_e2e.py --url` (`compose.lab-engines.json`) |
| `random-search` (Java) | synchronous `POST` → 200 | `seeded` | none by default (no job id); opt-in async | gateway `solve_remote`, re-evaluated by `bim_core` | executed in the worker (see `ENGINES_JAVA_IR02.md`) | JUnit in Docker executed (superseded "pendiente C2") |
| `multi-heuristic` (Java) | synchronous | per its manifest | as above | as above | as above | as above |
| `many-heuristic` (Java) | synchronous | per its manifest | as above | as above | as above | as above |
| `evolutionary-heuristics` (Java) | synchronous | per its manifest | as above | as above | as above | as above |
| `bim-generator` | CLI (`BimGeneratorCli`), not an engine | n/a | n/a | n/a | n/a | n/a |

## `minizinc-csp`: result × who proves it

`engine_e2e.py` never reports the engine's own numbers. The decision is re-evaluated with `bim_core.reevaluate`
(allowed terminations: the ones the `exact-weighted` manifest guarantees, else only `FEASIBLE`/`UNKNOWN`), and the label is:

| Label | Requires | Worker (fake solver) | Lab (real MiniZinc) |
| --- | --- | --- | --- |
| `optimal` | re-evaluated termination `OPTIMAL` **and** a proof that is not the engine's word: exhaustive enumeration when the binding space is small (≤ 5000), else a real solver whose claim the mode allows | executed: the 2-binding minimal package is proven by enumeration (`proof: exhaustive-enumeration`); a fake never earns `optimal` on a space it cannot enumerate | executed at `59ef9749`: the lab `seed` classified the result `optimal` (the per-label rows below that say `pendiente` predate that run; only `optimal` is reported in the figures received) |
| `feasible` | a valid decision with no hard violation, termination `FEASIBLE`, or `OPTIMAL` not demonstrable, or lowered by the re-evaluation | executed (incumbent without the `==========` marker is `feasible` even if it equals the optimum) | pendiente |
| `infeasible` | re-evaluated `INFEASIBLE` without solutions | executed (canned `=====UNSATISFIABLE=====`) | pendiente |
| `unknown` | no valid solution, or every decision dropped by the re-evaluation | executed (canned `=====UNKNOWN=====`) | pendiente |
| `inconsistent` (fails the run) | the engine claims `OPTIMAL` while a better binding exists | executed: a worse binding claimed optimal fails the run | pendiente |

## Modes of `engine_e2e.py`

| Mode | Engine | Process checks (group dead, CPU free, no zombie) | Used for |
| --- | --- | --- | --- |
| `--fake-minizinc` | local node + `tests/fake_minizinc.mjs` | executed from `/proc` | the worker (`tools/tests/test_engine_e2e.py`) |
| `--local-minizinc` | local node + the host's `minizinc` | executed from `/proc` | a machine with MiniZinc |
| `--url URL` | already running | `NO EJECUTADO` (the solver is elsewhere) | the lab (`seed` of `compose.lab-engines.json`) |

## What the fake can and cannot show

Shown: the engine's HTTP contract (`bim-engine/v1` shapes, `validate_job`), the OpenAPI conformance
(`openapi_diagnostics`) and that the gateway reads `cancellation` (`idScope: attempt`) as supported, the life cycle and
its races, ownership, and that a `DELETE` terminates a real process group, reaps it, stops its CPU use and leaves no
zombie. Not shown: that the MiniZinc model computes the right optimum, and the behaviour of the real `minizinc` /
`fzn-gecode` pair under SIGTERM/SIGKILL. The fake returns a canned incumbent chosen by the harness (the exhaustive
optimum), so a green fake run says "the plumbing is right", not "MiniZinc is right".

## Executed in the worker (record; the lab results are in the current view above)

* `pnpm test`: 80 tests in the sources, 75 executed, 5 `NO EJECUTADO` (`MINIZINC_REAL!=1`).
* `uv run pytest`: `test_remote_cancel.py`, `test_engine_cancel_contract.py`, `test_job_leases.py`,
  `test_job_reconciler.py`, `test_job_cancel_audit.py`, `tools/tests/test_engine_e2e.py` (150 passed with the fake
  engine started for real); `ruff check` of the three Python sources.
* `pytest ../lab/tests/test_lab_engines_profile.py`: static checks of `compose.lab-engines.json` (no Docker).

Java engines: their tests and the Python e2e with real `java` processes are in [ENGINES_JAVA_IR02.md](ENGINES_JAVA_IR02.md);
the Docker run of their JUnit suites is in the current view above.
