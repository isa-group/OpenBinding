import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { ALEX, MARIA, PENDING_ENGINE, usageOf } from '../src/test/fixtures/admin';

// S9b · administration, part two: admin-moderation and admin-maintenance (pricing is administered in the native SPACE and SPHERE consoles).
// There is no backend: the API origin is answered by page.route(), and the signed-in account is a platform administrator.
// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be looked at after a run.
// Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);
const down = detail(503, 'accounts_unavailable', 'The accounts database is not reachable.');
const forbidden = detail(403, 'insufficient_api_key_permission', 'The API key does not include this permission.');

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: ALEX.id, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

type Key =
  | 'moderation' | 'registrations' | 'report' | 'approve' | 'reject' | 'extension'
  | 'preview' | 'purge' | 'jobs';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Key, Handler>>;
  registrations: Array<typeof PENDING_ENGINE>;
  dialects: number;
  abandoned: number;
  purgeable: number;
  sent: {
    approved: string[];
    rejected: string[];
    extension: Array<{ kind: string; name: string; query: Record<string, string> }>;
    previewDays: string[];
    purge: Array<Record<string, unknown>>;
    jobs: number;
  };
}

const REPORT = {
  ...PENDING_ENGINE,
  openapiDigest: `sha256-${'b'.repeat(64)}`,
  openapi: { openapi: '3.1.0' },
  engine: { apiVersion: 'bim/v1', kind: 'Engine', metadata: { namespace: 'maria-santos', name: 'edge-solver', version: '0.3.1' }, spec: { modes: [] } },
  report: {
    status: 'verified',
    verifiedAt: '2026-10-08T10:00:00Z',
    durationMs: 1840,
    checks: [
      { id: 'openapi', status: 'passed', requestPath: '/solve', responseModes: ['sync'] },
      { id: 'health', status: 'passed' },
      { id: 'binding-result', status: 'passed', termination: 'FEASIBLE' },
    ],
  },
};

const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: { role?: 'admin' | 'user' } = {}): Promise<State> {
  const state: State = {
    refuse: {},
    registrations: [structuredClone(PENDING_ENGINE)],
    dialects: 1,
    abandoned: 1,
    purgeable: 14,
    sent: { approved: [], rejected: [], extension: [], previewDays: [], purge: [], jobs: 0 },
  };
  const me = options.role === 'user' ? { ...MARIA, role: 'user' } : { ...ALEX, institutional_branding: false };
  const answer = (key: Key, body: unknown | (() => unknown)): Handler => (route) => (
    state.refuse[key] ? state.refuse[key](route) : json(typeof body === 'function' ? (body as () => unknown)() : body)(route)
  );

  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's9b-access');
    localStorage.setItem('openbinding-refresh-token', 's9b-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's9b-access-2', refresh_token: 's9b-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(me));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf('PRO')));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), json([]));

  // --- engine registrations, dialects and resources
  await page.route(new RegExp(`^${API}/v1/engine-registrations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const method = route.request().method();
    if (parts.length === 2) return answer('registrations', () => ({ registrations: state.registrations }))(route);
    const name = decodeURIComponent(parts[2]);
    const action = parts[3];
    if (action === 'report') return answer('report', REPORT)(route);
    if (action === 'approve' && method === 'POST') {
      if (state.refuse.approve) return state.refuse.approve(route);
      state.sent.approved.push(name);
      state.registrations = state.registrations.filter((item) => item.name !== name);
      return json({ ...PENDING_ENGINE, status: 'published' })(route);
    }
    if (action === 'reject' && method === 'POST') {
      if (state.refuse.reject) return state.refuse.reject(route);
      state.sent.rejected.push(name);
      state.registrations = state.registrations.filter((item) => item.name !== name);
      return json({ ...PENDING_ENGINE, status: 'private' })(route);
    }
    return detail(404, 'not_found', 'not mocked')(route);
  });
  await page.route(new RegExp(`^${API}/v1/(dialects|resources)/[^/]+/approve(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const [, , kind, name] = url.pathname.split('/');
    if (state.refuse.extension) return state.refuse.extension(route);
    state.sent.extension.push({ kind, name: decodeURIComponent(name), query: Object.fromEntries(url.searchParams) });
    if (kind === 'dialects') state.dialects = 0;
    return json({ namespace: url.searchParams.get('namespace'), name, version: url.searchParams.get('version'), digest: `sha256-${'d'.repeat(64)}`, status: 'published' })(route);
  });

  // --- administration
  await page.route(new RegExp(`^${API}/v1/admin/.*`), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice('/v1/admin/'.length);
    const method = route.request().method();
    const params = url.searchParams;

    if (path === 'moderation') {
      return answer('moderation', () => ({
        engines: { published: 3, pending_review: 0 },
        dialects: { published: 2, pending_review: state.dialects },
        registrations: { private: 2, pending_review: state.registrations.length },
      }))(route);
    }

    if (path === 'maintenance/preview') {
      state.sent.previewDays.push(params.get('terminal_job_retention_days') ?? '');
      return answer('preview', () => ({
        expiredArtifacts: state.purgeable ? 2 : 0, expiredApiKeys: state.purgeable ? 1 : 0, terminalJobs: state.purgeable, abandonedJobs: state.abandoned,
        terminalJobCutoff: '2025-10-09T00:00:00Z',
      }))(route);
    }
    if (path === 'maintenance/purge' && method === 'POST') {
      if (state.refuse.purge) return state.refuse.purge(route);
      state.sent.purge.push(bodyOf(route));
      state.purgeable = 0;
      return json({ artifacts: 2, apiKeys: 1, jobs: 14 })(route);
    }
    if (path === 'maintenance/reconcile-jobs' && method === 'POST') {
      if (state.refuse.jobs) return state.refuse.jobs(route);
      state.sent.jobs += 1;
      state.abandoned = 0;
      return json({ settled: 1 })(route);
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

/**
 * A capture of the current state: with E2E_SCREENSHOTS=1 the whole page, its first `height` pixels, or one area, saved for a person to
 * look at; always a check that nothing scrolls sideways.
 */
async function capture(page: Page, testInfo: TestInfo, name: string, options: { height?: number; area?: Locator } = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const path = testInfo.outputPath(`${name}.png`);
  const width = page.viewportSize()?.width ?? 0;
  if (!process.env.E2E_SCREENSHOTS) {
    // No picture: the page is still measured below.
  } else if (options.area) {
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
// One worker for the whole file: with every test in parallel the browsers starve each other and the same walk takes twice as long.
test.describe.configure({ mode: 'default' });

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  // A phone is taller for the same content, so its captures keep more of the page.
  const tall = (height: number) => (isMobile ? Math.round(height * 1.9) : height);

  test.describe(`${name} · S9b administration`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('admin-moderation /app/admin/moderation · the queue, the verification report, approve, reject and the extensions', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/moderation');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Moderation', exact: true })).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Administration', exact: true }).getByText('Moderation', { exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('list', { name: 'Waiting for review' }).getByRole('listitem')).toHaveCount(3);
      const request = main.getByRole('listitem', { name: 'maria-santos/edge-solver' });
      await expect(request.getByText('Waiting for review')).toBeVisible();
      await expect(request.getByText('0.3.1', { exact: true })).toBeVisible();
      await expect(main.getByText('Needs “moderate engines”')).toBeVisible();
      await expect(main.getByText('Needs “moderate extensions”')).toBeVisible();
      await capture(page, testInfo, `moderation-${name}-queue`, { height: tall(1900) });

      await request.getByRole('button', { name: 'Show verification report' }).click();
      await expect(main.getByText('Contract matches bim-engine/v1')).toBeVisible();
      await expect(main.getByText('Health path answered')).toBeVisible();
      await expect(main.getByText('Sample problem solved')).toBeVisible();
      await capture(page, testInfo, `moderation-${name}-report`, { height: tall(2400) });

      // Somebody else decided first: the gateway says 409, and the queue is read again.
      state.refuse.approve = detail(409, 'registration_not_pending', 'The registration is no longer pending review.');
      await request.getByRole('button', { name: 'Approve and publish' }).click();
      const approve = page.getByRole('dialog', { name: 'Publish maria-santos/edge-solver for everyone?' });
      await capture(page, testInfo, `moderation-${name}-approve-dialog`);
      await approve.getByRole('button', { name: 'Approve and publish' }).click();
      await expect(main.getByText('This can’t be decided now (409 · registration_not_pending)')).toBeVisible();
      await capture(page, testInfo, `moderation-${name}-409`, { height: tall(1500) });

      state.refuse.approve = undefined;
      await main.getByRole('listitem', { name: 'maria-santos/edge-solver' }).getByRole('button', { name: 'Approve and publish' }).click();
      await page.getByRole('dialog', { name: 'Publish maria-santos/edge-solver for everyone?' }).getByRole('button', { name: 'Approve and publish' }).click();
      await expect(main.getByText('Approved. maria-santos/edge-solver@0.3.1 is published. Recorded in the audit log.')).toBeVisible();
      await expect(main.getByText('No engine is waiting for review')).toBeVisible();
      expect(state.sent.approved).toEqual(['edge-solver']);
      await expect(main.getByRole('list', { name: 'Waiting for review' }).getByRole('listitem').first().getByText('0', { exact: true })).toBeVisible();
      await capture(page, testInfo, `moderation-${name}-approved`, { height: tall(1500) });

      // The same request again, rejected: the API takes no reason, and says so.
      state.registrations = [structuredClone(PENDING_ENGINE)];
      await page.goto('/app/admin/moderation');
      await main.getByRole('listitem', { name: 'maria-santos/edge-solver' }).getByRole('button', { name: 'Reject' }).click();
      const reject = page.getByRole('dialog', { name: 'Reject maria-santos/edge-solver?' });
      await expect(reject.getByText(/The API takes no written reason/)).toBeVisible();
      await capture(page, testInfo, `moderation-${name}-reject-dialog`);
      await reject.getByRole('button', { name: 'Reject' }).click();
      await expect(main.getByText(/Rejected\. The request left the queue and maria-santos\/edge-solver@0\.3\.1 is private to maria-santos again/)).toBeVisible();
      expect(state.sent.rejected).toEqual(['edge-solver']);

      // Dialects and resources are approved by their exact revision; there is no reject for them.
      const form = main.getByRole('form', { name: 'Approve a dialect or resource' });
      await expect(form.getByRole('button', { name: 'Approve…' })).toBeDisabled();
      await form.getByLabel('Namespace').fill('maria-santos');
      await form.getByLabel('Name', { exact: true }).fill('edge-annotations');
      await form.getByLabel('Version').fill('1.0.0');
      await form.getByLabel('Revision (digest)').fill(`sha256-${'a'.repeat(64)}`);
      await capture(page, testInfo, `moderation-${name}-extension-form`, { area: main.getByRole('region', { name: 'Dialects and registered resources' }) });
      await form.getByRole('button', { name: 'Approve…' }).click();
      await page.getByRole('dialog', { name: 'Approve dialect maria-santos/edge-annotations@1.0.0?' }).getByRole('button', { name: 'Approve dialect' }).click();
      await expect(main.getByText('Dialect maria-santos/edge-annotations@1.0.0 approved and published. Recorded in the audit log.')).toBeVisible();
      expect(state.sent.extension).toEqual([{ kind: 'dialects', name: 'edge-annotations', query: { namespace: 'maria-santos', version: '1.0.0', revision: `sha256-${'a'.repeat(64)}` } }]);
      await expect(main.getByText(/there is no reject action for them/)).toBeVisible();

      // States: a key without the permission, a failure, an empty queue.
      state.refuse.registrations = forbidden;
      await page.goto('/app/admin/moderation');
      await expect(main.getByText('This key can’t moderate (403)')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      await capture(page, testInfo, `moderation-${name}-403`, { height: tall(1100) });
      state.refuse.registrations = down;
      await page.goto('/app/admin/moderation');
      await expect(main.getByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeVisible();
      await capture(page, testInfo, `moderation-${name}-503`, { height: tall(1100) });
      state.refuse.registrations = undefined;
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByText('No engine is waiting for review')).toBeVisible();
      await capture(page, testInfo, `moderation-${name}-empty`, { height: tall(1500) });
      expect(critical).toEqual([]);
    });

    test('admin-maintenance /app/admin/maintenance · preview, purge with a typed confirmation and reconcile jobs, with no contract action', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/maintenance');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Maintenance', exact: true })).toBeVisible();
      const impact = main.getByRole('list', { name: 'Maintenance preview' });
      await expect(impact.getByRole('listitem')).toHaveCount(4);
      await expect(impact.getByRole('listitem').filter({ hasText: 'Finished jobs to purge' }).getByText('14', { exact: true })).toBeVisible();
      await expect(main.getByText('Finished before Oct 9, 2025, more than 365 days ago.')).toBeVisible();
      expect(state.sent.previewDays[0]).toBe('365');
      await capture(page, testInfo, `maintenance-${name}-preview`, { height: tall(2300) });

      // A shorter retention is previewed again; one the API would refuse is not sent.
      await main.getByLabel('Keep finished jobs for (days)').fill('30');
      await main.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect.poll(() => state.sent.previewDays.at(-1)).toBe('30');
      await main.getByLabel('Keep finished jobs for (days)').fill('5');
      await expect(main.getByText(/Use a whole number from 7 to 3,650/)).toBeVisible();
      await expect(main.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
      await capture(page, testInfo, `maintenance-${name}-invalid`, { height: tall(1300) });
      await main.getByRole('button', { name: 'Try 7 days' }).click();
      await expect.poll(() => state.sent.previewDays.at(-1)).toBe('7');
      await main.getByLabel('Keep finished jobs for (days)').fill('365');
      await main.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect.poll(() => state.sent.previewDays.at(-1)).toBe('365');

      // Purging asks for the exact phrase, and a refusal says nothing was removed.
      state.refuse.purge = detail(409, 'maintenance_running', 'Another maintenance run holds the lock.');
      await expect(main.getByRole('button', { name: 'Purge…' })).toBeEnabled();
      await main.getByRole('button', { name: 'Purge…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Purge expired data?' });
      await expect(dialog.getByRole('button', { name: 'Purge permanently' })).toBeDisabled();
      await dialog.getByLabel(/Type PURGE EXPIRED to confirm/).fill('purge expired');
      await expect(dialog.getByRole('button', { name: 'Purge permanently' })).toBeDisabled();
      await dialog.getByLabel(/Type PURGE EXPIRED to confirm/).fill('PURGE EXPIRED');
      await capture(page, testInfo, `maintenance-${name}-purge-dialog`);
      await dialog.getByRole('button', { name: 'Purge permanently' }).click();
      await expect(main.getByText('Another maintenance run is in progress (409 · maintenance_running)')).toBeVisible();
      await expect(main.getByText(/Nothing was changed\. Run the preview again and check the audit log\./)).toBeVisible();
      expect(state.sent.purge).toEqual([]);
      await capture(page, testInfo, `maintenance-${name}-409`, { height: tall(2300) });

      state.refuse.purge = undefined;
      await main.getByRole('button', { name: 'Purge…' }).click();
      await page.getByRole('dialog', { name: 'Purge expired data?' }).getByLabel(/Type PURGE EXPIRED to confirm/).fill('PURGE EXPIRED');
      await page.getByRole('dialog', { name: 'Purge expired data?' }).getByRole('button', { name: 'Purge permanently' }).click();
      await expect(main.getByText('Purged. Recorded in the audit log; the next preview shows what is left.')).toBeVisible();
      expect(state.sent.purge).toEqual([{ confirmation: 'PURGE EXPIRED', terminal_job_retention_days: 365, error_retention_days: 90 }]);
      await expect(main.getByLabel('What was purged').getByText('Api keys')).toBeVisible();
      await capture(page, testInfo, `maintenance-${name}-purged`, { height: tall(2300) });

      // Abandoned jobs are settled. There is no contract action here: contracts live in SPACE.
      await main.getByRole('button', { name: 'Reconcile jobs' }).click();
      await expect(main.getByText('1 abandoned job settled. Recorded in the audit log.')).toBeVisible();
      expect(state.sent.jobs).toBe(1);
      await expect(main.getByRole('button', { name: /contract/i })).toHaveCount(0);
      await capture(page, testInfo, `maintenance-${name}-done`);

      // Nothing left to purge, a dependency down, a key without the permission.
      await page.goto('/app/admin/maintenance');
      await expect(main.getByText('Nothing to purge with these retention periods.')).toBeVisible();
      await capture(page, testInfo, `maintenance-${name}-nothing`, { height: tall(1500) });
      state.refuse.preview = detail(503, 'database_unavailable', 'The database did not answer.');
      await page.goto('/app/admin/maintenance');
      await expect(main.getByText('A dependency is down (503 · database_unavailable)')).toBeVisible();
      await capture(page, testInfo, `maintenance-${name}-503`, { height: tall(1500) });
      state.refuse.preview = forbidden;
      await page.goto('/app/admin/maintenance');
      await expect(main.getByText('This key can’t use administration (403)')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('administration is for administrators: another account is sent away from these screens and sees none of it', async ({ page }) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { role: 'user' });
      for (const path of ['/app/admin/moderation', '/app/admin/maintenance']) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/app\/account$/);
        await expect(page.getByText('Platform admin', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
      }
      expect(critical).toEqual([]);
    });
  });
}
