# ICSOC CI round 5: reducing the cost of the optimality proof in minizinc-csp

Context: PR #24, head 77cd05ea6232b019dc3c383d141da97c2c2ceb67, CI job 120154079229,
`test_reduced_campaign_matches_or_remains_statistically_sensible`. minizinc-csp / gecode with
`time_budget_ms` 30000 ends FEASIBLE.

**The final validation is the next CI run.** Nothing below was measured on a solver: there is no
MiniZinc, `fzn-gecode` or shell in this environment. The only executed things are the three registered
checks (install, `tsc` build, `minizinc_runner.test.js`). From the next log read `engine_flatten_ms`,
`engine_search_ms`, `termination`, `gecode_threads`, `gecode_statistics` (nodes, failures, propagations,
propagators, variables, solutions) and `encoding.vacuousCapacityChecks`.

**Not touched, as required:** `time_budget_ms` (test and engine), thresholds, expected OPTIMAL
termination, `mediaOrch_146588263_50.json`, digests, weights 0.33/0.34/0.33, normalisations. No `crp.md`:
the changes below do not raise the 30 s.

## Measured (from the CI log of job 120154079229, given in the task)

| item | value |
| --- | --- |
| flatten / search | 779 ms / 29468 ms |
| nodes / failures / peak depth | 68309 / 34151 / 15 |
| solutions / restarts | 1 / 0 |
| propagations | 178971011 (about 2600 per node) |
| propagators / variables | 28887 / 15099 |
| encoding | capacityChecks 224, binPackingChecks 0, relaxedLiterals 11, flatProducts 0 |
| widened float domains | 1532 |
| legacy baseline | OPTIMAL in 2.099 s, score 0.02037444933920705 |

Derived (arithmetic on those numbers, not measured separately): about 430 us per node, about 2300 nodes
per second, about 6 million propagations per second. The tree explored in 30 s is small; the time
goes to propagation (many propagators, many float propagators woken per node), and the proof is not
finished. How many nodes the full proof needs is **unknown**.

## What changed

### (d) Parallel search: `fzn-gecode -p N` (`minizinc_runner.ts`)

- The solve call is now `fzn-gecode -a -time <ms> -s -p <N> <file.widened.fzn>`. The FlatZinc file is still the
  last argument; `-a`, `-time` and `-s` keep their positions.
- `N` comes from `RunnerOptions.threads`, whose default (`runnerOptionsFromEnv`) is
  `FZN_GECODE_THREADS` (integer in [1,64], or `auto`/empty) or else `min(os.availableParallelism(), 8)`
  (`gecodeThreadsFromEnv`, `availableProcessors`, `MAX_AUTO_GECODE_THREADS`). An invalid value fails at
  start-up like the other `ENGINE_*`/`FZN_GECODE` variables. `new MiniZincRunner(options)` merges the
  environment defaults under its options, so the engine's own runner (`new Solver()`) takes the automatic count.
- The thread count is returned (`MiniZincRunResult.gecodeThreads`) and published as
  `provenance.gecode_threads` (`null` when the run ended before the solver started).
- There is no request option: `validateOptions` rejects unknown option keys and the gateway contract
  was not widened. The mechanism is the environment of the engine (`FZN_GECODE_THREADS`).
- **Validity for Gecode 6.3.0 (assumed, not run).** I rely on `-p <n>` ("number of threads, 0 = number
  of processing units") being a Gecode FlatZinc option, which is how the MiniZinc driver forwards its own `-p`
  to `fzn-gecode`. It is the one flag of this change I could not check against the pinned binary. If `fzn-gecode`
  rejected it, the engine would fail every solve with a solver error, which the next CI run shows at once;
  `FZN_GECODE_THREADS=1` still passes `-p 1`, so it would not avoid that.
- **Restarts (`-restart luby`) were not added.** With the model's static branching
  (`first_fail`, `indomain_min`) a restart repeats the same dive, so it only pays with nogoods or randomised
  branching, and I cannot check how `-restart` combines with `-a` and branch and bound in 6.3.0.
- **Reproducibility.** With `-p > 1` the number of nodes, the order of incumbents and, when several bindings
  share the optimal objective, the binding that is reported can differ between runs. The optimal
  objective value and the termination do not depend on the thread count (assumption: the same search space is
  explored, Gecode's parallel branch and bound is complete). `FZN_GECODE_THREADS=1` is the deterministic
  mode. The test compares score and features with tolerance, not the binding.
- **Capacity of the machine (assumed).** The speedup is bounded by the cores the engine container really
  gets and by `ENGINE_MAX_CONCURRENCY` (default 2): two concurrent jobs of 4 threads each compete for the same
  cores. `os.availableParallelism()` honours CPU affinity but not a cgroup CPU quota, so a container limited by
  quota to fewer CPUs than the host shows would oversubscribe. Gecode needs memory per thread (one
  copy of a space with about 29k propagators per worker).

### Ranking of incumbents (`solver.ts`)

`incumbentOrder` examines incumbents best objective first, latest first among equals. For the sequential
search, which prints strictly improving incumbents, this is exactly the previous "last to first". For a
parallel search it makes the answer the best incumbent rather than the one that arrived last. The unchanged
rule still applies on top: an incumbent that fails the exact post-check is skipped and the result is then
FEASIBLE, not OPTIMAL. The existing test "falls back to the latest exactly feasible incumbent" used
objectives 1 then 9, which is not a minimisation sequence; it now uses 1 then 0.5 (the later, lower value is
the relaxed-only binding that the exact check rejects). Its expectations are unchanged.

### (e) Capacity checks that cannot be violated are not posted (`dzn_builder.ts`, `binding_problem.mzn`)

- New data parameter `capacity_vacuous` (`array[1..n_capacity_checks] of bool`), computed by the exported
  `vacuousCapacityChecks`. A reified check `sum_t [pool(t) = p] * w_t * demand_t <= limit` is vacuous when
  the largest possible load, `sum over tasks of max(0, largest w_t * demand of an eligible candidate in p)`, times
  `(1 + 1e-9)` is within the limit **as printed** (already relaxed by the numeric slack). Never reported:
  checks that a bin-packing column enforces, and scope-2 (distinct selected candidate) checks when a candidate
  is eligible for several tasks (no per-task bound).
- The model skips those checks and no longer builds the per-task demand tables of columns that only vacuous
  checks use (`column_needs_demand`). A check that is skipped could never have failed, so the feasible set and
  therefore the optimum are unchanged; what disappears is, per vacuous check, one reified pool equality, one float
  product and a float sum term for each task, propagated at every node.
- `provenance.encoding.vacuousCapacityChecks` reports how many checks were dropped.
- **Effect in the ICSOC instance: unknown.** It depends on how loose the 56 pool capacities are against the
  5 tasks. If none of the 224 checks is vacuous this change does nothing there (the next log shows
  `vacuousCapacityChecks`).

### Why `binPackingChecks` is 0 (reading code; not confirmed on the data)

`binPackingColumns` (`placement.ts:130-191`, outside this task's scope, unchanged) turns a group of checks into
a native `bin_packing_capa` only if every task has the *same* demand for all its eligible candidates of the
column's model, the weights are integral after a common power-of-ten scaling that fits in 32 bits, the limits
are non-negative and finite, and, for the distinct-candidate scope, no candidate is eligible for two tasks.
The most likely reason in a catalog where every candidate carries its own resource demand is the first
condition. That would make the bin-packing path inapplicable without changing semantics; I did not widen it
(it would need a different encoding in `placement.ts`). Which condition fails here is **not known**.

## Considered and not applied (and why)

- **(a) Search annotation.** `first_fail` + `indomain_min` was kept. `dom_w_deg` and other selectors depend on
  what the 6.3.0 FlatZinc front-end accepts, which I cannot check, and an unknown annotation would break every
  solve. A different variable order needs measurements (nodes per order) to choose; with 5 slot variables of about
  108 values the first-fail order is essentially a static order.
- **(c) First incumbent and bound.** `orderEligibility` lists each task's candidates by weighted normalised
  loss of its own values, so the first dive is a good heuristic incumbent for the cost/security terms; the CI
  log shows `solutions: 1`, so either that incumbent is already optimal and the remaining 30 s is pure proof, or the
  search never improved it. The statistics do not tell which. Gecode adds the bound `objective < incumbent`
  itself after each solution; nothing in the model or the runner can strengthen that.
- **(e) Redundant additive bound on the objective** (sum of per-task minima of the weighted loss).
  Valid only for terms that are task-separable sums without clamping; whether more than one weighted term
  has that form here is unknown (cost is plausibly one, the others look like min/max aggregations or
  placement-time metrics). A wrong or too tight redundant constraint would change the optimum or
  reproduce the false-UNSAT/false-optimum ulp bugs that `numeric.ts` documents, and I could not run MiniZinc to
  rule that out. It needs a builder-side analysis of which terms are separable and a slack on the bound. Worth
  trying as a next step only if the next log shows a tree still large with `threads` > 1.
- **Per-node cost of the float propagators** (1532 widened float variables, the 2-D latency lookups
  `pool_latency[a, b]`): any change would need profiling data.

## Tests (all in `engines/minizinc-csp/src`, fake solver and static inspection)

In `minizinc_runner.test.ts` (executed by check 2):

- argv of the solve call: `-a -time <ms> -s -p 1 <file>` with `threads: 1` (the shared `fakeRunner` pins it for
  determinism), and a run with `threads: 3` gives `-s -p 3 <file>`, `gecodeThreads === 3`, `-a` still present.
- `gecodeThreadsFromEnv`: automatic choice from the processor count and its cap at 8, `auto`/blank, explicit
  `1`, an explicit value above the cap, invalid values (`0`, `65`, `-1`, `2.5`, `many`), and `runnerOptionsFromEnv`.
- `incumbentOrder`: improving sequence, out-of-order, ties, NaN, empty.
- `vacuousCapacityChecks`: vacuous / not, a load touching the limit keeps its check, bin-packing-covered and
  non-disjoint distinct-candidate checks never reported, non-finite demand, no checks.
- Model inspection: `binding_problem.mzn` declares `capacity_vacuous` and uses it in both places.

In `conformance.test.ts` (compiled by check 1, **not executed by any registered check**; the Dockerfile runs it
during the image build, including the real MiniZinc cases):

- DZN: `capacity_vacuous` for empty, bin-packed, reified-fallback and mixed (`[false, true]`) placement;
  `encoding.vacuousCapacityChecks`.
- `Solver`: `gecode_threads` in provenance (`null` without it); an out-of-order stream returns the best incumbent
  as OPTIMAL.
- Real MiniZinc (skipped without `minizinc`): a pool-capacity instance where both pools are roomy posts no check,
  returns the same optimum (all three tasks in the cheap pool, cost 3) and reports `vacuousCapacityChecks` 2. The
  existing capacity test (pool `a` holds 2 units for 3 tasks) still covers a check that is kept.

`cancel.test.ts` only gained the new required `encoding` field in its stub.

## Checks (through `qa_run`)

- Check 0 `pnpm --dir engines/minizinc-csp install --frozen-lockfile`: exit 0.
- Check 1 `pnpm --dir engines/minizinc-csp run build`: exit 0 (compiles every `src/*.ts`, `conformance.test.ts` included).
- Check 2 `node --test engines/minizinc-csp/dist/minizinc_runner.test.js`: exit 0, 36 tests, 33 pass,
  0 fail, 3 skipped (the three `real MiniZinc` tests, `NO EJECUTADO: MINIZINC_REAL!=1`).

Not executed: `conformance.test.js` (no registered check), the Python integration test, any MiniZinc/Gecode run.

## Open risks

1. `-p <n>` on the pinned Gecode 6.3.0 is assumed valid (see above). First thing to read in the next log.
2. The speedup of `-p` is unmeasured and bounded by the cores of the CI runner/container; with 2 cores at
   most about 2x is possible, and the proof may still need more than the 30 s that remain.
3. `vacuousCapacityChecks` may be 0 on this instance (then no effect there).
4. If the next log still ends FEASIBLE with `threads` > 1, the remaining levers are a stronger bound (redundant
   additive objective constraint, builder-side) and a cheaper latency/placement encoding; if the owner rules
   out any model change that cannot be measured first, the honest conclusion is that the 30 s budget cannot
   be met by search settings alone, which is a CRP matter, not something to do here.
