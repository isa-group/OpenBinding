# How to test: m23-evaluation-diff (slice E1)

`EvaluationDiff` compares what an engine claimed for a run with what the gateway evaluated. No screen mounts it yet
(J1 wires it into the run result), so the evidence is the unit tests.

## Run

```
cd frontend
pnpm install --frozen-lockfile
pnpm exec vitest run EvaluationDiff evaluationDiffModel src/test
pnpm exec eslint .
pnpm exec tsc -b
```

Expected: all test files pass (the `src/test` hygiene tests need no allow-list entry), eslint reports no errors in the
new files, tsc prints nothing.

## What each group shows

`evaluationDiffModel.test.ts` (pure derivation, `evaluationDiffOf`, `shortText`):
- no claim gives `no-claim` and no rows; agreement within 1e-9; a difference beyond it;
- row order: termination, features (evaluated keys, then claim-only keys), score;
- `not stated`, `not evaluated` and `not a number` kinds; invalid values never agree;
- different solution counts: only a `Solutions` row, `paired` false;
- score lists by component; `metrics` and `objectives.score` fallbacks;
- a malformed claim, and `constructor` / `__proto__` as ordinary feature names;
- no mutation on deeply frozen inputs; `shortText` at 500, 600 and with a surrogate pair at the cut.

`EvaluationDiff.test.tsx` (rendering):
- the region name and `label`; the three summary lines and their singulars;
- the `Differences` table headers and cells; number format and the six-decimal fallback;
- engine text shown as text inside `bdi` (no `img`, `b` or `a`), direction controls isolated, shortening;
- `Engine notes`, `Why the gateway changed the result`, the caps (100 rows, 20 notes) with their "more" lines;
- no `<pre>`; no hex colour in `EvaluationDiff.css`.

## Manual check

None before J1: there is no routed page. After J1, open a finished job: with today's API the line reads that the
claimed values are not kept for the run.
