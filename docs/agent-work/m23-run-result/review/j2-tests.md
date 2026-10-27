# J.2 tests: how to test the Jobs run result

Run: `cd frontend && pnpm exec vitest run src/pages/Jobs/JobDetail.test.tsx src/test/rawRenderingHygiene.test.ts src/routes/retiredScreens.test.tsx`.
Before the Jobs wiring these fail on assertions; after it they pass.

By hand on a preview (requirement `frontend-rendering-job-run-result`):

1. **A completed job.** Open `/app/<org>/<project>/jobs/<id>` of a finished run. The page shows one region `Run result`:
   the verdict badge first, the summary, the `Quality of this combination` figures, `Chosen providers` with task and
   provider names (not ids), `QoS against bounds`, `Claimed and evaluated values`, the trade-off set (two or more
   solutions), the single-swaps panel, a closed `View source`, and the closed `Engine log` last. The network tab shows
   one `GET /v1/jobs/<id>/ir` and one `GET /v1/jobs/<id>/report`. There is no `Compare with the engine` button.
2. **An infeasible job.** The `INFEASIBLE` badge comes first, then `Why no combination works` (with `See the rules` and
   `Try faster providers`), then the best attempt's parts. `QoS against bounds` shows the violated rule.
3. **A job whose compiled form is gone** (`/ir` answers 404 or 409). The region shows `The compiled problem of this run is
   not available, ...` and tasks and candidates appear by id. A failing `/report` shows no error.
4. **Queued, running, cancelled and failed jobs** keep their texts and make neither request.

Hygiene: the allow-list ceiling is 9, with offenders 3, 6, 8, 9, 10, 12, 13, 14, 15.
