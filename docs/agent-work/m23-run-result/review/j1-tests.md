# J.1 how to test: RunResult

Run from `frontend/`:

```
pnpm exec vitest run src/components/rendering/runResultModel.test.ts src/components/rendering/RunResult.test.tsx
pnpm exec tsc -b
pnpm exec eslint src/components/rendering
```

Fixtures are in `src/components/rendering/runResultFixtures.ts` (problem, constraints, two solutions, report).

## `runResultModel.test.ts`

Pure reading rules, own keys only:
- `verdictOf`: a non-empty string as it is, else `UNKNOWN`.
- `solutionsOf`: plain objects in order; anything else dropped.
- `figuresOf`: finite numbers of `features`, else `metrics`; `objectives.mode` never read.
- `optimizationTypeOf`: `objectives.type` of the first solution that has one.
- `unitsOf`, `notesOf`, `remoteOf`: units per feature, string notes, remote with at least one own key.

## `RunResult.test.tsx`

- Composition order: verdict, summary, notice, choice, figures, binding, bounds, objective, claims, trade-offs, extras, source, log; log and source closed.
- A run without solutions, and a solution without figures or objectives.
- Verdict for each termination and `UNKNOWN` for a missing one.
- Solution choice: the quality figures and the solution source follow the select; the claims and the trade-off set do not; no select for one solution.
- Canonical shape: `features` win over `metrics`, `metrics` as fallback, `type` and `scalarization` read and `mode` ignored.
- Names, missing problem note (`null`) and no note while loading (`undefined`), trade-off set, claims, source and log.
- The drawing of the chart is not checked in jsdom; ui-qa covers it.
