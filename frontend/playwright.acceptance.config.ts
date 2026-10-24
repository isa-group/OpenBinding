import { defineConfig } from '@playwright/test';

/**
 * Runner of the UI acceptance tests, which live in `acceptance/ui` at the repository root and are written only by the
 * test-designer. Like the `mocked` project of `playwright.config.ts`, it uses the Vite dev server on 127.0.0.1:4177, unless
 * `PLAYWRIGHT_BASE_URL` names a stack to talk to. Run it with `--pass-with-no-tests` while there are none.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4177';
const stackGiven = Boolean(process.env.PLAYWRIGHT_BASE_URL);

export default defineConfig({
  testDir: '../acceptance/ui',
  fullyParallel: true,
  retries: 0,
  outputDir: 'test-results/acceptance',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'acceptance' }],
  webServer: stackGiven ? undefined : {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4177`,
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: true,
  },
});
