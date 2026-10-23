# CRP: scope for solver statistics in the minizinc-csp engine

## Request

Widen the file scope of the next task to `engines/minizinc-csp/src/minizinc_runner.ts`,
`engines/minizinc-csp/src/solver.ts` and a unit test next to them
(`engines/minizinc-csp/src/minizinc_runner.test.ts`).

## Why

The ICSOC regression ends FEASIBLE at the 30 s budget where the legacy run proved
OPTIMAL in 2.099 s. Whether the time goes to flattening or to search is visible with
the current provenance (`flatten_ms`, `elapsed_ms`; the integration test now prints
both). The solver statistics (nodes, failures, propagations, depth) are not: the
runner calls `fzn-gecode -a -time <ms> <file>` (`minizinc_runner.ts:369`) without
`-s`, and `solver.ts:39-45` does not put any in provenance. Without them the search
side of the question (weak float proof vs a huge tree) cannot be answered.

## Proposed change (not made)

- Pass `-s` to fzn-gecode, parse the statistics block from stderr/stdout
  (`nodes`, `failures`, `restarts`, `propagations`, `peak depth`, `runtime`, `solvetime`)
  into `MiniZincRunResult`, and add them to `provenance` in `solver.ts`.
- Unit test with the fake MiniZinc/gecode in `tests/fake_minizinc.mjs`.
- No change to the model, the budget, the thresholds, the weights or the baseline.

## What this request does NOT ask for

- A larger `time_budget_ms`.
- A relaxed threshold or a different expected termination.
- Any change to the baseline JSON, digests or weights.

If the next CI log shows that flattening dominates, the statistics are not needed and
the fix would be a model/DZN size reduction instead; this CRP can then be dropped.

## Decision needed from the owner

Approve or reject the scope extension above.
