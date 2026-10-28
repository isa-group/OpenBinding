# Slice W tests (G3): how to test

Requirement: `req~frontend-rendering-workbench-run-result~1`.

Run: `cd frontend && pnpm exec vitest run src/pages/Workbench/Workbench.test.tsx`

- `workbenchTestKit.tsx` adds `runProblemDocument()` (the compiled `BindingProblem` that `readBindingProblem` reads),
  `runResult()`, `jobWith()` and `answerIr(mock, 'document' | 'missing' | 'pending')`.
- `Workbench.test.tsx` mocks `jobsApi.ir` (`jobs.ir`) and has the group `the authoritative result`: the RunResult parts, no
  `.wb-result-summary` and no `<pre>` outside a source view, ids with no note while `ir` is pending, the not-available note
  when `ir` fails with 404, and a placement decision (empty binding text, source under `View source`).
- Before the implementation the five new tests fail on assertions (no `Run result` region). After it, they must pass,
  and the other Workbench tests stay green. `jobs.ir` must be called once with `job-1`.
- Not done here: the hygiene test, the allow-list and `retiredScreens` (the implementation task).
