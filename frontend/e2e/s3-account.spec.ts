import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { PLANS_PRICING_FIXTURE } from '../src/test/fixtures/plansPricing';
import { authConfig, signedIn } from './helpers/session';

// S3 · the account: acct-settings (`/me/settings?section=`: account, sign-in & security, notifications, plan, appearance, beta
// features, danger zone) and acct-api-keys (`/me/api-keys`, with the Create new API key dialog at `?create=key`).
// (pub-pricing has its own file, pricing.spec.ts.) There is no backend: the API origin is answered by page.route().
// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: each walks the states of its screen in order, on one page.

const API = 'http://localhost:8000';

// Eight browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json =
  (body: unknown, status = 200): Handler =>
  route =>
    route.fulfill({ status, json: body });
const detail = (
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {}
): Handler => json(failureBody(status, code, error, extra), status);
const noContent: Handler = route => route.fulfill({ status: 204 });

/** A pricing token shaped like the gateway's: three dot-separated parts, the middle one a JSON payload. */
const token = (expiresInSeconds: number) =>
  [
    'header',
    Buffer.from(
      JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })
    ).toString('base64'),
    'signature',
  ].join('.');

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const lucia = {
  id: 'user-1',
  username: 'lucia.vega',
  email: 'lucia@example.org',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z',
  email_verified: true,
  institutional_email: true,
  password_enabled: true,
};
const marco = {
  ...lucia,
  username: 'marco.diaz',
  email: 'marco@example.org',
  plan: 'FREE',
  email_verified: false,
  institutional_email: false,
  password_enabled: true,
};
const iker = {
  ...marco,
  username: 'iker.mora',
  email: 'iker@example.org',
  role: 'admin',
  plan: 'LAB',
};
/** An account that signs in with SCORETech Identity only: no password of its own. */
const sofia = {
  ...lucia,
  username: 'sofia.ruiz',
  email: 'sofia@example.org',
  password_enabled: false,
};
type Account = typeof lucia & {
  display_name?: string | null;
  avatar?: unknown;
  api_keys_suspended_at?: string | null;
};

/** What the gateway reports for the RESEARCH plan of the pricing 0.2.0: the plan, its features and its limits, with no consumption. */
const researchUsage = () => ({
  plan: 'RESEARCH',
  contract_pending: false,
  features: {
    repository: true,
    runs: true,
    studies: true,
    generator: false,
    federatedEngines: true,
    collaboration: true,
    apiAccess: true,
  },
  capabilities: {
    maxProblems: null,
    maxCollections: null,
    maxRepositoryStorage: null,
    solverHours: 100,
    maxRunMinutes: 30,
    maxConcurrentRuns: 4,
    maxStudyCells: 5000,
    generatedInstances: 100_000,
    maxInstancesPerGeneration: 10_000,
    maxFederatedEngines: 3,
    maxPrivateProjects: 10,
    maxApiKeys: 10,
  },
});

/** FREE, as the pricing 0.2.0 sizes it. */
const freeUsage = () => ({
  plan: 'FREE',
  contract_pending: false,
  features: {
    repository: true,
    runs: true,
    studies: true,
    federatedEngines: true,
    apiAccess: true,
  },
  capabilities: {
    maxProblems: 25,
    maxRepositoryStorage: 500,
    maxRunMinutes: 5,
    maxConcurrentRuns: 1,
    maxStudyCells: 500,
    maxFederatedEngines: 1,
    maxApiKeys: 2,
  },
});

const DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;
const engineRef = {
  namespace: 'bim.builtin',
  name: 'random-search',
  version: '1.0.0',
  digest: DIGEST,
};
const engine = { ...engineRef, id: 'bim.builtin/random-search', ref: engineRef, modes: [] };

const reader = {
  id: 'k1',
  name: 'ci-lectura-resultados',
  prefix: 'obk_demo0001',
  created_at: '2026-09-01T00:00:00Z',
  last_used_at: '2026-10-08T00:00:00Z',
  expires_at: '2099-12-31T00:00:00Z',
  permissions: ['jobs:read', 'problems:read', 'studies:read'],
  engine_access: { all: true, engines: [] },
  boundary: {
    methods: ['GET'],
    organizations: ['isa-demo'],
    resource_kinds: ['runs', 'studies'],
    slugs: null,
  },
};
const runner = {
  id: 'k2',
  name: 'ejecucion-engine-fijo',
  prefix: 'obk_demo0002',
  created_at: '2026-09-10T00:00:00Z',
  last_used_at: null,
  expires_at: null,
  permissions: ['engines:execute', 'engines:read', 'problems:read', 'jobs:read'],
  engine_access: { all: false, engines: [engineRef] },
  boundary: {},
};
type ApiKey = typeof reader | typeof runner;

interface Notice {
  id: string;
  kind: string;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

const notifications = (): Notice[] => [
  {
    id: 'n1',
    kind: 'contract.changed',
    subject: 'Your OpenBinding agreement changed',
    body: 'Plan: FREE → RESEARCH. Add-ons: {} → {}. Reason: institutional_agreement.',
    payload: {
      reason: 'institutional_agreement',
      previous: { plan: 'FREE', addOns: {} },
      current: { plan: 'RESEARCH', addOns: {} },
      pricingVersion: '0.2.0',
    },
    read_at: null,
    created_at: hoursAgo(5),
  },
  {
    id: 'n2',
    kind: 'job.finished',
    subject: 'Job completed',
    body: 'Job 0000…f1 finished with FEASIBLE.',
    payload: {},
    read_at: hoursAgo(20),
    created_at: hoursAgo(26),
  },
  {
    id: 'n3',
    kind: 'organization.invitation',
    subject: 'You were invited to ISA Demo Group',
    body: 'Pablo invited you as MEMBER.',
    payload: {},
    read_at: null,
    created_at: hoursAgo(2),
  },
];

interface State {
  account: Account;
  pricingToken: Handler;
  usage: Handler;
  keys: ApiKey[];
  notifications: ReturnType<typeof notifications>;
  preferences: {
    inbox: boolean;
    email_contract_changes: boolean;
    email_invitations: boolean;
    email_job_failures: boolean;
    kinds: Record<string, { inbox: boolean; email: boolean }>;
  };
  beta: boolean;
  /** A refusal for one action; unset means the action succeeds. */
  refuse: Partial<
    Record<
      | 'patch'
      | 'delete'
      | 'list'
      | 'create'
      | 'revoke'
      | 'rotate'
      | 'notifications'
      | 'preferences'
      | 'savePreferences',
      Handler
    >
  >;
}

const methodOf = (route: Route) => route.request().method();

async function mockApi(
  page: Page,
  account: Account,
  overrides: Partial<State> = {},
  provider: 'local' | 'scoretech' = 'local'
): Promise<State> {
  const state: State = {
    account,
    pricingToken: json({ pricing_token: token(3600) }),
    usage: json(researchUsage()),
    keys: [reader, runner],
    notifications: notifications(),
    preferences: {
      inbox: true,
      email_contract_changes: true,
      email_invitations: true,
      email_job_failures: false,
      kinds: {
        OrganizationInvitation: { inbox: true, email: true },
        System: { inbox: true, email: true },
        CompositionUpdated: { inbox: true, email: true },
        RunFinished: { inbox: true, email: false },
        RunFailed: { inbox: true, email: true },
        CompositionAdopted: { inbox: true, email: false },
      },
    },
    beta: false,
    refuse: {},
    ...overrides,
  };

  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await authConfig(page, provider);
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await signedIn(page, 's3-access');
  await page.route(`${API}/v1/plans/pricing`, json(PLANS_PRICING_FIXTURE));
  await page.route(`${API}/v1/engines`, json({ engines: [engine] }));
  await page.route(
    url => url.origin + url.pathname === `${API}/v1/organizations`,
    json([
      {
        id: 'org-1',
        slug: 'isa-demo',
        name: 'ISA Demo Group',
        parent_id: null,
        effective_role: 'OWNER',
        description: '',
        avatar: { url: null, kind: null, bg_color: null, fg_color: null },
        role_source: null,
        children: [],
        created_at: '2026-09-01T00:00:00Z',
      },
    ])
  );

  await page.route(`${API}/v1/users/me`, async route => {
    const method = methodOf(route);
    if (method === 'PATCH') {
      if (state.refuse.patch) return state.refuse.patch(route);
      const body = route.request().postDataJSON() as {
        email?: string;
        display_name?: string;
        avatar?: unknown;
      };
      if (body.email) state.account = { ...state.account, email: body.email };
      if ('display_name' in body)
        state.account = { ...state.account, display_name: body.display_name || null };
      if ('avatar' in body) state.account = { ...state.account, avatar: body.avatar };
      return json(state.account)(route);
    }
    if (method === 'DELETE') return (state.refuse.delete ?? noContent)(route);
    return json(state.account)(route);
  });
  // What deleting the account deletes with it (F5-D): the personal organization and what it holds.
  await page.route(
    `${API}/v1/users/me/deletion`,
    json({
      personal_organization: {
        slug: 'lucia-vega',
        name: 'lucia.vega PERSONAL',
        compositions: 2,
        public_compositions: 1,
        problems: 1,
        runs: 4,
        feed_environments: 0,
      },
    })
  );
  await page.route(`${API}/v1/users/me/pricing-token`, route => state.pricingToken(route));
  await page.route(`${API}/v1/users/me/usage`, route => state.usage(route));

  await page.route(`${API}/v1/users/me/api-keys`, async route => {
    if (methodOf(route) === 'POST') {
      if (state.refuse.create) return state.refuse.create(route);
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const summary = {
        id: 'k3',
        prefix: 'obk_demo0003',
        created_at: new Date().toISOString(),
        last_used_at: null,
        expires_at: null,
        boundary: {},
        ...payload,
      };
      // The list never carries the secret; only this answer does.
      state.keys = [...state.keys, summary as unknown as ApiKey];
      return json({ ...summary, secret: 'obk_demo0003_SECRETO-UNICO-DE-PRUEBA' }, 201)(route);
    }
    if (state.refuse.list) return state.refuse.list(route);
    return json({ api_keys: state.keys })(route);
  });
  await page.route(new RegExp(`^${API}/v1/users/me/api-keys/([^/]+)/rotate$`), async route => {
    if (state.refuse.rotate) return state.refuse.rotate(route);
    const id = /api-keys\/([^/]+)\/rotate/.exec(route.request().url())?.[1];
    const key = state.keys.find(item => item.id === id) ?? reader;
    return json({ ...key, secret: 'obk_demo0001_NUEVO-SECRETO-DE-PRUEBA' })(route);
  });
  await page.route(new RegExp(`^${API}/v1/users/me/api-keys/([^/]+)$`), async route => {
    if (state.refuse.revoke) return state.refuse.revoke(route);
    const id = /api-keys\/([^/]+)$/.exec(route.request().url())?.[1];
    state.keys = state.keys.filter(item => item.id !== id);
    return noContent(route);
  });

  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), async route => {
    if (state.refuse.notifications) return state.refuse.notifications(route);
    return json(state.notifications)(route);
  });
  await page.route(`${API}/v1/notifications/read-all`, async route => {
    const stamp = new Date().toISOString();
    state.notifications = state.notifications.map(item => ({
      ...item,
      read_at: item.read_at ?? stamp,
    }));
    return json(state.notifications)(route);
  });
  await page.route(new RegExp(`^${API}/v1/notifications/([^/]+)/read$`), async route => {
    const id = /notifications\/([^/]+)\/read/.exec(route.request().url())?.[1];
    state.notifications = state.notifications.map(item =>
      item.id === id ? { ...item, read_at: new Date().toISOString() } : item
    );
    return json(state.notifications.find(item => item.id === id))(route);
  });
  await page.route(`${API}/v1/notifications/preferences`, async route => {
    if (methodOf(route) === 'PUT') {
      if (state.refuse.savePreferences) return state.refuse.savePreferences(route);
      state.preferences = route.request().postDataJSON() as State['preferences'];
      return json(state.preferences)(route);
    }
    if (state.refuse.preferences) return state.refuse.preferences(route);
    return json(state.preferences)(route);
  });
  await page.route(`${API}/v1/users/me/settings/beta-features`, async route => {
    if (methodOf(route) === 'PUT')
      state.beta = (route.request().postDataJSON() as { enabled: boolean }).enabled;
    return json({ enabled: state.beta })(route);
  });
  return state;
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

/** Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save a full-page picture of the current state for a person to look at. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
  if (process.env.E2E_SCREENSHOTS)
    await page.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
}

const SECTIONS: Array<[string, string]> = [
  ['Account', '/me/settings'],
  ['Public profile', '/me/settings?section=profile'],
  ['Notifications', '/me/settings?section=notifications'],
  ['Plan', '/me/settings?section=plan'],
  ['Appearance', '/me/settings?section=appearance'],
  ['Beta features', '/me/settings?section=beta'],
  ['Danger Zone', '/me/settings?section=danger'],
];

/**
 * The settings navigation: the sticky list of sections on a wide screen, the section selector on a phone. Every section is a link
 * to its address, the current one marked.
 */
async function expectSettingsNav(page: Page, isMobile: boolean, current: string) {
  if (isMobile) {
    const selector = page.getByRole('button', { name: `Settings section: ${current}` });
    await expect(selector).toBeVisible();
    await selector.click();
  }
  const nav = page.getByRole('navigation', { name: isMobile ? 'Settings sections' : 'Settings' });
  for (const [label, href] of SECTIONS)
    await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', href);
  await expect(nav.getByRole('link', { name: current, exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  if (isMobile) await page.keyboard.press('Escape');
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
  test.describe(`${name} · S3 account`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('acct-settings /me/settings · Account: the email, the password and the dirty guard', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/me/settings');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'Account Details' })).toBeVisible();
      await expect(page).toHaveTitle('OpenBinding - Settings');
      await expectSettingsNav(page, isMobile, 'Account');
      await expect(main.getByText('lucia.vega', { exact: true })).toBeVisible();
      await expect(main.getByText('lucia@example.org · member since Mar 2, 2026')).toBeVisible();
      await expect(main.getByText('Role · user')).toBeVisible();
      await expect(main.getByText('Plan · RESEARCH')).toBeVisible();
      await expect(main.getByText('Universidad de Sevilla · verified')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save email' })).toBeDisabled();
      await capture(page, testInfo, `settings-${name}-account`);

      // A new email needs the current password; the profile is re-read afterwards.
      await main.getByLabel('Email address').fill('new@example.org');
      await expect(main.getByText('You have unsaved changes')).toBeVisible();
      await main.getByRole('button', { name: 'Save email' }).click();
      await expect(
        main.getByText('Enter your current password to change your email.')
      ).toBeVisible();
      await main.getByLabel('Current password').first().fill('old-password-123');
      const patched = page.waitForRequest(
        request => request.method() === 'PATCH' && request.url() === `${API}/v1/users/me`
      );
      await main.getByRole('button', { name: 'Save email' }).click();
      expect((await patched).postDataJSON()).toEqual({
        email: 'new@example.org',
        current_password: 'old-password-123',
      });
      await expect(
        main.getByRole('status').filter({ hasText: 'Email updated to new@example.org.' })
      ).toBeVisible();
      await expect(main.getByText('new@example.org · member since Mar 2, 2026')).toBeVisible();

      state.refuse.patch = detail(409, 'already_registered', 'That email is already in use.');
      await main.getByLabel('Email address').fill('taken@example.org');
      await main.getByLabel('Current password').first().fill('old-password-123');
      await main.getByRole('button', { name: 'Save email' }).click();
      await expect(
        main.getByText('That email is already used by another account (409 · already_registered).')
      ).toBeVisible();
      await expect(main.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');

      state.refuse.patch = detail(401, 'invalid_credentials', 'Wrong password.');
      await main.getByLabel('Current password').first().fill('wrong-password');
      await main.getByRole('button', { name: 'Save email' }).click();
      await expect(
        main.getByText('That isn’t your current password (401 · invalid_credentials).').first()
      ).toBeVisible();
      await capture(page, testInfo, `settings-${name}-account-refusals`);

      // Leaving the section with an unsaved email asks first.
      if (!isMobile) {
        await page
          .getByRole('navigation', { name: 'Settings' })
          .getByRole('link', { name: 'Notifications', exact: true })
          .click();
        const unsaved = page.getByRole('dialog', { name: 'Unsaved changes' });
        await expect(unsaved).toBeVisible();
        await unsaved.getByRole('button', { name: 'Stay here' }).click();
        await expect(unsaved).toBeHidden();
        await expect.poll(() => new URL(page.url()).search).toBe('');
      }
      await main.getByLabel('Email address').fill('new@example.org');
      await main.getByLabel('Current password').first().fill('');

      // Password: ten characters, typed twice, and the current one.
      state.refuse.patch = undefined;
      await main.getByLabel('Current password').nth(1).fill('old-password-123');
      await main.getByLabel('New password', { exact: true }).fill('short');
      await expect(main.getByText('5 more characters needed')).toBeVisible();
      await expect(main.getByText('Strength: Too short')).toBeVisible();
      await main.getByLabel('Confirm new password').fill('short');
      await main.getByRole('button', { name: 'Change password' }).click();
      await expect(
        main.getByText('Password must be at least 10 characters long.').first()
      ).toBeVisible();
      await main.getByLabel('New password', { exact: true }).fill('new-secure-password');
      await main.getByLabel('Confirm new password').fill('something-different');
      await main.getByRole('button', { name: 'Change password' }).click();
      await expect(main.getByText('New password and confirm password do not match.')).toBeVisible();
      await main.getByLabel('Confirm new password').fill('new-secure-password');
      const changed = page.waitForRequest(
        request => request.method() === 'PATCH' && request.url() === `${API}/v1/users/me`
      );
      await main.getByRole('button', { name: 'Change password' }).click();
      expect((await changed).postDataJSON()).toEqual({
        current_password: 'old-password-123',
        new_password: 'new-secure-password',
      });
      await expect(main.getByRole('status').filter({ hasText: 'Password changed.' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('acct-settings has no Sign-in & Security section: sign-in is the session, not linked identities', async ({
      page,
    }) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, lucia);
      await page.goto('/me/settings?section=integrations');
      const main = page.locator('main');
      // An unknown section is the Account section.
      await expect(main.getByRole('heading', { level: 2, name: 'Account' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign-in & Security' })).toHaveCount(0);
      await expect(page.getByText(/Universidad de Sevilla · CAS|Link CAS identity/)).toHaveCount(0);
      expect(critical).toEqual([]);
    });

    test('acct-settings in SCORETech Identity mode: the SCORETech account, no local credentials, deletion without a password', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, sofia, {}, 'scoretech');
      await page.goto('/me/settings');
      const main = page.locator('main');
      await expect(
        main.getByRole('heading', { level: 2, name: 'Your SCORETech account' })
      ).toBeVisible();
      await expect(main.getByLabel('Email address')).toHaveCount(0);
      await expect(main.getByLabel('New password')).toHaveCount(0);
      const profile = main.getByRole('link', { name: /Open my SCORETech profile/ });
      await expect(profile).toHaveAttribute('target', '_blank');
      await expect(profile).toHaveAttribute('rel', 'noopener noreferrer');
      const href = new URL((await profile.getAttribute('href')) ?? '');
      expect(href.hash).toBe('#public-profile');
      expect(href.searchParams.get('return_to')).toBe(
        `${new URL(page.url()).origin}/me/settings?section=account`
      );
      await expectSettingsNav(page, isMobile, 'Account');
      await capture(page, testInfo, `settings-${name}-identity-account`);

      await page.goto('/me/settings?section=danger');
      await expect(
        main.getByRole('heading', { level: 3, name: 'Delete OpenBinding account' })
      ).toBeVisible();
      await expect(main.getByText(/Your SCORETech Identity account and your access/)).toBeVisible();
      await main.getByRole('button', { name: 'Delete my account' }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirm deletion' });
      await expect(dialog.getByLabel(/password/i)).toHaveCount(0);
      await dialog.getByLabel('Type sofia.ruiz to confirm').fill('sofia.ruiz');
      await capture(page, testInfo, `settings-${name}-identity-danger-dialog`);
      const deleted = page.waitForRequest(
        request => request.method() === 'DELETE' && request.url() === `${API}/v1/users/me`
      );
      await dialog.getByRole('button', { name: 'Delete account' }).click();
      expect((await deleted).postDataJSON()).toEqual({
        confirmation: 'sofia.ruiz',
        current_password: null,
      });
      await expect(page).toHaveURL(/\/$/);
      expect(critical).toEqual([]);
    });

    test('acct-settings · Public profile: the display name and the avatar, edited in local mode', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/me/settings?section=profile');
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 2, name: 'Public profile' })).toBeVisible();
      await expectSettingsNav(page, isMobile, 'Public profile');
      await main.getByLabel('Display name').fill('Lucía Vega');
      const patched = page.waitForRequest(
        request => request.method() === 'PATCH' && request.url() === `${API}/v1/users/me`
      );
      await main.getByRole('button', { name: 'Save display name' }).click();
      expect((await patched).postDataJSON()).toEqual({ display_name: 'Lucía Vega' });
      expect(state.account.display_name).toBe('Lucía Vega');
      await capture(page, testInfo, `settings-${name}-profile`);

      await main.getByRole('button', { name: 'Change avatar' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit avatar' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Icons' }).click();
      await dialog.getByRole('button', { name: 'Robot' }).click();
      await dialog.getByRole('button', { name: 'Background colour #0d7660' }).click();
      await capture(page, testInfo, `settings-${name}-avatar-editor`);
      const saved = page.waitForRequest(
        request => request.method() === 'PATCH' && request.url() === `${API}/v1/users/me`
      );
      await dialog.getByRole('button', { name: 'Save avatar' }).click();
      expect((await saved).postDataJSON()).toEqual({
        avatar: {
          kind: 'icon',
          assetId: 'avatar-9',
          backgroundColor: '#0d7660',
          foregroundColor: '#ffffff',
        },
      });
      await expect(dialog).toHaveCount(0);
      // The header follows: the session is read again and draws the new avatar.
      if (!isMobile)
        await expect(
          page.getByRole('button', { name: 'Account menu' }).locator('[data-avatar-kind="icon"]')
        ).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('acct-settings · Public profile in SCORETech Identity mode: read-only, edited in Identity', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(
        page,
        {
          ...sofia,
          display_name: 'Sofía Ruiz',
          avatar: {
            kind: 'icon',
            assetId: 'leaf',
            backgroundColor: '#212529',
            foregroundColor: '#ffffff',
          },
        },
        {},
        'scoretech'
      );
      await page.goto('/me/settings?section=profile');
      const main = page.locator('main');
      await expect(main.getByText('Sofía Ruiz')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Change avatar' })).toHaveCount(0);
      await expect(main.getByLabel('Display name')).toHaveCount(0);
      const edit = main.getByRole('link', { name: /Edit in SCORETech Identity/ });
      await expect(edit).toHaveAttribute('target', '_blank');
      expect(new URL((await edit.getAttribute('href')) ?? '').hash).toBe('#public-profile');
      await expect(main.locator('[data-avatar-kind="icon"]')).toBeVisible();
      await capture(page, testInfo, `settings-${name}-identity-profile`);
      expect(critical).toEqual([]);
    });

    test('acct-settings · Notifications: a kind × channel grid saved with its revision', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/me/settings?section=notifications');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
      await expectSettingsNav(page, isMobile, 'Notifications');
      const runsByEmail = main.getByRole('switch', { name: 'Runs finished: Email' });
      await expect(runsByEmail).toHaveAttribute('aria-checked', 'false');
      await expect(main.getByRole('switch')).toHaveCount(12);
      await expect(main.getByRole('switch', { name: 'Adoptions: Email' })).toHaveAttribute(
        'aria-checked',
        'false'
      );
      await expect(main.getByRole('link', { name: 'inbox' })).toHaveAttribute(
        'href',
        '/notifications'
      );
      await capture(page, testInfo, `settings-${name}-notifications`);

      await runsByEmail.click();
      await expect(runsByEmail).toHaveAttribute('aria-checked', 'true');
      const saved = page.waitForRequest(
        request =>
          request.method() === 'PUT' && request.url() === `${API}/v1/notifications/preferences`
      );
      await main.getByRole('button', { name: 'Save preferences' }).click();
      expect((await saved).postDataJSON().kinds.RunFinished).toEqual({ inbox: true, email: true });
      await expect(main.getByText('Preferences updated')).toBeVisible();
      expect(state.preferences.kinds.RunFinished.email).toBe(true);
      expect(critical).toEqual([]);
    });

    test('acct-settings · Plan: the plan, what it allows, your permissions and the native consoles', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, lucia);
      await page.goto('/me/settings?section=plan');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'Plan & permissions' })
      ).toBeVisible();
      await expectSettingsNav(page, isMobile, 'Plan');
      const plan = main.getByRole('region', { name: 'Your plan' });
      await expect(plan.getByText('RESEARCH', { exact: true })).toBeVisible();
      await expect(main.getByRole('link', { name: /Open SPACE console/ })).toHaveAttribute(
        'target',
        '_blank'
      );
      await expect(main.getByRole('link', { name: /Open SPHERE console/ })).toHaveAttribute(
        'rel',
        /noopener/
      );
      await expect(
        main.getByRole('link', { name: 'Your organizations and roles' })
      ).toHaveAttribute('href', '/me/orgs');
      await expect(main.getByRole('link', { name: 'Your API keys' })).toHaveAttribute(
        'href',
        '/me/api-keys'
      );
      await expect(main.getByRole('link', { name: 'Manage keys' })).toHaveAttribute(
        'href',
        '/me/api-keys'
      );
      await expect(main.getByRole('heading', { level: 3, name: 'Features' })).toBeVisible();
      await expect(
        main.getByRole('heading', { level: 3, name: 'What your plan allows' })
      ).toBeVisible();
      // Nothing is metered and nothing is sold here.
      await expect(main.getByRole('meter')).toHaveCount(0);
      await expect(main.getByRole('button', { name: /upgrade|buy|change plan/i })).toHaveCount(0);
      await capture(page, testInfo, `settings-${name}-plan`);
      expect(critical).toEqual([]);
    });

    test('acct-settings · Appearance: SPHERE orange or OpenBinding blue, kept in this browser', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, lucia);
      await page.goto('/me/settings?section=appearance');
      const main = page.locator('main');
      const brand = () => page.evaluate(() => document.documentElement.dataset.brand);

      await expect(main.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible();
      await expectSettingsNav(page, isMobile, 'Appearance');
      await expect(main.getByRole('radio', { name: /SPHERE orange/ })).toBeChecked();
      await expect(main.getByText('VITE_DEFAULT_BRAND')).toBeVisible();
      await capture(page, testInfo, `settings-${name}-appearance-sphere`);

      await main.getByText('OpenBinding blue', { exact: true }).click();
      await expect(main.getByRole('radio', { name: /OpenBinding blue/ })).toBeChecked();
      expect(await brand()).toBe('openbinding');
      await capture(page, testInfo, `settings-${name}-appearance-openbinding`);

      await page.reload();
      await expect(main.getByRole('radio', { name: /OpenBinding blue/ })).toBeChecked();
      expect(await brand()).toBe('openbinding');

      await main.getByRole('button', { name: 'Use the default' }).click();
      await expect(main.getByRole('radio', { name: /SPHERE orange/ })).toBeChecked();
      expect(await brand()).toBe('sphere');
      expect(critical).toEqual([]);
    });

    test('acct-settings · Beta features and the Danger Zone', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/me/settings?section=beta');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 2, name: /Beta features/ })).toBeVisible();
      const beta = main.getByRole('switch', { name: 'Enable beta features' });
      await expect(beta).toHaveAttribute('aria-checked', 'false');
      await expect(beta).toBeEnabled();
      await beta.click();
      await expect(beta).toHaveAttribute('aria-checked', 'true');
      expect(state.beta).toBe(true);
      await capture(page, testInfo, `settings-${name}-beta`);

      await page.goto('/me/settings?section=danger');
      await expect(main.getByRole('heading', { level: 2, name: 'Danger Zone' })).toBeVisible();
      await main.getByRole('button', { name: 'Delete my account' }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirm deletion' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Delete account' })).toBeDisabled();
      await expect(dialog.getByRole('note', { name: 'Your personal organization' })).toContainText(
        '2 compositions (1 public), 1 problem, 4 runs and 0 environments with a feed'
      );
      await dialog.getByLabel('Type lucia.vega to confirm').fill('lucia.vega');
      await expect(dialog.getByRole('button', { name: 'Delete account' })).toBeEnabled();
      await capture(page, testInfo, `settings-${name}-danger-dialog`);

      state.refuse.delete = detail(
        409,
        'last_owner',
        'Transfer or delete every organization for which this is the last owner.'
      );
      await dialog.getByRole('button', { name: 'Delete account' }).click();
      await expect(dialog.getByRole('alert')).toContainText('Hand the organization over');
      await expect(dialog.getByRole('link', { name: 'Your organizations' })).toHaveAttribute(
        'href',
        '/me/orgs'
      );
      state.refuse.delete = undefined;
      const deleted = page.waitForRequest(
        request => request.method() === 'DELETE' && request.url() === `${API}/v1/users/me`
      );
      await dialog.getByRole('button', { name: 'Delete account' }).click();
      expect((await deleted).postDataJSON()).toEqual({
        confirmation: 'lucia.vega',
        current_password: null,
      });
      await expect(page).toHaveURL(/\/$/);
      expect(critical).toEqual([]);
    });

    test('acct-api-keys in SCORETech Identity mode: when the keys stop, and suspended keys', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const state = await mockApi(
        page,
        { ...sofia, api_keys_suspended_at: inAMonth } as Account,
        { usage: json(freeUsage()) },
        'scoretech'
      );
      await page.goto('/me/api-keys');
      const main = page.locator('main');
      await expect(main.getByRole('status').filter({ hasText: 'stop working on' })).toContainText(
        'unless you sign in again'
      );
      await capture(page, testInfo, `api-keys-${name}-orphan-notice`);

      state.account = { ...state.account, api_keys_suspended_at: hoursAgo(2) } as Account;
      await page.reload();
      await expect(
        main.getByRole('alert').filter({ hasText: 'Your API keys are suspended' })
      ).toContainText('until you sign in with SCORETech Identity');
      await expect(main.getByRole('article', { name: 'ci-lectura-resultados' })).toBeVisible();
      await capture(page, testInfo, `api-keys-${name}-suspended`);
      expect(critical).toEqual([]);
    });

    test('acct-api-keys /me/api-keys: the list, a new key shown once, rotate and revoke', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, marco, { usage: json(freeUsage()) });
      await page.goto('/me/api-keys');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
      await expect(page).toHaveTitle('OpenBinding - API keys');
      const card = main.getByRole('article', { name: 'ci-lectura-resultados' });
      await expect(card.getByText('obk_demo0001…')).toBeVisible();
      await expect(card.getByText('GET only')).toBeVisible();
      await expect(card.getByText('org isa-demo')).toBeVisible();
      await expect(
        main
          .getByRole('article', { name: 'ejecucion-engine-fijo' })
          .getByText('Only bim.builtin/random-search@1.0.0')
      ).toBeVisible();
      await expect(main.getByText('2 of 2 keys')).toBeVisible();
      await expect(main.getByText(/You’ve reached your plan’s API key limit/)).toBeVisible();
      await capture(page, testInfo, `keys-${name}-list`);

      // Rotating shows the new secret once.
      await card.getByRole('button', { name: 'Rotate ci-lectura-resultados' }).click();
      const rotate = page.getByRole('dialog', { name: /Rotate “ci-lectura-resultados”/ });
      await rotate.getByRole('button', { name: 'Rotate key' }).click();
      await expect(main.getByText('obk_demo0001_NUEVO-SECRETO-DE-PRUEBA')).toBeVisible();
      await expect(main.getByText(/The previous secret has stopped working/)).toBeVisible();
      await main.getByRole('button', { name: 'Dismiss' }).first().click();
      await expect(main.getByText('obk_demo0001_NUEVO-SECRETO-DE-PRUEBA')).toBeHidden();

      // Revoking asks first.
      await card.getByRole('button', { name: 'Revoke ci-lectura-resultados' }).click();
      const revoke = page.getByRole('dialog', { name: /Revoke “ci-lectura-resultados”/ });
      await revoke.getByRole('button', { name: 'Revoke key' }).click();
      await expect(main.getByText('“ci-lectura-resultados” was revoked.')).toBeVisible();
      await expect(card).toHaveCount(0);
      expect(state.keys.map(key => key.id)).toEqual(['k2']);

      // A new key: the dialog lives at ?create=key.
      await main.getByRole('link', { name: 'Create new API key' }).click();
      await expect(page).toHaveURL(/\/me\/api-keys\?create=key$/);
      const dialog = page.getByRole('dialog', { name: 'Create new API key' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Name').fill('nightly-results');
      await dialog.getByRole('checkbox', { name: /^jobs:read/ }).check();
      await expect(dialog.getByRole('checkbox', { name: /^admin:accounts:read/ })).toBeDisabled();
      await dialog.getByRole('radio', { name: 'Only these engines' }).check();
      await dialog.getByRole('button', { name: 'Create key' }).click();
      await expect(dialog.getByRole('alert')).toContainText(
        '422 · The permissions you chose need all engines'
      );
      await dialog.getByRole('checkbox', { name: 'bim.builtin/random-search@1.0.0' }).check();
      await dialog.getByRole('combobox', { name: 'Search organizations' }).fill('isa');
      await dialog.getByRole('option', { name: /ISA Demo Group/ }).click();
      await dialog.getByRole('radio', { name: 'View only' }).click();
      await capture(page, testInfo, `keys-${name}-create`);
      const created = page.waitForRequest(
        request => request.method() === 'POST' && request.url() === `${API}/v1/users/me/api-keys`
      );
      await dialog.getByRole('button', { name: 'Create key' }).click();
      const sent = (await created).postDataJSON();
      expect(sent).toMatchObject({
        name: 'nightly-results',
        permissions: ['jobs:read'],
        engine_access: { all: false, engines: [engineRef] },
        boundary: { methods: ['GET'], organizations: ['isa-demo'] },
      });
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(/\/me\/api-keys$/);
      await expect(main.getByText('obk_demo0003_SECRETO-UNICO-DE-PRUEBA')).toBeVisible();
      await expect(main.getByText(/You won’t be able to see it again/)).toBeVisible();
      await expect(main.getByRole('article', { name: 'nightly-results' })).toBeVisible();
      await capture(page, testInfo, `keys-${name}-secret`);

      // The gateway can still refuse.
      state.refuse.create = detail(402, 'quota_exceeded', 'API key limit reached.');
      await page.goto('/me/api-keys?create=key');
      await dialog.getByLabel('Name').fill('one-too-many');
      await dialog.getByRole('checkbox', { name: /^problems:read/ }).check();
      await dialog.getByRole('button', { name: 'Create key' }).click();
      await expect(dialog.getByRole('alert')).toContainText(
        '402 · You’ve reached your plan’s API key limit'
      );
      expect(critical).toEqual([]);
    });

    test('acct-api-keys: an administrator can grant the admin-only permissions', async ({
      page,
    }) => {
      await mockApi(page, iker);
      await page.goto('/me/api-keys?create=key');
      const dialog = page.getByRole('dialog', { name: 'Create new API key' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: /^admin:accounts:read/ })).toBeEnabled();
      await expect(dialog.getByRole('checkbox', { name: /^engines:moderate/ })).toBeEnabled();
    });
  });
}
