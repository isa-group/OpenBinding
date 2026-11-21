/**
 * The gateway against the real SCORETech Identity lab (F5-A, lab/identity/walk.sh): no OpenBinding screen is involved yet,
 * so the browser drives the gateway's login route and Identity's own pages, and `page.request` (sharing the cookie jar)
 * drives `pending`, `complete`, `session`, `logout` and `GET /v1/users/me`.
 *
 * Phases, each a separate run of this file selected by tag: `@bootstrap` (the administrator by `sub`, on an empty
 * database), the main phase (untagged), `@signup` (a native registration), `@granted` (after the harness grants it the
 * permission) and `@rollback` (with the gateway in local mode). The harness checks the database between them.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  OB,
  answerWithCode,
  api,
  email,
  identityAsksForAnEmail,
  landed,
  readState,
  remember,
  startSignIn,
  storagePath,
  tokenOf,
  username,
} from './support';

test.describe.configure({ mode: 'serial' });

async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function firstSignIn(page: Page, role: Parameters<typeof email>[0], query = '') {
  await startSignIn(page, query);
  await answerWithCode(page, email(role));
  return landed(page);
}

test('@bootstrap the administrator by sub signs in first and becomes administrator', async ({
  browser,
}) => {
  const { context, page } = await fresh(browser);
  const url = await firstSignIn(page, 'admin');
  expect(url.pathname).toBe('/sso/identity/username');
  const done = await api(page).complete(username('admin'));
  expect(done.status()).toBe(201);
  const me = await (await api(page).me(await tokenOf(await api(page).session()))).json();
  expect(me.role).toBe('admin');
  remember({ adminId: me.id });
  await context.close();
});

test('member: a first sign-in chooses its username, returns as the same account, renews once and signs out', async ({
  browser,
}) => {
  const { context, page } = await fresh(browser);
  const url = await firstSignIn(page, 'member', '?returnTo=%2Fcompositions');
  expect(url.pathname).toBe('/sso/identity/username');
  expect(url.searchParams.get('returnTo')).toBe('/compositions');

  const pending = await api(page).pending();
  expect(pending.status()).toBe(200);
  const body = await pending.json();
  // Created unverified in Identity: the code sign-in verified the email (O6).
  expect(body.email_verified).toBe(true);
  expect(body.email).toBe(email('member'));
  expect(body.suggested_username).toBeTruthy();

  const taken = await api(page).complete('lab-owner');
  expect(taken.status()).toBe(409);
  expect((await taken.json()).detail.code).toBe('username_taken');
  const done = await api(page).complete(username('member'));
  expect(done.status()).toBe(201);
  expect((await done.json()).return_to).toBe('/compositions');
  const token = await tokenOf(await api(page).session());
  const first = await (await api(page).me(token)).json();
  expect(first.username).toBe(username('member'));
  expect(first.email_verified).toBe(true);
  // Every account owns its personal organization from its first sign-in, named after it (F5-D, SPHERE's rule).
  const owned = (await (await api(page).organizations(token)).json()) as {
    slug: string;
    name: string;
    is_personal: boolean;
    effective_role: string;
    parent_id: string | null;
  }[];
  expect(owned.filter(org => org.is_personal)).toEqual([
    expect.objectContaining({
      slug: username('member').toLowerCase().replace(/[._]/g, '-'),
      name: `${username('member')} PERSONAL`,
      effective_role: 'OWNER',
      parent_id: null,
    }),
  ]);

  // Returning: Identity's SSO session answers at once (no code), and the account is the same.
  await startSignIn(page);
  const again = await landed(page);
  expect(again.pathname).toBe('/sso/identity/callback');
  const fresh_token = await tokenOf(await api(page).session());
  expect((await (await api(page).me(fresh_token)).json()).id).toBe(first.id);
  remember({ memberId: first.id });

  // The access token lasts 60 s in the lab: after 35 s every renewal needs Identity, and five at once make one refresh
  // (the harness checks refresh_generation moved by exactly one).
  await page.waitForTimeout(35_000);
  const renewals = await Promise.all(Array.from({ length: 5 }, () => api(page).session()));
  expect(renewals.map(r => r.status())).toEqual([200, 200, 200, 200, 200]);
  const bearer = await tokenOf(renewals[0]);
  expect((await api(page).me(bearer)).status()).toBe(200);

  expect((await api(page).logout()).status()).toBe(204);
  expect((await api(page).me(bearer)).status()).toBe(401);
  expect((await api(page).session()).status()).toBe(401);
  expect(await identityAsksForAnEmail(page)).toBe(true);
  await context.close();
});

test('research: a verified institutional email starts on RESEARCH', async ({ browser }) => {
  const { context, page } = await fresh(browser);
  const url = await firstSignIn(page, 'research');
  expect(url.pathname).toBe('/sso/identity/username');
  expect((await api(page).complete(username('research'))).status()).toBe(201);
  const me = await (await api(page).me(await tokenOf(await api(page).session()))).json();
  expect(me.plan).toBe('RESEARCH');
  expect(me.institutional_email).toBe(true);
  remember({ researchId: me.id });
  // Kept for the rollback phase: its session cookie must be refused once the gateway runs in local mode.
  await context.storageState({ path: storagePath('research') });
  await context.close();
});

test('clash: an email a seeded account verified refuses the first sign-in, and Identity asks again', async ({
  browser,
}) => {
  const { context, page } = await fresh(browser);
  const url = await firstSignIn(page, 'clash');
  expect(url.pathname).toBe('/authentication');
  expect(url.searchParams.get('identity_error')).toBe('account_not_linked');
  expect(await identityAsksForAnEmail(page)).toBe(true);
  await context.close();
});

test('squat: an email an unverified seeded account holds is released to the new identity', async ({
  browser,
}) => {
  const { context, page } = await fresh(browser);
  const url = await firstSignIn(page, 'squat');
  expect(url.pathname).toBe('/sso/identity/username');
  expect((await api(page).complete(username('squat'))).status()).toBe(201);
  const me = await (await api(page).me(await tokenOf(await api(page).session()))).json();
  expect(me.email).toBe(email('squat'));
  await context.close();
});

test('norole: OpenBinding refuses an account without openbinding:access, and Identity asks again', async ({
  browser,
}) => {
  const { context, page } = await fresh(browser);
  const url = await firstSignIn(page, 'norole');
  expect(url.pathname).toBe('/authentication');
  expect(url.searchParams.get('identity_error')).toBe('access_denied');
  expect(await identityAsksForAnEmail(page)).toBe(true);
  await context.close();
});

test('the configuration names the Identity account page, and it answers', async ({ browser }) => {
  const { context, page } = await fresh(browser);
  const config = await (await api(page).config()).json();
  expect(config.provider).toBe('scoretech');
  expect(config.login_url).toBe(`${OB}/api/v1/auth/identity/login`);
  expect(config.account_url).toMatch(/\/identity\/account\/#public-profile$/);
  const response = await page.goto(config.account_url);
  expect(response?.status() ?? 0).toBeLessThan(400);
  await context.close();
});

test('@signup a native registration by email code is refused until the permission is granted', async ({
  browser,
}) => {
  const { context, page } = await fresh(browser);
  // Identity registers natively from its sign-in page: an unknown email gets a code, then the registration stage.
  await startSignIn(page);
  await answerWithCode(page, email('new'), { first: 'Walk', last: 'Newcomer' });
  const url = await landed(page);
  expect(url.pathname).toBe('/authentication');
  expect(url.searchParams.get('identity_error')).toBe('access_denied');
  remember({ signupAt: String(Date.now()) });
  await context.close();
});

test('@granted with the permission, the registered account signs in with a verified email', async ({
  browser,
}) => {
  // Identity sends one code per recipient a minute.
  const wait = Number(readState().signupAt ?? 0) + 61_000 - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  const { context, page } = await fresh(browser);
  const url = await firstSignIn(page, 'new');
  expect(url.pathname).toBe('/sso/identity/username');
  const pending = await (await api(page).pending()).json();
  expect(pending.email_verified).toBe(true);
  expect((await api(page).complete(`ob-new-${process.env.WALK_RUN}`)).status()).toBe(201);
  await context.close();
});

test('@rollback in local mode the Identity session is refused, and a reset password signs in the same account', async ({
  browser,
}) => {
  const state = readState();
  const context = await browser.newContext({ storageState: storagePath('research') });
  const page = await context.newPage();
  const config = await (await api(page).config()).json();
  expect(config.provider).toBe('local');
  expect((await api(page).session()).status()).toBe(401);

  const requested = await page.request.post(`${OB}/api/v1/auth/password-reset/request`, {
    data: { email: email('research') },
  });
  expect(requested.status()).toBe(202);
  const token = (await requested.json()).token as string;
  expect(token).toBeTruthy();
  const chosen = ['rolled', 'back', process.env.WALK_RUN, 'walk'].join('-');
  const completed = await page.request.post(`${OB}/api/v1/auth/password-reset/complete`, {
    data: { token, new_password: chosen },
  });
  expect(completed.status()).toBe(204);
  const login = await page.request.post(`${OB}/api/v1/auth/login`, {
    data: { username_or_email: username('research'), password: chosen },
  });
  expect(login.status()).toBe(200);
  const me = await (await api(page).me((await login.json()).access_token)).json();
  expect(me.id).toBe(state.researchId);
  await context.close();
});
