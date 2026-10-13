import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';

// S2 · authentication, invitations and the state gallery:
// auth-login, auth-register, auth-reset-request, auth-reset-complete, auth-cas-callback, org-invite-accept, sys-states.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: each walks the states of its screen in order, on one page.

const API = 'http://localhost:8000';
const TOKEN = `obi_${'a1b2c3d4'.repeat(2)}_${'e5f6a7b8'.repeat(3)}`;
const RESET_TOKEN = 'obr_k3j9d8f7_h2g1s0a9q8w7e6r5t4y3u2i1o0p9';
const CAS_CODE = 'c'.repeat(43);

const tokens = { access_token: 's2-access', refresh_token: 's2-refresh', token_type: 'bearer', expires_in: 900 };

const person = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1', username: 'sofia', email: 'sofia@example.org', role: 'user', is_active: true, plan: 'FREE',
  created_at: '2026-09-01T00:00:00Z', ...overrides,
});

const researcher = person({ username: 'lucia', email: 'lucia@example.org', plan: 'RESEARCH', cas_verified: true, institutional_branding: true });

const isaDemo = {
  id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, billing_sponsor_user_id: 'sponsor-1',
  effective_role: 'MEMBER', created_at: '2026-09-01T00:00:00Z',
};

const membership = {
  id: 'member-1', organization_id: 'org-1', user_id: 'user-1', username: 'sofia', email: 'sofia@example.org', role: 'MEMBER',
  created_at: '2026-10-09T10:00:00Z',
};

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json(failureBody(status, code, error, extra), status);

type Handler = (route: Route) => Promise<void> | void;

interface Mocks {
  /** Signed in as this account from the first request. */
  account?: ReturnType<typeof person>;
  accept?: Handler;
  /** What GET /v1/organizations answers; a function lets the answer change once something happened. */
  organizations?: unknown[] | (() => unknown[]);
}

/** Everything these screens read, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  // Whoever signs in during a test becomes this account; /v1/users/me is only asked once a token exists.
  let current = mocks.account ?? person();
  if (mocks.account) await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 's2-access'));
  await page.route(`${API}/v1/users/me`, (route) => route.fulfill({ json: current }));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: 's2-pricing' }));
  await page.route(`${API}/v1/notifications**`, json([]));
  const organizations = mocks.organizations ?? [isaDemo];
  await page.route(`${API}/v1/organizations`, (route) => route.fulfill({
    json: typeof organizations === 'function' ? organizations() : organizations,
  }));
  await page.route(`${API}/v1/organizations/isa-demo/projects`, json([]));
  await page.route(`${API}/v1/auth/login`, json(tokens));
  await page.route(`${API}/v1/auth/register`, json(person(), 201));
  await page.route(`${API}/v1/auth/password-reset/request`, json({ accepted: true, delivery: 'email' }, 202));
  await page.route(`${API}/v1/auth/password-reset/complete`, (route) => route.fulfill({ status: 204 }));
  await page.route(`${API}/v1/auth/cas/exchange`, (route) => {
    current = researcher;
    return route.fulfill({ json: tokens });
  });
  await page.route(`${API}/v1/invitations/accept`, mocks.accept ?? json(membership));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
}

function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', (error) => critical.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && /The above error occurred|Minified React error|Maximum update depth|Uncaught/i.test(text)) critical.push(`console: ${text}`);
  });
  return critical;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save a full-page picture of the current state for a person to look at. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expectNoHorizontalOverflow(page);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
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
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S2`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('auth-login /login', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/login');
      const main = page.locator('main');

      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
      const cas = main.getByRole('link', { name: 'Continue with Universidad de Sevilla (CAS)' });
      await expect(cas).toHaveAttribute('href', `${API}/v1/auth/cas/start?mode=login`);
      await expect(cas.locator('img')).toHaveAttribute('src', '/brands/us-fama.png');
      await expect(main.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/password-reset');
      await expect(main.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/register');
      await capture(page, testInfo, `login-${name}-empty`);

      // Both fields are asked for before the gateway is.
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(main.getByText('Enter your username or email.')).toBeVisible();
      await expect(main.getByText('Enter your password.')).toBeVisible();
      await expect(main.getByLabel('Username or email')).toBeFocused();
      await capture(page, testInfo, `login-${name}-validation`);

      // A wrong password and an unknown account read the same.
      await page.route(`${API}/v1/auth/login`, detail(401, 'invalid_credentials', 'Those credentials do not match an active account.'));
      await main.getByLabel('Username or email').fill('ghost');
      await main.getByLabel('Password').fill('not-the-password');
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(main.getByRole('alert')).toContainText('That username or email and password don’t match an active account.');
      await expect(main.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
      await capture(page, testInfo, `login-${name}-401`);

      // The accounts service is down: said as such, with the way to the status page.
      await page.route(`${API}/v1/auth/login`, detail(503, 'auth_unavailable', 'Accounts are not reachable.'));
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(main.getByRole('alert')).toContainText('Sign-in is unavailable right now (503)');
      await expect(main.getByRole('alert').getByRole('link', { name: 'Service status' })).toHaveAttribute('href', '/status');
      await capture(page, testInfo, `login-${name}-503`);

      // A session that ended without being asked to is explained.
      await page.evaluate(() => sessionStorage.setItem('openbinding-session-ended', '1'));
      await page.goto('/login');
      await expect(main.getByText('Your session ended and couldn’t be renewed.')).toBeVisible();
      await capture(page, testInfo, `login-${name}-session-expired`);

      // Someone who is signed in already is told so, with the way on.
      await page.evaluate(() => localStorage.setItem('openbinding-access-token', 's2-access'));
      await page.goto('/login');
      await expect(main.getByRole('heading', { level: 1, name: 'You’re already signed in' })).toBeVisible();
      await expect(main.getByText('Signed in as sofia (sofia@example.org).')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute('href', '/app');
      await expect(main.getByRole('button', { name: 'Log in as someone else' })).toBeVisible();
      await capture(page, testInfo, `login-${name}-already-signed-in`);

      // A visitor sent here by a protected page signs in and goes back to it.
      await forgetEverything(page);
      await page.route(`${API}/v1/auth/login`, json(tokens));
      await page.goto('/app/system/states');
      await expect(page).toHaveURL(/\/login$/);
      await main.getByLabel('Username or email').fill('sofia');
      await main.getByLabel('Password').fill('a-long-enough-password');
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(page).toHaveURL(/\/app\/system\/states$/);
      await expect(page.locator('header.app-header')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'States and recoverable errors' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('auth-register /register', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.route(`${API}/v1/auth/register`, detail(409, 'already_registered', 'That username or email is already in use.'));
      await page.goto('/register');
      const main = page.locator('main');

      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible();
      await expect(main.getByText('New accounts start on the free plan')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
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
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(main.getByRole('alert')).toContainText('That username or email is already registered (409).');
      await expect(main.getByRole('alert').getByRole('link', { name: 'reset your password' })).toHaveAttribute('href', '/password-reset');
      await capture(page, testInfo, `register-${name}-409`);

      await page.route(`${API}/v1/auth/register`, detail(422, 'weak_password', 'That password is on the list of common passwords.'));
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(main.getByText('That password is on the list of common passwords.')).toBeVisible();
      await expect(main.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
      await capture(page, testInfo, `register-${name}-422`);

      await page.route(`${API}/v1/auth/register`, detail(503, 'pricing_unavailable', 'The active pricing cannot be resolved.'));
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(main.getByRole('alert')).toContainText('Accounts can’t be created right now (503). Nothing was saved');
      await capture(page, testInfo, `register-${name}-503`);

      // The account is created, signed in and taken to the workspace.
      await page.route(`${API}/v1/auth/register`, json(person(), 201));
      await main.getByRole('button', { name: 'Create account' }).click();
      await expect(page).toHaveURL(/\/app$/);
      await expect(page.locator('header.app-header')).toBeVisible();

      // And a signed-in visitor is told they already have one.
      await page.goto('/register');
      await expect(main.getByRole('heading', { level: 1, name: 'You already have an account' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Log out' })).toBeVisible();
      await capture(page, testInfo, `register-${name}-already-signed-in`);
      expect(critical).toEqual([]);
    });

    test('auth-reset-request /password-reset', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/password-reset');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Forgot your password?' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
      await capture(page, testInfo, `reset-request-${name}-empty`);

      await main.getByLabel('Email address').fill('nope');
      await main.getByRole('button', { name: 'Send reset link' }).click();
      await expect(main.getByText('Enter a valid email address.')).toBeVisible();
      await capture(page, testInfo, `reset-request-${name}-invalid`);

      await page.route(`${API}/v1/auth/password-reset/request`, detail(503, 'email_unavailable', 'Mail is down.'));
      await main.getByLabel('Email address').fill('sofia@example.org');
      await main.getByRole('button', { name: 'Send reset link' }).click();
      await expect(main.getByRole('alert')).toContainText('We can’t send email right now (503).');
      await capture(page, testInfo, `reset-request-${name}-503`);

      await page.route(`${API}/v1/auth/password-reset/request`, json({ accepted: true, delivery: 'email' }, 202));
      await main.getByRole('button', { name: 'Send reset link' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Check your inbox' })).toBeVisible();
      await expect(main.getByText('If an account exists for that email')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Send another link' })).toBeVisible();
      await capture(page, testInfo, `reset-request-${name}-sent`);
      expect(critical).toEqual([]);
    });

    test('auth-reset-complete /password-reset/complete', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/password-reset/complete');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'This link is incomplete' })).toBeVisible();
      await expect(main.getByText('Reset link · missing')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/password-reset');
      await capture(page, testInfo, `reset-complete-${name}-no-token`);

      await page.goto(`/password-reset/complete?token=${RESET_TOKEN}`);
      await expect(main.getByRole('heading', { level: 1, name: 'Set a new password' })).toBeVisible();
      await expect(main.getByText('Reset link · ready to use')).toBeVisible();
      await main.getByLabel('New password').fill('short');
      await expect(main.getByText('Strength: Too short')).toBeVisible();
      await main.getByLabel('Confirm password').fill('different');
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(main.getByText('Use at least 10 characters.')).toBeVisible();
      await expect(main.getByText('The passwords don’t match.')).toBeVisible();
      await capture(page, testInfo, `reset-complete-${name}-validation`);

      await page.route(`${API}/v1/auth/password-reset/complete`, detail(422, 'weak_password', 'That password is on the list of common passwords.'));
      await main.getByLabel('New password').fill('password1234');
      await main.getByLabel('Confirm password').fill('password1234');
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(main.getByText('That password is on the list of common passwords.')).toBeVisible();
      await expect(main.getByText('Reset link · ready to use')).toBeVisible();
      await capture(page, testInfo, `reset-complete-${name}-422`);

      // The refused link retires the form.
      await page.route(`${API}/v1/auth/password-reset/complete`, detail(401, 'reset_token_invalid', 'Reset token is invalid or expired.'));
      await main.getByLabel('New password').fill('a-long-enough-password');
      await main.getByLabel('Confirm password').fill('a-long-enough-password');
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'This reset link can’t be used' })).toBeVisible();
      await expect(main.getByText('Reset link · not accepted')).toBeVisible();
      await expect(main.getByLabel('New password')).toHaveCount(0);
      await capture(page, testInfo, `reset-complete-${name}-refused`);

      // A good link spends the token it was given, with the password that was typed.
      let spent: { token: string; new_password: string } | null = null;
      await page.route(`${API}/v1/auth/password-reset/complete`, (route) => {
        spent = route.request().postDataJSON() as { token: string; new_password: string };
        return route.fulfill({ status: 204 });
      });
      await page.goto(`/password-reset/complete?token=${RESET_TOKEN}`);
      await main.getByLabel('New password').fill('a-long-enough-password');
      await main.getByLabel('Confirm password').fill('a-long-enough-password');
      await expect(main.getByText('Strength: Good')).toBeVisible();
      await main.getByRole('button', { name: 'Set new password' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Password changed' })).toBeVisible();
      await expect(main.getByText('Reset link · used')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Continue to log in' })).toHaveAttribute('href', '/login');
      expect(spent).toEqual({ token: RESET_TOKEN, new_password: 'a-long-enough-password' });
      await capture(page, testInfo, `reset-complete-${name}-changed`);
      expect(critical).toEqual([]);
    });

    test('auth-cas-callback /auth/cas/callback', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      const main = page.locator('main');

      await page.goto('/auth/cas/callback');
      await expect(main.getByRole('heading', { name: 'There’s no code to finish sign-in' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
      await capture(page, testInfo, `cas-${name}-no-code`);

      // Log in with CAS, heading for a protected page: the success card carries the institution's own mark.
      await page.evaluate(() => sessionStorage.setItem('openbinding-cas-flow', JSON.stringify({ mode: 'login', returnTo: '/app/system/states', at: Date.now() })));
      await page.goto(`/auth/cas/callback?code=${CAS_CODE}`);
      await expect(main.getByText('Universidad de Sevilla · CAS · log in')).toBeVisible();
      await expect(main.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
      await expect(main.getByText(/qualifies for RESEARCH under the current pricing/)).toBeVisible();
      await expect(main.locator('.auth-institution img[alt="Universidad de Sevilla"]')).toHaveAttribute('src', '/brands/us-fama.png');
      await expect(main.getByRole('link', { name: 'Continue to your workspace' })).toHaveAttribute('href', '/app/system/states');
      await expect(main.getByRole('link', { name: 'Account › Identities' })).toHaveAttribute('href', '/app/account/identities');
      await capture(page, testInfo, `cas-${name}-login-success`);

      // Link an identity to the signed-in account: a different flow, back to the identities screen.
      await page.evaluate(() => sessionStorage.setItem('openbinding-cas-flow', JSON.stringify({ mode: 'link', returnTo: null, at: Date.now() })));
      await page.goto(`/auth/cas/callback?code=${CAS_CODE}`);
      await expect(main.getByText('Universidad de Sevilla · CAS · link identity')).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Identity linked' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to my account' })).toHaveAttribute('href', '/app/account/identities');
      await capture(page, testInfo, `cas-${name}-link-success`);

      await page.route(`${API}/v1/auth/cas/exchange`, detail(401, 'cas_code_invalid', 'CAS code was used, expired or is invalid.'));
      await page.goto(`/auth/cas/callback?code=${CAS_CODE}`);
      await expect(main.getByRole('alert')).toContainText('This code can’t be used.');
      await capture(page, testInfo, `cas-${name}-code-invalid`);

      await page.route(`${API}/v1/auth/cas/exchange`, detail(503, 'institutional_pricing_invalid', 'The active iPricing must declare the CAS-only RESEARCH plan.'));
      await page.goto(`/auth/cas/callback?code=${CAS_CODE}`);
      await expect(main.getByRole('alert')).toContainText('503 · institutional_pricing_invalid');
      await expect(main.getByRole('link', { name: 'Service status' })).toHaveAttribute('href', '/status');
      await capture(page, testInfo, `cas-${name}-503`);

      await page.route(`${API}/v1/auth/cas/exchange`, detail(409, 'identity_in_use', 'That UVUS identity belongs to another account.'));
      await page.goto(`/auth/cas/callback?code=${CAS_CODE}`);
      await expect(main.getByRole('heading', { name: 'This identity can’t be used here' })).toBeVisible();
      await expect(main.getByText('This identity is already linked to another account.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Go to Account › Identities' })).toHaveAttribute('href', '/app/account/identities');
      await capture(page, testInfo, `cas-${name}-linked-elsewhere`);

      // The gateway reports its own failures in the address, each with a message of its own and a way forward.
      const reported: Array<[string, string]> = [
        ['cas_unavailable', 'Institutional sign-in is unavailable right now (503).'],
        ['cas_state_invalid', 'This sign-in attempt has expired (cas_state_invalid).'],
        ['cas_ticket_invalid', 'The university didn’t accept this sign-in (cas_ticket_invalid).'],
        ['account_inactive', 'This account is deactivated (account_inactive).'],
        ['pricing_unavailable', 'The pricing service didn’t answer (503 · pricing_unavailable).'],
        ['cas_error', 'The sign-in couldn’t be finished (cas_error).'],
      ];
      for (const [code, title] of reported) {
        await page.goto(`/auth/cas/callback?error=${code}`);
        await expect(main.getByText(title)).toBeVisible();
        await expect(main.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
      }
      await page.goto('/auth/cas/callback?error=cas_ticket_invalid');
      await expect(main.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', `${API}/v1/auth/cas/start?mode=login`);
      await capture(page, testInfo, `cas-${name}-ticket-invalid`);
      await page.goto('/auth/cas/callback?error=account_inactive');
      await expect(main.getByRole('link', { name: 'Try again' })).toHaveCount(0);

      // Linking CAS raised the plan to RESEARCH at no cost: the exchange says so, and the screen the person lands on tells them once.
      await page.route(`${API}/v1/auth/cas/exchange`, json({ ...tokens, plan_changed: { from: 'BASIC', to: 'RESEARCH', extra_cost: false } }));
      await page.evaluate(() => sessionStorage.setItem('openbinding-cas-flow', JSON.stringify({ mode: 'login', returnTo: '/app', at: Date.now() })));
      await page.goto(`/auth/cas/callback?code=${CAS_CODE}&plan_changed=RESEARCH`);
      await expect(main.getByRole('heading', { name: 'You’re signed in' })).toBeVisible();
      await main.getByRole('link', { name: 'Continue to your workspace' }).click();
      const planNote = page.getByText('Your account is now on the RESEARCH plan. There is no extra cost.');
      await expect(planNote).toBeVisible();
      await capture(page, testInfo, `cas-${name}-plan-changed`);
      await page.getByRole('button', { name: 'Dismiss' }).click();
      await expect(planNote).toHaveCount(0);
      await page.reload();
      await expect(page.locator('#platform-main')).toBeVisible();
      await expect(planNote).toHaveCount(0);
      expect(critical).toEqual([]);
    });

    test('org-invite-accept /invitations/accept', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      let joined = false;
      await mockApi(page, {
        organizations: () => (joined ? [isaDemo] : []),
        accept: (route) => {
          joined = true;
          return route.fulfill({ json: membership });
        },
      });
      await page.goto(`/invitations/accept?token=${TOKEN}`);
      const main = page.locator('main');

      // No session: the public header, and a prompt that keeps the invitation.
      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(page.locator('header.app-header')).toHaveCount(0);
      await expect(main.getByRole('heading', { level: 1, name: 'Log in to accept' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Create an account' })).toBeVisible();
      // The secret is no longer in the address bar.
      await expect.poll(() => page.url()).not.toContain(TOKEN);
      await capture(page, testInfo, `invite-${name}-log-in`);

      // Logging in brings the page back, with the application header and the token in the field.
      await main.getByRole('link', { name: 'Log in' }).click();
      await main.getByLabel('Username or email').fill('sofia');
      await main.getByLabel('Password').fill('a-long-enough-password');
      await main.getByRole('button', { name: 'Log in' }).click();
      await expect(page).toHaveURL(/\/invitations\/accept$/);
      await expect(page.locator('header.app-header')).toBeVisible();
      await expect(main.getByLabel('Invitation token')).toHaveValue(TOKEN);
      await expect(main.getByRole('heading', { level: 1, name: 'Join with this invitation' })).toBeVisible();
      await expect(main.getByText('Signed in as sofia.')).toBeVisible();
      await capture(page, testInfo, `invite-${name}-form`);

      await main.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'You joined ISA Demo Group' })).toBeVisible();
      await expect(main.getByText('@isa-demo')).toBeVisible();
      await expect(main.getByText('MEMBER', { exact: true })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open the organization' })).toHaveAttribute('href', '/app/isa-demo');
      await capture(page, testInfo, `invite-${name}-joined`);

      // Without a link: paste the token. A short one is refused locally; the gateway refuses the rest.
      // (Opening the same address again would be a reload, which keeps the token in the entry's state on purpose.)
      await page.goto('/status');
      await page.goto('/invitations/accept');
      // A full page load again, on a development server that is compiling for other workers: the session is read before the page shows.
      await expect(main.getByRole('heading', { level: 1, name: 'Paste your invitation' })).toBeVisible({ timeout: 20_000 });
      await expect(main.getByText('the API has no endpoint to preview an invitation')).toBeVisible();
      await capture(page, testInfo, `invite-${name}-paste`);
      await main.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(main.getByText('Paste the invitation token.')).toBeVisible();
      await main.getByLabel('Invitation token').fill('obi_too_short');
      await expect(main.getByText(/at least 32 characters/)).toBeVisible();
      await capture(page, testInfo, `invite-${name}-short`);

      await page.route(`${API}/v1/invitations/accept`, detail(404, 'not_found', 'Invitation is invalid or expired.'));
      await main.getByLabel('Invitation token').fill(TOKEN);
      await main.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(main.getByRole('alert')).toContainText('This invitation can’t be used.');
      await expect(main.getByRole('alert')).toContainText('different email address than sofia@example.org');
      await capture(page, testInfo, `invite-${name}-invalid`);

      await page.route(`${API}/v1/invitations/accept`, json({
        detail: { code: 'sponsor_quota_exceeded', error: 'The sponsor contract allows 15 members.', quota: { limit_id: 'members', limit: 15, used: 16 } },
      }, 402));
      await main.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(main.getByRole('alert')).toContainText('402 · sponsor_quota_exceeded');
      await expect(main.getByRole('alert')).toContainText('your invitation stays valid until it expires');
      await capture(page, testInfo, `invite-${name}-402`);

      // The account already belongs to the organization by now.
      await page.route(`${API}/v1/invitations/accept`, json(membership));
      await main.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'You’re already a member of ISA Demo Group' })).toBeVisible();
      await expect(main.getByText('Nothing changed: your current role stays as it is.')).toBeVisible();
      await capture(page, testInfo, `invite-${name}-already-member`);
      expect(critical).toEqual([]);
    });

    test('sys-states /app/system/states', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { account: person() });
      await page.goto('/app/system/states');
      const main = page.locator('#platform-main');

      await expect(page.locator('header.app-header')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'States and recoverable errors' })).toBeVisible();
      for (const status of ['401', '402', '403', '404', '429', '503']) {
        await expect(main.locator('.ui-state-chip', { hasText: new RegExp(`^${status}$`) }).first()).toBeVisible();
      }
      await expect(main.getByRole('heading', { name: 'This needs ADMIN in ISA Demo Group' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'See who manages this organization' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
      await expect(main.getByRole('button', { name: 'Retry now' })).toBeDisabled();
      await expect(main.getByRole('meter')).toHaveCount(0);
      await capture(page, testInfo, `states-${name}-all`);

      await main.getByRole('button', { name: 'Quota', exact: true }).click();
      await expect(main.locator('article.ui-state')).toHaveCount(3);
      await capture(page, testInfo, `states-${name}-quota`);

      await main.getByRole('button', { name: 'Warnings & dates', exact: true }).click();
      await main.getByRole('button', { name: 'Present', exact: true }).click();
      await expect(main.getByRole('heading', { name: 'Plan features: confirmed' })).toBeVisible();
      await capture(page, testInfo, `states-${name}-warnings`);

      await main.getByRole('button', { name: 'All', exact: true }).click();
      await expect(main.getByText('Headline: “All your job slots are busy”')).toBeVisible();
      expect(critical).toEqual([]);
    });
  });
}
