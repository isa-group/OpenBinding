/**
 * Settings, avatars, orphan keys and deletion against the real SCORETech Identity lab (F5-C, lab/identity/walk.sh).
 *
 * Phases, after the gateway and screens walks and their post-checks:
 * - `@account` (J10, J5): `member` signs in; Settings › Account opens its SCORETech profile in a new tab and comes back
 *   (`return_to`, Identity's "Back to application"); Public profile shows Identity's display name and the `tentuAvatar` the
 *   fixture gave it (`icon`/`leaf` on graphite and paper), read-only; the header and a member list draw that avatar; a
 *   personal API key works and the keys page says when it stops; the administrator (by `sub`) reads the Identity tab of
 *   `member` and of `research` (issuer, subject, last renewal, sessions, RESEARCH by e-mail).
 * - the harness moves `member`'s last Identity renewal back 31 days (and its session's upstream expiry ahead, so no renewal
 *   moves it back before the page is read);
 * - `@orphan` (J7, J10): the key answers 401 `api_key_suspended` and the keys page warns; a sign-in brings the key back;
 *   then `member` deletes its OpenBinding account from the Danger Zone without a password, and the key goes with it.
 *
 * Visual stops (screens/account-…), both palettes at 1440 and 390 px: Settings › Account and Public profile, the dashboard
 * with the header avatar, the member list, the keys notice and the suspended-keys warning, the admin Identity tab.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  BRANDS,
  OB,
  WIDTHS,
  answerWithCode,
  api,
  chooseBrand,
  email,
  landed,
  readState,
  remember,
  startSignIn,
  stop,
  storagePath,
  tokenOf,
  username,
  type Role,
} from './support';

test.describe.configure({ mode: 'serial' });

/** A fresh browser signed in by email code as `role`, back on OpenBinding. */
async function signIn(browser: Browser, role: Role): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startSignIn(page);
  await answerWithCode(page, email(role));
  expect((await landed(page)).pathname).toBe('/sso/identity/callback');
  return page;
}

async function bearer(page: Page): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await tokenOf(await api(page).session())}` };
}

/** Every palette and width of one screen: `ready` waits for what the screen must show. */
async function stops(
  page: Page,
  path: string,
  name: string,
  ready: (page: Page) => Promise<void>
): Promise<void> {
  for (const brand of BRANDS) {
    await chooseBrand(page, brand);
    for (const size of WIDTHS) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`${OB}${path}`);
      await ready(page);
      await stop(page, `account-${name}-${brand}-${size.name}`);
    }
  }
  await chooseBrand(page, 'sphere');
  await page.setViewportSize({ width: 1280, height: 800 });
}

const heading = (page: Page, name: string) =>
  expect(page.locator('main').getByRole('heading', { level: 2, name })).toBeVisible();

test('@account J10: Settings › Account opens the SCORETech profile, which comes back', async ({
  browser,
}) => {
  const page = await signIn(browser, 'member');
  await page.goto(`${OB}/me/settings`);
  await heading(page, 'Your SCORETech account');
  const main = page.locator('main');
  await expect(main.getByLabel('Email address')).toHaveCount(0);
  await expect(main.getByLabel('New password')).toHaveCount(0);
  const link = main.getByRole('link', { name: /Open my SCORETech profile/ });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const href = new URL((await link.getAttribute('href')) ?? '');
  expect(href.hash).toBe('#public-profile');
  expect(href.searchParams.get('return_to')).toBe(`${OB}/me/settings?section=account`);
  await stops(page, '/me/settings', 'settings-identity', p => heading(p, 'Your SCORETech account'));

  // The profile opens in a new tab, signs in silently with the SSO session and offers the way back.
  const [profile] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  const back = profile.getByRole('link', { name: 'Back to application' });
  await expect(back).toBeVisible({ timeout: 60_000 });
  expect(await back.getAttribute('href')).toBe(`${OB}/me/settings?section=account`);
  await stop(profile, 'account-identity-profile-page');
  await profile.close();
  await page.context().storageState({ path: storagePath('member') });
});

test('@account J10: the public profile, the header and a member list draw Identity’s name and avatar', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: storagePath('member') });
  const page = await context.newPage();
  await page.goto(`${OB}/me/settings?section=profile`);
  const main = page.locator('main');
  await expect(main.getByText('Walk member', { exact: true })).toBeVisible();
  await expect(main.getByText(`@${username('member')}`)).toBeVisible();
  await expect(main.getByRole('button', { name: 'Change avatar' })).toHaveCount(0);
  await expect(main.getByLabel('Display name')).toHaveCount(0);
  await expect(main.getByRole('link', { name: /Edit in SCORETech Identity/ })).toHaveAttribute(
    'href',
    /#public-profile$/
  );
  // The fixture's tentuAvatar: the leaf icon on graphite, drawn in paper.
  const avatar = main.locator('[data-avatar-kind="icon"]');
  await expect(avatar).toHaveCSS('background-color', 'rgb(33, 37, 41)');
  await expect(avatar).toHaveCSS('color', 'rgb(255, 255, 255)');
  await stops(page, '/me/settings?section=profile', 'profile-identity', async p => {
    await expect(p.locator('main').getByText('Walk member', { exact: true })).toBeVisible();
  });

  await page.goto(`${OB}/`);
  await expect(
    page.getByRole('button', { name: 'Account menu' }).locator('[data-avatar-kind="icon"]')
  ).toBeVisible();
  await stops(page, '/', 'header-avatar', async p => {
    await expect(p.getByRole('heading', { level: 1, name: /Welcome back/ })).toBeVisible();
  });

  // An organization of its own: the member list draws the same avatar beside the display name.
  const slug = `walk-${process.env.WALK_RUN}-avatars`;
  const created = await page.request.post(`${OB}/api/v1/organizations`, {
    headers: await bearer(page),
    data: { slug, name: `Walk ${process.env.WALK_RUN} avatars` },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${OB}/orgs/${slug}/members`);
  const row = page
    .locator('main')
    .getByRole('listitem')
    .filter({ hasText: `@${username('member')}` });
  await expect(row.getByText('Walk member', { exact: true })).toBeVisible();
  await expect(row.locator('[data-avatar-kind="icon"]')).toBeVisible();
  await stops(page, `/orgs/${slug}/members`, 'member-list', async p => {
    await expect(p.locator('main').getByText('Walk member', { exact: true })).toBeVisible();
  });
  await context.close();
});

test('@account J7: a personal key works, and the keys page says when it stops', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: storagePath('member') });
  const page = await context.newPage();
  await page.goto(`${OB}/`);
  const created = await page.request.post(`${OB}/api/v1/users/me/api-keys`, {
    headers: await bearer(page),
    data: {
      name: 'walk orphan key',
      permissions: ['account:read'],
      engine_access: { all: true, engines: [] },
      boundary: {},
    },
  });
  expect(created.status()).toBe(201);
  const secret = ((await created.json()) as { secret: string }).secret;
  // Kept for the next phase only; removed from the state when it ends.
  remember({ orphanKey: secret });
  const me = await page.request.get(`${OB}/api/v1/users/me`, { headers: { 'X-API-Key': secret } });
  expect(me.status()).toBe(200);
  expect(
    ((await me.json()) as { api_keys_suspended_at: string }).api_keys_suspended_at
  ).toBeTruthy();

  await page.goto(`${OB}/me/api-keys`);
  const notice = page.locator('main').getByRole('status').filter({ hasText: 'stop working on' });
  await expect(notice).toContainText('unless you sign in again');
  await stops(page, '/me/api-keys', 'keys-notice', async p => {
    await expect(
      p.locator('main').getByRole('status').filter({ hasText: 'stop working on' })
    ).toBeVisible();
  });
  remember({ memberId: ((await me.json()) as { id: string }).id });
  await context.storageState({ path: storagePath('member') });
  await context.close();
});

test('@account J5: the administrator reads the Identity tab of an account', async ({ browser }) => {
  const page = await signIn(browser, 'admin');
  const { memberId, researchId } = readState();
  expect(memberId && researchId).toBeTruthy();

  await page.goto(`${OB}/admin/users/${researchId}?tab=identity`);
  const facts = page.locator('main').getByLabel('Account facts');
  await expect(facts.getByText('SCORETech Identity', { exact: true })).toBeVisible();
  await expect(facts.getByText('http://localhost:18000/identity/auth/realms/score')).toBeVisible();
  await expect(facts.getByText('Institutional domain of its verified e-mail')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy Identity subject' })).toBeVisible();

  await page.goto(`${OB}/admin/users/${memberId}?tab=identity`);
  await expect(facts.getByText('SCORETech Identity', { exact: true })).toBeVisible();
  await expect(facts.getByText('Never granted')).toBeVisible();
  await expect(facts.getByText('Never', { exact: true })).toHaveCount(0);
  await stops(page, `/admin/users/${memberId}?tab=identity`, 'admin-identity-tab', async p => {
    await expect(
      p.locator('main').getByLabel('Account facts').getByText('SCORETech Identity', { exact: true })
    ).toBeVisible();
  });
  await page.context().close();
});

test('@orphan J7: 31 days without Identity suspend the key; a sign-in brings it back', async ({
  browser,
}) => {
  const { orphanKey } = readState();
  expect(orphanKey).toBeTruthy();
  const context = await browser.newContext({ storageState: storagePath('member') });
  const page = await context.newPage();
  const refused = await page.request.get(`${OB}/api/v1/users/me`, {
    headers: { 'X-API-Key': orphanKey },
  });
  expect(refused.status()).toBe(401);
  expect(((await refused.json()) as { detail: { code: string } }).detail.code).toBe(
    'api_key_suspended'
  );

  await page.goto(`${OB}/me/api-keys`);
  const warning = page
    .locator('main')
    .getByRole('alert')
    .filter({ hasText: 'Your API keys are suspended' });
  await expect(warning).toContainText('until you sign in with SCORETech Identity');
  await stops(page, '/me/api-keys', 'keys-suspended', async p => {
    await expect(
      p.locator('main').getByRole('alert').filter({ hasText: 'Your API keys are suspended' })
    ).toBeVisible();
  });

  // Signing in again (the SSO session answers at once) renews with Identity: the key works.
  await startSignIn(page);
  expect((await landed(page)).pathname).toBe('/sso/identity/callback');
  const again = await page.request.get(`${OB}/api/v1/users/me`, {
    headers: { 'X-API-Key': orphanKey },
  });
  expect(again.status()).toBe(200);
  await page.goto(`${OB}/me/api-keys`);
  await expect(
    page.locator('main').getByRole('status').filter({ hasText: 'stop working on' })
  ).toBeVisible();
  await context.storageState({ path: storagePath('member') });
  await context.close();
});

test('@orphan J10: the Danger Zone deletes the OpenBinding account without a password', async ({
  browser,
}) => {
  const { orphanKey } = readState();
  const context = await browser.newContext({ storageState: storagePath('member') });
  const page = await context.newPage();
  await page.goto(`${OB}/me/settings?section=danger`);
  const main = page.locator('main');
  await expect(
    main.getByRole('heading', { level: 3, name: 'Delete OpenBinding account' })
  ).toBeVisible();
  await expect(main.getByText(/Your SCORETech Identity account and your access/)).toBeVisible();
  // The organization it owns is handed over or deleted first: delete it through the API.
  const slug = `walk-${process.env.WALK_RUN}-avatars`;
  const removed = await page.request.delete(`${OB}/api/v1/organizations/${slug}`, {
    headers: await bearer(page),
  });
  expect(removed.status()).toBe(204);

  await main.getByRole('button', { name: 'Delete my account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm deletion' });
  await expect(dialog.getByLabel(/password/i)).toHaveCount(0);
  await dialog.getByLabel(`Type ${username('member')} to confirm`).fill(username('member'));
  await stop(page, 'account-danger-identity');
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  await page.waitForURL(url => url.origin === OB && url.pathname === '/', { timeout: 60_000 });

  expect((await api(page).session()).status()).toBe(401);
  const gone = await page.request.get(`${OB}/api/v1/users/me`, {
    headers: { 'X-API-Key': orphanKey },
  });
  expect(gone.status()).toBe(401);
  remember({ orphanKey: '' });
  await context.close();
});
