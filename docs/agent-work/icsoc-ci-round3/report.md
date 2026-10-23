# ICSOC CI round 3: why minizinc-csp ends FEASIBLE at 30 s

Failing test: `openbinding-gateway/tests/integration/test_icsoc_regression.py::test_reduced_campaign_matches_or_remains_statistically_sensible`
(PR #24, head 8c1058c, job 120104161047). minizinc-csp / gecode / `time_budget_ms` 30000
ends with `termination=FEASIBLE`, `engineReported.elapsed_ms=30311`. The legacy baseline
(`mediaOrch_146588263_50.json`, `legacyExact`) proved OPTIMAL in 2.099 s with score
0.02037444933920705.

## Result

**The cause is NOT confirmed.** Reading the code does not identify a defect I can
fix with a minimal change, and I did not change any engine file. I could not run
the engine, MiniZinc or the gateway stack here, and I could not run `git log`/`git diff`
(only file reading and the two registered `pnpm` checks were available), so the
history comparison against 6dcf959 and 18860bb was not done. What was done:

1. Read `engines/minizinc-csp/src/{solver.ts,minizinc_runner.ts,dzn_builder.ts}` and
   `model/binding_problem.mzn` and tested the hypotheses below against them.
2. Made the integration test diagnosable without relaxing anything (see "Test change").
3. No CRP is needed to *relax* anything, but one is filed (`crp.md`) to ask for scope
   for the instrumentation that the next round needs.

## Hypotheses

### Discarded

- **Non-integer weights (0.33/0.34/0.33) degrade the search compared with scaled integers.**
  Discarded as a cause *by code reading*, not by measurement. `term_weight` is a
  `float` array (`dzn_builder.ts:520`, `optimization()` at 988-1042) and the objective is
  `sum(term_weight * term_loss) + placement_penalty + soft_penalty`
  (`binding_problem.mzn:497-498`). Every `term_loss` is a float variable (linear equality
  over a float `raw`, `:479-495`), so the objective is a float variable in either case.
  Scaling the weights to integers would not turn it into an integer objective and would
  not change which float propagators are posted. The weights are also the historical
  ones that the legacy run used (the owner confirmed they belong to the request); the
  only code that reads them besides the objective is `orderEligibility`
  (`dzn_builder.ts:600-`), which orders each task's candidates by weighted estimated loss.
  With the same weights the order is the same as in the legacy lane. The check
  `|sum(weights) - 1| <= 1e-12` (`:1031-1034`) passes for 0.33+0.34+0.33, and the job
  completed, so the weights were accepted.
- **The time budget is applied wrongly or doubly.** `solver.ts:27-31` passes
  `--time-limit 30000`; `minizinc_runner.ts:339-369` gives flattening the whole limit and
  fzn-gecode `max(1, limit - flattenMs)`. So the limit is shared by flattening and
  search, as documented in the runner. `elapsed_ms=30311` is consistent with the
  budget being spent (30000 + process start/teardown), not with the budget being
  exceeded by a bug.
- **Wrong termination mapping.** `solver.ts:36-38,74` reports OPTIMAL only when the
  stream has `==========` and no incumbent was rejected, and FEASIBLE otherwise. A
  FEASIBLE with 30311 ms is what a search cut by `-time` produces. If an incumbent had
  been rejected by the exact evaluation, `provenance.relaxed_incumbents_rejected` would
  be present in the job's provenance; it is a cheap thing to look for in the next log.

### Open (cannot be confirmed or discarded from the code alone)

- **H1: flattening takes a large part of the 30 s.** The instance has 5 tasks, 540
  candidates, 35 features, 56 pools. The model builds per-task fixed-point `table_value`
  limbs for every (task, metric) pair, a `candidate_log` table of 540 x 35, atom tables
  `n_atoms x n_candidates`, and a `lo` limb computed per table. The runner measures
  `flattenMs` and reports it as `provenance.flatten_ms`, so one CI log answers this.
  If `flatten_ms` is in the order of 10 s or more, `search_ms = elapsed_ms - flatten_ms`
  is what is left for gecode, and the lever is the model/DZN size (a code fix), not the
  search.
- **H2: the proof of optimality is weak for the float objective.** The legacy optimum
  sits on the corner of the domain (`cost = 1.26844236` equals the normalisation
  minimum, `security = 1.0` the maximum, `latency = 37`). Gecode propagates float
  intervals through `sum(w_i * loss_i)`; a branch-and-bound over a float objective
  needs bound propagation from the slot variables through the fixed-point limbs, the
  `unbounded_normalized * range == raw - min` equalities and the linear sum, and that
  propagation is weak. Whether the proof needs 2 s or more than 30 s depends on
  how far these bounds prune, which I cannot measure by reading.
- **H3: the model/DZN changed since the legacy 2.099 s.** The baseline records
  `sourceCommit 81e095ca…` and a run before the model moved to fixed-point limbs,
  bin-packing columns, flat products and the `is_defined_var` float brancher
  suppression. Any of those changes the proof time in either direction. Confirming this
  needs `git log -p` on `model/binding_problem.mzn`, `dzn_builder.ts` and
  `minizinc_runner.ts` between 6dcf959 and 18860bb, which I could not run. The commits
  in the log are all generic "Complete task ..." messages, so the history would have to
  be read as diffs.
- **H4: CI machine is slower or noisier than the one that recorded 2.099 s.** A 15x gap
  is large for hardware alone, so this is unlikely to be the whole story, but it is not
  excluded. The test now prints the wall time of each lane to make this visible.

### What the engine does not report (limits of the diagnostic)

`solver.ts:39-45` puts in provenance: `elapsed_ms`, `time_budget_ms`, `flatten_ms`,
`widened_float_domains`, `suppressed_float_branchers`, `ozn_rendered` and `encoding`
(flat products, log-space metrics, soft constraints, bin-packing columns/checks,
capacity checks, relaxed literals). **It does not report gecode statistics (nodes,
failures, propagations, peak depth)**: `minizinc_runner.ts:369` runs
`fzn-gecode -a -time <ms> <file>` without `-s`/`-statistics`. So the next CI log will
answer H1 (flattening vs search) and give the DZN encoding sizes, but not nodes or
failures. The request asked for them; they need the runner to pass `-s` and the solver
to put the statistics in provenance, which are `engines/minizinc-csp/src/**` files outside
my scope. See `crp.md`.

## Test change

`openbinding-gateway/tests/integration/test_icsoc_regression.py` only. No threshold,
expected termination (OPTIMAL), `time_budget_ms`, weights, baseline JSON or digest was
touched.

- Each lane is timed with `time.monotonic()` and, right after it ends, a line is printed:
  `lane=… termination=… test_wall_s=… engine_elapsed_ms=… engine_flatten_ms=…
  engine_search_ms=… time_budget_ms=…` (`search = elapsed - flatten`). It is printed
  before any assertion, so pytest shows it in "Captured stdout call" on failure, and
  live with `-s`.
- The complete `provenance.engineReported` of minizinc-csp is printed as indented,
  key-sorted JSON.
- The OPTIMAL assertion message now carries: the observed termination, the legacy
  elapsed time, the three lane lines, the complete `engineReported` and the complete
  `provenance`, none truncated.
- Not verified by execution: the integration test needs the gateway stack
  (`http://127.0.0.1:8000`) and the full dataset, neither available here, and neither
  registered check compiles or runs Python. The edit is not syntax-checked by a tool.
  It was reviewed by reading only.

## Checks

- Check 0 `pnpm --dir engines/minizinc-csp install --frozen-lockfile`: exit 0.
- Check 1 `pnpm --dir engines/minizinc-csp run build` (`tsc`): exit 0.
  Both only cover the TypeScript engine, which I did not modify.

## Next round

Read from the CI log: `engine_flatten_ms` vs `engine_search_ms`, `encoding`, and whether
`relaxed_incumbents_rejected` exists. If flatten dominates, shrink the DZN/model
(code fix, in `engines/minizinc-csp`). If search dominates, instrument gecode statistics
(`crp.md`) before touching the model. Changing the budget or the threshold is not
proposed.
