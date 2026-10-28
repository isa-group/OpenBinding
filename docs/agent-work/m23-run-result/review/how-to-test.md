# m23-run-result: how to test (whole change)

Requirements: `frontend-rendering-job-run-result`, `frontend-rendering-workbench-run-result`,
`frontend-rendering-run-result-allow-list`. Per-slice notes: `h-tests.md`, `j1-tests.md`, `j2-tests.md`, `j2-impl.md`,
`w-tests.md` (kept).

## Commands (from `frontend/`)
- Focused: `pnpm exec vitest run src/pages/Jobs src/pages/Workbench src/components/rendering src/test/rawRenderingHygiene.test.ts src/routes/retiredScreens.test.tsx`
- Whole suite: `pnpm exec vitest run --exclude '**/node_modules/**' --exclude 'e2e/**'`
- Types and lint: `pnpm exec tsc -b`, `pnpm exec eslint . --quiet`
- Playwright (`e2e/s6a-jobs.spec.ts`, `e2e/s5d-workbench.spec.ts`) cannot run in the lab; CI runs it.

## Jobs run (`/app/<org>/<project>/jobs/<id>`)
1. Completed job: one "Run result" region with the verdict, "Quality of this combination", "Chosen providers",
   "QoS against bounds", "Claimed and evaluated values", the swaps panel and, closed, "View source".
2. Infeasible job: "Why no combination works" right after the verdict; no swaps panel.
3. Queued, running, cancelled or failed job: the old message; no `/ir` or `/report` request.
4. `/v1/jobs/<id>/ir` answering 404 or 409: the run result says the compiled problem is not available and shows ids.
5. The old "Compiled form" block and "Best combination found" heading are gone.

## Workbench run (`/app/<org>/<project>/workbench`, button Solve)
1. Binding decision: inside "Authoritative result" a "Run result" region with a "Chosen providers" table; no
   `.wb-result-summary`, no "Solution 1" region, no raw JSON `<pre>` outside "View source".
2. Placement decision (not a binding): the table shows its empty text and the decision source sits under "View source".
3. `ir` pending: ids with no note; `ir` 404: the not-available note. `jobs.ir` is called once with the job id.

## Hygiene ceiling
- `MAX_ALLOWED_OFFENDERS` is 8; the allow-list holds offenders 6, 8, 9, 10, 12, 13, 14, 15 and offenders 1 to 4 are
  absent (`rawRenderingHygiene.test.ts`, `retiredScreens.test.tsx`). Adding a raw `<pre>` or `JSON.stringify` render in
  `src/` makes the hygiene test fail.
