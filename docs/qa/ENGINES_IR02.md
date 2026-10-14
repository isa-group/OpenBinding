# Engines × mode × result (normalized IR, `bim_core` 0.2.0)

What each engine does with the normalized `BindingProblem` IR, how its result is re-evaluated, and what has really been
run. "Worker" is the development container (node, java, mvn, uv; **no `minizinc`, no network for Maven**); "lab" is
`lab_compose`. Nothing is marked executed that was not.

## Matrix

| Engine | Transport | Mode | Remote cancel | Result path | Worker (fake) | Lab (real) |
| --- | --- | --- | --- | --- | --- | --- |
| `minizinc-csp` | asynchronous: `202` + `GET /internal/v1/jobs/{id}` | `exact-weighted` (SINGLE weighted sum, Gecode) | `DELETE` implemented (`docs/qa/ENGINE_CANCELLATION.md`) | `engine_e2e.py`: compile → submit → poll → `bim_core.reevaluate` → classify | **executed** with `tests/fake_minizinc.mjs` (real processes): solve, registration, cancel, races, tenants | **pendiente lab real**: 5 `MINIZINC_REAL=1` tests + `engine_e2e.py --url` (`compose.lab-engines.json`) |
| `random-search` (Java) | synchronous `POST` → 200 | `seeded` | none (no job id) | gateway `solve_remote`, re-evaluated by `bim_core` | pendiente C2 | pendiente C2 |
| `multi-heuristic` (Java) | synchronous | per its manifest | none | as above | pendiente C2 | pendiente C2 |
| `many-heuristic` (Java) | synchronous | per its manifest | none | as above | pendiente C2 | pendiente C2 |
| `evolutionary-heuristics` (Java) | synchronous | per its manifest | none | as above | pendiente C2 | pendiente C2 |
| `bim-generator` | CLI (`BimGeneratorCli`), not an engine | n/a | n/a | n/a | n/a | n/a |

## `minizinc-csp`: result × who proves it

`engine_e2e.py` never reports the engine's own numbers. The decision is re-evaluated with `bim_core.reevaluate`
(allowed terminations: the ones the `exact-weighted` manifest guarantees, else only `FEASIBLE`/`UNKNOWN`), and the label is:

| Label | Requires | Worker (fake solver) | Lab (real MiniZinc) |
| --- | --- | --- | --- |
| `optimal` | re-evaluated termination `OPTIMAL` **and** a proof that is not the engine's word: exhaustive enumeration when the binding space is small (≤ 5000), else a real solver whose claim the mode allows | executed: the 2-binding minimal package is proven by enumeration (`proof: exhaustive-enumeration`); a fake never earns `optimal` on a space it cannot enumerate | pendiente |
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

## Executed in the worker

* `pnpm test`: 80 tests in the sources, 75 executed, 5 `NO EJECUTADO` (`MINIZINC_REAL!=1`).
* `uv run pytest`: `test_remote_cancel.py`, `test_engine_cancel_contract.py`, `test_job_leases.py`,
  `test_job_reconciler.py`, `test_job_cancel_audit.py`, `tools/tests/test_engine_e2e.py` (150 passed with the fake
  engine started for real); `ruff check` of the three Python sources.
* `pytest ../lab/tests/test_lab_engines_profile.py`: static checks of `compose.lab-engines.json` (no Docker).

Java engines (their tests need Maven, which has no network in the worker) and the registrations that reach them are the
subject of C2.
