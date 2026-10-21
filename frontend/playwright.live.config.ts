import { defineConfig } from '@playwright/test';

/**
 * The live specs (`e2e/live`) as the lab runs them, inside the `e2e` service of compose.lab.json: against the stack that is already
 * up (`BASE_URL`, `http://web:8080` there), with the synthetic users the seed created. `playwright.config.ts` stays as it is for
 * the mocked specs and for runs from a workstation; this file has no web server and no mocked project.
 *
 * - `desktop` (1280x800) runs every spec; `mobile` (390x844, touch) runs only the visual QA. The login of the lab is throttled per
 *   user (10 attempts in 5 minutes), and the functional specs do not depend on the size of the screen.
 * - One worker: the specs share the lab and its login budget.
 * - `outputDir` is a subdirectory of the results: Playwright empties it when a run starts, and `done`, `report.json` and the
 *   screenshots of the visual QA live beside it.
 * - Chromium runs with `--no-sandbox` (the container is unprivileged and has no user namespaces to spare) and
 *   `--disable-dev-shm-usage` (the shared memory of the container is not guaranteed to be large enough).
 */
const results = process.env.E2E_RESULTS_DIR ?? '/results';
const baseURL = process.env.BASE_URL ?? 'http://web:8080';
const browser = { browserName: 'chromium' as const, launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } };

export default defineConfig({
  testDir: './e2e/live',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A run waits for a real engine (04) and may wait out a throttled login (support.ts): the budget is generous.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  outputDir: `${results}/test-output`,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...browser, viewport: { width: 1280, height: 800 } } },
    {
      name: 'mobile',
      testMatch: '**/visual-qa.spec.ts',
      use: { ...browser, viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
});
