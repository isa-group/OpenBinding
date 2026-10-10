import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';

// S3 · pricing and account: acct-profile, acct-usage, acct-keys, acct-key-new, acct-identities, acct-notifications.
// (pub-pricing has its own file, pricing.spec.ts.) There is no backend: the API origin is answered by page.route().
// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: each walks the states of its screen in order, on one page.

const API = 'http://localhost:8000';

// Eight browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);
const noContent: Handler = (route) => route.fulfill({ status: 204 });

/** A pricing token shaped like the gateway's: three dot-separated parts, the middle one a JSON payload. */
const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const lucia = {
  id: 'user-1', username: 'lucia.vega', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z', cas_verified: true, institutional_branding: true,
};
const marco = { ...lucia, username: 'marco.diaz', email: 'marco@example.org', plan: 'BASIC', cas_verified: false, institutional_branding: false };
const iker = { ...marco, username: 'iker.mora', email: 'iker@example.org', role: 'admin', plan: 'PRO' };
type Account = typeof lucia;

const RENEWS = '2026-11-01T00:00:00Z';
const tracked = (id: string, limit: number, used: number, unit: string, renews: string | null = null) =>
  ({ limit_id: id, limit, used, remaining: Math.max(0, limit - used), unit, renews_at: renews });

/** What the gateway reports for the RESEARCH plan of the pricing 0.1.0, with some of it used. */
const researchUsage = () => ({
  plan: 'RESEARCH',
  contract_pending: false,
  features: { authoring: true, solve: true, federatedEngines: true, apiAccess: true, collaboration: true, studies: true, advancedAnalytics: true, reproducibleExport: true, publishing: true, reproducibilityArchive: false, institutionalBranding: true },
  capabilities: {
    capacityUnits: 1_000_000, taskStarts: 50, solverSeconds: 30_000, federatedTaskStarts: 100, concurrentJobs: 3, federatedEngines: 5, apiKeys: 25,
    maxTimeoutSeconds: 900, maxIterations: 1_000_000, maxPayloadBytes: 134_217_728, maxInstanceComplexityLog10: 20, jobHistoryDays: 180, studyRuns: 100,
    organizations: 5, members: 15, projects: 50, privateProjects: 30, collections: 50, studies: 25, storageBytes: 5_368_709_120,
  },
  limits: {
    capacityUnits: tracked('capacityUnits', 1_000_000, 120_000, 'capacity-unit/month', RENEWS),
    taskStarts: tracked('taskStarts', 50, 18, 'solve/month', RENEWS),
    solverSeconds: tracked('solverSeconds', 30_000, 7_420, 'second/month', RENEWS),
    federatedTaskStarts: tracked('federatedTaskStarts', 100, 3, 'solve/month', RENEWS),
    studyRuns: tracked('studyRuns', 100, 4, 'run/month', RENEWS),
    concurrentJobs: tracked('concurrentJobs', 3, 1, 'job'),
    federatedEngines: tracked('federatedEngines', 5, 1, 'engine'),
    apiKeys: tracked('apiKeys', 25, 2, 'key'),
    maxTimeoutSeconds: tracked('maxTimeoutSeconds', 900, 0, 'second'),
    maxIterations: tracked('maxIterations', 1_000_000, 0, 'iteration'),
    maxPayloadBytes: tracked('maxPayloadBytes', 134_217_728, 0, 'byte'),
    maxInstanceComplexityLog10: tracked('maxInstanceComplexityLog10', 20, 0, 'log10 combinations'),
    jobHistoryDays: tracked('jobHistoryDays', 180, 0, 'day'),
    organizations: tracked('organizations', 5, 2, 'organization'),
    members: tracked('members', 15, 3, 'member'),
    projects: tracked('projects', 50, 3, 'project'),
    privateProjects: tracked('privateProjects', 30, 2, 'project'),
    collections: tracked('collections', 50, 1, 'collection'),
    studies: tracked('studies', 25, 1, 'study'),
    storageBytes: tracked('storageBytes', 5_368_709_120, 52_428_800, 'byte'),
  },
});

/** BASIC with the monthly solves and study runs used up and the only API key in use. */
const spentUsage = () => ({
  plan: 'BASIC',
  contract_pending: false,
  features: { authoring: true, solve: true, advancedAnalytics: false, institutionalBranding: false },
  capabilities: { capacityUnits: 5000, taskStarts: 10, solverSeconds: 900, studyRuns: 3, concurrentJobs: 1, apiKeys: 1, maxTimeoutSeconds: 60, maxPayloadBytes: 8_388_608, maxInstanceComplexityLog10: 9, jobHistoryDays: 7 },
  limits: {
    taskStarts: tracked('taskStarts', 10, 10, 'solve/month', RENEWS),
    solverSeconds: tracked('solverSeconds', 900, 610, 'second/month', RENEWS),
    studyRuns: tracked('studyRuns', 3, 3, 'run/month', RENEWS),
    concurrentJobs: tracked('concurrentJobs', 1, 1, 'job'),
    apiKeys: tracked('apiKeys', 1, 1, 'key'),
    maxTimeoutSeconds: tracked('maxTimeoutSeconds', 60, 0, 'second'),
    maxPayloadBytes: tracked('maxPayloadBytes', 8_388_608, 0, 'byte'),
    maxInstanceComplexityLog10: tracked('maxInstanceComplexityLog10', 9, 0, 'log10 combinations'),
    jobHistoryDays: tracked('jobHistoryDays', 7, 0, 'day'),
  },
});

const DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;
const engineRef = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: DIGEST };
const engine = { ...engineRef, id: 'bim.builtin/random-search', ref: engineRef, modes: [] };

const reader = {
  id: 'k1', name: 'ci-lectura-resultados', prefix: 'obk_demo0001', created_at: '2026-09-01T00:00:00Z', last_used_at: '2026-10-08T00:00:00Z',
  expires_at: '2099-12-31T00:00:00Z', permissions: ['jobs:read', 'projects:read', 'reports:read', 'studies:read'], engine_access: { all: true, engines: [] },
  boundary: { methods: ['GET'], organizations: ['isa-demo'], projects: ['qos-benchmarks'], resource_kinds: ['jobs', 'studies', 'reports'], slugs: null },
};
const runner = {
  id: 'k2', name: 'ejecucion-engine-fijo', prefix: 'obk_demo0002', created_at: '2026-09-10T00:00:00Z', last_used_at: null, expires_at: null,
  permissions: ['engines:execute', 'engines:read', 'instances:validate', 'jobs:read'], engine_access: { all: false, engines: [engineRef] }, boundary: {},
};
type ApiKey = typeof reader | typeof runner;

const notifications = () => [
  {
    id: 'n1', kind: 'contract.changed', subject: 'Your OpenBinding agreement changed', body: 'Plan: BASIC → RESEARCH. Add-ons: {} → {}. Reason: institutional_agreement.',
    payload: { reason: 'institutional_agreement', previous: { plan: 'BASIC', addOns: {} }, current: { plan: 'RESEARCH', addOns: {} }, pricingVersion: '0.1.0' },
    read_at: null, created_at: hoursAgo(5),
  },
  { id: 'n2', kind: 'job.finished', subject: 'Job completed', body: 'Job 0000…f1 finished with FEASIBLE.', payload: {}, read_at: hoursAgo(20), created_at: hoursAgo(26) },
  { id: 'n3', kind: 'organization.invitation', subject: 'You were invited to ISA Demo Group', body: 'Pablo invited you as MEMBER.', payload: {}, read_at: null, created_at: hoursAgo(2) },
];

/** A request that the account become the billing sponsor of an organization (`SponsorProposalView`): nothing changes until the account accepts. */
const sponsorRequest = (id: string, organization: string, slug: string, by: string) => ({
  id, organization_id: `org-${slug}`, organization_slug: slug, organization_name: organization,
  proposed_user_id: 'user-1', proposed_username: 'lucia.vega', proposed_by_user_id: `user-${by}`, proposed_by_username: by,
  status: 'pending' as 'pending' | 'accepted' | 'declined', created_at: '2026-10-08T09:00:00Z', expires_at: '2026-10-22T09:00:00Z',
  decided_at: null as string | null, decided_by_user_id: null as string | null, decision_reason: null as string | null,
});

interface State {
  account: Account;
  pricingToken: Handler;
  usage: Handler;
  keys: ApiKey[];
  identities: Array<{ id: string; provider: string; subject: string; verifiedAt: string }>;
  notifications: ReturnType<typeof notifications>;
  preferences: { inbox: boolean; email_contract_changes: boolean; email_invitations: boolean; email_job_failures: boolean };
  /** The requests addressed to the account. */
  sponsorRequests: Array<ReturnType<typeof sponsorRequest>>;
  /** How each request was answered. */
  answered: Array<{ id: string; answer: string }>;
  /** A refusal for one action; unset means the action succeeds. */
  refuse: Partial<Record<'patch' | 'delete' | 'list' | 'create' | 'revoke' | 'rotate' | 'link' | 'unlink' | 'notifications' | 'preferences' | 'savePreferences' | 'accept', Handler>>;
}

const methodOf = (route: Route) => route.request().method();

async function mockApi(page: Page, account: Account, overrides: Partial<State> = {}): Promise<State> {
  const state: State = {
    account,
    pricingToken: json({ pricing_token: token(3600) }),
    usage: json(researchUsage()),
    keys: [reader, runner],
    identities: account.cas_verified ? [{ id: 'i1', provider: 'us-cas', subject: 'lvega1', verifiedAt: '2026-09-01T00:00:00Z' }] : [],
    notifications: notifications(),
    preferences: { inbox: true, email_contract_changes: true, email_invitations: true, email_job_failures: false },
    sponsorRequests: [],
    answered: [],
    refuse: {},
    ...overrides,
  };
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's3-access');
    localStorage.setItem('openbinding-refresh-token', 's3-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  // A 401 that is not an expired session (a wrong password) makes the client renew the session once before it reports it.
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's3-access-2', refresh_token: 's3-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/auth/logout`, noContent);
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/engines`, json({ engines: [engine] }));
  await page.route(`${API}/v1/organizations`, json([{
    id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, billing_sponsor_user_id: 'user-1', effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z',
  }]));
  await page.route(`${API}/v1/organizations/isa-demo/projects`, json([{
    id: 'project-1', organization_id: 'org-1', slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: '', visibility: 'private',
    created_by_id: 'user-1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', access: 'member', effective_role: 'OWNER',
  }]));
  // The CAS round trip leaves the application; stand in for the university's side of it.
  await page.route('**/api/v1/auth/cas/start**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>CAS (simulated)</h1>' }));

  await page.route(`${API}/v1/users/me`, async (route) => {
    const method = methodOf(route);
    if (method === 'PATCH') {
      if (state.refuse.patch) return state.refuse.patch(route);
      const body = route.request().postDataJSON() as { email?: string };
      if (body.email) state.account = { ...state.account, email: body.email };
      return json(state.account)(route);
    }
    if (method === 'DELETE') return (state.refuse.delete ?? noContent)(route);
    return json(state.account)(route);
  });
  await page.route(`${API}/v1/users/me/pricing-token`, (route) => state.pricingToken(route));
  await page.route(`${API}/v1/users/me/usage`, (route) => state.usage(route));

  await page.route(`${API}/v1/users/me/api-keys`, async (route) => {
    if (methodOf(route) === 'POST') {
      if (state.refuse.create) return state.refuse.create(route);
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      const summary = {
        id: 'k3', prefix: 'obk_demo0003', created_at: new Date().toISOString(), last_used_at: null, expires_at: null, boundary: {}, ...payload,
      };
      // The list never carries the secret; only this answer does.
      state.keys = [...state.keys, summary as unknown as ApiKey];
      return json({ ...summary, secret: 'obk_demo0003_SECRETO-UNICO-DE-PRUEBA' }, 201)(route);
    }
    if (state.refuse.list) return state.refuse.list(route);
    return json({ api_keys: state.keys })(route);
  });
  await page.route(new RegExp(`^${API}/v1/users/me/api-keys/([^/]+)/rotate$`), async (route) => {
    if (state.refuse.rotate) return state.refuse.rotate(route);
    const id = /api-keys\/([^/]+)\/rotate/.exec(route.request().url())?.[1];
    const key = state.keys.find((item) => item.id === id) ?? reader;
    return json({ ...key, secret: 'obk_demo0001_NUEVO-SECRETO-DE-PRUEBA' })(route);
  });
  await page.route(new RegExp(`^${API}/v1/users/me/api-keys/([^/]+)$`), async (route) => {
    if (state.refuse.revoke) return state.refuse.revoke(route);
    const id = /api-keys\/([^/]+)$/.exec(route.request().url())?.[1];
    state.keys = state.keys.filter((item) => item.id !== id);
    return noContent(route);
  });

  // The requests to sponsor an organization that wait for this account, and the two ways of answering one.
  await page.route(new RegExp(`^${API}/v1/users/me/sponsor-proposals(\\?.*)?$`), (route) => {
    const wanted = new URL(route.request().url()).searchParams.get('status');
    return json(state.sponsorRequests.filter((item) => !wanted || item.status === wanted))(route);
  });
  await page.route(new RegExp(`^${API}/v1/sponsor-proposals/([^/]+)/(accept|decline)$`), async (route) => {
    const [, id, answer] = /sponsor-proposals\/([^/]+)\/(accept|decline)/.exec(route.request().url()) ?? [];
    if (answer === 'accept' && state.refuse.accept) return state.refuse.accept(route);
    state.answered.push({ id, answer });
    state.sponsorRequests = state.sponsorRequests.map((item) => (item.id === id ? { ...item, status: answer === 'accept' ? 'accepted' as const : 'declined' as const } : item));
    return json(state.sponsorRequests.find((item) => item.id === id))(route);
  });
  await page.route(`${API}/v1/users/me/identities`, (route) => json(state.identities)(route));
  await page.route(new RegExp(`^${API}/v1/users/me/identities/([^/?]+)`), async (route) => {
    if (state.refuse.unlink) return state.refuse.unlink(route);
    state.identities = [];
    // Unlinking a RESEARCH account moves the plan back to the default one, and with it the institutional mark.
    state.account = { ...state.account, plan: 'BASIC', cas_verified: false, institutional_branding: false };
    return noContent(route);
  });
  await page.route(`${API}/v1/auth/cas/link-intent`, async (route) => {
    if (state.refuse.link) return state.refuse.link(route);
    return json({ url: '/api/v1/auth/cas/start?mode=link&intent=s3' })(route);
  });

  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), async (route) => {
    if (state.refuse.notifications) return state.refuse.notifications(route);
    return json(state.notifications)(route);
  });
  await page.route(`${API}/v1/notifications/read-all`, async (route) => {
    const stamp = new Date().toISOString();
    state.notifications = state.notifications.map((item) => ({ ...item, read_at: item.read_at ?? stamp }));
    return json(state.notifications)(route);
  });
  await page.route(new RegExp(`^${API}/v1/notifications/([^/]+)/read$`), async (route) => {
    const id = /notifications\/([^/]+)\/read/.exec(route.request().url())?.[1];
    state.notifications = state.notifications.map((item) => (item.id === id ? { ...item, read_at: new Date().toISOString() } : item));
    return json(state.notifications.find((item) => item.id === id))(route);
  });
  await page.route(`${API}/v1/notifications/preferences`, async (route) => {
    if (methodOf(route) === 'PUT') {
      if (state.refuse.savePreferences) return state.refuse.savePreferences(route);
      state.preferences = route.request().postDataJSON() as State['preferences'];
      return json(state.preferences)(route);
    }
    if (state.refuse.preferences) return state.refuse.preferences(route);
    return json(state.preferences)(route);
  });
  return state;
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

/** Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save a full-page picture of the current state for a person to look at. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
}

/** The account side navigation: five destinations, the current one marked. */
async function expectAccountNav(main: Locator, current: string) {
  const nav = main.getByRole('navigation', { name: 'Account' });
  const destinations: Array<[string, string]> = [
    ['Profile & security', '/app/account'], ['Usage & plan', '/app/account/usage'], ['API keys', '/app/account/keys'],
    ['Identities', '/app/account/identities'], ['Notifications', '/app/account/notifications'],
  ];
  for (const [label, href] of destinations) await expect(nav.getByRole('link', { name: label })).toHaveAttribute('href', href);
  await expect(nav.getByRole('link', { name: current })).toHaveAttribute('aria-current', 'page');
}

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(90_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S3 account`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('acct-profile /app/account', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/app/account');
      const main = page.locator('#platform-main');

      await expect(page.locator('header.app-header')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
      await expectAccountNav(main, 'Profile & security');
      await expect(main.getByText('lucia.vega', { exact: true })).toBeVisible();
      await expect(main.getByText('lucia@example.org · member since Mar 2, 2026')).toBeVisible();
      await expect(main.getByText('Role · user')).toBeVisible();
      await expect(main.getByText('Plan · RESEARCH')).toBeVisible();
      await expect(main.getByText('Universidad de Sevilla · verified')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save changes' })).toBeDisabled();
      await capture(page, testInfo, `profile-${name}-success`);
      if (isMobile) {
        // The phone gets the layout of the screen and of its dialog; the states are the ones the desktop walks through.
        await main.getByRole('button', { name: 'Delete my account' }).click();
        await expect(page.getByRole('dialog', { name: 'Confirm deletion' })).toBeVisible();
        await capture(page, testInfo, `profile-${name}-delete-dialog`);
        expect(critical).toEqual([]);
        return;
      }

      // A new email needs the current password; the profile is re-read afterwards.
      await main.getByLabel('Email address').fill('new@example.org');
      await main.getByLabel('Current password').first().fill('old-password-123');
      await expect(main.getByText('You have unsaved changes')).toBeVisible();
      const patched = page.waitForRequest((request) => request.method() === 'PATCH' && request.url() === `${API}/v1/users/me`);
      await main.getByRole('button', { name: 'Save changes' }).click();
      expect((await patched).postDataJSON()).toEqual({ email: 'new@example.org', current_password: 'old-password-123' });
      await expect(main.getByRole('status').filter({ hasText: 'Email updated to new@example.org.' })).toBeVisible();
      await expect(main.getByText('new@example.org · member since Mar 2, 2026')).toBeVisible();
      state.refuse.patch = detail(409, 'already_registered', 'That email is already in use.');
      await main.getByLabel('Email address').fill('taken@example.org');
      await main.getByLabel('Current password').first().fill('old-password-123');
      await main.getByRole('button', { name: 'Save changes' }).click();
      await expect(main.getByText('That email is already used by another account (409 · already_registered).')).toBeVisible();
      await expect(main.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
      await capture(page, testInfo, `profile-${name}-409`);

      state.refuse.patch = detail(401, 'invalid_credentials', 'The current password is required to change these details.');
      await main.getByLabel('Current password').first().fill('wrong-password');
      await main.getByRole('button', { name: 'Save changes' }).click();
      await expect(main.getByText('That isn’t your current password (401 · invalid_credentials).').first()).toBeVisible();
      // Password: ten characters, typed twice, and the current one.
      state.refuse.patch = undefined;
      const current = main.getByLabel('Current password').nth(1);
      await current.fill('old-password-123');
      await main.getByLabel('New password', { exact: true }).fill('short');
      await expect(main.getByText('5 more characters needed')).toBeVisible();
      await main.getByLabel('Confirm new password').fill('short');
      await main.getByRole('button', { name: 'Change password' }).click();
      await expect(main.getByText('Password must be at least 10 characters long.').first()).toBeVisible();
      await main.getByLabel('New password', { exact: true }).fill('new-secure-password');
      await main.getByLabel('Confirm new password').fill('something-different');
      await main.getByRole('button', { name: 'Change password' }).click();
      await expect(main.getByText('New password and confirm password do not match.')).toBeVisible();
      await main.getByLabel('Confirm new password').fill('new-secure-password');
      const changed = page.waitForRequest((request) => request.method() === 'PATCH' && request.url() === `${API}/v1/users/me`);
      await main.getByRole('button', { name: 'Change password' }).click();
      expect((await changed).postDataJSON()).toEqual({ current_password: 'old-password-123', new_password: 'new-secure-password' });
      await expect(main.getByRole('status').filter({ hasText: 'Password changed.' })).toBeVisible();

      // Deleting the account asks for the username, and the gateway can still refuse.
      await main.getByRole('button', { name: 'Delete my account' }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirm deletion' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Delete account' })).toBeDisabled();
      await dialog.getByLabel('Type lucia.vega to confirm').fill('lucia.vega');
      await expect(dialog.getByRole('button', { name: 'Delete account' })).toBeEnabled();

      state.refuse.delete = detail(409, 'last_owner', 'Transfer or delete every organization for which this is the last owner.');
      await dialog.getByRole('button', { name: 'Delete account' }).click();
      await expect(dialog.getByRole('alert')).toContainText('409 · last_owner');
      await capture(page, testInfo, `profile-${name}-delete-409-owner`);
      state.refuse.delete = detail(409, 'last_pricing_admin', 'Cannot delete the last administrator who authored pricing releases.');
      await dialog.getByRole('button', { name: 'Delete account' }).click();
      await expect(dialog.getByRole('alert')).toContainText('409 · last_pricing_admin');
      // Cancelling leaves everything as it was; deleting for real leaves the application.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      state.refuse.delete = undefined;
      await main.getByRole('button', { name: 'Delete my account' }).click();
      await dialog.getByLabel('Type lucia.vega to confirm').fill('lucia.vega');
      const deleted = page.waitForRequest((request) => request.method() === 'DELETE' && request.url() === `${API}/v1/users/me`);
      await dialog.getByRole('button', { name: 'Delete account' }).click();
      expect((await deleted).postDataJSON()).toEqual({ confirmation: 'lucia.vega', current_password: null });
      await expect(page).toHaveURL(/\/$/);
      expect(critical).toEqual([]);
    });

    test('acct-profile: logging out, a pending contract and a refused read', async ({ page }, testInfo) => {
      const state = await mockApi(page, marco, { usage: json({ ...spentUsage(), contract_pending: true }) });
      await page.goto('/app/account');
      const main = page.locator('#platform-main');

      await expect(main.getByText('Contract pending')).toBeVisible();
      await expect(main.getByText('Universidad de Sevilla · verified')).toHaveCount(0);
      await capture(page, testInfo, `profile-${name}-pending`);

      state.usage = detail(403, 'forbidden', 'The API key lacks account:read.');
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('account:read');
      await capture(page, testInfo, `profile-${name}-403`);
      if (isMobile) return;

      const loggedOut = page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${API}/v1/auth/logout`);
      await main.getByRole('button', { name: 'Log out' }).click();
      expect((await loggedOut).postDataJSON()).toEqual({ refresh_token: 's3-refresh' });
      await expect(page).toHaveURL(/\/login$/);
    });

    test('acct-usage /app/account/usage', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/app/account/usage');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Usage & plan' })).toBeVisible();
      await expectAccountNav(main, 'Usage & plan');
      const plan = main.getByRole('region', { name: 'Your plan' });
      await expect(plan.getByText('RESEARCH', { exact: true })).toBeVisible();
      await expect(plan.getByText('Free with verified CAS')).toBeVisible();
      await expect(plan.getByText(/Live pricing 0\.1\.0 · Monthly allowances renew Nov 1, 2026/)).toBeVisible();
      await expect(plan.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/pricing');

      await expect(main.getByRole('meter', { name: 'Solves', exact: true })).toHaveAttribute('aria-valuenow', '18');
      await expect(main.getByRole('meter', { name: 'Solves', exact: true })).toHaveAttribute('aria-valuemax', '50');
      await expect(main.getByText(/Renews Nov 1, 2026 \(in \d+ days\)\./)).toBeVisible();
      await expect(main.getByRole('meter', { name: 'Solver time' })).toHaveAttribute('aria-valuenow', '7420');
      const capacity = main.getByRole('heading', { name: 'Capacity in use' }).locator('xpath=ancestor::section[1]');
      await expect(capacity.getByText('2 / 25')).toBeVisible();
      await expect(capacity.getByRole('link', { name: 'Manage keys' })).toHaveAttribute('href', '/app/account/keys');
      const ceilings = main.getByRole('region', { name: 'Ceilings table' });
      await expect(ceilings.getByRole('row', { name: /Max time per job/ })).toContainText('15 min');
      await expect(ceilings.getByRole('row', { name: /Max time per job/ })).toContainText('900 s');
      await expect(ceilings.getByRole('row', { name: /Max problem size/ })).toContainText('10²⁰');
      await expect(main.getByRole('link', { name: 'Open job history' })).toHaveAttribute('href', '/app/jobs');
      await expect(main.getByRole('heading', { name: 'Organizations you sponsor' })).toBeVisible();
      await expect(main.getByText('From your usage')).toBeVisible();
      await expect(main.getByText('Authoring', { exact: true }).locator('..')).toContainText('Enabled');
      await expect(main.getByText('Reproducibility archive', { exact: true }).locator('..')).toContainText('Not in plan');
      await capture(page, testInfo, `usage-${name}-research`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The token is internal: an expired one is explained in plain words, a missing one too, and neither is shown.
      const expired = token(-60);
      state.pricingToken = json({ pricing_token: expired });
      await page.reload();
      await expect(main.getByText('Plan check expired · can’t confirm')).toBeVisible();
      await expect(main.getByText(/Your plan check has expired, so features can’t be confirmed/)).toBeVisible();
      await expect(main.getByText('Authoring', { exact: true }).locator('..')).toContainText('Can’t confirm');
      expect(await page.content()).not.toContain(expired);
      await capture(page, testInfo, `usage-${name}-token-stale`);

      state.pricingToken = detail(503, 'pricing_unavailable', 'A pricing token cannot be issued right now.');
      await page.reload();
      await expect(main.getByText('Can’t confirm features')).toBeVisible();
      await expect(main.getByText(/No plan check is available yet/)).toBeVisible();
      // The allowances change without leaving the page: Refresh usage asks the gateway again.
      const refresh = () => main.getByRole('button', { name: 'Refresh usage' }).click();
      state.usage = json({ ...researchUsage(), contract_pending: true });
      await refresh();
      await expect(main.getByText('Your contract is pending.')).toBeVisible();
      await expect(main.getByRole('heading', { name: 'This month' })).toHaveCount(0);
      state.usage = json(spentUsage());
      await refresh();
      await expect(main.getByText('Used up. New solves can’t start until it renews; a request now gets a 402.')).toBeVisible();
      await expect(main.getByText('0 left', { exact: true })).toHaveCount(2);
      await capture(page, testInfo, `usage-${name}-spent`);

      state.usage = json({ ...spentUsage(), capabilities: {}, limits: {} });
      await refresh();
      await expect(main.getByText('Your plan declares no usage limits, so there’s nothing to track here.')).toBeVisible();
      state.usage = detail(503, 'pricing_unavailable', 'Quotas cannot be read right now.');
      await refresh();
      await expect(main.getByRole('alert')).toContainText('We can’t read your usage right now (503 · pricing_unavailable).');
      await expect(main.getByRole('heading', { name: 'This month' })).toHaveCount(0);
      await capture(page, testInfo, `usage-${name}-503`);
      state.usage = json(researchUsage());
      await main.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByRole('heading', { name: 'This month' })).toBeVisible();

      state.usage = detail(403, 'forbidden', 'The API key lacks account:read.');
      await main.getByRole('button', { name: 'Refresh usage' }).click();
      await expect(main.getByRole('alert')).toContainText('account:read');
      expect(critical).toEqual([]);
    });

    test('acct-keys /app/account/keys', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/app/account/keys');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
      await expectAccountNav(main, 'API keys');
      await expect(main.getByRole('link', { name: 'New key' })).toHaveAttribute('href', '/app/account/keys/new');
      await expect(main.getByText('2 of 25 keys')).toBeVisible();
      const first = main.getByRole('article', { name: 'ci-lectura-resultados' });
      await expect(first.getByText('obk_demo0001…')).toBeVisible();
      await expect(first.getByText('created Sep 1, 2026')).toBeVisible();
      await expect(first.getByText('last used Oct 8, 2026')).toBeVisible();
      await expect(first.getByText('expires Dec 31, 2099')).toBeVisible();
      for (const label of ['GET only', 'org isa-demo', 'project qos-benchmarks', 'jobs, studies, reports']) await expect(first.getByText(label, { exact: true })).toBeVisible();
      await expect(first.getByText('All engines, including future ones')).toBeVisible();
      const second = main.getByRole('article', { name: 'ejecucion-engine-fijo' });
      await expect(second.getByText('Only bim.builtin/random-search@1.0.0 (sha256-b2c3…d4e5)')).toBeVisible();
      await expect(second.getByText('No extra limits')).toBeVisible();
      await expect(main.getByText(/The secret is shown only once/)).toBeVisible();
      await capture(page, testInfo, `keys-${name}-list`);
      if (isMobile) {
        await first.getByRole('button', { name: 'Rotate ci-lectura-resultados' }).click();
        await page.getByRole('dialog', { name: 'Rotate “ci-lectura-resultados”?' }).getByRole('button', { name: 'Rotate key' }).click();
        await expect(page.getByRole('dialog', { name: 'Copy your new secret now' }).getByText('obk_demo0001_NUEVO-SECRETO-DE-PRUEBA')).toBeVisible();
        await capture(page, testInfo, `keys-${name}-secret`);
        expect(critical).toEqual([]);
        return;
      }

      // Rotating shows the new secret once and does not let go of it until it is confirmed as stored.
      await first.getByRole('button', { name: 'Rotate ci-lectura-resultados' }).click();
      const confirm = page.getByRole('dialog', { name: 'Rotate “ci-lectura-resultados”?' });
      await expect(confirm).toBeVisible();      await confirm.getByRole('button', { name: 'Rotate key' }).click();
      const secret = page.getByRole('dialog', { name: 'Copy your new secret now' });
      await expect(secret.getByText('obk_demo0001_NUEVO-SECRETO-DE-PRUEBA')).toBeVisible();
      await expect(secret.getByRole('button', { name: 'Done' })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(secret).toBeVisible();
      await capture(page, testInfo, `keys-${name}-secret`);
      await secret.getByLabel('I’ve stored the secret somewhere safe').check();
      await secret.getByRole('button', { name: 'Done' }).click();
      await expect(secret).toBeHidden();
      await expect(page.getByText('NUEVO-SECRETO-DE-PRUEBA')).toHaveCount(0);

      // Revoking asks first, then the key is gone from the list.
      await first.getByRole('button', { name: 'Revoke ci-lectura-resultados' }).click();
      const revoke = page.getByRole('dialog', { name: 'Revoke “ci-lectura-resultados”?' });
      await expect(revoke.getByText(/This can’t be undone/)).toBeVisible();      const revoked = page.waitForRequest((request) => request.method() === 'DELETE' && request.url() === `${API}/v1/users/me/api-keys/k1`);
      await revoke.getByRole('button', { name: 'Revoke key' }).click();
      await revoked;
      await expect(main.getByText('“ci-lectura-resultados” was revoked.')).toBeVisible();
      await expect(main.getByRole('article', { name: 'ci-lectura-resultados' })).toHaveCount(0);
      await expect(main.getByText('1 of 25 keys')).toBeVisible();
      // A key that is gone already (404) is reported, and the list is refreshed.
      state.refuse.revoke = detail(404, 'not_found', 'Key not found.');
      await main.getByRole('button', { name: 'Revoke ejecucion-engine-fijo' }).click();
      await page.getByRole('button', { name: 'Revoke key' }).click();
      await expect(main.getByText('That key no longer exists or isn’t yours (404). The list was refreshed.')).toBeVisible();      state.refuse.revoke = undefined;

      // The plan's limit is a warning here and a 402 in the wizard.
      state.keys = [reader, runner];
      state.usage = json({ ...researchUsage(), limits: { ...researchUsage().limits, apiKeys: tracked('apiKeys', 2, 2, 'key') } });
      await page.reload();
      await expect(main.getByText(/You’ve reached your plan’s API key limit \(2\)\./)).toBeVisible();
      await expect(main.getByRole('meter', { name: 'Active keys' })).toHaveAttribute('aria-valuenow', '2');
      await capture(page, testInfo, `keys-${name}-limit`);

      state.keys = [];
      await page.reload();
      await expect(main.getByText('No API keys')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Create your first key' })).toHaveAttribute('href', '/app/account/keys/new');
      await capture(page, testInfo, `keys-${name}-empty`);

      state.refuse.list = detail(503, 'unavailable', 'Accounts are not reachable.');
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('Nothing was loaded');      state.refuse.list = detail(403, 'forbidden', 'The API key lacks keys:read.');
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByRole('alert')).toContainText('keys:read');      expect(critical).toEqual([]);
    });

    test('acct-key-new /app/account/keys/new', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, marco);
      await page.goto('/app/account/keys/new');
      const main = page.locator('#platform-main');
      const next = () => main.getByRole('button', { name: 'Continue' }).click();

      await expect(main.getByRole('heading', { level: 1, name: 'New API key' })).toBeVisible();
      await expectAccountNav(main, 'API keys');
      await expect(main.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('New key');
      const steps = main.getByRole('list', { name: 'Steps' });
      await expect(steps.getByRole('button')).toHaveCount(5);
      await expect(steps.getByRole('button', { name: 'Name' })).toHaveAttribute('aria-current', 'step');
      await capture(page, testInfo, `keynew-${name}-1-name`);
      if (isMobile) {
        await main.getByLabel('Name').fill('ci-nightly');
        await next();
        await expect(main.getByRole('heading', { name: 'Permissions' })).toBeVisible();
        await expect(main.getByText('Only global administrators can grant this.')).toHaveCount(5);
        await capture(page, testInfo, `keynew-${name}-2-permissions`);
        expect(critical).toEqual([]);
        return;
      }

      await next();
      await expect(main.getByText('Give the key a name.')).toBeVisible();
      await main.getByLabel('Name').fill('ci-nightly');
      await main.getByLabel('Expires').selectOption('30');
      await next();

      // The five admin-only permissions are locked with a reason, so nothing implies an admin key from the browser.
      await expect(main.getByRole('heading', { name: 'Permissions' })).toBeVisible();
      await expect(main.getByRole('checkbox')).toHaveCount(30);
      for (const id of ['engines:moderate', 'extensions:moderate', 'pricing:admin', 'admin:accounts:read', 'admin:accounts:write']) {
        await expect(main.getByRole('checkbox', { name: new RegExp(`^${id}`) })).toBeDisabled();
      }
      await expect(main.getByText('Only global administrators can grant this.')).toHaveCount(5);
      await expect(main.getByText(/Permissions marked ADMIN are only granted to global administrators/)).toBeVisible();
      await next();
      await expect(main.getByRole('alert')).toContainText('Choose at least one permission.');
      await capture(page, testInfo, `keynew-${name}-2-permissions`);
      await main.getByRole('button', { name: 'Preset: run an engine' }).click();
      for (const id of ['engines:read', 'engines:execute', 'jobs:read', 'instances:validate']) {
        await expect(main.getByRole('checkbox', { name: new RegExp(`^${id}`) })).toBeChecked();
      }
      await next();

      // Engine-bound permissions need all engines or an exact one (422 before the request is made).
      await expect(main.getByRole('heading', { name: 'Engine access' })).toBeVisible();
      await expect(main.getByRole('radio', { name: /All engines/ })).toBeChecked();
      await main.getByRole('radio', { name: /Only these engines/ }).check();
      await expect(main.getByRole('checkbox', { name: /bim\.builtin\/random-search@1\.0\.0/ })).toBeVisible();
      await next();
      await expect(main.getByRole('alert')).toContainText('422 · The permissions you chose need all engines or at least one exact engine.');      await main.getByRole('checkbox', { name: /bim\.builtin\/random-search@1\.0\.0/ }).check();
      await next();

      await expect(main.getByRole('heading', { name: /^Limits/ })).toBeVisible();
      await main.getByRole('group', { name: 'HTTP methods' }).getByRole('button', { name: 'GET' }).click();
      await main.getByRole('group', { name: 'Organizations' }).getByRole('button', { name: 'isa-demo' }).click();
      await main.getByRole('group', { name: 'Projects' }).getByRole('button', { name: 'qos-benchmarks' }).click();
      await main.getByRole('group', { name: 'Resource kinds' }).getByRole('button', { name: 'jobs' }).click();
      await main.getByRole('group', { name: 'Slugs' }).getByLabel('Add slugs').fill('latency-study');
      await main.getByRole('group', { name: 'Slugs' }).getByRole('button', { name: 'Add' }).click();
      await expect(main.getByRole('group', { name: 'Slugs' }).getByRole('button', { name: 'latency-study' })).toHaveAttribute('aria-pressed', 'true');      await next();

      await expect(main.getByRole('heading', { name: 'Review' })).toBeVisible();
      const review = main.locator('dl.keynew-review');
      await expect(review).toContainText('ci-nightly');
      await expect(review).toContainText('In 30 days');
      await expect(review).toContainText('Launch, cancel and retry jobs (engines:execute)');
      await expect(review).toContainText('GET · isa-demo · qos-benchmarks · jobs · latency-study');
      await capture(page, testInfo, `keynew-${name}-5-review`);

      // The gateway's refusals, one by one: 402, 403 escalation, 403 not grantable, 422 engines.
      const create = main.getByRole('button', { name: 'Create key' });
      state.refuse.create = detail(402, 'quota_exceeded', 'Your plan allows 1 API key, and you have 1.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('402 · You’ve reached your plan’s API key limit.');      state.refuse.create = detail(403, 'api_key_escalation', 'A key may create only keys whose permissions are a subset of its own.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('403 · api_key_escalation');      state.refuse.create = detail(403, 'permission_not_grantable', 'Only an administrator account may grant moderation permissions.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('403 · permission_not_grantable');      state.refuse.create = detail(422, 'validation_error', 'Engine discovery, analysis, execution and job access require all Engines or at least one exact Engine revision');
      await create.click();
      await expect(main.getByRole('heading', { name: 'Engine access' })).toBeVisible();
      await expect(main.getByRole('alert')).toContainText('422 · The permissions you chose need all engines or at least one exact engine.');      state.refuse.create = undefined;
      await next();
      await next();

      // Created: the secret is shown once, and the way on is closed until it is confirmed as stored.
      const created = page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${API}/v1/users/me/api-keys`);
      await create.click();
      const sent = (await created).postDataJSON() as Record<string, unknown>;
      expect(sent).toMatchObject({
        name: 'ci-nightly',
        permissions: ['engines:read', 'engines:execute', 'jobs:read', 'instances:validate'],
        engine_access: { all: false, engines: [engineRef] },
        boundary: { methods: ['GET'], organizations: ['isa-demo'], projects: ['qos-benchmarks'], resource_kinds: ['jobs'], slugs: ['latency-study'] },
      });
      const days = (Date.parse(sent.expires_at as string) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
      const secret = page.getByRole('dialog', { name: '“ci-nightly” is ready. Copy its secret now' });
      await expect(secret.getByText('obk_demo0003_SECRETO-UNICO-DE-PRUEBA')).toBeVisible();
      await expect(secret.getByRole('button', { name: 'Go to my keys' })).toBeDisabled();
      await capture(page, testInfo, `keynew-${name}-secret`);
      await secret.getByLabel('I’ve stored the secret somewhere safe').check();
      await secret.getByRole('button', { name: 'Go to my keys' }).click();
      await expect(page).toHaveURL(/\/app\/account\/keys$/);
      await expect(main.getByRole('article', { name: 'ci-nightly' })).toBeVisible();
      await expect(page.getByText('SECRETO-UNICO-DE-PRUEBA')).toHaveCount(0);
      expect(critical).toEqual([]);
    });

    test('acct-key-new: an administrator can grant the admin-only permissions', async ({ page }, testInfo) => {
      test.skip(isMobile, 'A desktop check: the phone shows the same step, laid out by the capture above.');
      await mockApi(page, iker);
      await page.goto('/app/account/keys/new');
      const main = page.locator('#platform-main');

      await main.getByLabel('Name').fill('admin-audit-reader');
      await main.getByRole('button', { name: 'Continue' }).click();
      await expect(main.getByRole('checkbox')).toHaveCount(30);
      for (const id of ['engines:moderate', 'pricing:admin', 'admin:accounts:read']) {
        await expect(main.getByRole('checkbox', { name: new RegExp(`^${id}`) })).toBeEnabled();
      }
      await expect(main.getByText('Only global administrators can grant this.')).toHaveCount(0);
      await expect(main.getByText('ADMIN', { exact: true })).toHaveCount(5);
      await main.getByRole('checkbox', { name: /^admin:accounts:read/ }).check();
      await capture(page, testInfo, `keynew-${name}-admin`);
    });

    test('acct-identities /app/account/identities', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/app/account/identities');
      const main = page.locator('#platform-main');
      const header = page.locator('header.app-header');

      await expect(main.getByRole('heading', { level: 1, name: 'Identities' })).toBeVisible();
      await expectAccountNav(main, 'Identities');
      await expect(main.getByText('Universidad de Sevilla · CAS')).toBeVisible();
      await expect(main.getByText('Verified · linked Sep 1, 2026 · lvega1')).toBeVisible();
      await expect(main.getByText(/Shown on signed-in pages because your plan includes the institutional identity/)).toBeVisible();
      await expect(main.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/us-fama.png');
      await expect(header.getByRole('img', { name: 'Universidad de Sevilla' }).first()).toBeAttached();
      await expect(main.getByText(/Linking one moves an account on the default plan to RESEARCH automatically, at no extra cost/)).toBeVisible();
      await capture(page, testInfo, `identities-${name}-linked`);
      if (isMobile) {
        await main.getByRole('button', { name: 'Unlink' }).click();
        await expect(page.getByRole('dialog', { name: 'Unlink your Universidad de Sevilla identity?' }).getByLabel('Plan change')).toContainText('50 solves / month');
        await capture(page, testInfo, `identities-${name}-unlink-dialog`);
        expect(critical).toEqual([]);
        return;
      }

      // Leaving RESEARCH is typed: the dialog says what changes and refuses anything but the exact phrase.
      await main.getByRole('button', { name: 'Unlink' }).click();
      const dialog = page.getByRole('dialog', { name: 'Unlink your Universidad de Sevilla identity?' });
      await expect(dialog.getByLabel('Plan change')).toContainText('50 solves / month');
      await expect(dialog.getByLabel('Plan change')).toContainText('10 solves / month');
      const unlink = dialog.getByRole('button', { name: 'Unlink' });
      await expect(unlink).toBeDisabled();
      await dialog.getByLabel('Type DOWNGRADE RESEARCH to confirm').fill('downgrade research');
      await expect(unlink).toBeDisabled();
      await dialog.getByLabel('Type DOWNGRADE RESEARCH to confirm').fill('DOWNGRADE RESEARCH');
      await expect(unlink).toBeEnabled();
      await capture(page, testInfo, `identities-${name}-unlink-dialog`);

      state.refuse.unlink = detail(409, 'research_downgrade_confirmation_required', 'Type DOWNGRADE RESEARCH to remove US CAS and lose institutional access.');
      await unlink.click();
      await expect(dialog.getByRole('alert')).toContainText('409 · research_downgrade_confirmation_required');      state.refuse.unlink = detail(503, 'pricing_unavailable', 'The pricing service is not reachable.');
      await unlink.click();
      await expect(dialog.getByRole('alert')).toContainText('Your identity and plan were not changed');
      state.refuse.unlink = undefined;
      const removed = page.waitForRequest((request) => request.method() === 'DELETE' && request.url().startsWith(`${API}/v1/users/me/identities/i1`));
      await unlink.click();
      expect(new URL((await removed).url()).searchParams.get('confirmation')).toBe('DOWNGRADE RESEARCH');
      await expect(main.getByText('Identity unlinked. Your plan is now BASIC.')).toBeVisible();
      await expect(main.getByText('Not linked', { exact: true })).toBeVisible();
      // The plan and the institutional mark follow without a reload.
      await expect(header.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveCount(0);
      await expect(main.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveCount(0);
      await capture(page, testInfo, `identities-${name}-unlinked`);

      // Linking leaves for the CAS, with the one-use address the gateway gave; a paused service is explained.
      state.refuse.link = detail(503, 'institutional_pricing_invalid', 'The active iPricing must declare the CAS-only RESEARCH plan.');
      await main.getByRole('button', { name: 'Link CAS identity' }).click();
      await expect(main.getByText('Institutional sign-in is paused (503 · institutional_pricing_invalid): the current pricing has no valid RESEARCH plan. Try again later.')).toBeVisible();      state.refuse.link = undefined;
      await main.getByRole('button', { name: 'Link CAS identity' }).click();
      await expect(page).toHaveURL(/\/api\/v1\/auth\/cas\/start\?mode=link&intent=s3/);
      expect(critical).toEqual([]);
    });

    test('acct-identities: an account that is not on RESEARCH unlinks without a typed phrase', async ({ page }) => {
      test.skip(isMobile, 'A desktop check: the dialog is laid out by the capture of the other test.');
      const state = await mockApi(page, marco, {
        identities: [{ id: 'i1', provider: 'us-cas', subject: 'mdiaz2', verifiedAt: '2026-09-01T00:00:00Z' }],
      });
      await page.goto('/app/account/identities');
      const main = page.locator('#platform-main');

      await expect(main.getByText('Verified · linked Sep 1, 2026 · mdiaz2')).toBeVisible();
      await expect(main.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveCount(0);
      await main.getByRole('button', { name: 'Unlink' }).click();
      const dialog = page.getByRole('dialog', { name: 'Unlink your Universidad de Sevilla identity?' });
      await expect(dialog.getByText('Your plan stays as it is.')).toBeVisible();
      await expect(dialog.getByRole('textbox')).toHaveCount(0);
      state.refuse.unlink = detail(409, 'last_login_method', 'Set a password before removing the last external identity.');
      await dialog.getByRole('button', { name: 'Unlink' }).click();
      await expect(dialog.getByRole('alert')).toContainText('409 · last_login_method');
      state.refuse.unlink = undefined;
      await dialog.getByRole('button', { name: 'Unlink' }).click();
      await expect(main.getByText('Identity unlinked.', { exact: true })).toBeVisible();
    });

    test('acct-notifications: the requests to sponsor an organization are answered here', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia, {
        sponsorRequests: [sponsorRequest('prop-1', 'ISA Demo Group', 'isa-demo', 'nora'), sponsorRequest('prop-2', 'QoS Lab', 'qos-lab', 'pilar')],
      });
      await page.goto('/app/account/notifications');
      const main = page.locator('#platform-main');
      const block = main.getByRole('region', { name: 'Sponsor requests for you' });

      await expect(block.getByRole('heading', { name: 'Sponsor requests for you' })).toBeVisible();
      await expect(block.getByRole('listitem')).toHaveCount(2);
      await expect(block.getByText(/nora asks you to sponsor it and everything under it/)).toBeVisible();
      await expect(block.getByText(/(Expires|Expired) Oct 22, 2026/).first()).toBeVisible();
      // The header bell counts what waits for an answer.
      if (!isMobile) await expect(page.locator('header.app-header').getByRole('button', { name: /2 sponsor requests waiting for you/ })).toBeVisible();
      await capture(page, testInfo, `notifications-${name}-sponsor-requests`);

      // Declining says that nothing changes, and tells the person who asked.
      await block.getByRole('button', { name: 'Decline sponsoring QoS Lab' }).click();
      const declining = page.getByRole('dialog', { name: 'Decline sponsoring QoS Lab?' });
      await expect(declining).toContainText('Nothing changes: QoS Lab keeps its current sponsor');
      await declining.getByRole('button', { name: 'Decline request' }).click();
      await expect(main.getByText('You declined to sponsor QoS Lab.')).toBeVisible();
      expect(state.answered).toEqual([{ id: 'prop-2', answer: 'decline' }]);
      await expect(block.getByRole('listitem')).toHaveCount(1);

      // Accepting says whose quota and plan it uses; a plan that can’t take it leaves the request open.
      await block.getByRole('button', { name: 'Accept sponsoring ISA Demo Group' }).click();
      const accepting = page.getByRole('dialog', { name: 'Sponsor ISA Demo Group?' });
      await expect(accepting).toContainText('passes to your quota and is limited by your plan (RESEARCH)');
      await expect(accepting).toContainText('If they don’t fit, nothing changes and the request stays open');
      await capture(page, testInfo, `notifications-${name}-sponsor-accept`);
      state.refuse.accept = json({ detail: { code: 'sponsor_quota_exceeded', error: 'The sponsor contract allows 15 members.', quota: { limit_id: 'members', limit: 15, used: 18 } } }, 402);
      await accepting.getByRole('button', { name: 'Accept and sponsor' }).click();
      await expect(accepting.getByRole('alert')).toContainText('Your plan can’t take this organization and everything under it (402 · sponsor_quota_exceeded). members: 18 of 15 used. The request is still waiting');
      state.refuse.accept = json({ detail: { code: 'pricing_unavailable', error: 'The pricing service is not reachable.' } }, 503);
      await accepting.getByRole('button', { name: 'Accept and sponsor' }).click();
      await expect(accepting.getByRole('alert')).toContainText('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed; the request is still waiting. Try again in a moment.');
      state.refuse.accept = undefined;
      await accepting.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByText('You are now the sponsor of ISA Demo Group. Its consumption counts against your plan.')).toBeVisible();
      expect(state.answered).toEqual([{ id: 'prop-2', answer: 'decline' }, { id: 'prop-1', answer: 'accept' }]);
      await expect(block.getByRole('listitem')).toHaveCount(0);
      expect(critical).toEqual([]);
    });

    test('acct-notifications /app/account/notifications', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page, lucia);
      await page.goto('/app/account/notifications');
      const main = page.locator('#platform-main');
      const list = main.getByRole('list', { name: 'Notifications' });

      await expect(main.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
      await expectAccountNav(main, 'Notifications');
      await expect(main.getByText('You have 2 unread notifications')).toBeVisible();
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await expect(main.getByText('Notifications are kept for 7 days.')).toBeVisible();
      await capture(page, testInfo, `notifications-${name}-list`);
      if (isMobile) {
        await list.getByRole('button', { name: /Your OpenBinding agreement changed/ }).click();
        await expect(main.getByRole('group', { name: 'Before and after' })).toContainText('RESEARCH');
        await capture(page, testInfo, `notifications-${name}-contract-change`);
        expect(critical).toEqual([]);
        return;
      }

      // A contract change opens to what it was before and after.
      await list.getByRole('button', { name: /Your OpenBinding agreement changed/ }).click();
      const change = main.getByRole('group', { name: 'Before and after' });
      await expect(change).toContainText('BASIC');
      await expect(change).toContainText('RESEARCH');
      await expect(main.getByText('Reason: institutional agreement · pricing version 0.1.0')).toBeVisible();
      await expect(main.getByRole('link', { name: 'See my usage' })).toHaveAttribute('href', '/app/account/usage');
      await capture(page, testInfo, `notifications-${name}-contract-change`);

      const read = page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${API}/v1/notifications/n1/read`);
      await main.getByRole('button', { name: 'Mark as read' }).click();
      await read;
      await expect(main.getByText('You have 1 unread notification')).toBeVisible();

      // Filters.
      await main.getByRole('button', { name: 'Jobs' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await expect(list.getByText('Job completed')).toBeVisible();
      await main.getByRole('button', { name: 'Invitations' }).click();
      await expect(list.getByText('You were invited to ISA Demo Group')).toBeVisible();      await main.getByRole('button', { name: 'Contract changes' }).click();
      await main.getByLabel('Show unread only').check();
      await expect(main.getByText('Nothing matches these filters.')).toBeVisible();      await main.getByLabel('Show unread only').uncheck();
      await main.getByRole('button', { name: 'All', exact: true }).click();

      const readAll = page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${API}/v1/notifications/read-all`);
      await main.getByRole('button', { name: 'Mark all read' }).click();
      await readAll;
      await expect(main.getByText('All caught up!')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Mark all read' })).toBeDisabled();

      // Email preferences: the contract-change switch first, saved as the whole set.
      const switches = main.getByRole('switch');
      await expect(switches.first()).toHaveAccessibleName('Email me about contract changes');
      await expect(switches.first()).toHaveAttribute('aria-checked', 'true');
      await expect(main.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
      await switches.first().click();
      await expect(main.getByText('You have unsaved changes')).toBeVisible();      const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url() === `${API}/v1/notifications/preferences`);
      await main.getByRole('button', { name: 'Save preferences' }).click();
      expect((await saved).postDataJSON()).toEqual({ inbox: true, email_contract_changes: false, email_invitations: true, email_job_failures: false });
      await expect(main.getByRole('button', { name: 'Saved' })).toBeDisabled();
      await capture(page, testInfo, `notifications-${name}-preferences-saved`);

      state.refuse.savePreferences = detail(503, 'unavailable', 'Accounts are not reachable.');
      await switches.nth(2).click();
      await main.getByRole('button', { name: 'Save preferences' }).click();
      await expect(main.getByText(/Nothing was saved/)).toBeVisible();
      state.notifications = [];
      await page.reload();
      await expect(main.getByText('No notifications found')).toBeVisible();
      await expect(main.getByText('All caught up!')).toBeVisible();
      state.refuse.notifications = detail(503, 'unavailable', 'Accounts are not reachable.');
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('Notifications couldn’t be loaded.');      state.refuse.notifications = detail(403, 'forbidden', 'The API key lacks notifications:read.');
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByRole('alert')).toContainText('notifications:read');      expect(critical).toEqual([]);
    });
  });
}
