# Evidence: ICSOC regression weights and documentation

## Owner decision applied

A BIM package does not define weights in `optimization.json`. It declares
criteria only (id, feature, direction, normalize). The strategy (type,
scalarization, weights) goes in the `optimization` object of the execution
request. The change in `18860bb` is intentional.

## Changes

- `openbinding-gateway/tests/integration/test_icsoc_regression.py`: the
  `OPTIMIZATION` constant sent to `/v1/jobs` now carries the historical weights
  of `experimentation/icsoc/generator/configs/default.yml`:
  `{type: SINGLE, scalarization: weighted-sum, weights: [latency 0.33, cost 0.34, security 0.33]}`.
  The shape follows the validation in
  `bim-toolchain/packages/bim-core/src/bim_core/compat.py` (lines 404-477):
  each weight has exactly `criteria` and `value`, the criteria ids are the
  feature names, and the values are normalized to sum to one. Without weights the
  gateway fills equal weights (`1/count`), which changes the exact optimum.
  Thresholds, expected termination `OPTIMAL`, scores, assertions, the baseline
  JSON, digests and goldens are untouched.
- Documentation, only the sentences that put weights or aggregation strategy in
  the package: `docs/BIM_V1.md` (Optimization bullet), `docs/AUTHORING_GUIDE.md`
  (policy/strategy paragraph), `docs/SEMANTICS.md` (weighted optimization),
  `docs/CONCISENESS.md` (counted fields). `docs/DEMO.md:472` already stated this
  correctly and was used as the reference.

## Checks

- Check 0 (py_compile of the regression test + `experimentation/icsoc/generator/tests`),
  run after the edit: exit 0, `13 passed, 3 skipped`.
- The integration test itself was NOT run: it needs the gateway stack
  (`http://127.0.0.1:8000`) and the full ICSOC dataset, which are not available
  here. Its correctness against the stack is unverified.
- Check 1 (`git log -L607,618:experimentation/icsoc/generator/generator.py` and
  `git log -S candidateCatalog` over `6dcf959..HEAD`), exit 0, complete output:

  ```
  b67e72e Complete task 75f076a53f9249ef
  ```

## Commit that moved placement and routing to `candidateCatalog`

Per check 1, the only commit in `6dcf959..HEAD` touching generator.py lines
607-618 (and, if the second query returned it, the one introducing the
`candidateCatalog` string) is `b67e72e` ("Complete task 75f076a53f9249ef").
The output is a single line, so the two queries cannot be told apart in it; the
log of lines 641-642 was not queried separately.

Whether the move was deliberate is not established by this evidence: the commit
subject is the supervisor's generic task-completion message and says nothing
about the intent. Check 1 does not show the diff or the task description. To
settle it, read `git show b67e72e -- experimentation/icsoc/generator/generator.py`
and the task record 75f076a53f9249ef. This is open.
