# ICSOC CI round 4: Gecode search statistics for minizinc-csp

Context: PR #24, head bfcb36ef7078d78c9d32cada83df901a1bde255e, CI job 120143895090,
`test_reduced_campaign_matches_or_remains_statistically_sensible`. For minizinc-csp / gecode
with `time_budget_ms` 30000 the CI reported:

| value | observed |
| --- | --- |
| `engine_flatten_ms` | 838 |
| `engine_search_ms` | 29436 (of 30000) |
| `termination` | FEASIBLE |
| encoding | `capacityChecks` 224, `relaxedLiterals` 11, `flatProducts` 0, `binPackingChecks` 0 |
| `widened_float_domains` | 1532 |
| `suppressed_float_branchers` | 0 |
| legacy baseline | OPTIMAL in 2.099 s |

Flattening is not the problem (838 ms). The search does not close the optimality proof.
This round is instrumentation only: **the model, the budget (30000 ms), the thresholds, the
expected OPTIMAL termination, the baseline, the digests and the weights were not touched.**

## What was done

1. `engines/minizinc-csp/src/minizinc_runner.ts`
   - fzn-gecode is now started as `fzn-gecode -a -time <ms> -s <file.widened.fzn>`.
   - New `extractGecodeStatistics(stdout)` and the exported `GecodeStatistics`
     (`{ values, raw }`). It recognises the Gecode front-end block (`%%  nodes:         123`,
     `%%  peak depth:    17`, ...) and the `%%%mzn-stat: name=value` form, normalises the
     names (`peak depth` -> `peak_depth`), turns a time printed with a millisecond figure in
     parentheses (`29.436 (29436.000 ms)`) into `<name>_ms` (`runtime_ms`, `solvetime_ms`),
     reads other numbers as numbers and anything else as text. `raw` keeps the original lines, so
     a name or layout this parser does not know is still visible in the next CI log.
   - It tolerates the absence of the block (older Gecode, a solver killed by the outer timeout,
     the fake solver): the result is then `undefined`.
   - `MiniZincRunResult.gecodeStatistics` carries it. The block is also looked for in stderr
     when stdout has none.
   - The statistic lines are **removed from the stream before anything else reads it**: the
     text given to `renderSolverOutputDetailed`, to the `.ozn` rendering pass and hence to
     `Solver` never contains them. `stdoutEvents` (the raw, timestamped chunks) is left as it
     came. Only lines that match the two statistic forms are removed; solution lines, `----------`,
     `==========`, `=====UNSATISFIABLE=====`, `=====UNKNOWN=====` and other `%` comments pass
     through unchanged. No code path that decides the termination reads the statistics.
2. `engines/minizinc-csp/src/solver.ts`: `provenance.gecode_statistics` (the `values` map) and
   `provenance.gecode_statistics_raw` (the lines), both `null` when fzn-gecode printed none.
   The termination logic (`complete`, `unsatisfiable`, incumbent re-evaluation) is unchanged.
   The gateway stores `provenance` verbatim under `provenance.engineReported`
   (`services/execution.py:115`) and `scrub` only drops credential-like keys; none of the new
   names (`nodes`, `failures`, `restarts`, `propagations`, `peak_depth`, `runtime_ms`, ...) is one.
3. `openbinding-gateway/tests/integration/test_icsoc_regression.py`: the complete
   `engineReported` was already printed (per lane in the failure message, and for minizinc-csp
   right after the lane), so `gecode_statistics` and `gecode_statistics_raw` appear in it with no
   further change. In addition the one-line lane summary now ends with
   `gecode_statistics={...}` (sorted JSON, `null` when absent). **No assertion, threshold or
   expected value was changed.** Not executed here (needs the gateway stack and the dataset).
4. Tests
   - `minizinc_runner.test.ts` (real child processes with `tests/fake_minizinc.mjs`, whose
     `FAKE_MINIZINC_STDOUT_FILE` already lets a test script the solver output, so the fake needed no
     change): the solve call carries `-s` (the argv assertion was updated from `argv[3]` = file to
     `argv[3]` = `-s`, `argv[4]` = file); a run with a statistics block after two incumbents and
     `==========` returns exactly the same rendered stdout as without it, with the statistics
     parsed and the raw events untouched; `=====UNSATISFIABLE=====` followed by a block; the block does
     not reach the `.ozn` rendering pass (the render call receives exactly the stream's bytes);
     the run without a block has `gecodeStatistics === undefined`; unit tests of
     `extractGecodeStatistics` (Gecode form, `%%%mzn-stat` form, unreadable values as text,
     statistics before/between/after solution blocks, no block, empty input).
   - `conformance.test.ts`: `Solver` puts the statistics in the provenance, `null` without them,
     and the termination and solutions are identical in both cases. This file is built by check 1 but
     none of the registered checks executes it (see Checks).

## What I could not verify

- The exact layout of the block that **Gecode 6.3.0** prints with `-s`. I wrote the parser from my
  recollection of its FlatZinc front-end (`%%  runtime:`, `solvetime:`, `solutions:`, `variables:`,
  `propagators:`, `propagations:`, `nodes:`, `failures:`, `restarts:`, `peak depth:`), with no
  access to the real binary here. The parser is generic (any `%%  name: value` line), and `raw`
  keeps everything, so the first CI run will show the real names even if some differ. If the
  real solver prints the block to a stream or in a form that neither pattern matches, then
  `gecode_statistics` will be `null` and nothing else changes.
- The CI run itself, and the Python test (no gateway stack available).

## Hypotheses on why the optimality proof is slow

Everything below comes **from reading `model/binding_problem.mzn`, `dzn_builder.ts` and the runner,
not from measurements**. Each should be confirmed or discarded with the numbers the next CI log
will print (`nodes`, `failures`, `propagations`, `peak_depth`, `restarts`, `solutions`).

- **H-A (weak bound on a float objective).** The objective is
  `sum(term_weight * term_loss) + placement_penalty + soft_penalty` over float variables
  (`:497-498`), linked to the slots through fixed-point `table_value` limbs and linear equalities
  (`:174-185`, `:486`). Gecode only prunes a subtree when the interval of `objective_value` is
  disjoint from `< incumbent`. That interval is the sum of the independent minima of each
  criterion, i.e. it ignores the fact that the best slot for cost is not the best for latency or
  security. With 5 tasks and 540 candidates (round 3), if they split evenly (about 108 per task, an assumption) the tree has about 10^10 leaves;
  if the bound only bites when most slots are assigned, nodes grow very fast. Expected signature: `nodes` in
  the tens of millions or more with `failures` close to `nodes` and a large `peak_depth` (near 5
  would mean the bound only works at the leaves).
- **H-B (slack on domains blunts the proof).** 1532 float domains are widened by
  `1e-9 * max(|bound|, 1)` (`numeric.ts:34-37`) and the comparison literals are relaxed too
  (11 relaxed literals). That is deliberate (it avoided false UNSAT), but it means a subtree
  whose lower bound lies within about 1e-9 of the incumbent cannot be pruned. The legacy
  optimum sits on a domain corner (cost at the normalisation minimum, security at the maximum), and
  if many candidate combinations tie with it or lie within the slack, the proof has to visit all of
  them. Expected signature: the incumbent stops improving early (`solutions` small) and the
  search keeps failing at depth.
- **H-C (strict improvement over floats).** For a float objective the branch-and-bound constraint
  added after each solution is a float relation; if it is not strict by a step, equal-valued
  solutions can be re-reported or the tail of the proof can be explored several times. I cannot
  say from the code what Gecode 6.3 does here. Expected signature: `solutions` much larger than
  the number of distinct objective values you see in the trace.
- **H-D (224 capacity checks without bin-packing).** `binPackingChecks` is 0, so 224 capacity
  constraints are posted as sums of `bool2int(task_pool[t] == pool) * invocation * demand`
  (`:315-331`), with `demand` a float `table_value`. Such reified sums fail only when nearly all
  tasks are assigned (their bound is weak while slots are open). They add many propagators
  (cost per node) without contributing to the bound. The 224 x 5 reified equalities plus the
  1532 float variables also make each propagation round expensive: expect `propagations` /
  `nodes` high and `runtime` per node large.
- **H-E (branching).** `int_search(selected_slot, first_fail, indomain_min, complete)` (`:503`)
  with all domains of similar size degenerates to a static task order, and `indomain_min` orders by the
  estimated loss that `orderEligibility` computes, which is a heuristic for the incumbent but not
  a bound. No restarts, no objective-guided branching, no learned weights. Expected signature:
  `restarts: 0`.
- **H-F (latency via 2-D element lookups).** `pool_latency[from_pool, to_pool]` (`:342`, `:370`)
  indexes a 2-D array by two variables and Gecode/MiniZinc decompose this into reified
  equalities, so the latency lower bound is poor until pools are fixed. This only matters if the
  instance has Placement; the 56 pools suggest it does.

Not credible after this round (already discarded in round 3 and unchanged): wrong time-budget
accounting (838 + 29436 = 30274 of 30000, i.e. the budget is simply used up), wrong
termination mapping, non-integer weights.

## Candidate model changes (described, NOT applied)

These are for the owner/CRP, because this round does not change the model:

1. **Redundant additive lower bound.** When the objective terms are sums over tasks (sum
   aggregations; here `flatProducts` is 0), post an implied constraint
   `objective >= sum_t min_over_remaining_slots(partial loss)` through a per-task `table_value`
   of the weighted loss of each candidate, i.e. express `objective` as `sum_t loss_t[slot_t]` (one
   element per task with the exact weighted contribution) so the bound is the sum of per-task minima
   after normalisation and clamping, and tighter than the per-metric combination. Valid only
   when every term is a task-separable sum; the lowering already knows this.
2. **Native bin packing for the 224 capacity checks** when demands are constant per task
   (`binPackingChecks` is 0 here: find out why they are not eligible; the model supports it at
   `:108-111`, `:311-314`), or merge them per pool.
3. **Search**: add `restart_luby` / `dom_w_deg`, or order slots by a lower bound (best loss first
   with `indomain_min` already; try `smallest` on a slot-loss variable).
4. **Objective scaling**: express the objective as an integer (fixed-point) variable so Gecode's
   integer branch-and-bound (strict `< best`) and linear bounds-consistent propagators are used
   instead of float intervals. This changes the numerics of the exact check and needs its own
   review.

## Checks (through `qa_run`)

- Check 0 `pnpm --dir engines/minizinc-csp install --frozen-lockfile`: exit 0.
- Check 1 `pnpm --dir engines/minizinc-csp run build`: exit 0 (also compiles `conformance.test.ts`).
- Check 2 `node --test engines/minizinc-csp/dist/minizinc_runner.test.js`: exit 0, 25 tests,
  22 pass, 0 fail, 3 skipped (the three `real MiniZinc` tests, `NO EJECUTADO: MINIZINC_REAL!=1`).
- `conformance.test.js` (including the new `Solver` provenance test) is compiled but **not executed**:
  no registered check runs it. The Python test change was not executed either.

## Next step

Read from the next CI log `gecode_statistics` (and `gecode_statistics_raw` to see the real names),
then decide among the model changes above. Nothing here proposes raising the budget or relaxing
the termination or thresholds.
