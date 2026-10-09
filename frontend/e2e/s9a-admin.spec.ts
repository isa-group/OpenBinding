import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import type { AdminUserView } from '../src/api/auth';
import {
  AUDIT, BAJA, CONTROL_ROOM, EMPTY_QUEUES, ERROR_EVENTS, ERROR_OVERVIEW, IKER, LUCIA, MARCO, MODERATION, NORA, ORG, OVERVIEW, SUB_ORG, USERS,
  queuesAt, subscriptionOf, usageOf, userPage,
} from '../src/pages/Admin/adminFixtures';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';

// S9a · administration, part one: admin-overview, admin-users, admin-user-detail, admin-audit, admin-errors, admin-queues and admin-sponsor.
// There is no backend: the API origin is answered by page.route(), and the signed-in account is a platform administrator.
// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be looked at after a run.
// Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json({ detail: { code, error, ...extra } }, status);
const down = detail(503, 'accounts_unavailable', 'The accounts database is not reachable.');
const forbidden = detail(403, 'insufficient_api_key_permission', 'The API key does not include this permission.');

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: IKER.id, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

type Key =
  | 'overview' | 'queues' | 'moderation' | 'errorOverview' | 'errors' | 'audit' | 'users' | 'subscription' | 'usage' | 'catalog'
  | 'sponsor' | 'organization' | 'controlRoom';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Key, Handler>>;
  users: AdminUserView[];
  addOns: Record<string, Record<string, number>>;
  /** Who sponsors the organization now. */
  sponsor: string;
  sent: {
    patch: Array<{ id: string; body: Record<string, unknown> }>;
    subscription: Array<{ id: string; body: Record<string, unknown> }>;
    plan: Array<{ id: string; plan: string }>;
    resync: string[];
    revoked: string[];
    sponsor: Array<{ id: string; body: Record<string, unknown> }>;
  };
}

const KEY_ID = '00000000-0000-4000-8000-0000000003a1';
const KEY_MISSING = '00000000-0000-4000-8000-000000000404';
const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

const REGISTRATION = {
  namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: `sha256-${'e5f6'.repeat(16)}`, status: 'pending_review', active: true,
};

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: { role?: 'admin' | 'user' } = {}): Promise<State> {
  const state: State = {
    refuse: {},
    users: structuredClone(USERS),
    addOns: {},
    sponsor: LUCIA.id,
    sent: { patch: [], subscription: [], plan: [], resync: [], revoked: [], sponsor: [] },
  };
  const me = options.role === 'user' ? { ...LUCIA, role: 'user' } : { ...IKER, institutional_branding: false };
  const answer = (key: Key, body: unknown): Handler => (route) => (state.refuse[key] ? state.refuse[key](route) : json(body)(route));
  const userOf = (id: string | undefined) => state.users.find((account) => account.id === id);

  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's9a-access');
    localStorage.setItem('openbinding-refresh-token', 's9a-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's9a-access-2', refresh_token: 's9a-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, (route) => answer('catalog', catalogFixture)(route));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(me));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf('PRO')));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engine-registrations**`, json({ registrations: [REGISTRATION] }));
  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    if (parts.length === 2) return json([ORG, SUB_ORG])(route);
    if (parts.length === 3) {
      // An administrator who is not a member can read no organization but the ones they belong to.
      if (['isa-demo', ORG.id].includes(decodeURIComponent(parts[2]))) return answer('organization', { ...ORG, billing_sponsor_user_id: state.sponsor })(route);
      return detail(403, 'organization_forbidden', 'This action requires viewer access to the organization.')(route);
    }
    return json([])(route);
  });

  // --- administration
  await page.route(new RegExp(`^${API}/v1/admin/.*`), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice('/v1/admin/'.length);
    const parts = path.split('/');
    const method = route.request().method();
    const params = url.searchParams;

    if (path === 'overview') return answer('overview', OVERVIEW)(route);
    if (path === 'queues') return answer('queues', queuesAt(Date.now()))(route);
    if (path === 'moderation') return answer('moderation', MODERATION)(route);
    if (path === 'errors/overview') return answer('errorOverview', ERROR_OVERVIEW)(route);
    if (path === 'pricing/control-room') return answer('controlRoom', CONTROL_ROOM)(route);
    if (path === 'maintenance/preview') {
      return json({ expiredArtifacts: 2, expiredApiKeys: 1, terminalJobs: 14, abandonedJobs: 1, terminalJobCutoff: '2025-10-09T00:00:00Z' })(route);
    }
    if (path === 'engine-routing/metrics') return json({ summary: {}, engines: {} })(route);
    if (path === 'engine-routing/observations') return json({ total: 0, limit: 15, offset: 0, observations: [] })(route);

    if (path === 'errors') {
      const wantedStatus = params.get('status_code');
      const wantedCategory = params.get('category');
      const wantedSearch = (params.get('search') ?? '').toLowerCase();
      const items = ERROR_EVENTS.filter((item) => (
        (!wantedStatus || String(item.status_code) === wantedStatus)
        && (!wantedCategory || item.category === wantedCategory)
        && (!wantedSearch || item.error_code.includes(wantedSearch) || item.endpoint.includes(wantedSearch))
      ));
      return answer('errors', { items, total: items.length, limit: 50, offset: 0 })(route);
    }

    if (path === 'audit') {
      const action = params.get('action');
      const events = AUDIT.events.filter((event) => !action || event.action === action);
      return answer('audit', { ...AUDIT, events, total: events.length })(route);
    }

    if (path === 'users') {
      const search = (params.get('search') ?? '').toLowerCase();
      const offset = Number(params.get('offset') ?? 0);
      const limit = Number(params.get('limit') ?? 50);
      const matching = state.users.filter((account) => !search || account.username.includes(search) || account.email.includes(search));
      return answer('users', userPage(matching.slice(offset, offset + limit), { total: matching.length, offset, limit }))(route);
    }

    if (parts[0] === 'users' && parts.length >= 2) {
      const account = userOf(parts[1]);
      const rest = parts.slice(2).join('/');
      if (!account) return detail(404, 'not_found', 'No such account.')(route);
      if (!rest && method === 'PATCH') {
        const body = bodyOf(route);
        state.sent.patch.push({ id: account.id, body });
        Object.assign(account, body);
        return json({ ...account, api_key_count: 0 })(route);
      }
      if (rest === 'subscription' && method === 'GET') {
        return answer('subscription', subscriptionOf(account, state.addOns[account.id] ?? {}))(route);
      }
      if (rest === 'subscription' && method === 'POST') {
        const body = bodyOf(route);
        state.sent.subscription.push({ id: account.id, body });
        if (body.plan === 'RESEARCH' && !account.cas_verified) return detail(409, 'research_requires_us_cas', 'RESEARCH requires a verified Universidad de Sevilla CAS identity.')(route);
        account.plan = String(body.plan);
        state.addOns[account.id] = body.add_ons as Record<string, number>;
        return json({ ...subscriptionOf(account, state.addOns[account.id]), changed: true })(route);
      }
      if (rest === 'plan' && method === 'POST') {
        const body = bodyOf(route);
        state.sent.plan.push({ id: account.id, plan: String(body.plan) });
        account.plan = String(body.plan);
        return json(account)(route);
      }
      if (rest === 'usage') return answer('usage', usageOf(account.plan, 10))(route);
      if (rest === 'usage/resync' && method === 'POST') {
        state.sent.resync.push(account.id);
        return json({ plan: account.plan, slots_in_flight: 1, slots_recorded: 2, corrected_by: -1 })(route);
      }
      if (rest.startsWith('api-keys/') && method === 'DELETE') {
        const keyId = rest.slice('api-keys/'.length);
        if (keyId === KEY_MISSING) return detail(404, 'not_found', 'No such API key.')(route);
        state.sent.revoked.push(keyId);
        return route.fulfill({ status: 204 });
      }
    }

    if (parts[0] === 'organizations' && parts[2] === 'sponsor' && method === 'POST') {
      const body = bodyOf(route);
      state.sent.sponsor.push({ id: parts[1], body });
      if (state.refuse.sponsor) return state.refuse.sponsor(route);
      const sponsor = userOf(String(body.billing_sponsor_user_id));
      if (!sponsor?.is_active) return detail(422, 'invalid_sponsor', 'Sponsor must be active.')(route);
      state.sponsor = sponsor.id;
      return json({ ...ORG, billing_sponsor_user_id: sponsor.id })(route);
    }
    return detail(404, 'not_found', 'not mocked')(route);
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

/** A capture of the current state: the whole page, its first `height` pixels, or one area; then a check that nothing scrolls sideways. */
async function capture(page: Page, testInfo: TestInfo, name: string, options: { height?: number; area?: Locator } = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const path = testInfo.outputPath(`${name}.png`);
  const width = page.viewportSize()?.width ?? 0;
  if (options.area) {
    await options.area.screenshot({ path, animations: 'disabled' });
  } else if (options.height) {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width, height: Math.min(options.height, total) } });
  } else {
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  }
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  // A phone is taller for the same content, so its captures keep more of the page.
  const tall = (height: number) => (isMobile ? Math.round(height * 1.9) : height);

  test.describe(`${name} · S9a administration`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('admin-overview /app/admin · the blocks, the tools and the panels that have no screen yet', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Administration', exact: true })).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Administration', exact: true }).getByText('Overview', { exact: true })).toHaveAttribute('aria-current', 'page');
      const accounts = main.getByRole('region', { name: 'Accounts', exact: true });
      await expect(accounts.getByText('7', { exact: true })).toBeVisible();
      await expect(accounts.getByText('3 BASIC', { exact: true })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Job queue', exact: true }).getByText(/Oldest waiting: minizinc job, running for about 1 day/)).toBeVisible();
      await expect(main.getByRole('region', { name: 'Moderation', exact: true }).getByText('Engine publication requests')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Errors, last 24 h', exact: true }).getByText('9 events in total')).toBeVisible();
      const pricing = main.getByRole('region', { name: 'Pricing', exact: true });
      await expect(pricing.getByText('SPHERE reachable')).toBeVisible();
      await expect(pricing.getByText('SPACE unreachable')).toBeVisible();
      await expect(pricing.getByText('1 private draft')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Recent changes', exact: true }).getByText('contract.subscription.changed')).toBeVisible();
      await expect(main.getByRole('link', { name: /^Account agreement/ })).toHaveAttribute('href', '/app/admin/users');
      await expect(main.getByRole('link', { name: /^Pricing release/ })).toHaveAttribute('href', '/app/admin/pricing/0.1.0');
      await capture(page, testInfo, `overview-${name}-top`, { height: tall(1900) });

      // The panels that have no screen of their own yet keep working here.
      await expect(main.getByRole('row', { name: 'lucia-vega/edge-solver' })).toBeVisible();
      await expect(main.getByText('Terminal jobs')).toBeVisible();
      await capture(page, testInfo, `overview-${name}-full`);
      await main.getByRole('row', { name: 'lucia-vega/edge-solver' }).getByRole('button', { name: 'Reject' }).click();
      const reject = page.getByRole('dialog', { name: 'Reject publication of lucia-vega/edge-solver?' });
      await capture(page, testInfo, `overview-${name}-reject-dialog`);
      await reject.getByRole('button', { name: 'Cancel' }).click();
      await main.getByRole('button', { name: 'Purge expired data' }).click();
      const purge = page.getByRole('dialog', { name: 'Purge expired data?' });
      await expect(purge.getByRole('button', { name: 'Confirm purge' })).toBeDisabled();
      await capture(page, testInfo, `overview-${name}-purge-dialog`);
      await purge.getByRole('button', { name: 'Cancel' }).click();

      // One block failing leaves the rest of the page as it was.
      state.refuse.queues = detail(503, 'accounts_unavailable', 'down');
      await page.goto('/app/admin');
      const queue = main.getByRole('region', { name: 'Job queue', exact: true });
      await expect(queue.getByText('This block couldn’t load')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Accounts', exact: true }).getByText('7', { exact: true })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-block-fails`, { height: tall(1300) });
      state.refuse.queues = undefined;
      await queue.getByRole('button', { name: 'Retry this block' }).click();
      await expect(queue.getByText(/Oldest waiting/)).toBeVisible();

      // A key without the permission is told so, and the block offers no retry.
      state.refuse.moderation = forbidden;
      await page.goto('/app/admin');
      await expect(main.getByRole('region', { name: 'Moderation', exact: true }).getByText('This key can’t use administration (403)')).toBeVisible();

      // Sponsorship is reached by naming the organization.
      await main.getByLabel('Organization slug or id').fill('isa-demo');
      await main.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(page).toHaveURL(/\/app\/admin\/organizations\/isa-demo\/sponsor$/);
      await expect(page.locator('#platform-main').getByRole('heading', { level: 1, name: 'Transfer sponsorship' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('admin-users /app/admin/users · search, filters, and the changes an administrator may make', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/users');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Accounts', exact: true })).toBeVisible();
      const marco = main.getByRole('row', { name: 'marco.diaz', exact: true });
      await expect(marco).toBeVisible();
      await expect(marco.getByRole('link', { name: 'marco.diaz' })).toHaveAttribute('href', `/app/admin/users/${MARCO.id}`);
      await expect(main.getByRole('row', { name: 'sofia.rey', exact: true }).getByText('contract pending')).toBeVisible();
      await expect(main.getByRole('row', { name: 'baja.demo', exact: true }).getByText('Inactive', { exact: true })).toBeVisible();
      await expect(main.getByRole('row', { name: 'iker.mora', exact: true }).getByText('you', { exact: true })).toBeVisible();
      await expect(main.getByText('Showing 1–6 of 6 accounts')).toBeVisible();
      await capture(page, testInfo, `users-${name}-list`, { height: tall(1800) });

      // Filters narrow the page; the search asks the gateway.
      await main.getByRole('group', { name: 'Role' }).getByRole('button', { name: 'Admins' }).click();
      await expect(main.getByRole('row', { name: 'marco.diaz', exact: true })).toHaveCount(0);
      await expect(main.getByRole('row', { name: 'iker.mora', exact: true })).toBeVisible();
      await main.getByRole('group', { name: 'Role' }).getByRole('button', { name: 'Any role' }).click();
      await main.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Contract pending' }).click();
      await expect(main.getByRole('row', { name: 'sofia.rey', exact: true })).toBeVisible();
      await expect(main.getByRole('row', { name: 'lucia.vega', exact: true })).toHaveCount(0);
      await capture(page, testInfo, `users-${name}-filtered`, { height: tall(1000) });
      await main.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Any status' }).click();
      await main.getByRole('searchbox', { name: 'Search accounts' }).fill('marco');
      await expect(main.getByRole('row', { name: 'lucia.vega', exact: true })).toHaveCount(0);
      await expect(main.getByText('Showing 1–1 of 1 accounts')).toBeVisible();
      await main.getByRole('searchbox', { name: 'Search accounts' }).fill('zzzz');
      await expect(main.getByText('No account matches')).toBeVisible();
      await capture(page, testInfo, `users-${name}-no-match`, { height: tall(900) });
      await main.getByRole('button', { name: 'Clear filters' }).click();
      await expect(main.getByRole('row', { name: 'marco.diaz', exact: true })).toBeVisible();

      // Deactivating asks first, then the list is read again.
      await main.getByRole('button', { name: 'Deactivate marco.diaz' }).click();
      const dialog = page.getByRole('dialog', { name: 'Deactivate marco.diaz?' });
      await capture(page, testInfo, `users-${name}-confirm`);
      await dialog.getByRole('button', { name: 'Deactivate', exact: true }).click();
      await expect(main.getByText('marco.diaz was deactivated.')).toBeVisible();
      expect(state.sent.patch).toEqual([{ id: MARCO.id, body: { is_active: false } }]);
      await expect(main.getByRole('row', { name: 'marco.diaz', exact: true }).getByText('Inactive', { exact: true })).toBeVisible();
      await main.getByRole('button', { name: 'Make admin lucia.vega' }).click();
      await page.getByRole('dialog', { name: 'Make lucia.vega an administrator?' }).getByRole('button', { name: 'Make administrator' }).click();
      await expect(main.getByText('lucia.vega is now an administrator.')).toBeVisible();
      expect(state.sent.patch[1]).toEqual({ id: LUCIA.id, body: { role: 'admin' } });

      // Nobody deactivates or demotes themselves.
      await main.getByRole('button', { name: 'Make user iker.mora' }).click();
      await expect(main.getByText('You can’t demote or deactivate yourself (409 · cannot_demote_self)')).toBeVisible();
      expect(state.sent.patch).toHaveLength(2);
      await capture(page, testInfo, `users-${name}-self`, { height: tall(1100) });

      // Failures read apart from an empty list.
      state.refuse.users = down;
      await page.goto('/app/admin/users');
      await expect(main.getByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeVisible();
      await expect(main.getByText('There are no accounts yet')).toHaveCount(0);
      await capture(page, testInfo, `users-${name}-503`, { height: tall(900) });
      state.refuse.users = undefined;
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByRole('row', { name: 'marco.diaz', exact: true })).toBeVisible();
      state.refuse.users = forbidden;
      await page.goto('/app/admin/users');
      await expect(main.getByText('This key can’t use administration (403)')).toBeVisible();
      await capture(page, testInfo, `users-${name}-403`, { height: tall(900) });
      state.refuse.users = undefined;
      state.users = [];
      await page.goto('/app/admin/users');
      await expect(main.getByText('There are no accounts yet')).toBeVisible();
      await capture(page, testInfo, `users-${name}-empty`, { height: tall(900) });
      expect(critical).toEqual([]);
    });

    test('admin-user-detail /app/admin/users/:user · agreement, usage, keys and organizations of one account', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`/app/admin/users/${MARCO.id}`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'marco.diaz', exact: true })).toBeVisible();
      await expect(main.getByText(/marco-diaz@example\.invalid · since Jun 15, 2026/)).toBeVisible();
      await expect(main.getByText(/Pinned to pricing 0\.1\.0 · renews Nov 1, 2026/)).toBeVisible();
      await expect(main.getByText('10 of 10')).toBeVisible();
      await expect(main.getByRole('group', { name: 'Ceilings for each request' }).getByText('Max time per job')).toBeVisible();
      const plans = main.getByRole('radiogroup', { name: 'New plan' });
      await expect(plans.getByRole('radio')).toHaveCount(4);
      await expect(plans.getByRole('radio', { name: /^BASIC · current/ })).toBeChecked();
      await expect(main.getByRole('button', { name: 'Apply agreement', exact: true })).toBeDisabled();
      await capture(page, testInfo, `detail-${name}-top`, { height: tall(2600) });

      // Choosing another plan shows what changes before anything is sent.
      await plans.getByRole('radio', { name: /^ADVANCED/ }).click();
      await main.getByRole('button', { name: 'More compute pack' }).click();
      await expect(main.getByLabel('Compute pack quantity')).toHaveText('1');
      await expect(main.getByRole('table').getByText('Solves', { exact: true })).toBeVisible();
      await main.getByLabel(/^Detail/).fill('Agreement 2026-14');
      await capture(page, testInfo, `detail-${name}-editing`, { height: tall(3000) });
      await main.getByRole('button', { name: 'Apply agreement', exact: true }).click();
      const apply = page.getByRole('dialog', { name: 'Apply agreement to marco.diaz?' });
      await capture(page, testInfo, `detail-${name}-confirm`);
      await apply.getByRole('button', { name: 'Apply agreement' }).click();
      await expect(main.getByText(/Agreement updated for marco\.diaz \(institutional agreement\)/)).toBeVisible();
      expect(state.sent.subscription).toEqual([{
        id: MARCO.id,
        body: { plan: 'ADVANCED', add_ons: { COMPUTE_PACK: 1 }, reason: 'institutional_agreement', detail: 'Agreement 2026-14' },
      }]);
      await expect(main.getByText('compute pack ×1')).toBeVisible();
      await expect(main.getByRole('radio', { name: /^ADVANCED · current/ })).toBeChecked();
      await capture(page, testInfo, `detail-${name}-applied`, { height: tall(1400) });

      // RESEARCH needs a CAS identity, and the gateway says so.
      await plans.getByRole('radio', { name: /^RESEARCH/ }).click();
      await main.getByRole('button', { name: 'Apply agreement', exact: true }).click();
      await page.getByRole('dialog', { name: 'Apply agreement to marco.diaz?' }).getByRole('button', { name: 'Apply agreement' }).click();
      await expect(main.getByText('RESEARCH needs a verified CAS identity (409 · research_requires_us_cas)')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-409`, { height: tall(3300) });
      await plans.getByRole('radio', { name: /^PRO/ }).click();
      await main.getByRole('button', { name: 'Change plan only, keep add-ons' }).click();
      await page.getByRole('dialog', { name: 'Change plan of marco.diaz?' }).getByRole('button', { name: 'Change plan' }).click();
      await expect(main.getByText(/Agreement updated for marco\.diaz \(administrative decision\)/)).toBeVisible();
      expect(state.sent.plan).toEqual([{ id: MARCO.id, plan: 'PRO' }]);

      // Usage can be recounted, and a key can be taken back by its id.
      await main.getByRole('button', { name: 'Resync concurrency' }).click();
      await capture(page, testInfo, `detail-${name}-resync-dialog`);
      await page.getByRole('dialog', { name: 'Resync concurrency?' }).getByRole('button', { name: 'Resync', exact: true }).click();
      await expect(main.getByText('Corrected by')).toBeVisible();
      expect(state.sent.resync).toEqual([MARCO.id]);
      await main.getByLabel('Key id').fill(KEY_ID);
      await main.getByRole('button', { name: 'Revoke key' }).click();
      await capture(page, testInfo, `detail-${name}-revoke-dialog`);
      await page.getByRole('dialog', { name: 'Revoke the key of marco.diaz?' }).getByRole('button', { name: 'Revoke key' }).click();
      await expect(main.getByText(/Key revoked\. Requests with it fail from now on/)).toBeVisible();
      expect(state.sent.revoked).toEqual([KEY_ID]);
      await main.getByLabel('Key id').fill(KEY_MISSING);
      await main.getByRole('button', { name: 'Revoke key' }).click();
      await page.getByRole('dialog', { name: 'Revoke the key of marco.diaz?' }).getByRole('button', { name: 'Revoke key' }).click();
      await expect(main.getByText('No such API key (404)')).toBeVisible();
      await expect(main.getByText(/has no list of the organizations an account belongs to or sponsors/)).toBeVisible();
      await capture(page, testInfo, `detail-${name}-bottom`);

      // The pricing cannot be read: the rest of the page stays useful.
      state.refuse.catalog = detail(503, 'pricing_unavailable', 'SPACE is down');
      await page.goto(`/app/admin/users/${MARCO.id}`);
      await expect(main.getByText('The active pricing couldn’t be read')).toBeVisible();
      await expect(main.getByRole('radiogroup', { name: 'New plan' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Resync concurrency' })).toBeVisible();
      await capture(page, testInfo, `detail-${name}-pricing-503`, { height: tall(1800) });
      state.refuse.catalog = undefined;

      // An account found by name, and one that does not exist.
      await page.goto('/app/admin/users/lucia.vega');
      await expect(main.getByRole('heading', { level: 1, name: 'lucia.vega', exact: true })).toBeVisible();
      await expect(main.getByText('Verified (us-cas)')).toBeVisible();
      await page.goto('/app/admin/users/00000000-0000-4000-8000-0000000000ff');
      await expect(main.getByText('No such account', { exact: true })).toBeVisible();
      await capture(page, testInfo, `detail-${name}-404`, { height: tall(900) });
      expect(critical).toEqual([]);
    });

    test('admin-audit /app/admin/audit · the timeline, the detail of an event and its filters', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/audit');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Audit log', exact: true })).toBeVisible();
      await expect(main.getByRole('list', { name: 'Events, newest first' }).getByRole('listitem')).toHaveCount(3);
      await expect(main.getByText('2 abandoned jobs were reconciled.')).toBeVisible();
      await expect(main.getByText('Pricing live activated: 0.1.0.')).toBeVisible();
      await capture(page, testInfo, `audit-${name}-list`, { height: tall(1500) });

      await main.getByRole('button', { name: /contract\.subscription\.changed/ }).click();
      const aside = main.getByRole('complementary', { name: 'Event detail' });
      await expect(aside.getByLabel('Before and after').getByText('BASIC · no add-ons')).toBeVisible();
      await expect(aside.getByLabel('Before and after').getByText('RESEARCH · no add-ons')).toBeVisible();
      // The raw event sits behind “View source”, so the readable value is the whole text of its field.
      await expect(aside.getByText('Agreement 2026-14', { exact: true })).toBeVisible();
      await expect(aside.getByRole('link', { name: '00000000…' })).toHaveAttribute('href', `/app/admin/users/${IKER.id}`);
      await capture(page, testInfo, `audit-${name}-detail`, { height: tall(1700) });

      await main.getByRole('group', { name: 'Kind of event' }).getByRole('button', { name: 'Pricing' }).click();
      await expect(main.getByText('2 abandoned jobs were reconciled.')).toHaveCount(0);
      await main.getByRole('group', { name: 'Kind of event' }).getByRole('button', { name: 'All', exact: true }).click();
      await main.getByLabel('Exact action').fill('pricing.live.activated');
      await main.getByRole('button', { name: 'Filter', exact: true }).click();
      await expect(main.getByRole('list', { name: 'Events, newest first' }).getByRole('listitem')).toHaveCount(1);
      await main.getByRole('button', { name: 'Clear “pricing.live.activated”' }).click();
      await expect(main.getByRole('list', { name: 'Events, newest first' }).getByRole('listitem')).toHaveCount(3);

      state.refuse.audit = json({ events: [], total: 0, offset: 0, limit: 100 });
      await page.goto('/app/admin/audit');
      await expect(main.getByText('No events for this filter')).toBeVisible();
      await capture(page, testInfo, `audit-${name}-empty`, { height: tall(900) });
      state.refuse.audit = down;
      await page.goto('/app/admin/audit');
      await expect(main.getByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeVisible();
      await capture(page, testInfo, `audit-${name}-503`, { height: tall(900) });
      state.refuse.audit = undefined;
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByText('2 abandoned jobs were reconciled.')).toBeVisible();
      state.refuse.audit = forbidden;
      await page.goto('/app/admin/audit');
      await expect(main.getByText('This key can’t use administration (403)')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('admin-errors /app/admin/errors · the summary, errors grouped by code and the events behind each group', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/errors');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Errors', exact: true })).toBeVisible();
      await expect(main.getByText('9 error events')).toBeVisible();
      await expect(main.getByRole('img', { name: 'Errors by status: 402: 5, 422: 1, 429: 2, 503: 1' })).toBeVisible();
      await expect(main.getByText('7 refusals')).toBeVisible();
      const groups = main.getByRole('list', { name: 'Errors grouped by code' });
      await expect(groups.getByRole('listitem')).toHaveCount(3);
      const aside = main.getByRole('complementary', { name: 'Error detail' });
      await expect(aside.getByText('402 · quota_exceeded')).toBeVisible();
      await expect(aside.getByLabel('Quota at the time').getByText('10 of 10 solve/month')).toBeVisible();
      await capture(page, testInfo, `errors-${name}-list`, { height: tall(2300) });
      await capture(page, testInfo, `errors-${name}-full`);

      await groups.getByRole('button', { name: /pricing_unavailable/ }).click();
      await expect(aside.getByText('503 · pricing_unavailable')).toBeVisible();
      await expect(aside.getByText('Not signed in')).toBeVisible();

      // A select is named by its label together with the option it shows, and the chart is named “by status” too: find it by its label.
      const status = main.locator('label', { hasText: /^Status/ }).locator('select');
      await status.selectOption('429');
      await expect(groups.getByRole('listitem')).toHaveCount(1);
      await expect(groups.getByText('concurrency_limit_exceeded')).toBeVisible();
      await capture(page, testInfo, `errors-${name}-filtered`, { height: tall(1900) });
      await status.selectOption('404');
      await expect(main.getByText('No events match these filters')).toBeVisible();
      await capture(page, testInfo, `errors-${name}-no-match`, { height: tall(1900) });
      await main.getByRole('button', { name: 'Clear filters' }).first().click();
      await expect(groups.getByRole('listitem')).toHaveCount(3);

      state.refuse.errors = down;
      await page.goto('/app/admin/errors');
      await expect(main.getByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeVisible();
      await capture(page, testInfo, `errors-${name}-503`, { height: tall(1900) });
      state.refuse.errors = undefined;
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(groups.getByRole('listitem')).toHaveCount(3);

      state.refuse.errorOverview = json({ ...ERROR_OVERVIEW, total_errors_24h: 0, by_category_24h: {}, by_status_code_24h: {}, top_users_quota: [], top_solvers_failed: [], timeline: [] });
      state.refuse.errors = json({ items: [], total: 0, limit: 50, offset: 0 });
      await page.goto('/app/admin/errors');
      await expect(main.getByText('No errors in the retention window')).toBeVisible();
      await capture(page, testInfo, `errors-${name}-empty`, { height: tall(1500) });
      state.refuse.errors = forbidden;
      state.refuse.errorOverview = forbidden;
      await page.goto('/app/admin/errors');
      await expect(main.getByText('This key can’t use administration (403)').first()).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('admin-queues /app/admin/queues · jobs by state, the oldest ones, and what the gateway does not let an administrator do', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/queues');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Queues', exact: true })).toBeVisible();
      await expect(main.getByRole('list', { name: 'Jobs by state' }).getByRole('listitem')).toHaveCount(5);
      await expect(main.getByText('One job has run far past its time budget')).toBeVisible();
      const jobs = main.getByRole('list', { name: 'Jobs in flight, oldest first' });
      await expect(jobs.getByRole('listitem', { name: 'minizinc running' }).getByText('Age about 1 day · past its budget')).toBeVisible();
      await expect(jobs.getByRole('listitem', { name: 'random-search queued' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Reconcile abandoned jobs' })).toHaveAttribute('href', '/app/admin/maintenance');
      await expect(main.getByRole('heading', { name: 'What this screen can’t do' })).toBeVisible();
      await capture(page, testInfo, `queues-${name}-list`, { height: tall(1700) });
      await capture(page, testInfo, `queues-${name}-full`);

      await main.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(main.getByText('One job has run far past its time budget')).toBeVisible();
      await main.getByLabel('Refresh every 10 s').check();
      await expect(main.getByLabel('Refresh every 10 s')).toBeChecked();
      await main.getByLabel('Refresh every 10 s').uncheck();

      state.refuse.queues = json(EMPTY_QUEUES);
      await page.goto('/app/admin/queues');
      await expect(main.getByText('Queues are empty')).toBeVisible();
      await capture(page, testInfo, `queues-${name}-empty`, { height: tall(1100) });
      state.refuse.queues = down;
      await page.goto('/app/admin/queues');
      await expect(main.getByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeVisible();
      await capture(page, testInfo, `queues-${name}-503`, { height: tall(900) });
      state.refuse.queues = undefined;
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByRole('list', { name: 'Jobs by state' })).toBeVisible();
      state.refuse.queues = forbidden;
      await page.goto('/app/admin/queues');
      await expect(main.getByText('This key can’t use administration (403)')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('admin-sponsor /app/admin/organizations/:org/sponsor · choose the new sponsor, see its limits and confirm the transfer', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/organizations/isa-demo/sponsor');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Transfer sponsorship', exact: true })).toBeVisible();
      await expect(main.getByText('ISA Demo Group', { exact: true })).toBeVisible();
      await expect(main.locator('strong', { hasText: 'lucia.vega' }).first()).toBeVisible();
      await expect(main.getByText(/QoS Lab \(sub-organization\)/)).toBeVisible();
      await expect(main.getByText(/organization owners can set any active account/)).toBeVisible();
      await capture(page, testInfo, `sponsor-${name}-start`, { height: tall(1500) });

      await main.getByRole('searchbox', { name: 'Search accounts' }).fill('nora');
      const candidate = main.getByRole('radio', { name: /nora\.campos/ });
      await candidate.click();
      await expect(main.getByRole('table').getByText('Storage', { exact: true })).toBeVisible();
      await expect(main.getByText('Can sponsor', { exact: true })).toBeVisible();
      await expect(main.getByText(/The gateway has no dry run/)).toBeVisible();
      await capture(page, testInfo, `sponsor-${name}-limits`, { height: tall(2300) });

      // An inactive account cannot be a sponsor.
      await main.getByRole('searchbox', { name: 'Search accounts' }).fill('baja');
      await main.getByRole('radio', { name: /baja\.demo/ }).click();
      await expect(main.getByText('Can’t sponsor', { exact: true })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Transfer sponsorship' })).toBeDisabled();
      await capture(page, testInfo, `sponsor-${name}-inactive`, { height: tall(2100) });

      // The gateway refuses when the new sponsor’s limits would be passed.
      await main.getByRole('searchbox', { name: 'Search accounts' }).fill('nora');
      await main.getByRole('radio', { name: /nora\.campos/ }).click();
      state.refuse.sponsor = detail(402, 'sponsor_quota_exceeded', 'The sponsor contract allows 15 members; this operation would exceed it.', { quota: { limit_id: 'members', limit: 15, used: 18 } });
      await main.getByRole('button', { name: 'Transfer sponsorship' }).click();
      const confirm = page.getByRole('dialog', { name: 'Transfer sponsorship of ISA Demo Group?' });
      await capture(page, testInfo, `sponsor-${name}-confirm`);
      await confirm.getByRole('button', { name: 'Transfer', exact: true }).click();
      await expect(main.getByText('Over the new sponsor’s limits (402 · sponsor_quota_exceeded)')).toBeVisible();
      await expect(main.getByText(/allows 15 members; with this organization they would use 18/)).toBeVisible();
      await capture(page, testInfo, `sponsor-${name}-402`, { height: tall(2300) });

      // Once it fits, it moves.
      state.refuse.sponsor = undefined;
      await main.getByRole('button', { name: 'Transfer sponsorship' }).click();
      await page.getByRole('dialog', { name: 'Transfer sponsorship of ISA Demo Group?' }).getByRole('button', { name: 'Transfer', exact: true }).click();
      await expect(main.getByText(/Sponsorship of ISA Demo Group moved to nora\.campos/)).toBeVisible();
      expect(state.sent.sponsor[state.sent.sponsor.length - 1]).toEqual({ id: ORG.id, body: { billing_sponsor_user_id: NORA.id } });
      await expect(main.locator('strong', { hasText: 'nora.campos' }).first()).toBeVisible();
      await capture(page, testInfo, `sponsor-${name}-done`, { height: tall(1500) });
      expect(BAJA.is_active).toBe(false);

      // An organization the administrator is not a member of cannot be read by name, only by id.
      state.refuse.organization = detail(403, 'organization_forbidden', 'This action requires viewer access to the organization.');
      await page.goto('/app/admin/organizations/secret-lab/sponsor');
      await expect(main.getByText('This organization can’t be read by name')).toBeVisible();
      await capture(page, testInfo, `sponsor-${name}-by-name`, { height: tall(1100) });
      await page.goto(`/app/admin/organizations/${ORG.id}/sponsor`);
      await expect(main.getByText('Only the id is known')).toBeVisible();
      await capture(page, testInfo, `sponsor-${name}-by-id`, { height: tall(1100) });
      state.refuse.organization = down;
      await page.goto('/app/admin/organizations/isa-demo/sponsor');
      await expect(main.getByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('administration is for administrators: another account is sent away and sees none of it', async ({ page }) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { role: 'user' });
      for (const path of ['/app/admin', '/app/admin/users', `/app/admin/users/${MARCO.id}`, '/app/admin/audit', '/app/admin/errors', '/app/admin/queues', '/app/admin/organizations/isa-demo/sponsor']) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/app\/account$/);
        await expect(page.getByText('Platform admin', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
      }
      expect(critical).toEqual([]);
    });
  });
}
