# CRP: the ICSOC golden does not match the criteria of the current package (conditional on H2)

Status: **proposal, nothing was changed.** It applies only if the next CI print confirms H2
(see `report.md`, section 5). If it shows H1, discard this CRP: the problem is then a model defect
and is fixed in `engines/minizinc-csp`, without touching any golden.

## Situation

After round 6 the exact lane finishes OPTIMAL in 967 ms with score 0.20072008379148443; the golden
says 0.02037444933920705 (`legacyExact`, `currentExact` in
`experimentation/icsoc/regression/mediaOrch_146588263_50.json`).

## The two hypotheses

**H1: defect of the model (rounds 3-6).** The model excludes a feasible binding of score 0.0204 (or
any binding below 0.2007), so the OPTIMAL is false. Reading found nothing in the round-5 and round-6
changes that could do that (`report.md`, section 2). It would be shown by the test print: a
`WARNING` line (random-search or evolutionary below the exact score with no hard violation).

**H2: the golden is stale with respect to the package.**
`generator.py:517-530` writes `"direction": "minimize"` for the `latency`, `cost` and `security`
criteria, pinned by `generator/tests/test_generator.py:350`, while the feature `security` is
`direction: maximize` (`generator.py:695-701`). The three recorded baseline scores contain no
security term although their security is 1.0 and its weight 0.33; under `minimize` that term is 0.33.
Rescored with the declared criteria, the baseline binding is 0.3504, random-search 0.3999 and
evolutionary 0.3942 (arithmetic in `report.md`, section 3). An OPTIMAL of 0.2007 is then below the
baseline binding and not contradictory.

## What the owner must decide if H2 holds

The golden cannot be reconciled with the package by any change in the engine or in the test
assertions; one of the two sides has to change, and both are owner decisions.

1. **Which semantics is intended for the `security` criterion?**
   - (a) *Higher security is better* (as the feature, the legacy corpus and the historical case say).
     Then the generator is wrong: the criterion must be `maximize` (or take the feature's direction),
     `test_generator.py:350` must stop pinning `minimize` for all three, and the **package digest and
     the IR digest** in the golden change with the package. The scores in the golden would then
     probably stay valid (not verified; it needs one run). Files: `generator.py`,
     `generator/tests/test_generator.py`, `mediaOrch_146588263_50.json` (`digests` only, if the scores
     reproduce).
   - (b) *`minimize` is intended for all three criteria.* Then the golden must be regenerated from a
     run: `legacyExact`, `currentExact` (score, features, and the binding is not stored), the two
     `currentObserved` entries, `heuristic1000Evaluations` (the historical quantiles come from the
     legacy campaign and were computed with maximised security, so their meaning changes) and
     probably the classifications. The historical equivalence "the reduced case reproduces the
     published campaign" is lost and the test names and docstrings should say so.
2. **Whether the first test (`test_reduced_dataset_reproduces_the_historical_case`) currently
   passes.** If it does, the golden digests were refreshed with the package but the scores were not;
   the owner should say how the digests were produced, because option (a) and option (b) change
   different fields.
3. **Who may edit the golden.** The current rule is that goldens, digests, thresholds and weights are
   not touched without a CRP. This document is that request; it does not authorise anything until
   approved, and the approval should name the fields in question and the commit/CI run whose output
   is to be recorded.
4. **Whether the dated `currentObserved` heuristic scores (2026-08-28) are to be kept** as a
   historical record in a separate field, instead of overwritten.

## What this CRP does not ask for

- A relaxation of `abs=1e-9`, of the OPTIMAL expectation, of `time_budget_ms` or of any weight.
- A change in the engine: round 6 stays as it is (967 ms, 658 propagators).

## Evidence still missing (needed before approving)

The output of `_campaign_report` from a CI run of this branch: package criteria directions, the
three lanes' features and bindings, and the baseline rescored under the package criteria. It either
confirms the arithmetic above or sends the investigation back to H1.
