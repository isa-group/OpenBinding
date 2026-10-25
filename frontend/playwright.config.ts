import { defineConfig } from '@playwright/test';

/**
 * Two kinds of specs:
 * - `mocked`: every spec outside `e2e/live`, against the Vite dev server with the API answered by the spec itself (or against
 *   a frontend already running on port 5173 when `ANALYSIS_LIVE=1`; the spec written for that mode was retired with the analysis screens).
 * - `live`: `e2e/live/*.spec.ts`, against a running stack (the lab, by default `http://localhost:18100`) with its synthetic users.
 *   Run it with `PLAYWRIGHT_BASE_URL=http://localhost:18100 LAB_SEED_PASSWORD=<the seed password> pnpm exec playwright test --project=live`;
 *   the password comes from the environment only. Screenshots go to the output directory of the run (`test-results/`).
 *
 * Setting `PLAYWRIGHT_BASE_URL` also stops the local Vite server from being started: there is a stack to talk to already.
 */
const liveBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:18100';
const stackGiven = Boolean(process.env.PLAYWRIGHT_BASE_URL);
const analysisLive = process.env.ANALYSIS_LIVE === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mocked',
      testIgnore: '**/live/**',
      use: { baseURL: analysisLive ? 'http://localhost:5173' : 'http://127.0.0.1:4177' },
    },
    {
      name: 'live',
      testMatch: '**/live/**/*.spec.ts',
      // The lab is shared and its login is throttled per user: the specs of this project take turns.
      fullyParallel: false,
      use: { baseURL: liveBaseUrl, viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: analysisLive || stackGiven ? undefined : {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4177`,
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: true,
  },
});
