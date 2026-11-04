import { defineConfig } from '@playwright/test';

/**
 * Runner of the UI acceptance tests, which live in `acceptance/ui` at the repository root and are written only by the
 * test-designer. Like the `mocked` project of `playwright.config.ts`, it uses the Vite dev server on 127.0.0.1:4177, unless
 * `PLAYWRIGHT_BASE_URL` names a stack to talk to. `E2E_PORT` replaces the port (and never reuses a server already running on it),
 * so that runs of several worktrees on one host do not share a server. Run it with `--pass-with-no-tests` while there are none.
 */
const portGiven = Boolean(process.env.E2E_PORT);
const port = process.env.E2E_PORT ?? '4177';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const stackGiven = Boolean(process.env.PLAYWRIGHT_BASE_URL);

export default defineConfig({
  testDir: '../acceptance/ui',
  fullyParallel: true,
  retries: 0,
  // The first tests of a run open the application on a Vite server that compiles each module on demand, in parallel: the default
  // five seconds of an assertion are not enough for the first screen.
  expect: { timeout: 20_000 },
  outputDir: 'test-results/acceptance',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'acceptance' }],
  webServer: stackGiven ? undefined : {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !portGiven,
  },
});
