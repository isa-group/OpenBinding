# How to test: m23-objective-breakdown (slice O1)

`ObjectiveBreakdown` and its model `objectiveTermsOf` are new and not wired into any page yet (J1 and W1 do that), so
there is no screen to open. The evidence is the unit tests.

## Run

From the repository root:

```
cd frontend
pnpm install --frozen-lockfile
pnpm exec vitest run ObjectiveBreakdown objectiveModel src/test
pnpm exec eslint .
pnpm exec tsc -b
```

Expected: all tests pass (the hygiene tests in `src/test` still pass because no allow-list entry changes), eslint
reports no errors and `tsc -b` prints nothing.

## What each test shows

`frontend/src/components/rendering/objectiveModel.test.ts`
- Terms with a problem: direction and unit come from the compiled problem; `weighted` is loss × weight.
- Terms without a problem, or with a problem that names neither the criterion nor the feature: direction and unit are
  `null`, never guessed.
- `null`, `undefined`, a string, an array and the earlier `{ mode, score }` shape give `null`.
- Tolerant reading: a non-number value, a missing component, a non-string scalarization or penalty and a list score with
  a non-number entry.

`frontend/src/components/rendering/ObjectiveBreakdown.test.tsx`
- Region name (default and `label`), and the `Scalarization`, `Score`, `Penalty` summary.
- Weighted-sum table: column headers, row values with units and direction in words, and the `Total weighted loss` row.
- List score: one item per position named by criterion, then `Penalty`, later positions `Entry <n>`; no weight columns.
- Weighted sum with a list score: weight columns stay, no total row.
- Missing values show `—` (hidden from assistive technology) with `no value` for screen readers; the total shows the
  same when a weighted loss is missing.
- Number format (en-US, at most three decimals), the no-terms note, text-only rendering of markup-like strings, and no
  hex colour in the stylesheet.

## Not covered here

The rendered look and the 390 px horizontal scroll are checked by ui-qa once J1 shows the component on a screen
(1440×900 and 390×844). `openspec validate m23-objective-breakdown --strict` is not a registered check for this task.
