# J.2 implementation note: the Jobs page through RunResult

Requirement: `req~frontend-rendering-job-run-result~1`.

How to test:
1. `cd frontend && pnpm exec vitest run src/pages/Jobs src/components/rendering src/api src/test/rawRenderingHygiene.test.ts src/routes/retiredScreens.test.tsx`
2. Open a completed job (`/app/<org>/<project>/jobs/<id>`): one "Run result" region with the verdict, "Quality of this combination",
   "Chosen providers", "QoS against bounds", "Claimed and evaluated values", then the swaps panel and, closed, "View source".
3. A queued, running, cancelled or failed job shows its old message and requests neither `/ir` nor `/report`.
4. Make `/v1/jobs/<id>/ir` answer 404 or 409: the run result says the compiled problem is not available and shows ids.
5. An infeasible job shows "Why no combination works" right after the verdict and no swaps panel.
6. Playwright (`e2e/s6a-jobs.spec.ts`) is checked by CI; it cannot run in the lab.
7. The raw-rendering allow-list now has 9 entries (offender 2 retired); Workbench RunPanel (3) is retired by the next slice.
