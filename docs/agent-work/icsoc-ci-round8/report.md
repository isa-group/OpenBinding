# icsoc-ci-round8: criterion direction comes from its feature

Context: PR #24, base 53db471 (head 53db4716a954a7585f480ddd4000d0d61f63e961). Owner answer to
`crp-icsoc-security-direction`: option (a), each criterion takes its direction from its feature's
definition, with a test; do not change scores, thresholds or classifications of the golden; only the
`package` and `ir` digests, explained in the review package; stop and open a CRP if anything else differs.

## 1. What changed

| file | change |
| --- | --- |
| `experimentation/icsoc/generator/generator.py` | In the `Optimization` document, `"direction": "minimize"` (literal, same for the three criteria) is now `features[feature_name]["direction"]`. `features` is the dict from `base_feature_definitions` (the same one written to `application.json`), so the feature definition is the single source. No per-criterion literal remains. `latency` and `cost` stay `minimize`; `security` becomes `maximize`. |
| `experimentation/icsoc/generator/tests/test_generator.py` | `_assert_optimization_matches_profile` no longer asserts `== "minimize"`; it takes the application document and asserts `criterion["direction"] == application.spec.features[criterion.id].direction` for every criterion. The dataset-free test `test_synthetic_instance_optimization_uses_current_profile_schema` also pins the explicit result `{latency: minimize, cost: minimize, security: maximize}`. No other assertion was changed or relaxed. |
| `experimentation/icsoc/regression/mediaOrch_146588263_50.json` | **Not changed** (see section 2). |

## 2. Digests: NOT regenerated (pending)

The `package` and `ir` digests of `mediaOrch_146588263_50.json` change, because `optimization.json`
now carries `"direction": "maximize"` for `security`. I could **not** compute the new values here and I
did not invent them:

- they come from the real package generated from `experimentation/icsoc/original_dataset`
  (seed `146588263`, infrastructure 50, generator seed 12345), which is not in this worktree;
- `ir` additionally needs `compile_instance` on that package.

Current values (unchanged in the file, therefore stale after this change):

| digest | before (in the file) | after |
| --- | --- | --- |
| package | `sha256-b69d4c4b2acdedb5a2f28a088c599e27c33e8744424a15c736b391fd1b0c4382` | pending, not computed |
| ir | `sha256-9482add1ff2848a209fd7627c6ab7ddee9cfa3023129603917d62ff8ca8fcceb` | pending, not computed |

Consequence: until they are refreshed, the first assertions of
`openbinding-gateway/tests/integration/test_icsoc_regression.py` (lines 133 and 135,
`package_digest == baseline["digests"]["package"]` and `problem.digest == baseline["digests"]["ir"]`)
will fail on CI with the new digests. That is the expected, and only expected, difference.

How to regenerate (needs the dataset, MiniZinc not required for the digests): run the integration test
once in an environment that has the dataset (the CI job of the PR). Its failure message prints the
actual `reduced_package.package_digest` and `problem.digest`; copy those two values, and only those
two, into `digests.package` and `digests.ir`. The equivalent manual route is to call `generate_dataset`
with `applications={"mediaOrch"}`, `dataset_seeds={"146588263"}`, `sizes={"50"}`, `seed=12345`, then
`load_package(...).package_digest` and `compile_instance(package).digest`.

**Discrepancy to keep open:** if the new digests differ for any reason other than the `security`
direction (for example, if the package digest changes in more than `optimization.json`), that is a
different difference and per the owner's instruction needs a CRP, not a silent refresh. I cannot
check it here. A diff of the generated `optimization.json` against the previous one should show exactly
one changed line: `criteria[2].direction` `minimize` -> `maximize`.

## 3. Scores, thresholds, classifications

Confirmed by construction: no score, threshold, weight, classification, name or any other field of
`mediaOrch_146588263_50.json` was touched; the file is byte-identical to the base. The golden scores
were computed with security maximised (round 7, section 3: the three baseline scores contain no
security term although security is 1.0 with weight 0.33), which is what the package declares after
this change, so they are expected to reproduce. This is expected, not measured: nothing was run on a
solver here.

## 4. Text for the review package of #24

> **Optimization criteria direction.** The ICSOC generator wrote `direction: "minimize"` for the
> three criteria (latency, cost, security), while the `security` feature is declared `maximize`. The
> engine and the gateway score a criterion with its own direction, so the golden
> `mediaOrch_146588263_50.json`, whose scores were computed with security maximised, was not
> reproduced (CI returned an OPTIMAL of 0.2007 instead of 0.0204). Per the owner's answer to
> `crp-icsoc-security-direction` (option a), each criterion now takes its direction from the
> definition of its feature (single source of truth in `generator.py`), and a test checks that every
> criterion matches its feature and that `security` is `maximize`. In the golden only the `package`
> and `ir` digests change, because `optimization.json` changes; scores, thresholds, weights and
> classifications are unchanged. The new digests are the ones produced by the generator on the real
> dataset and must be taken from the CI run (see the report `docs/agent-work/icsoc-ci-round8/report.md`).

## 5. Checks (through `qa_run`)

- Check 0 `uv --project openbinding-gateway sync --locked --extra test`: exit 0 (74 packages installed;
  only the uv hardlink warning on stderr).
- Check 1 `uv --project openbinding-gateway run --extra test python -m pytest -o addopts=
  experimentation/icsoc/generator/tests -q`: exit 0, `13 passed, 3 skipped in 14.93s`. The skipped
  tests are the ones that need the ICSOC dataset (`requires_dataset`), which is absent; I did not read
  the skip reasons from the output, which only shows the count. The dataset-free test that pins
  `security: maximize` ran and passed.

Not executed: the gateway integration regression test, any MiniZinc run, any generation on the real
dataset.

## 6. Open points

1. `digests.package` and `digests.ir` are stale until regenerated as in section 2.
2. Confirm in CI that the golden scores reproduce with the new direction (H2 from round 7).
