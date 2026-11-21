/**
 * Helpers of the SCORETech Identity walks (playwright.identity.config.ts).
 *
 * Signing in by email code drives Identity's own theme at SCORELabUS/SCORETech-identity@215dffe
 * (`provider/themes/score/login/email-otp.ftl`): `#email` and Continue, then the six-digit code read from the lab's
 * Mailpit and typed into `#code`; a first registration also fills `#firstName`, `#lastName`, `#terms` and `#privacy`
 * and presses "Create account". After SPHERE's `api/src/test/e2e/scoretech-identity.browser.ts`. The gateway's JSON
 * routes are called through `page.request`, which shares the page's cookie jar, with the frontend's `Origin`.
 * Nothing here logs an address, a code or a token.
 */
import { expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const OB = process.env.BASE_URL ?? 'http://localhost:18198';
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';
export const RUN = process.env.WALK_RUN ?? '';
const RESULTS = process.env.E2E_RESULTS_DIR ?? '/results';
const STATE = `${RESULTS}/walk-state.json`;

/** `opowner`, `opmember` and `opviewer` stand for the lab's owner, member and viewer in F4's operation walk (04). */
export type Role =
  | 'admin'
  | 'member'
  | 'research'
  | 'norole'
  | 'clash'
  | 'squat'
  | 'new'
  | 'screens'
  | 'opowner'
  | 'opmember'
  | 'opviewer';

export function email(role: Role): string {
  if (role === 'research') return `ob-walk-${RUN}-research@research.example`;
  if (role === 'clash') return 'lab-orgadmin@example.org';
  if (role === 'squat') return 'lab-outsider@example.org';
  if (role === 'new') return `ob-new-${RUN}@example.invalid`;
  return `ob-walk-${RUN}-${role}@example.invalid`;
}

export function username(role: Role): string {
  return `ob-walk-${RUN}-${role}`;
}

export function readState(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function remember(values: Record<string, string>): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(STATE, JSON.stringify({ ...readState(), ...values }));
}

export function storagePath(role: Role): string {
  return `${RESULTS}/storage-${role}.json`;
}

interface MailpitList {
  messages?: { ID: string; To?: { Address: string }[] }[];
}

async function messageIds(recipient: string): Promise<Set<string>> {
  const list = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()) as MailpitList;
  return new Set(
    (list.messages ?? [])
      .filter(m => (m.To ?? []).some(to => to.Address.toLowerCase() === recipient.toLowerCase()))
      .map(m => m.ID)
  );
}

/**
 * Identity sends one code per recipient a minute: wait until a minute has passed since this run last asked for one for
 * `recipient` (the phases and the walks share the fixture users), then note when this one is asked for.
 */
async function respectTheCodeLimit(recipient: string): Promise<void> {
  const key = `codeAt:${recipient.toLowerCase()}`;
  const wait = Number(readState()[key] ?? 0) + 61_000 - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  remember({ [key]: String(Date.now()) });
}

async function newCode(recipient: string, before: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 240; attempt++) {
    for (const id of await messageIds(recipient)) {
      if (before.has(id)) continue;
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
        Text?: string;
      };
      const code = detail.Text?.match(/\b[0-9]{6}\b/)?.[0];
      if (code) return code;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('no sign-in code arrived for the fixture user');
}

/** On Identity's email page: request a code for `recipient`, type it, and finish a registration when asked. */
export async function answerWithCode(
  page: Page,
  recipient: string,
  names?: { first: string; last: string }
) {
  await page.locator('#email').waitFor();
  await respectTheCodeLimit(recipient);
  const before = await messageIds(recipient);
  await page.locator('#email').fill(recipient);
  // The sign-in form's submit is "Continue"; the registration screen's may be named otherwise: Enter submits either.
  await page.locator('#email').press('Enter');
  await page.locator('#code').waitFor();
  await page.locator('#code').fill(await newCode(recipient, before));
  // The field submits itself once six digits are in; press its button when it has not.
  await page
    .locator('[data-otp-submit]')
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  if (names) {
    await page.locator('#firstName').waitFor();
    await page.locator('#firstName').fill(names.first);
    await page.locator('#lastName').fill(names.last);
    await page.locator('#terms').check();
    await page.locator('#privacy').check();
    await page.locator('#firstName').press('Enter');
  }
}

/** Back on OpenBinding's origin after the gateway's callback: the frontend path it sent the browser to. */
export async function landed(page: Page): Promise<URL> {
  await page.waitForURL(url => url.origin === OB && !url.pathname.startsWith('/api/'), {
    timeout: 60_000,
  });
  return new URL(page.url());
}

export async function startSignIn(page: Page, query = '') {
  await page.goto(`${OB}/api/v1/auth/identity/login${query}`);
}

/** Whether Identity asks for an email again (its SSO session is over) instead of returning to OpenBinding at once. */
export async function identityAsksForAnEmail(page: Page): Promise<boolean> {
  await startSignIn(page);
  await page.waitForLoadState('domcontentloaded');
  return (await page.locator('#email').count()) > 0 && new URL(page.url()).origin !== OB;
}

type Cookies = Parameters<BrowserContext['addCookies']>[0];

/**
 * Signs `role`, which has already chosen its username, in on `page` and returns an access token, for the live walks run
 * behind Identity (e2e/live/support.ts, `LAB_SIGN_IN=identity`). With Identity's SSO cookies from this user's earlier
 * sign-in (never OpenBinding's own `ob_` cookies), Identity answers at once; otherwise by email code.
 */
export async function signInReturning(page: Page, role: Role): Promise<string> {
  const saved = storagePath(role);
  if (existsSync(saved)) {
    const { cookies } = JSON.parse(readFileSync(saved, 'utf8')) as { cookies: Cookies };
    await page.context().addCookies(cookies.filter(cookie => !/^(__Host-)?ob_/.test(cookie.name)));
  }
  await startSignIn(page);
  const home = () => {
    const url = new URL(page.url());
    return url.origin === OB && !url.pathname.startsWith('/api/');
  };
  await expect
    .poll(async () => home() || (await page.locator('#email').count()) > 0, { timeout: 60_000 })
    .toBe(true);
  if (!home()) await answerWithCode(page, email(role));
  expect((await landed(page)).pathname, `${username(role)} has a username`).not.toBe(
    '/sso/identity/username'
  );
  await page.waitForURL(url => url.origin === OB && url.pathname === '/', { timeout: 60_000 });
  await page.context().storageState({ path: saved });
  return tokenOf(await api(page).session());
}

export function api(page: Page) {
  const headers = { Origin: OB };
  return {
    pending: () => page.request.get(`${OB}/api/v1/auth/identity/pending`),
    complete: (name: string) =>
      page.request.post(`${OB}/api/v1/auth/identity/complete`, {
        data: { username: name },
        headers,
      }),
    session: () => page.request.post(`${OB}/api/v1/auth/identity/session`, { headers }),
    logout: (scope: 'this' | 'all' = 'this') =>
      page.request.post(`${OB}/api/v1/auth/identity/logout`, { data: { scope }, headers }),
    me: (token: string) =>
      page.request.get(`${OB}/api/v1/users/me`, { headers: { Authorization: `Bearer ${token}` } }),
    organizations: (token: string) =>
      page.request.get(`${OB}/api/v1/organizations`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    config: () => page.request.get(`${OB}/api/v1/auth/config`),
  };
}

export async function tokenOf(response: APIResponse): Promise<string> {
  expect(response.status(), 'POST /v1/auth/identity/session').toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** The two palettes of the screens (`data-brand`), set before the page loads as the palette switch stores it. */
export const BRANDS = ['sphere', 'openbinding'] as const;
export const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;
const BRAND_KEY = 'openbinding:brand';

/** Use `brand` from the next load of `page` on (the palette is read once, before the first paint). */
export async function chooseBrand(page: Page, brand: (typeof BRANDS)[number]): Promise<void> {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [BRAND_KEY, brand]);
}

/** A visual stop: a screenshot under the results (`screens/<name>.png`), after the fonts and with no sideways scroll. */
export async function stop(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(1);
  mkdirSync(`${RESULTS}/screens`, { recursive: true });
  await page.screenshot({
    path: `${RESULTS}/screens/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

/** Every key and value Web Storage holds, to prove that none is a token. */
export async function webStorage(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [localStorage, sessionStorage].flatMap(storage =>
      Object.keys(storage).map(key => `${key}=${storage.getItem(key)}`)
    )
  );
}
