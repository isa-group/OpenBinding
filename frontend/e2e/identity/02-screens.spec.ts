/**
 * OpenBinding's screens against the real SCORETech Identity lab (F5-B, lab/identity/walk.sh): the person signs in from the
 * header, chooses a username on /sso/identity/username, lands on the dashboard and keeps the session through a reload and
 * past the 60 s access lifespan; a sign-out in one tab signs the other out; the refusals of a first sign-in are pages with
 * Try again; with the gateway rolled back to local mode, /authentication is the form again.
 *
 * Phases: `@screens` (after the gateway walk's main phase, on the seeded lab) and `@rollback` (the gateway in local mode).
 * Visual stops (screens/…): every `identity-error-*` page and the username screen (empty, a taken name, a valid one), at
 * 1440 and 390 px in both palettes.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  BRANDS,
  OB,
  WIDTHS,
  answerWithCode,
  email,
  landed,
  remember,
  stop,
  storagePath,
  chooseBrand,
  username,
  webStorage,
} from './support';

test.describe.configure({ mode: 'serial' });

const ERRORS: Array<[string, string]> = [
  ['signin_failed', 'Sign-in could not be completed'],
  ['account_not_linked', 'This email belongs to another account'],
  ['access_denied', 'Your SCORETech account can’t use OpenBinding yet'],
  ['unavailable', 'SCORETech Identity is unavailable'],
  ['expired', 'Your sign-in expired'],
  ['account_disabled', 'This account is disabled'],
];

async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** From OpenBinding's sign-in page to Identity's: the page leaves the frontend's origin by itself. */
async function toIdentity(page: Page) {
  await page.waitForURL(url => url.origin !== OB, { timeout: 60_000 });
  await page.locator('#email').waitFor();
}

test('@screens J1, J2: a first sign-in from the header, a taken username, the dashboard, a reload and a renewal', async ({
  browser,
}) => {
  const { context, page } = await fresh(browser);
  await page.goto(`${OB}/`);
  await page.locator('header').getByRole('link', { name: 'Log in' }).first().click();
  await toIdentity(page);
  await answerWithCode(page, email('screens'));
  const url = await landed(page);
  expect(url.pathname).toBe('/sso/identity/username');

  const main = page.locator('main');
  const field = main.getByLabel('Username');
  // The pending sign-up can be read again until it is completed: every palette and width of the three states.
  for (const brand of BRANDS) {
    await chooseBrand(page, brand);
    for (const size of WIDTHS) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.reload();
      await expect(
        main.getByRole('heading', { level: 1, name: 'Choose your username' })
      ).toBeVisible();
      await expect(field).not.toHaveValue('');
      await stop(page, `identity-username-empty-${brand}-${size.name}`);
      await field.fill('lab-owner');
      await main.getByRole('button', { name: 'Create my account' }).click();
      await expect(main.getByText('That username is taken. Choose another one.')).toBeVisible();
      await stop(page, `identity-username-409-${brand}-${size.name}`);
      await field.fill(username('screens'));
      await stop(page, `identity-username-valid-${brand}-${size.name}`);
    }
  }
  await chooseBrand(page, 'sphere');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await field.fill(username('screens'));
  await main.getByRole('button', { name: 'Create my account' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: `Welcome back, ${username('screens')}` })
  ).toBeVisible({ timeout: 30_000 });

  // The session is the HttpOnly cookie: a reload keeps it, and nothing in Web Storage is a token.
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: `Welcome back, ${username('screens')}` })
  ).toBeVisible();
  expect((await webStorage(page)).filter(entry => /eyJ|access|refresh|token/i.test(entry))).toEqual(
    []
  );
  // OpenBinding's own cookies (Keycloak's, on Identity's path, are not its business) are all HttpOnly.
  const ours = (await context.cookies(OB)).filter(cookie => cookie.name.includes('ob_'));
  expect(ours.map(cookie => cookie.name)).toContain('ob_session');
  expect(ours.filter(cookie => !cookie.httpOnly).map(cookie => cookie.name)).toEqual([]);

  // Past the lab's 60 s access lifespan the screens keep working: the session renews through Identity (the harness checks
  // the generation moved).
  await page.waitForTimeout(65_000);
  await page.goto(`${OB}/me/orgs`);
  await expect(page.getByRole('heading', { level: 1, name: 'Your organizations' })).toBeVisible();
  remember({ screensAt: String(Date.now()) });
  await context.storageState({ path: storagePath('screens') });
  await context.close();
});

test('@screens J3: signing out in one tab signs the other out, and Identity asks for a code again', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: storagePath('screens') });
  const first = await context.newPage();
  await first.goto(`${OB}/me/orgs`);
  await expect(first.getByRole('heading', { level: 1, name: 'Your organizations' })).toBeVisible();
  const second = await context.newPage();
  await second.goto(`${OB}/me/orgs`);
  await expect(second.getByRole('heading', { level: 1, name: 'Your organizations' })).toBeVisible();

  await first.getByRole('button', { name: 'Account menu' }).click();
  await first.getByRole('button', { name: 'Sign out', exact: true }).click();
  // The other tab learns of it (BroadcastChannel), leaves the protected page and, the SSO session being over, Identity asks
  // for an email again.
  await toIdentity(second);
  await expect(second.locator('#email')).toBeVisible();
  await context.close();
});

test('@screens J4: the refusals of a first sign-in are pages with Try again (clash, norole), and each code has its page', async ({
  browser,
}) => {
  for (const [role, code, title] of [
    ['clash', 'account_not_linked', 'This email belongs to another account'],
    ['norole', 'access_denied', 'Your SCORETech account can’t use OpenBinding yet'],
  ] as const) {
    const { context, page } = await fresh(browser);
    await page.goto(`${OB}/authentication`);
    await toIdentity(page);
    await answerWithCode(page, email(role));
    const url = await landed(page);
    expect(url.pathname).toBe('/authentication');
    expect(url.searchParams.get('identity_error')).toBe(code);
    await expect(
      page.locator('main').getByRole('heading', { level: 1, name: title })
    ).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: 'Try again' })).toBeVisible();
    await context.close();
  }

  const { context, page } = await fresh(browser);
  await page.goto(`${OB}/`);
  for (const brand of BRANDS) {
    await chooseBrand(page, brand);
    for (const size of WIDTHS) {
      await page.setViewportSize({ width: size.width, height: size.height });
      for (const [code, title] of ERRORS) {
        await page.goto(`${OB}/authentication?identity_error=${code}`);
        await expect(
          page.locator('main').getByRole('heading', { level: 1, name: title })
        ).toBeVisible();
        // The error page never sends the browser on by itself.
        expect(new URL(page.url()).origin).toBe(OB);
        await stop(page, `identity-error-${code}-${brand}-${size.name}`);
      }
    }
  }
  await context.close();
});

test('@rollback J8: in local mode /authentication is the form again, and an Identity session no longer counts', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: storagePath('research') });
  const page = await context.newPage();
  await page.goto(`${OB}/me/orgs`);
  await expect(page).toHaveURL(/\/authentication$/);
  await expect(page.locator('main').getByLabel('Username or email')).toBeVisible();
  await expect(page.locator('main').getByRole('button', { name: 'Log in' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(OB);
  await stop(page, 'rollback-authentication');
  await context.close();
});
