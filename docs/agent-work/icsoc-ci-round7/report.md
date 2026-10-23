# icsoc-ci-round7: the new OPTIMAL (score 0.2007) against the baseline (0.02037)

Context: PR #24, head 2a51ff4e4908c2062e8513fa7e0864f79a3c1048, CI job 120189053538,
`test_reduced_campaign_matches_or_remains_statistically_sensible`.

**Nothing below was run on a solver.** There is no MiniZinc, `fzn-gecode`, gateway stack or
dataset here (`experimentation/icsoc/original_dataset` is not in this worktree). Executed: the three
registered checks only. Everything marked "reading" comes from the files of this worktree at the
task's starting commit; everything marked "CI" comes from the task description.

Not touched: the assertions of the test, `mediaOrch_146588263_50.json`, digests, tolerances,
weights, `time_budget_ms`, the generator, the expected OPTIMAL termination.

## 1. Measured (CI job 120189053538, as given)

| item | value |
| --- | --- |
| minizinc-csp termination | OPTIMAL |
| time | 967 ms (flatten 118, search 849) |
| nodes / failures | 27370 / 13664 |
| propagators / variables | 658 (was 27851) / 409 (was 14874) |
| solutions / gecode_threads | 9 / 4 |
| score of the returned binding | 0.20072008379148443 |
| baseline `legacyExact` and `currentExact` | score 0.02037444933920705, cost 1.26844236, latency 37.0, security 1.0 |

Also measured, by the engine itself: `solver.ts:88` throws unless
`|exact score - objective_value| <= 1e-6` for the incumbent it returns, and the job completed.
So for the **returned** binding the model's objective (latency lookups included) agrees with the
canonical evaluation. This says nothing about bindings the model did not return.

## 2. Reading verification of rounds 5 and 6 (task 1)

Verdict: **no defect found** in the round-5 (`capacity_vacuous`) or round-6 (latency lookups)
changes. They cannot, by reading, remove a binding that satisfies the problem. Each point:

### Round 6, latency tables

| point | evidence |
| --- | --- |
| `n_pool_slots` equals the dimension of both tables, dummy pool included | `placement.ts:199-200,206-213` push `poolModel` and `poolRefs` together (starting with the dummy), `poolSlots = poolRefs.length`; `dzn_builder.ts:577` prints `n_pool_slots = poolModel.length`. |
| `pool_latency` is `n_pool_slots x n_pool_slots`, row = from, column = to | `placement.ts:214` (`Array.from({length: poolSlots}, () => Array(poolSlots)...)`), written at `[poolIndex(from)-1][poolIndex(to)-1]` (`:223`); printed row by row by `fmt2dF` -> `fmt2d` (`encoders/format.ts:3-4,23`), `dzn_builder.ts:581`. |
| flattened index is `(from-1)*n + to` | `binding_problem.mzn:351` builds `[pool_latency[a, b] \| a in 1..n_pool_slots, b in 1..n_pool_slots]`: `a` is the outer generator, so the list is row-major; `:352` indexes it with `(from_pool - 1) * n_pool_slots + to_pool`, which is 1-based and ranges over `1..n^2`. Pinned by the new test `puts the cell of (from, to) at ...` on an asymmetric 3-pool table. |
| `event_latency` is `n_events x n_pool_slots`, row = event, column = destination pool | `placement.ts:247-256`: event index `eventModel.length + 1`, one entry per `poolRefs` (dummy included); `dzn_builder.ts:585`; model `:354` reads `[event_latency[event, p] \| p in 1..n_pool_slots]` with `to_pool`. The event index used by `transition_from` / `activity_predecessor_source` is the same index (`placement.ts:301-303,433`). Pinned by the new test `gives each event one row ...`. |
| the 2-D table is not transposed | `placement.ts:223` stores from-pool as row; the model's `a` (first generator) is `from_pool`. The new test uses `a->b = 3`, `b->a = 7` to make a transpose visible. |
| scale / domain of `table_value` | `binding_problem.mzn:174-176`: `scale = 10^floor(log10(2147483647 / max\|v\|))`, so `max\|v\| * scale <= 2^31-1` by construction. **No clamp and no sentinel**: there is no INF or "no route" value in either table, because `fmtFloat` throws on non-finite input (`format.ts:13`) and missing links become `0` (`placement.ts:223`, see risk 1). `hi` fits 32 bits; `lo` is bounded by `0.5 * 1e9`. |
| bound of `value` | `:185` `var min(table)..max(table)`, over the whole flattened table: the diagonal zeros, the zeros of the dummy pool and of other models' pools, and every real latency are inside. The recovered value is within one ulp of `v` (comment `:169-173`), so the interval of the equality contains `v` and meets `min..max` there. |
| both forms of the equality | `:187-188`: `value * scale == high` when every `lo` is 0, else `value * (scale*1e9) == high*1e9 + lo[idx]`. Both are exact for decimal data. |
| every access goes through the new functions | `:356-360` (transitions) and `:385-387` (activity predecessors); the static test already in the tree pins it. |

### Round 5, `capacity_vacuous`

| point | evidence |
| --- | --- |
| it can only drop checks that no selection violates | `dzn_builder.ts:69-93`: the load is the sum over tasks of the largest weighted demand of an eligible candidate in the check's pool; the check is dropped only if `load * (1 + 1e-9) <= limit`, with `limit` as printed (already relaxed, `:465`). An over-approximation of the real load can only keep more checks, never fewer. |
| pool and column indices agree | `candidatePool` and `capacityPool` both use `poolIndex` (`placement.ts:232,238,275`); the column index is the one printed in `capacity_column` (`:277`) and used for `candidateResourceDemand` (`:282-285`). |
| the model skips exactly those checks | `binding_problem.mzn:320-322` (`capacity_in_bin \/ capacity_vacuous` -> `true`). The demand tables of columns used only by vacuous checks are replaced by `0.0` (`:294-304`) and are only read in the branches `:323-330` that a vacuous check never reaches. |
| a non-finite or missing limit keeps the check | `Number.isFinite(load) && load*(1+1e-9) <= limit` is false for `NaN`. |
| disjointness | scope 2 is reported only when `selectionDisjoint`; the generator makes candidates per task, so it is true here (assumed from the generator, not measured). |

### Things found while reading that are NOT the cause (risks)

1. `placement.ts:223`: a pool pair with no link gets latency `0` in the model, while
   `evaluatePlacement` (`placement.ts:488`) throws a plain `Error` for the same pair. The model is
   therefore more permissive than the evaluator there, never stricter; if the solver ever chose such a
   pair, the whole solve would fail instead of skipping the incumbent. Not triggered in this run
   (the job completed). Pre-existing, unchanged.
2. The `lo` form of `table_value` uses coefficients up to `scale * 1e9` and constants up to about
   `2^31 * 1e9` in a Gecode float linear equality. Rounding there is relative (about 1e-16), so the
   interval of a latency is about 1e-13 wide (assumed, not measured), far below the 1e-9 slack of
   `numeric.ts`.
3. `globalMetricModel[metric - 1] = modelId` (`placement.ts:431`) keeps the last placement model that
   declares a global latency for the same feature; the evaluator does the same (`:567-572`), so they agree.

## 3. Evidence that points to H2, found while reading (not measured)

The package's optimization criteria are produced by `experimentation/icsoc/generator/generator.py:517-530`:

```python
"criteria": [{"id": feature_name, ..., "direction": "minimize",
              "normalize": {**normalize_bounds[feature_name], "clamp": True}}
             for feature_name in ("latency", "cost", "security")]
```

`direction` is the literal `"minimize"` for **all three** criteria, and
`generator/tests/test_generator.py:350` asserts exactly that. But the feature itself is declared
`"security": {"direction": "maximize", "aggregation": "min", ...}` (`generator.py:695-701`).
Both the engine (`solver.ts:298-300`, `dzn_builder.ts:1076` -> `binding_problem.mzn:509`) and the
gateway score a criterion with **its own** `direction`: `minimize` -> loss = normalized value.

Consequence for the baseline, by arithmetic on `mediaOrch_146588263_50.json`
(normalisation latency 0..599.28, cost 1.26844236..225.08162276, security 0.33..1.0; weights 0.33/0.34/0.33):

| vector | recorded score | rescored with security `minimize` |
| --- | --- | --- |
| `legacyExact` / `currentExact` (cost 1.26844236, latency 37.0, security 1.0) | 0.02037444933920705 = 0.33*37/599.28 | 0.020374 + 0.33 * (1.0-0.33)/(1.0-0.33) = **0.350374** |
| `currentObserved` random-search (cost 20.075004, latency 75.0245, sec 1.0) | 0.0698825520 = 0.33*75.0245/599.28 + 0.34*18.80656164/223.81318040 | 0.069883 + 0.33 = 0.399883 |
| `currentObserved` evolutionary (cost 16.660663890000002, latency 74.137, sec 1.0) | 0.06420703414 | 0.394207 |

The recorded scores of the **three** baseline entries contain no security term although all three
have security 1.0 and weight 0.33. Under `minimize` that term would be 0.33. So every recorded score
was produced with security as a **maximised** criterion, and none of them is reproducible with the
criteria the package declares today. Under the declared criteria the baseline binding scores 0.3504,
and a returned OPTIMAL of 0.2007 < 0.3504 is not contradictory: the engine would have found a binding
with lower security that is better under "minimise security".

What this does **not** prove: that 0.2007 is the true optimum of the current package (that needs the
CI print below), nor when or why `direction` became `minimize` for security (no `git log` here; the
description of the task dates it to the generator change 8508385). The first test of the file asserts
`package_digest == baseline["digests"]["package"]`; if it passes in CI, the digests were refreshed
with the package while the scores were not. I could not check that.

## 4. Test change (task 2): nothing relaxed

`openbinding-gateway/tests/integration/test_icsoc_regression.py`: new `_campaign_report`, printed
right before the first score assertion (so it appears in the captured stdout of a failing run). It
prints:

- every criterion: package direction / feature direction / normalisation / request weight;
- per lane (minizinc-csp, random-search, evolutionary-heuristics): termination, number of solutions,
  score, penalty, features, per-criterion `value/loss/weight`, violations and the binding;
- the baseline `legacyExact`, `currentExact` and each `currentObserved` entry **rescored under the
  package's own criteria** (`_rescore`, same formula as the engine and the gateway);
- the best score per lane, and a `WARNING` line if random-search or evolutionary beats the exact
  lane by more than 1e-9 (that would make the exact OPTIMAL false: H1).

No assertion, tolerance, baseline value or option was changed. The Python was not executed (no
gateway stack, no dataset) and no registered check compiles it; it was reviewed by reading only.

`engines/minizinc-csp/src/minizinc_runner.test.ts`: new describe `placement latency tables as the
model reads them` (3 tests) calling `buildPlacementEncoding` on an asymmetric three-pool network:
dimensions and DZN text of `pool_latency` and `event_latency`, the row-major cell of `(from, to)`,
explicit event latency overriding the network, dummy pool first.

## 5. How to read the next CI print

| observation | reading |
| --- | --- |
| package criteria show `security: minimize / maximize`, the returned minizinc binding has security < 1.0, the baseline rescored equals about 0.3504, random/evolutionary scores are >= 0.2007 (and no `WARNING`) | **H2**: the golden predates the criteria; the engine result is consistent with the package. |
| `WARNING: random-search ... < minizinc-csp`, or evolutionary below 0.2007, with empty hard violations | **H1**: the model excludes a feasible binding. Then compare the heuristic binding with the exact one task by task (cost, pool, latency) to find which constraint of the model rejects it. |
| criteria show `security: maximize` | the reading in section 3 is wrong for the CI package and the 0.2007 vs 0.0204 gap is unexplained; H1 stays open and the print above is what to analyse. |
| minizinc binding has security 1.0, cost 1.268 and latency 37.0 | the score would then be 0.02037 and the assertion could not have failed; it is not what CI reported. |

## 6. Checks (through `qa_run`)

- Check 0 `pnpm --dir engines/minizinc-csp install --frozen-lockfile`: exit 0.
- Check 1 `pnpm --dir engines/minizinc-csp run build`: exit 0.
- Check 2 `node --test engines/minizinc-csp/dist/minizinc_runner.test.js`: exit 0, 42 tests, 39 pass,
  0 fail, 3 skipped (the three `real MiniZinc` tests, `NO EJECUTADO: MINIZINC_REAL!=1`).

Not executed: `conformance.test.js` (no registered check), the Python test, any MiniZinc/Gecode run.

## 7. Open points

1. H1 vs H2 is not closed by execution: it needs the next CI print.
2. `crp.md` lists what the owner must decide if H2 holds.
3. The speed result of round 6 stands on its own: 658 propagators and 967 ms are real; they do not
   depend on which hypothesis wins.
