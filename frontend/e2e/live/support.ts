import { expect, type Page, type TestInfo } from '@playwright/test';
import { prepareCapture, waitUntilSettled } from '../helpers/pageChecks';

/**
 * Support for the specs of the `live` project: they run against a stack that is already up (the lab, `http://localhost:18100` by
 * default) with the synthetic users `tools/seed_lab.py` created. Nothing is mocked and nothing is created here beyond what the
 * specs do through the interface (one job).
 */

/** The synthetic users of the lab and what each one is for. The password is not here: see {@link labPassword}. */
export const LAB_USERS = {
  owner: 'lab-owner',
  member: 'lab-member',
  viewer: 'lab-viewer',
  outsider: 'lab-outsider',
} as const;

export type LabRole = keyof typeof LAB_USERS;

/** The data the lab seeds: `lab-main` (sponsor `lab-owner`) with the private project `bim-demo` and its case `simple-seq`. */
export const ORG = 'lab-main';
export const OTHER_ORG = 'lab-other';
export const PROJECT = 'bim-demo';
export const CASE = 'simple-seq';
export const PROJECT_PATH = `/app/${ORG}/${PROJECT}`;

/** The addresses of the native consoles the interface links to; the lab build does not override the defaults. */
export const SPACE_URL = process.env.PLAYWRIGHT_SPACE_URL ?? 'https://space.score.us.es';
export const SPHERE_URL = process.env.PLAYWRIGHT_SPHERE_URL ?? 'https://sphere.score.us.es';

/** Every user of the lab has the password the seed was given. It is read from the environment and never written down. */
export function labPassword(): string {
  const value = process.env.LAB_SEED_PASSWORD;
  if (!value) throw new Error('LAB_SEED_PASSWORD is not set: export the password the lab users were seeded with (it is not kept in the repository).');
  return value;
}

/** The access and refresh token keys of the browser session (`src/api/client.ts`). */
const ACCESS_TOKEN_KEY = 'openbinding-access-token';
const REFRESH_TOKEN_KEY = 'openbinding-refresh-token';

/**
 * Signs in through the API and hands the session to the page before it loads, so a spec does not spend a login of the (throttled) form.
 * Through the lab proxy the API is under `/api`; `PLAYWRIGHT_API_URL` names another one.
 */
export async function signInByApi(page: Page, role: LabRole): Promise<void> {
  const api = process.env.PLAYWRIGHT_API_URL ?? '/api';
  const response = await page.request.post(`${api}/v1/auth/login`, { data: { username_or_email: LAB_USERS[role], password: labPassword() } });
  expect(response.ok(), `login of ${LAB_USERS[role]} answered HTTP ${response.status()}`).toBeTruthy();
  const tokens = await response.json() as { access_token: string; refresh_token: string };
  await page.addInitScript((session) => {
    localStorage.setItem(session.access, session.accessToken);
    localStorage.setItem(session.refresh, session.refreshToken);
  }, { access: ACCESS_TOKEN_KEY, refresh: REFRESH_TOKEN_KEY, accessToken: tokens.access_token, refreshToken: tokens.refresh_token });
}

/** Signs in through the form of the login page, the way a person does. */
export async function signInThroughForm(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** Collects the errors the page throws, to be checked at the end of a spec. */
export function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** The two sizes every screen is looked at in: a desktop and a phone. */
export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

/**
 * Takes the screen at 1440x900 and at 390x844 and saves both in the output directory of the run (`test-results/<spec>/`), attached to
 * the report as well. The page goes back to the size it had.
 */
export async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const before = page.viewportSize();
  for (const view of VIEWPORTS) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await waitUntilSettled(page);
    await prepareCapture(page);
    const path = testInfo.outputPath(`${name}-${view.name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`${name}-${view.name}`, { path, contentType: 'image/png' });
  }
  if (before) await page.setViewportSize(before);
}
