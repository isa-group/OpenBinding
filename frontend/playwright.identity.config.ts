import { defineConfig } from '@playwright/test';

/**
 * The SCORETech Identity walks (`e2e/identity`), run only by lab/identity/walk.sh inside the `e2e-identity` service of
 * compose.lab-identity.json, against the OB lab on http://localhost:18198 and the SCORETech Identity lab on
 * http://localhost:18000 (host networking: Identity's issuer and return origins are loopback ones). No web server and no
 * mocked project; one worker, because the users, their email codes and Identity's code limits are shared. The phases of a
 * walk are separate runs selected by tag (`@bootstrap`, the untagged main phase, `@signup`, `@granted`, `@rollback`);
 * what one phase learns for the next is kept in `walk-state.json` under the results.
 */
const results = process.env.E2E_RESULTS_DIR ?? '/results';

export default defineConfig({
  testDir: './e2e/identity',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // One directory per phase (WALK_PHASE): Playwright empties its output directory when a run starts.
  outputDir: `${results}/test-output${process.env.WALK_PHASE ? `-${process.env.WALK_PHASE}` : ''}`,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: `${results}/identity-report${process.env.WALK_PHASE ? `-${process.env.WALK_PHASE}` : ''}.json`,
      },
    ],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:18198',
    browserName: 'chromium',
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
});
