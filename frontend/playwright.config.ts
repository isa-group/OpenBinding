import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  use: {
    baseURL: process.env.ANALYSIS_LIVE === '1' ? 'http://localhost:5173' : 'http://127.0.0.1:4177',
    trace: 'retain-on-failure',
  },
  webServer: process.env.ANALYSIS_LIVE === '1' ? undefined : {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4177`,
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: true,
  },
});
