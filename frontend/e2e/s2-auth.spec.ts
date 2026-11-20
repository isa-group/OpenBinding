import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { authConfig } from './helpers/session';

// S2 · authentication and invitations, on SPHERE's split authentication layout:
// auth (/authentication, its login and register views), auth-forgot-password, auth-reset-password, org-join,
// and in SCORETech mode the way to SCORETech Identity, its error pages and auth-identity-callback.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: each walks the states of its screen in order, on one page.

const API = 'http://localhost:8000';
const CODE = 'c0de0000c0de0000';
/** What `GET /v1/invitations/{code}/preview` answers. */
const preview = {
  code: CODE,
  organization: {
    id: 'org-1',
    slug: 'isa-demo',
    name: 'ISA Demo Group',
    description: '',
    avatar: {},
    public_compositions: 0,
  },
  expires_at: '2026-12-01T00:00:00Z',
  invited_by: { id: 'user-nora', username: 'nora', avatar: null },
};
const RESET_TOKEN = 'obr_k3j9d8f7_h2g1s0a9q8w7e6r5t4y3u2i1o0p9';

const tokens = {
  access_token: 's2-access',
  refresh_token: 's2-refresh',
  token_type: 'bearer',
  expires_in: 900,
};

const person = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  username: 'sofia',
  email: 'sofia@example.org',
  role: 'user',
  is_active: true,
  plan: 'FREE',
  created_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

const isaDemo = {
  id: 'org-1',
  slug: 'isa-demo',
  name: 'ISA Demo Group',
  parent_id: null,
  effective_role: 'MEMBER',
  created_at: '2026-09-01T00:00:00Z',
};

const json =
  (body: unknown, status = 200) =>
  (route: Route) =>
    route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  json(failureBody(status, code, error, extra), status);

interface Mocks {
  /** What `GET /v1/auth/config` says: the local form (default) or SCORETech Identity. */
  provider?: 'local' | 'scoretech';
  /** Signed in as this account from the first request. */
  account?: ReturnType<typeof person>;
  /** What GET /v1/organizations answers; a function lets the answer change once something happened. */
  organizations?: unknown[] | (() => unknown[]);
}

/**
 * Everything these screens read, answered; anything else on the API origin is an empty 404. The session is the gateway's
 * cookie: `POST /v1/auth/identity/session` answers a token while it lives (from the start with `account`, after a sign-in,
 * or registration) and 401 otherwise. `setSession` plants or ends it, as another tab would.
 */
async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await authConfig(page, mocks.provider);
  // Whoever signs in during a test becomes this account; /v1/users/me is only asked once a token exists.
  const current = mocks.account ?? person();
  let cookie = Boolean(mocks.account);
  await page.route(`${API}/v1/auth/identity/session`, route =>
    cookie
      ? route.fulfill({
          json: { access_token: 's2-access', token_type: 'bearer', expires_in: 300 },
        })
      : route.fulfill({
          status: 401,
          json: failureBody(401, 'no_session', 'There is no session; sign in.'),
        })
  );
  await page.route(`${API}/v1/auth/identity/logout`, route => {
    cookie = false;
    return route.fulfill({ status: 204 });
  });
  await page.route(`${API}/v1/users/me`, route => route.fulfill({ json: current }));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: 's2-pricing' }));
  await page.route(`${API}/v1/notifications**`, json([]));
  const organizations = mocks.organizations ?? [isaDemo];
  await page.route(
    url => url.origin + url.pathname === `${API}/v1/organizations`,
    route =>
      route.fulfill({
        json: typeof organizations === 'function' ? organizations() : organizations,
      })
  );
  const signIn = (route: Route) => {
    cookie = true;
    return route.fulfill({ json: tokens });
  };
  const register = (route: Route) => {
    cookie = true;
    return route.fulfill({ status: 201, json: person() });
  };
  await page.route(`${API}/v1/auth/login`, signIn);
  await page.route(`${API}/v1/auth/register`, register);
  await page.route(
    `${API}/v1/auth/password-reset/request`,
    json({ accepted: true, delivery: 'email' }, 202)
  );
  await page.route(`${API}/v1/auth/password-reset/complete`, route =>
    route.fulfill({ status: 204 })
  );
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  return {
    /** Plant or end the session cookie, as another tab signing in or out would. */
    setSession(on: boolean) {
      cookie = on;
    },
    /** The successful sign-in and registration answers (they set the cookie), to route again after a refusal. */
    signIn,
    register,
  };
}

function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', error => critical.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      /The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)
    )
      critical.push(`console: ${text}`);
  });
  return critical;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save a full-page picture of the current state for a person to look at. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expectNoHorizontalOverflow(page);
  if (process.env.E2E_SCREENSHOTS)
    await page.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
}

/** Leave the browser as a visitor would find it: no session, nothing remembered. */
async function forgetEverything(page: Page) {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(90_000);

const viewports = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    deviceScaleFactor: 1,
  },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S2`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('auth /authentication (log in)', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const gateway = await mockApi(page);
      await page.goto('/authentication');
      const main = page.locator('main');

      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
      // Local mode: the password form, with no single sign-on button.
      await expect(
        main.getByRole('link', { name: 'Continue with Universidad de Sevilla' })
      ).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
      await expect(main.getByRole('link', { name: 'Create one' })).toHaveAttribute(
        'href',
        '/authentication?view=register'
      );
      await expect(main.getByRole('link', { name: 'Back', exact: true })).toHaveAttribute(
        'href',
        '/'
      );
      await expect(page).toHaveTitle('OpenBinding - Log in');
      await capture(page, testInfo, `login-${name}-empty`);

      // Both fields are asked for before the gateway is.
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(main.getByText('Enter your username or email.')).toBeVisible();
      await expect(main.getByText('Enter your password.')).toBeVisible();
      await expect(main.getByLabel('Username or email')).toBeFocused();
      await capture(page, testInfo, `login-${name}-validation`);

      // A wrong password and an unknown account read the same.
      await page.route(
        `${API}/v1/auth/login`,
        detail(401, 'invalid_credentials', 'Those credentials do not match an active account.')
      );
      await main.getByLabel('Username or email').fill('ghost');
      await main.getByLabel('Password').fill('not-the-password');
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(main.getByRole('alert')).toContainText(
        'That username or email and password don’t match an active account.'
      );
      await expect(main.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
      await capture(page, testInfo, `login-${name}-401`);

      // The accounts service is down: said as such, with the gateway's service status beside it.
      await page.route(
        `${API}/v1/auth/login`,
        detail(503, 'auth_unavailable', 'Accounts are not reachable.')
      );
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(main.getByRole('alert')).toContainText('Sign-in is unavailable right now (503)');
      await expect(main.getByRole('alert')).toContainText(/Service status: /);
      await capture(page, testInfo, `login-${name}-503`);

      // A session that ended without being asked to is explained.
      await page.evaluate(() => sessionStorage.setItem('openbinding-session-ended', '1'));
      await page.goto('/authentication');
      await expect(main.getByText('Your session ended and couldn’t be renewed.')).toBeVisible();
      await capture(page, testInfo, `login-${name}-session-expired`);

      // Someone who is signed in already is told so, with the way on.
      gateway.setSession(true);
      await page.goto('/authentication');
      await expect(
        main.getByRole('heading', { level: 1, name: 'You’re already signed in' })
      ).toBeVisible();
      await expect(main.getByText('Signed in as sofia (sofia@example.org).')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute(
        'href',
        '/'
      );
      await expect(main.getByRole('button', { name: 'Log in as someone else' })).toBeVisible();
      await capture(page, testInfo, `login-${name}-already-signed-in`);

      // A visitor sent here by a protected page signs in and goes back to it.
      await forgetEverything(page);
      gateway.setSession(false);
      await page.route(`${API}/v1/auth/login`, gateway.signIn);
      await page.goto('/me/orgs');
      await expect(page).toHaveURL(/\/authentication$/);
      await main.getByLabel('Username or email').fill('sofia');
      await main.getByLabel('Password').fill('a-long-enough-password');
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(page).toHaveURL(/\/me\/orgs$/);
      await expect(page.locator('header.app-header')).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Your organizations' })
      ).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('auth /authentication?view=register (create an account)', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const gateway = await mockApi(page);
      await page.route(
        `${API}/v1/auth/register`,
        detail(409, 'already_registered', 'That username or email is already in use.')
      );
      await page.goto('/authentication?view=register');
      const main = page.locator('main');

      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(
        main.getByRole('heading', { level: 1, name: 'Create your account' })
      ).toBeVisible();
      await expect(page).toHaveTitle('OpenBinding - Create an account');
      await expect(main.getByText('New accounts start on the free plan')).toBeVisible();
      await expect(main.getByText('Strength: Not set')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Compare plans' })).toHaveAttribute(
        'href',
        '/pricing'
      );
      await capture(page, testInfo, `register-${name}-empty`);

      await main.getByLabel('Username').fill('a!');
      await main.getByLabel('Email').fill('not-an-email');
      await main.getByLabel('Password').fill('short');
      await expect(main.getByText('5 more characters needed')).toBeVisible();
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(main.getByText('Enter a valid email address.')).toBeVisible();
      await expect(main.getByText('Password must be at least 10 characters long.')).toBeVisible();
      await expect(main.getByLabel('Username')).toBeFocused();
      await capture(page, testInfo, `register-${name}-validation`);

      await main.getByLabel('Username').fill('sofia.rey');
      await main.getByLabel('Email').fill('sofia@example.org');
      await main.getByLabel('Password').fill('a-long-enough-password');
      await expect(main.getByText('✓ At least 10 characters')).toBeVisible();
      await expect(main.getByText('Strength: Good')).toBeVisible();
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(main.getByRole('alert')).toContainText(
        'That username or email is already registered (409).'
      );
      await expect(
        main.getByRole('alert').getByRole('link', { name: 'reset your password' })
      ).toHaveAttribute('href', '/forgot-password');
      await capture(page, testInfo, `register-${name}-409`);

      await page.route(
        `${API}/v1/auth/register`,
        detail(422, 'weak_password', 'That password is on the list of common passwords.')
      );
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(
        main.getByText('That password is on the list of common passwords.')
      ).toBeVisible();
      await expect(main.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
      await capture(page, testInfo, `register-${name}-422`);

      await page.route(
        `${API}/v1/auth/register`,
        detail(503, 'pricing_unavailable', 'The active pricing cannot be resolved.')
      );
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(main.getByRole('alert')).toContainText(
        'Accounts can’t be created right now (503). Nothing was saved'
      );
      await capture(page, testInfo, `register-${name}-503`);

      // The account is created, signed in and taken to the dashboard.
      await page.route(`${API}/v1/auth/register`, gateway.register);
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/');
      await expect(page.locator('header.app-header')).toBeVisible();

      // And a signed-in visitor is told they already have one.
      await page.goto('/authentication?view=register');
      await expect(
        main.getByRole('heading', { level: 1, name: 'You already have an account' })
      ).toBeVisible();
      await expect(main.getByRole('button', { name: 'Log out' })).toBeVisible();
      await capture(page, testInfo, `register-${name}-already-signed-in`);
      expect(critical).toEqual([]);
    });

    test('auth-forgot-password /forgot-password', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/forgot-password');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 1, name: 'Forgot your password?' })
      ).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to log in' })).toHaveAttribute(
        'href',
        '/authentication'
      );
      await expect(page).toHaveTitle('OpenBinding - Forgot password');
      await capture(page, testInfo, `reset-request-${name}-empty`);

      await main.getByLabel('Email address').fill('nope');
      await main.getByRole('button', { name: 'Send reset link' }).click();
      await expect(main.getByText('Enter a valid email address.')).toBeVisible();
      await capture(page, testInfo, `reset-request-${name}-invalid`);

      await page.route(
        `${API}/v1/auth/password-reset/request`,
        detail(503, 'email_unavailable', 'Mail is down.')
      );
      await main.getByLabel('Email address').fill('sofia@example.org');
      await main.getByRole('button', { name: 'Send reset link' }).click();
      await expect(main.getByRole('alert')).toContainText('We can’t send email right now (503).');
      await capture(page, testInfo, `reset-request-${name}-503`);

      await page.route(
        `${API}/v1/auth/password-reset/request`,
        json({ accepted: true, delivery: 'email' }, 202)
      );
      await main.getByRole('button', { name: 'Send reset link' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Check your inbox' })).toBeVisible();
      await expect(main.getByText('If an account exists for that email')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Send another link' })).toBeVisible();
      await capture(page, testInfo, `reset-request-${name}-sent`);
      expect(critical).toEqual([]);
    });

    test('auth-reset-password /reset-password?token=…', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      const main = page.locator('main');

      // An empty token is no token: the link can't be used, and a new one is a click away.
      await page.goto('/reset-password?token=');
      await expect(
        main.getByRole('heading', { level: 1, name: 'This reset link can’t be used' })
      ).toBeVisible();
      await expect(main.getByText('Reset link · missing')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
      await capture(page, testInfo, `reset-complete-${name}-empty-token`);

      // A reset link lands on the reset screen, with its token in the address.
      await page.goto(`/reset-password?token=${RESET_TOKEN}`);
      await expect(
        main.getByRole('heading', { level: 1, name: 'Set a new password' })
      ).toBeVisible();
      await expect(main.getByText('Reset link · ready to use')).toBeVisible();
      await main.getByLabel('New password').fill('short');
      await expect(main.getByText('Strength: Too short')).toBeVisible();
      await main.getByLabel('Confirm password').fill('different');
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(main.getByText('Use at least 10 characters.')).toBeVisible();
      await expect(main.getByText('The passwords don’t match.')).toBeVisible();
      await capture(page, testInfo, `reset-complete-${name}-validation`);

      await page.route(
        `${API}/v1/auth/password-reset/complete`,
        detail(422, 'weak_password', 'That password is on the list of common passwords.')
      );
      await main.getByLabel('New password').fill('password1234');
      await main.getByLabel('Confirm password').fill('password1234');
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(
        main.getByText('That password is on the list of common passwords.')
      ).toBeVisible();
      await expect(main.getByText('Reset link · ready to use')).toBeVisible();
      await capture(page, testInfo, `reset-complete-${name}-422`);

      // The refused link retires the form.
      await page.route(
        `${API}/v1/auth/password-reset/complete`,
        detail(401, 'reset_token_invalid', 'Reset token is invalid or expired.')
      );
      await main.getByLabel('New password').fill('a-long-enough-password');
      await main.getByLabel('Confirm password').fill('a-long-enough-password');
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(
        main.getByRole('heading', { level: 1, name: 'This reset link can’t be used' })
      ).toBeVisible();
      await expect(main.getByText('Reset link · not accepted')).toBeVisible();
      await expect(main.getByLabel('New password')).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
      await capture(page, testInfo, `reset-complete-${name}-refused`);

      // A good link spends the token it was given, with the password that was typed.
      let spent: { token: string; new_password: string } | null = null;
      await page.route(`${API}/v1/auth/password-reset/complete`, route => {
        spent = route.request().postDataJSON() as { token: string; new_password: string };
        return route.fulfill({ status: 204 });
      });
      await page.goto(`/reset-password?token=${RESET_TOKEN}`);
      await main.getByLabel('New password').fill('a-long-enough-password');
      await main.getByLabel('Confirm password').fill('a-long-enough-password');
      await expect(main.getByText('Strength: Good')).toBeVisible();
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Password changed' })).toBeVisible();
      await expect(main.getByText('Reset link · used')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Continue to log in' })).toHaveAttribute(
        'href',
        '/authentication'
      );
      expect(spent).toEqual({ token: RESET_TOKEN, new_password: 'a-long-enough-password' });
      await capture(page, testInfo, `reset-complete-${name}-changed`);

      // The way on to log in says why.
      await main.getByRole('link', { name: 'Continue to log in' }).click();
      await expect(page).toHaveURL(/\/authentication$/);
      await expect(main.getByText('Password changed. Log in with the new password.')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('org-join /orgs/join/:code', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      let joined = false;
      await mockApi(page, { organizations: () => (joined ? [isaDemo] : []) });
      await page.route(`${API}/v1/invitations/${CODE}/preview`, json(preview));
      await page.route(`${API}/v1/invitations/${CODE}/join`, route => {
        joined = true;
        return route.fulfill({ json: { ...isaDemo, effective_role: 'MEMBER' } });
      });
      await page.route(
        `${API}/v1/invitations/unknown-code/preview`,
        detail(404, 'not_found', 'Invitation not found.')
      );
      await page.goto(`/orgs/join/${CODE}`);
      const main = page.locator('main');

      // No session: sign in first, then back to the invitation.
      await expect(page).toHaveURL(/\/authentication$/);
      await main.getByLabel('Username or email').fill('sofia');
      await main.getByLabel('Password').fill('a-long-enough-password');
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(page).toHaveURL(new RegExp(`/orgs/join/${CODE}$`));

      // SPHERE's join card: the organization, who invited, the role it joins with.
      await expect(main.getByRole('heading', { level: 1, name: 'ISA Demo Group' })).toBeVisible();
      await expect(main.getByText('@isa-demo')).toBeVisible();
      await expect(main.getByText('@nora invited you to join this organization.')).toBeVisible();
      await capture(page, testInfo, `join-${name}-card`);
      await main.getByRole('button', { name: 'Join ISA Demo Group' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'You joined!' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open ISA Demo Group' })).toHaveAttribute(
        'href',
        '/orgs/isa-demo'
      );
      await capture(page, testInfo, `join-${name}-joined`);

      // One neutral answer for any code that does not let anybody in.
      await page.goto('/orgs/join/unknown-code');
      await expect(
        main.getByRole('heading', { level: 1, name: 'Invalid invitation' })
      ).toBeVisible();
      await capture(page, testInfo, `join-${name}-invalid`);
      expect(critical).toEqual([]);
    });
  });
}

/** Where the browser was sent: the gateway's SCORETech sign-in route, answered by a stand-in page. */
async function interceptIdentity(page: Page): Promise<URL[]> {
  const visits: URL[] = [];
  await page.route(`${API}/v1/auth/identity/login**`, route => {
    visits.push(new URL(route.request().url()));
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>SCORETech Identity</title><h1>SCORETech Identity</h1>',
    });
  });
  return visits;
}

const IDENTITY_ERRORS: Array<[string, string]> = [
  ['signin_failed', 'Sign-in could not be completed'],
  ['account_not_linked', 'This email belongs to another account'],
  ['access_denied', 'Your SCORETech account can’t use OpenBinding yet'],
  ['unavailable', 'SCORETech Identity is unavailable'],
  ['expired', 'Your sign-in expired'],
  ['account_disabled', 'This account is disabled'],
];

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S2 in SCORETech mode`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('auth /authentication sends logging in and signing up to SCORETech Identity, with a safe returnTo', async ({
      page,
    }) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { provider: 'scoretech' });
      const visits = await interceptIdentity(page);

      await page.goto('/authentication');
      await expect(page.getByRole('heading', { name: 'SCORETech Identity' })).toBeVisible();
      await page.goto('/authentication?view=register');
      await expect(page.getByRole('heading', { name: 'SCORETech Identity' })).toBeVisible();
      // A visitor sent here by a protected page comes back to it.
      await page.goto('/me/orgs');
      await expect(page.getByRole('heading', { name: 'SCORETech Identity' })).toBeVisible();
      expect(visits.map(url => url.searchParams.get('returnTo'))).toEqual(['/', '/', '/me/orgs']);
      expect(visits.every(url => url.pathname === '/v1/auth/identity/login')).toBe(true);
      // Identity manages passwords: the reset screens go to sign-in too.
      await page.goto('/forgot-password');
      await expect(page.getByRole('heading', { name: 'SCORETech Identity' })).toBeVisible();
      await page.goto('/reset-password?token=obr_x_y');
      await expect(page.getByRole('heading', { name: 'SCORETech Identity' })).toBeVisible();
      expect(visits).toHaveLength(5);
      expect(critical).toEqual([]);
    });

    test('auth ?identity_error= names each refusal, offers Try again and never loops', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { provider: 'scoretech' });
      const visits = await interceptIdentity(page);
      const main = page.locator('main');
      for (const [code, title] of IDENTITY_ERRORS) {
        await page.goto(`/authentication?identity_error=${code}`);
        await expect(main.getByRole('heading', { level: 1, name: title })).toBeVisible();
        await expect(main.getByRole('link', { name: 'Try again' })).toHaveAttribute(
          'href',
          /\/v1\/auth\/identity\/login\?returnTo=%2F$/
        );
        await capture(page, testInfo, `identity-error-${code}-${name}`);
      }
      expect(visits).toHaveLength(0);
      await main.getByRole('link', { name: 'Try again' }).click();
      await expect(page.getByRole('heading', { name: 'SCORETech Identity' })).toBeVisible();
      expect(visits).toHaveLength(1);
      expect(critical).toEqual([]);
    });

    test('auth-identity-callback /sso/identity/callback goes where the person was going, once signed in', async ({
      page,
    }) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { provider: 'scoretech', account: person() });
      await page.goto('/sso/identity/callback?returnTo=%2Fme%2Forgs');
      await expect(page).toHaveURL(/\/me\/orgs$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Your organizations' })
      ).toBeVisible();
      await page.goto('/sso/identity/callback?returnTo=%2F%2Fevil.example');
      await expect.poll(() => new URL(page.url()).pathname).toBe('/');
      expect(critical).toEqual([]);
    });

    test('auth-identity-callback without a session says the sign-in failed', async ({ page }) => {
      await mockApi(page, { provider: 'scoretech' });
      await interceptIdentity(page);
      await page.goto('/sso/identity/callback?returnTo=%2Fme%2Forgs');
      await expect(page).toHaveURL(/\/authentication\?identity_error=signin_failed$/);
      await expect(
        page
          .locator('main')
          .getByRole('heading', { level: 1, name: 'Sign-in could not be completed' })
      ).toBeVisible();
    });
    test('auth-identity-username /sso/identity/username: a taken name, then a free one', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { provider: 'scoretech' });
      let signedUp = false;
      const chosen: string[] = [];
      await page.route(`${API}/v1/auth/identity/pending`, route =>
        route.fulfill({
          json: {
            suggested_username: 'sofia',
            email: 'sofia@example.org',
            email_verified: true,
            display_name: 'Sofía Ramos',
            expires_at: '2026-12-01T00:15:00Z',
          },
        })
      );
      await page.route(`${API}/v1/auth/identity/complete`, route => {
        const username = String((route.request().postDataJSON() as { username: string }).username);
        chosen.push(username);
        if (username === 'sofia')
          return route.fulfill({
            status: 409,
            json: failureBody(409, 'username_taken', 'That username is taken.'),
          });
        signedUp = true;
        return route.fulfill({ status: 201, json: { return_to: '/me/orgs' } });
      });
      await page.route(`${API}/v1/auth/identity/session`, route =>
        signedUp
          ? route.fulfill({
              json: { access_token: 's2-access', token_type: 'bearer', expires_in: 300 },
            })
          : route.fulfill({
              status: 401,
              json: failureBody(401, 'no_session', 'There is no session.'),
            })
      );
      const main = page.locator('main');
      await page.goto('/sso/identity/username?returnTo=%2Fme%2Forgs');
      await expect(
        main.getByRole('heading', { level: 1, name: 'Choose your username' })
      ).toBeVisible();
      await expect(main.getByLabel('Username')).toHaveValue('sofia');
      await expect(main.getByText('sofia@example.org')).toBeVisible();
      await capture(page, testInfo, `identity-username-${name}-empty`);

      await main.getByRole('button', { name: 'Create my account' }).click();
      await expect(main.getByText('That username is taken. Choose another one.')).toBeVisible();
      await expect(main.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true');
      await capture(page, testInfo, `identity-username-${name}-409`);

      await main.getByLabel('Username').fill('sofia.ramos');
      await capture(page, testInfo, `identity-username-${name}-valid`);
      await main.getByRole('button', { name: 'Create my account' }).click();
      await expect(page).toHaveURL(/\/me\/orgs$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Your organizations' })
      ).toBeVisible();
      expect(chosen).toEqual(['sofia', 'sofia.ramos']);
      expect(critical).toEqual([]);
    });

    test('auth-identity-username with no sign-up waiting goes back to sign in, saying it expired', async ({
      page,
    }) => {
      await mockApi(page, { provider: 'scoretech' });
      await interceptIdentity(page);
      await page.route(`${API}/v1/auth/identity/pending`, route =>
        route.fulfill({
          status: 404,
          json: failureBody(404, 'no_pending_signup', 'Nothing waits.'),
        })
      );
      await page.goto('/sso/identity/username');
      await expect(page).toHaveURL(/\/authentication\?identity_error=expired$/);
      await expect(
        page.locator('main').getByRole('heading', { level: 1, name: 'Your sign-in expired' })
      ).toBeVisible();
    });
  });
}
