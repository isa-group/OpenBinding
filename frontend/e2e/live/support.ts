import type { Page, TestInfo } from '@playwright/test';
import { prepareCapture, waitUntilSettled } from '../helpers/pageChecks';
import { signInReturning, type Role as IdentityRole } from '../identity/support';

/**
 * Support for the specs of the `live` project: they run against a stack that is already up (the lab: `BASE_URL`, `http://web:8080`
 * inside the `e2e` service of compose.lab.json, `http://localhost:18100` through the tunnel) with the synthetic users
 * `tools/seed_lab.py` created. Nothing is mocked and nothing is created here beyond what the specs do through the interface (one job).
 * Every spec signs in on its own and depends on no other spec; they only need the seed.
 */

/** The synthetic users of the lab and what each one is for. The password is not here: see {@link labPassword}. */
export const LAB_USERS = {
  owner: 'lab-owner',
  member: 'lab-member',
  viewer: 'lab-viewer',
  outsider: 'lab-outsider',
} as const;

export type LabRole = keyof typeof LAB_USERS;

/** The data the lab seeds: `lab-main` (owner `lab-owner`) with its problem `simple-seq`. */
export const ORG = 'lab-main';
export const OTHER_ORG = 'lab-other';
export const CASE = 'simple-seq';
/** The organization's page (SPHERE's, with its tabs in the address). */
export const ORG_PAGE = `/orgs/${ORG}`;
/** The organization's Problems tab, and the pages of its problems (`${PROBLEM_PAGES}/<slug>`). */
export const PROBLEMS_TAB = `${ORG_PAGE}/problems`;
export const PROBLEM_PAGES = `/problems/${ORG}`;
/** The runs of the lab organization: its Runs tab. A run is `${RUN_PATH}/<id>` and the launcher `${LAUNCH_PATH}&problem=…`. */
export const RUNS_PATH = `/orgs/${ORG}/runs`;
/** Where a run of the lab organization opens: `${RUN_PATH}/<id>` (`run-detail`). */
export const RUN_PATH = `/runs/${ORG}`;
/** The run launcher in the lab organization (`run-launch`), to which a problem and a version are added as `&problem=…&revision=…`. */
export const LAUNCH_PATH = `/runs/new?org=${ORG}`;

/** The addresses of the native consoles the interface links to; the lab build does not override the defaults. */
export const SPACE_URL = process.env.PLAYWRIGHT_SPACE_URL ?? 'https://space.score.us.es';
export const SPHERE_URL = process.env.PLAYWRIGHT_SPHERE_URL ?? 'https://sphere.score.us.es';

/** Where the run keeps what the controller will not see directly: screenshots of the visual QA, reports. `/results` in the lab. */
export const RESULTS_DIR = process.env.E2E_RESULTS_DIR ?? '/results';

/**
 * Every user of the lab has the password the seed was given. It reaches the specs through the environment only: `LAB_SEED_PASSWORD`
 * from a workstation, `DEMO_SEED_PASSWORD` (the name the lab uses for it) inside the `e2e` service. It is never written down.
 */
export function labPassword(): string {
  const value = process.env.LAB_SEED_PASSWORD || process.env.DEMO_SEED_PASSWORD;
  if (!value)
    throw new Error(
      'Neither LAB_SEED_PASSWORD nor DEMO_SEED_PASSWORD is set: export the password the lab users were seeded with (it is not kept in the repository).'
    );
  return value;
}

/** Where the API is: under `/api` of the same origin through the lab proxy; `PLAYWRIGHT_API_URL` names another one. */
export const API = process.env.PLAYWRIGHT_API_URL ?? '/api';

/**
 * The login of the gateway lets a user try 10 times in 5 minutes; a spec that meets the limit waits for it instead of failing. The
 * wait follows `Retry-After` up to the whole window, so one wait always clears it: the walks repeated in one run sign the owner in
 * more than 10 times in 5 minutes.
 */
const LOGIN_TRIES = 3;
const LONGEST_WAIT_S = 300;

/** The origin the walks browse (`BASE_URL`, `http://web:8080` in the lab), which the gateway trusts (`AUTH_TRUSTED_ORIGINS`). */
const BROWSER_ORIGIN = new URL(process.env.BASE_URL ?? 'http://web:8080').origin;

/**
 * `LAB_SIGN_IN=identity`: a walk run behind SCORETech Identity (the `e2e-identity` service of compose.lab-identity.json,
 * lab/identity/walk.sh), where the gateway refuses `POST /v1/auth/login`. `owner`, `member` and `viewer` are then the fixture
 * users `ob-walk-<run>-op{owner,member,viewer}`, to whom the walk moved the seeded `lab-main` memberships.
 */
const IDENTITY_SIGN_IN = process.env.LAB_SIGN_IN === 'identity';
const IDENTITY_USERS: Partial<Record<LabRole, IdentityRole>> = {
  owner: 'opowner',
  member: 'opmember',
  viewer: 'opviewer',
};

/**
 * Signs in through the API from the page's own browser context, so a spec does not spend a login of the (throttled) form: the
 * answer's HttpOnly session cookie lands in the context's cookie jar, and the page turns it into a token when it loads, as after a
 * sign-in by the form. Returns the access token, for the specs that ask the API something themselves. Behind Identity
 * (`LAB_SIGN_IN=identity`) it signs the role's fixture user in with SCORETech Identity instead.
 */
export async function signInByApi(page: Page, role: LabRole): Promise<string> {
  if (IDENTITY_SIGN_IN) {
    const fixture = IDENTITY_USERS[role];
    if (!fixture) throw new Error(`${LAB_USERS[role]} has no SCORETech Identity fixture user`);
    return signInReturning(page, fixture);
  }
  let status = 0;
  for (let attempt = 1; attempt <= LOGIN_TRIES; attempt += 1) {
    const response = await page.request.post(`${API}/v1/auth/login`, {
      data: { username_or_email: LAB_USERS[role], password: labPassword() },
      headers: { Origin: BROWSER_ORIGIN },
    });
    status = response.status();
    if (response.ok()) {
      const grant = (await response.json()) as { access_token: string };
      return grant.access_token;
    }
    if (status !== 429 || attempt === LOGIN_TRIES) break;
    const wait = Number(response.headers()['retry-after']);
    await page.waitForTimeout(
      1000 * Math.min(Number.isFinite(wait) && wait > 0 ? wait : 30, LONGEST_WAIT_S)
    );
  }
  throw new Error(`login of ${LAB_USERS[role]} answered HTTP ${status}`);
}

/** Signs in through the form of the login page, the way a person does. */
export async function signInThroughForm(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  await page.goto('/authentication');
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** Collects the errors the page throws, to be checked at the end of a spec. */
export function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

/** The two sizes every screen is looked at in: a desktop and a phone. */
export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

/**
 * Takes the screen at 1440x900 and at 390x844 and saves both in the output directory of the run (`<results>/test-output/<spec>/`),
 * attached to the report as well. The page goes back to the size it had. (The visual QA spec keeps its own pictures in
 * `<results>/screenshots`.)
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

export { FEED_CONSUMER, MAILPIT, labFeedKey } from './feedKey';
