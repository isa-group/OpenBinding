import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaywrightTestConfig, PlaywrightTestProject } from '@playwright/test';
import base from '../playwright.config';

/**
 * The base config with the Vite port taken from `E2E_PORT`, so that runs of several worktrees on one host do not share a server.
 * Run it as `E2E_PORT=<port> pnpm exec playwright test --config e2e/playwright.port.config.ts --project=mocked ...`.
 *
 * Relative paths of a config resolve against the config file, which lives in `e2e/` here: the path options are made absolute
 * against the frontend directory, where the base config expects them.
 */
const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portGiven = Boolean(process.env.E2E_PORT);
const port = process.env.E2E_PORT ?? '4177';

const absolute = (p: string | undefined) => (p === undefined ? undefined : path.resolve(frontendDir, p));
const withPort = (url: string | undefined) => url?.replace(':4177', `:${port}`);

type PathOptions = { testDir?: string; outputDir?: string; snapshotDir?: string };

function withAbsolutePaths<T extends PathOptions>(options: T): T {
  const resolved = { ...options };
  for (const key of ['testDir', 'outputDir', 'snapshotDir'] as const) {
    if (typeof resolved[key] === 'string') resolved[key] = absolute(resolved[key]);
  }
  return resolved;
}

const projects: PlaywrightTestProject[] = (base.projects ?? []).map((project) => {
  const resolved = withAbsolutePaths(project);
  const baseURL = withPort(project.use?.baseURL);
  return baseURL === undefined ? resolved : { ...resolved, use: { ...project.use, baseURL } };
});

const webServer = base.webServer;
const config: PlaywrightTestConfig = {
  ...withAbsolutePaths(base),
  projects,
  webServer: webServer && !Array.isArray(webServer)
    ? {
        ...webServer,
        command: webServer.command.replace('--port 4177', `--port ${port}`),
        url: withPort(webServer.url),
        cwd: frontendDir,
        reuseExistingServer: portGiven ? false : webServer.reuseExistingServer,
      }
    : webServer,
};

export default config;
