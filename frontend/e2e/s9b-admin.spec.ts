import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { DRAFT_RELEASE, DRAINING_RELEASE, LIVE_RELEASE, PRICING_ROOM, previewOf } from '../src/pages/Admin/pricingFixtures';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { ALEX, MARIA, PENDING_ENGINE, usageOf } from '../src/test/fixtures/admin';

// S9b · administration, part two: admin-moderation, admin-maintenance, admin-routing, admin-pricing, admin-pricing-draft and admin-pricing-release.
// There is no backend: the API origin is answered by page.route(), and the signed-in account is a platform administrator.
// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be looked at after a run.
// Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string): Handler => json({ detail: { code, error } }, status);
const down = detail(503, 'accounts_unavailable', 'The accounts database is not reachable.');
const forbidden = detail(403, 'insufficient_api_key_permission', 'The API key does not include this permission.');

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: ALEX.id, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

type Key =
  | 'moderation' | 'registrations' | 'report' | 'approve' | 'reject' | 'extension'
  | 'preview' | 'purge' | 'jobs' | 'contracts'
  | 'metrics' | 'observations' | 'recalibrate'
  | 'room' | 'sync' | 'versionPreview' | 'validate' | 'draft' | 'fork' | 'publish' | 'action' | 'archive' | 'delete' | 'audit';

type Release = typeof LIVE_RELEASE;

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Key, Handler>>;
  registrations: Array<typeof PENDING_ENGINE>;
  dialects: number;
  releases: Release[];
  abandoned: number;
  purgeable: number;
  sent: {
    approved: string[];
    rejected: string[];
    extension: Array<{ kind: string; name: string; query: Record<string, string> }>;
    previewDays: string[];
    purge: Array<Record<string, unknown>>;
    jobs: number;
    contracts: number;
    recalibrate: number;
    observations: string[];
    sync: number;
    validate: string[];
    drafts: Array<Record<string, unknown>>;
    forks: Array<{ source: string; body: Record<string, unknown> }>;
    publish: Array<Record<string, unknown>>;
    actions: Array<{ version: string; action: string }>;
    deleted: string[];
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

const METRICS = {
  summary: { totalEngines: 3, healthyEngines: 2, degradedEngines: 1, activeJobs: 4 },
  engines: {
    'random-search': { available: true, activeJobs: 2, healthStatus: 'HEALTHY', confidence: 0.95, oneHourFailureRate: 0.02, avgLatency: 2.15, cusumSPlus: 0.12, cusumSMinus: 0, driftAlarm: false },
    minizinc: { available: true, activeJobs: 2, healthStatus: 'HEALTHY', confidence: 0.62, oneHourFailureRate: 0.05, avgLatency: 7.8, cusumSPlus: 1.85, cusumSMinus: 0, driftAlarm: true },
    evolutionary: { available: false, activeJobs: 0, healthStatus: 'DEGRADED', confidence: 0.2, oneHourFailureRate: 0.6, avgLatency: 12, cusumSPlus: 3.5, cusumSMinus: 0, driftAlarm: true },
  },
};

const observation = (n: number, engine: string, outcome: string, seconds: number, extra: Record<string, unknown> = {}) => ({
  id: `obs-${n}`,
  jobId: `job-${100 + n}`,
  adaptationLoopId: `loop-${n}`,
  engineSelected: engine,
  workloadFeatures: { S: 10 + n, D_constr: 1.5 + n / 10, N_tasks: 8 + n },
  candidateEvaluations: [
    { engine, predicted: { latency: seconds, quality: 0.94, failureRisk: 0.02 }, admissible: true, utility: 0.884 },
    { engine: 'minizinc', predicted: { latency: 8.5, quality: 1, failureRisk: 0.45 }, admissible: false, utility: 0.65, rejectionReason: 'Failure risk exceeds phase transition threshold' },
  ],
  predictedMetrics: { latency: seconds },
  actualMetrics: { actualLatency: seconds * 1.1 },
  residuals: { latency: 0.1 * n - 0.2, quality: 0 },
  outcome,
  createdAt: `2026-10-0${n}T10:00:00Z`,
  ...extra,
});

const OBSERVATIONS = [
  observation(1, 'random-search', 'success', 58),
  observation(2, 'random-search', 'success', 61),
  observation(3, 'minizinc', 'success', 33),
  observation(4, 'minizinc', 'failure', 120),
  observation(5, 'evolutionary', 'success', 90),
];

const AUDIT = {
  events: [
    { id: 'e1', organizationId: null, actorId: ALEX.id, action: 'pricing.live.activated', targetType: 'PricingRelease', targetId: null, detail: { version: '0.1.0' }, createdAt: '2026-09-02T09:00:00Z' },
    { id: 'e2', organizationId: null, actorId: ALEX.id, action: 'pricing.draft.created', targetType: 'PricingRelease', targetId: '0.2.0-draft.1', detail: {}, createdAt: '2026-10-01T09:00:00Z' },
  ],
  total: 2, offset: 0, limit: 200,
};

const VALID = { valid: true, version: '0.2.0-draft.1', digest: `sha256-${'c'.repeat(64)}`, plans: ['BASIC', 'ADVANCED', 'PRO'], add_ons: ['COMPUTE_PACK'], errors: [], warnings: ['The tag Analysis is unused.'] };

const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: { role?: 'admin' | 'user' } = {}): Promise<State> {
  const state: State = {
    refuse: {},
    registrations: [structuredClone(PENDING_ENGINE)],
    dialects: 1,
    releases: [structuredClone(DRAFT_RELEASE), structuredClone(LIVE_RELEASE), structuredClone(DRAINING_RELEASE)],
    abandoned: 1,
    purgeable: 14,
    sent: {
      approved: [], rejected: [], extension: [], previewDays: [], purge: [], jobs: 0, contracts: 0, recalibrate: 0, observations: [], sync: 0,
      validate: [], drafts: [], forks: [], publish: [], actions: [], deleted: [],
    },
  };
  const me = options.role === 'user' ? { ...MARIA, role: 'user' } : { ...ALEX, institutional_branding: false };
  const answer = (key: Key, body: unknown | (() => unknown)): Handler => (route) => (
    state.refuse[key] ? state.refuse[key](route) : json(typeof body === 'function' ? (body as () => unknown)() : body)(route)
  );
  const room = () => ({ ...PRICING_ROOM, live: state.releases.find((release) => release.is_live)?.version ?? null, releases: state.releases });
  const releaseOf = (version: string) => state.releases.find((release) => release.version === version);

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
    const parts = path.split('/');
    const method = route.request().method();
    const params = url.searchParams;

    if (path === 'moderation') {
      return answer('moderation', () => ({
        engines: { published: 3, pending_review: 0 },
        dialects: { published: 2, pending_review: state.dialects },
        registrations: { private: 2, pending_review: state.registrations.length },
      }))(route);
    }
    if (path === 'audit') return answer('audit', AUDIT)(route);

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
    if (path === 'maintenance/reconcile-contracts' && method === 'POST') {
      if (state.refuse.contracts) return state.refuse.contracts(route);
      state.sent.contracts += 1;
      return json({ renewed: 2 })(route);
    }

    if (path === 'engine-routing/metrics') return answer('metrics', METRICS)(route);
    if (path === 'engine-routing/observations') {
      state.sent.observations.push(params.get('engine') ?? '');
      const wanted = params.get('engine');
      const rows = OBSERVATIONS.filter((item) => !wanted || item.engineSelected === wanted);
      return answer('observations', { total: rows.length, limit: 15, offset: 0, observations: rows })(route);
    }
    if (path === 'engine-routing/recalibrate' && method === 'POST') {
      if (state.refuse.recalibrate) return state.refuse.recalibrate(route);
      state.sent.recalibrate += 1;
      return json({ status: 'recalibrated', recalibratedAt: '2026-10-09T12:00:00Z', observationsProcessed: OBSERVATIONS.length, calibratedEngines: ['random-search', 'minizinc'] })(route);
    }

    if (path === 'pricing/control-room') return answer('room', room)(route);
    if (path === 'pricing/sync' && method === 'POST') {
      if (state.refuse.sync) return state.refuse.sync(route);
      state.sent.sync += 1;
      return json({ created: 1 })(route);
    }
    if (parts[0] === 'pricing' && parts[1] === 'versions' && parts[3] === 'preview') {
      const version = decodeURIComponent(parts[2]);
      if (state.refuse.versionPreview) return state.refuse.versionPreview(route);
      return route.fulfill({ status: 200, contentType: 'text/plain', body: previewOf(version) });
    }
    if (path === 'pricing/validate' && method === 'POST') {
      state.sent.validate.push(String(bodyOf(route).yaml));
      return answer('validate', VALID)(route);
    }
    if (path === 'pricing/drafts' && method === 'POST') {
      if (state.refuse.draft) return state.refuse.draft(route);
      const body = bodyOf(route);
      state.sent.drafts.push(body);
      const version = /^version: (.*)$/m.exec(String(body.yaml))?.[1] ?? '0.2.0-draft.1';
      const created = { ...structuredClone(DRAFT_RELEASE), id: '00000000-0000-4000-8000-000000009001', version, changelog: String(body.changelog) };
      state.releases = [created, ...state.releases.filter((item) => item.version !== version)];
      return json({ release: created, message: `Draft ${version} was created in SPHERE.` })(route);
    }
    if (parts[0] === 'pricing' && parts[1] === 'drafts' && parts[3] === 'fork' && method === 'POST') {
      if (state.refuse.fork) return state.refuse.fork(route);
      const body = bodyOf(route);
      state.sent.forks.push({ source: decodeURIComponent(parts[2]), body });
      const created = { ...structuredClone(DRAFT_RELEASE), id: '00000000-0000-4000-8000-000000009002', version: String(body.version) };
      state.releases = [created, ...state.releases];
      return json({ release: created, message: `Draft ${created.version} was forked.` })(route);
    }
    if (parts[0] === 'pricing' && parts[1] === 'drafts' && parts.length === 3 && method === 'DELETE') {
      if (state.refuse.delete) return state.refuse.delete(route);
      const version = decodeURIComponent(parts[2]);
      state.sent.deleted.push(version);
      state.releases = state.releases.filter((item) => item.version !== version);
      return route.fulfill({ status: 204 });
    }
    if (path === 'pricing/publish' && method === 'POST') {
      if (state.refuse.publish) return state.refuse.publish(route);
      const body = bodyOf(route);
      state.sent.publish.push(body);
      const created = { ...structuredClone(DRAFT_RELEASE), id: '00000000-0000-4000-8000-000000009003', version: String(body.version), sphere_state: 'PUBLIC_RELEASE' as const, changelog: String(body.changelog) };
      state.releases = [created, ...state.releases];
      return json({ release: created, message: `Release ${created.version} was published.` })(route);
    }
    if (parts[0] === 'pricing' && parts[1] === 'versions' && ['deploy', 'activate', 'drain', 'archive'].includes(parts[3]) && method === 'POST') {
      const version = decodeURIComponent(parts[2]);
      const action = parts[3];
      if (state.refuse[action === 'archive' ? 'archive' : 'action']) return state.refuse[action === 'archive' ? 'archive' : 'action']!(route);
      state.sent.actions.push({ version, action });
      const release = releaseOf(version);
      if (!release) return detail(404, 'not_found', 'No such version.')(route);
      if (action === 'deploy') release.space_state = 'ACTIVE';
      if (action === 'drain') release.space_state = 'DRAINING';
      if (action === 'archive') release.space_state = 'ARCHIVED';
      if (action === 'activate') {
        for (const other of state.releases) if (other.is_live) { other.is_live = false; other.space_state = 'DRAINING'; }
        release.is_live = true;
        release.space_state = 'ACTIVE';
      }
      return json({ release, message: `${version}: ${action} done.` })(route);
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

    test('admin-maintenance /app/admin/maintenance · preview, purge with a typed confirmation, reconcile jobs and contracts', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/maintenance');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Maintenance', exact: true })).toBeVisible();
      const impact = main.getByRole('list', { name: 'Maintenance preview' });
      await expect(impact.getByRole('listitem')).toHaveCount(4);
      await expect(impact.getByRole('listitem').filter({ hasText: 'Finished jobs to purge' }).getByText('14', { exact: true })).toBeVisible();
      await expect(main.getByText('Finished before Oct 9, 2025, more than 365 days ago.')).toBeVisible();
      await expect(main.getByText('0.1.0', { exact: true })).toBeVisible();
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

      // Abandoned jobs are settled, and contracts moved to LIVE after a confirmation.
      await main.getByRole('button', { name: 'Reconcile jobs' }).click();
      await expect(main.getByText('1 abandoned job settled. Recorded in the audit log.')).toBeVisible();
      expect(state.sent.jobs).toBe(1);
      await main.getByRole('button', { name: 'Reconcile contracts' }).click();
      await capture(page, testInfo, `maintenance-${name}-contracts-dialog`);
      await page.getByRole('dialog', { name: 'Move expired contracts to LIVE?' }).getByRole('button', { name: 'Reconcile contracts' }).click();
      await expect(main.getByText('Expired contracts were renewed onto the LIVE pricing. Recorded in the audit log.')).toBeVisible();
      expect(state.sent.contracts).toBe(1);
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

    test('admin-routing /app/admin/engine-routing · engine health and drift, the observations and recalibration', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/engine-routing');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Engine routing', exact: true })).toBeVisible();
      const engines = main.getByRole('list', { name: 'Engines' });
      await expect(engines.getByRole('listitem')).toHaveCount(3);
      await expect(engines.getByRole('listitem', { name: 'minizinc' }).getByText('Drift alarm')).toBeVisible();
      await expect(engines.getByRole('listitem', { name: 'evolutionary' }).getByText('Offline')).toBeVisible();
      await expect(engines.getByRole('listitem', { name: 'random-search' }).getByText('95%')).toBeVisible();
      await expect(main.getByLabel('Router health').getByText('Degraded')).toBeVisible();
      await expect(main.getByRole('row', { name: 'minizinc obs-4' }).getByText('failure')).toBeVisible();
      await expect(main.getByText('Showing 1–5 of 5 observations')).toBeVisible();
      await expect(main.getByText(/The weights and thresholds of that policy aren’t exposed by the API/)).toBeVisible();
      await capture(page, testInfo, `routing-${name}-top`, { height: tall(2200) });
      await capture(page, testInfo, `routing-${name}-full`);

      // An observation opens to the candidates the router weighed.
      await main.getByRole('row', { name: 'random-search obs-1' }).getByRole('button', { name: 'Inspect' }).click();
      await expect(main.getByText('loop-1', { exact: true })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Candidate solver evaluations' }).getByText('Failure risk exceeds phase transition threshold')).toBeVisible();
      await capture(page, testInfo, `routing-${name}-inspect`, { height: tall(2600) });
      await main.getByRole('row', { name: 'random-search obs-1' }).getByRole('button', { name: 'Hide' }).click();

      // Filtering by engine asks the gateway for that engine.
      await main.getByRole('group', { name: 'Engine' }).getByRole('button', { name: 'minizinc' }).click();
      await expect(main.getByRole('row', { name: 'random-search obs-1' })).toHaveCount(0);
      await expect(main.getByText('Showing 1–2 of 2 observations')).toBeVisible();
      expect(state.sent.observations).toContain('minizinc');
      await capture(page, testInfo, `routing-${name}-filtered`, { height: tall(1900) });
      await main.getByRole('group', { name: 'Engine' }).getByRole('button', { name: 'All', exact: true }).click();

      // Recalibration asks first, then shows what the gateway did.
      await main.getByRole('button', { name: 'Recalibrate…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Recalibrate the router?' });
      await expect(dialog.getByText(/It refits on all 5 observations/)).toBeVisible();
      await capture(page, testInfo, `routing-${name}-recalibrate-dialog`);
      await dialog.getByRole('button', { name: 'Recalibrate', exact: true }).click();
      const result = main.getByLabel('Recalibration result');
      await expect(result.getByText('random-search, minizinc')).toBeVisible();
      await expect(result.getByText('5', { exact: true })).toBeVisible();
      expect(state.sent.recalibrate).toBe(1);
      await capture(page, testInfo, `routing-${name}-recalibrated`, { height: tall(1500) });

      // A failed recalibration, a failed read, a key without the permission, and nothing observed yet.
      state.refuse.recalibrate = detail(503, 'router_unavailable', 'The router did not answer.');
      await main.getByRole('button', { name: 'Recalibrate…' }).click();
      await page.getByRole('dialog', { name: 'Recalibrate the router?' }).getByRole('button', { name: 'Recalibrate', exact: true }).click();
      await expect(main.getByText('A service isn’t available right now (503 · router_unavailable)')).toBeVisible();
      state.refuse.metrics = detail(500, 'router_error', 'The router failed.');
      await page.goto('/app/admin/engine-routing');
      await expect(main.getByText('Routing metrics couldn’t be loaded')).toBeVisible();
      await expect(main.getByText(/Engine suggestions keep working with the last calibration/)).toBeVisible();
      await capture(page, testInfo, `routing-${name}-error`, { height: tall(1500) });
      state.refuse.metrics = forbidden;
      state.refuse.observations = forbidden;
      await page.goto('/app/admin/engine-routing');
      await expect(main.getByText('This key can’t use administration (403)').first()).toBeVisible();
      state.refuse.metrics = json({ summary: { totalEngines: 0, healthyEngines: 0, degradedEngines: 0, activeJobs: 0 }, engines: {} });
      state.refuse.observations = json({ total: 0, limit: 15, offset: 0, observations: [] });
      await page.goto('/app/admin/engine-routing');
      await expect(main.getByText('No observations yet')).toBeVisible();
      await capture(page, testInfo, `routing-${name}-empty`, { height: tall(1300) });
      expect(critical).toEqual([]);
    });

    test('admin-pricing /app/admin/pricing · the control room: health, LIVE, lifecycle, versions, sync and contracts', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/pricing');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Pricing control room', exact: true })).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Administration', exact: true }).getByText('Pricing', { exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByText('LIVE is not a certification')).toBeVisible();
      await expect(main.getByRole('region', { name: 'SPHERE', exact: true }).getByText('Connected')).toBeVisible();
      await expect(main.getByRole('region', { name: 'SPACE 1.5', exact: true }).getByText('Connected')).toBeVisible();
      await expect(main.getByRole('region', { name: 'LIVE', exact: true }).getByText('0.1.0', { exact: true }).first()).toBeVisible();
      await expect(main.getByRole('link', { name: /Open SPACE Console/ })).toHaveAttribute('target', '_blank');
      await expect(main.getByRole('link', { name: 'New draft' })).toHaveAttribute('href', '/app/admin/pricing/drafts/new');
      await expect(main.getByRole('listitem', { name: 'Draining' }).getByRole('link', { name: '0.0.9' })).toBeVisible();
      const draft = main.getByRole('row', { name: 'Version 0.2.0-draft.1' });
      await expect(draft.getByText('Private draft')).toBeVisible();
      await expect(draft.getByText('Not deployed')).toBeVisible();
      await expect(main.getByRole('row', { name: 'Version 0.1.0' }).getByText('LIVE')).toBeVisible();
      await capture(page, testInfo, `pricing-${name}-top`, { height: tall(2300) });
      await capture(page, testInfo, `pricing-${name}-full`);

      // Syncing says what it recorded; a version that differs between SPHERE and this database is named.
      await main.getByRole('button', { name: 'Sync metadata' }).click();
      await expect(main.getByText(/Metadata synced: 1 new version recorded/)).toBeVisible();
      expect(state.sent.sync).toBe(1);

      // Moving expired contracts asks first.
      await main.getByRole('button', { name: 'Move expired contracts to LIVE' }).click();
      await capture(page, testInfo, `pricing-${name}-contracts-dialog`);
      await page.getByRole('dialog', { name: 'Move expired contracts to LIVE?' }).getByRole('button', { name: 'Reconcile contracts' }).click();
      await expect(main.getByText('Expired contracts were renewed onto the LIVE pricing. Recorded in the audit log.')).toBeVisible();
      expect(state.sent.contracts).toBe(1);

      // A version opens its own page.
      await main.getByRole('row', { name: 'Version 0.2.0-draft.1' }).getByRole('link', { name: 'Open 0.2.0-draft.1' }).click();
      await expect(page).toHaveURL(/\/app\/admin\/pricing\/0\.2\.0-draft\.1$/);
      await expect(page.locator('#platform-main').getByRole('heading', { level: 1, name: 'Pricing 0.2.0-draft.1' })).toBeVisible();

      // States: the control plane failing, SPHERE not configured, a divergence, no release, a key without the permission.
      state.refuse.sync = detail(502, 'pricing_digest_mismatch', 'SPHERE content differs from the recorded fingerprint.');
      await page.goto('/app/admin/pricing');
      await main.getByRole('button', { name: 'Sync metadata' }).click();
      await expect(main.getByText('The content doesn’t match its fingerprint (502 · pricing_digest_mismatch)')).toBeVisible();
      await capture(page, testInfo, `pricing-${name}-502`, { height: tall(1500) });
      state.refuse.room = json({ ...PRICING_ROOM, sphere: { enabled: false, reachable: false }, space: { enabled: true, reachable: false }, divergence: { onlyInSphere: ['0.3.0'], onlyLocal: [] } });
      await page.goto('/app/admin/pricing');
      await expect(main.getByRole('region', { name: 'SPHERE', exact: true }).getByText('Not configured')).toBeVisible();
      await expect(main.getByRole('region', { name: 'SPACE 1.5', exact: true }).getByText('Unavailable')).toBeVisible();
      await expect(main.getByText('0.3.0', { exact: true })).toBeVisible();
      await capture(page, testInfo, `pricing-${name}-degraded`, { height: tall(2300) });
      state.refuse.room = json({ ...PRICING_ROOM, live: null, releases: [], remoteVersions: [] });
      await page.goto('/app/admin/pricing');
      await expect(main.getByText('No releases recorded here yet')).toBeVisible();
      await capture(page, testInfo, `pricing-${name}-empty`, { height: tall(1500) });
      state.refuse.room = detail(503, 'sphere_disabled', 'SPHERE is disabled.');
      await page.goto('/app/admin/pricing');
      await expect(main.getByText('SPHERE or SPACE isn’t available (503 · sphere_disabled)')).toBeVisible();
      state.refuse.room = forbidden;
      await page.goto('/app/admin/pricing');
      await expect(main.getByText('This key can’t administer pricing (403)')).toBeVisible();
      await capture(page, testInfo, `pricing-${name}-403`, { height: tall(1100) });
      expect(critical).toEqual([]);
    });

    test('admin-pricing-draft /app/admin/pricing/drafts/new · edit with forms, validate, compare with LIVE, save and publish', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/pricing/drafts/new');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'New pricing draft', exact: true })).toBeVisible();
      const versions = main.getByRole('radiogroup', { name: 'Version' });
      await expect(versions.getByRole('radio', { name: '0.1.0 · LIVE' })).toBeChecked();
      await expect(main.getByRole('radiogroup', { name: 'Start from' }).getByRole('radio')).toHaveCount(3);
      await capture(page, testInfo, `draft-${name}-start`, { height: tall(1500) });

      // Step 2: the plans, limits, features and add-ons are forms.
      await main.getByRole('button', { name: 'Next: edit plans' }).click();
      await expect(main.getByRole('heading', { name: '2 · Plans, features and limits' })).toBeVisible();
      await expect(main.getByLabel('Solves for BASIC')).toHaveValue('10');
      await expect(main.getByLabel('Solves for PRO')).toHaveValue('unlimited');
      await expect(main.getByRole('button', { name: 'Advanced analytics on BASIC' })).toHaveAttribute('aria-pressed', 'false');
      await expect(main.getByLabel('COMPUTE_PACK adds solves')).toHaveValue('100');
      await capture(page, testInfo, `draft-${name}-forms`, { height: tall(2600) });
      await main.getByLabel('Solves for BASIC').fill('lots');
      await expect(main.getByRole('list', { name: 'What needs fixing' }).getByText('BASIC · Solves')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Next: validate' })).toBeDisabled();
      await capture(page, testInfo, `draft-${name}-invalid`, { height: tall(2600) });
      await main.getByLabel('Solves for BASIC').fill('20');
      await main.getByLabel('Concurrent jobs for PRO').fill('12');
      await main.getByRole('button', { name: 'Advanced analytics on BASIC' }).click();
      await main.getByRole('button', { name: 'Show all 3 limits' }).click();
      await expect(main.getByLabel('Storage for PRO')).toHaveValue('21474836480');
      await main.getByRole('button', { name: 'New add-on' }).click();
      await expect(main.getByRole('button', { name: 'Next: validate' })).toBeDisabled();
      await main.getByRole('button', { name: 'Remove add-on' }).last().click();
      await main.getByRole('button', { name: 'Next: validate' }).click();

      // Step 3: validate, and read what changed against LIVE.
      const validation = main.getByRole('region', { name: '3 · Validate' });
      await expect(validation.getByLabel('Draft version')).toHaveValue('0.2.0-draft.1');
      await validation.getByRole('button', { name: 'Validate' }).click();
      await expect(validation.getByRole('list', { name: 'What the gateway read' }).getByText('Ready')).toBeVisible();
      await expect(validation.getByText('The tag Analysis is unused.')).toBeVisible();
      const changes = validation.getByRole('group', { name: 'Changes against LIVE' });
      await expect(changes.getByText('Concurrent jobs')).toBeVisible();
      await expect(changes.getByText('12 ▲')).toBeVisible();
      await expect(changes.getByText('20 ▲')).toBeVisible();
      await expect(changes.getByText('Advanced analytics')).toBeVisible();
      expect(state.sent.validate[0]).toContain('version: 0.2.0-draft.1');
      expect(state.sent.validate[0]).toContain('concurrentJobs: { value: 12 }');
      expect(state.sent.validate[0]).toContain('storageBytes: { value: 21474836480 }');
      await capture(page, testInfo, `draft-${name}-validated`, { height: tall(2600) });

      // A document the gateway refuses (422) can’t go on.
      state.refuse.validate = json({ detail: [{ loc: ['body', 'yaml'], msg: 'plans.PRO.usageLimits: unknown limit' }] }, 422);
      await validation.getByLabel('Draft version').fill('0.2.0-draft.2');
      await validation.getByRole('button', { name: 'Validate' }).click();
      await expect(validation.getByText('plans.PRO.usageLimits: unknown limit')).toBeVisible();
      await expect(validation.getByRole('button', { name: 'Next: save draft' })).toBeDisabled();
      await capture(page, testInfo, `draft-${name}-422`, { height: tall(1900) });
      state.refuse.validate = undefined;
      await validation.getByLabel('Draft version').fill('0.2.0-draft.1');
      await validation.getByRole('button', { name: 'Validate' }).click();
      await expect(validation.getByRole('button', { name: 'Next: save draft' })).toBeEnabled();
      await validation.getByRole('button', { name: 'Next: save draft' }).click();

      // Step 4: a version that exists is refused (409); then the draft is saved, private and not certified.
      const save = main.getByRole('region', { name: '4 · Save a private draft' });
      await save.getByLabel('What changed (changelog)').fill('More jobs on PRO');
      state.refuse.draft = detail(409, 'pricing_version_exists', 'Version 0.2.0-draft.1 already exists.');
      await save.getByRole('button', { name: 'Save draft in SPHERE' }).click();
      await expect(main.getByText('The gateway refused the change (409 · pricing_version_exists)')).toBeVisible();
      await capture(page, testInfo, `draft-${name}-409`, { height: tall(1500) });
      state.refuse.draft = undefined;
      await save.getByRole('button', { name: 'Save draft in SPHERE' }).click();
      await expect(save.getByText('0.2.0-draft.1 saved as a private draft')).toBeVisible();
      await expect(save.getByText(/Not public, not deployed, not LIVE/)).toBeVisible();
      expect(state.sent.drafts).toHaveLength(1);
      expect(state.sent.drafts[0]).toMatchObject({ changelog: 'More jobs on PRO', migration_manifest: { reason: 'new functionality' } });
      await capture(page, testInfo, `draft-${name}-saved`, { height: tall(1500) });

      // Step 5: publish an immutable release, after a confirmation that says it is not LIVE and not certified.
      await save.getByRole('button', { name: 'Next: publish' }).click();
      const publish = main.getByRole('region', { name: '5 · Publish an immutable release' });
      await publish.getByLabel('Release version').fill('0.2.0');
      await publish.getByRole('button', { name: 'Publish 0.2.0' }).click();
      const dialog = page.getByRole('dialog', { name: 'Publish 0.2.0 as an immutable release?' });
      await expect(dialog.getByText(/doesn’t make it LIVE and doesn’t certify its content/)).toBeVisible();
      await capture(page, testInfo, `draft-${name}-publish-dialog`);
      await dialog.getByRole('button', { name: 'Publish release' }).click();
      await expect(publish.getByText('0.2.0 published')).toBeVisible();
      expect(state.sent.publish).toEqual([{ draft_version: '0.2.0-draft.1', version: '0.2.0', changelog: 'More jobs on PRO', migration_manifest: { reason: 'new functionality' } }]);
      await expect(publish.getByRole('link', { name: 'Open release' })).toHaveAttribute('href', '/app/admin/pricing/0.2.0');
      await capture(page, testInfo, `draft-${name}-published`, { height: tall(1500) });

      // The other ways to start: fork a version right away, or load a file.
      await page.goto('/app/admin/pricing/drafts/new');
      await main.getByRole('radio', { name: /^Fork a version as it is/ }).click();
      await main.getByLabel('New draft version').fill('0.3.0-draft.1');
      await main.getByRole('button', { name: 'Fork 0.1.0 into 0.3.0-draft.1' }).click();
      await expect(main.getByText('0.3.0-draft.1 saved as a private draft')).toBeVisible();
      expect(state.sent.forks).toEqual([{ source: '0.1.0', body: { version: '0.3.0-draft.1', changelog: '' } }]);
      await page.goto('/app/admin/pricing/drafts/new');
      await main.getByRole('radio', { name: /^Load a YAML file/ }).click();
      await capture(page, testInfo, `draft-${name}-file`, { height: tall(1300) });

      // The control room failing; a key without the permission; another account.
      state.refuse.room = detail(502, 'pricing_control_plane_error', 'SPHERE answered 500.');
      await page.goto('/app/admin/pricing/drafts/new');
      await expect(main.getByText('The pricing control plane returned an error (502 · pricing_control_plane_error)')).toBeVisible();
      await capture(page, testInfo, `draft-${name}-502`, { height: tall(1300) });
      expect(critical).toEqual([]);
    });

    test('admin-pricing-release /app/admin/pricing/:version · a version’s content, comparison with LIVE, history and actions', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/admin/pricing/0.1.0');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Pricing 0.1.0', exact: true })).toBeVisible();
      await expect(main.getByText(/A public, immutable release/)).toBeVisible();
      await expect(main.getByRole('list', { name: 'About this version' }).getByText('First release.')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Where this version is' }).getByRole('listitem', { name: /^LIVE/ })).toBeVisible();
      const plans = main.getByRole('list', { name: 'Plans' });
      await expect(plans.getByRole('listitem', { name: 'PRO' }).getByText('Unlimited')).toBeVisible();
      await expect(plans.getByRole('listitem', { name: 'BASIC' }).getByText('Free', { exact: true })).toBeVisible();
      await expect(main.getByRole('list', { name: 'Add-ons' }).getByText('Compute pack')).toBeVisible();
      await expect(main.getByText('This is the LIVE version, so there is nothing to compare it with.')).toBeVisible();
      await expect(main.getByRole('list', { name: 'Events of this version' }).getByText('Pricing live activated: 0.1.0.')).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Contracts on 0.1.0' })).toBeVisible();
      for (const label of ['Deploy to SPACE', 'Make LIVE', 'Drain', 'Archive']) {
        await expect(main.getByRole('group', { name: label }).getByRole('button', { name: label })).toBeDisabled();
      }
      await capture(page, testInfo, `release-${name}-live-top`, { height: tall(2300) });
      await capture(page, testInfo, `release-${name}-live-full`);
      await expect(main.getByRole('button', { name: 'Show the customer preview' })).toBeVisible();

      // A draft: compared with LIVE, deployed as a preview after a confirmation, then published.
      await main.locator('.adm-header-actions select').selectOption('0.2.0-draft.1');
      await expect(main.getByRole('heading', { level: 1, name: 'Pricing 0.2.0-draft.1', exact: true })).toBeVisible();
      await expect(main.getByText(/It isn’t certified, and it can’t be LIVE until it is published as a release/)).toBeVisible();
      const changes = main.getByRole('group', { name: 'Changes of 0.2.0-draft.1 against LIVE' });
      await expect(changes.getByText('Concurrent jobs')).toBeVisible();
      await expect(changes.getByText('10 ▲')).toBeVisible();
      await expect(main.getByRole('group', { name: 'Deploy to SPACE' }).getByText('Available')).toBeVisible();
      await expect(main.getByRole('group', { name: 'Make LIVE' }).getByText('Not now')).toBeVisible();
      await capture(page, testInfo, `release-${name}-draft-top`, { height: tall(2300) });
      await main.getByRole('group', { name: 'Deploy to SPACE' }).getByRole('button', { name: 'Deploy to SPACE' }).click();
      const deploy = page.getByRole('dialog', { name: 'Deploy to SPACE 0.2.0-draft.1?' });
      await capture(page, testInfo, `release-${name}-deploy-dialog`);
      await deploy.getByRole('button', { name: 'Deploy to SPACE' }).click();
      await expect(main.getByText('0.2.0-draft.1: deploy done.')).toBeVisible();
      expect(state.sent.actions).toEqual([{ version: '0.2.0-draft.1', action: 'deploy' }]);
      await expect(main.getByRole('group', { name: 'Drain' }).getByText('Available')).toBeVisible();

      // 403 for a key without the permission, then the publication of the draft.
      state.refuse.action = forbidden;
      await main.getByRole('group', { name: 'Drain' }).getByRole('button', { name: 'Drain' }).click();
      await page.getByRole('dialog', { name: 'Drain 0.2.0-draft.1?' }).getByRole('button', { name: 'Drain' }).click();
      await expect(main.getByText('This key can’t administer pricing (403)')).toBeVisible();
      state.refuse.action = undefined;
      await main.getByRole('group', { name: 'Publish as a release' }).getByRole('button', { name: 'Publish…' }).click();
      const publish = page.getByRole('dialog', { name: 'Publish 0.2.0-draft.1 as a release?' });
      await publish.getByLabel('Release version (X.Y.Z)').fill('0.2.0');
      await publish.getByLabel('Changelog (required)').fill('More jobs on PRO');
      await capture(page, testInfo, `release-${name}-publish-dialog`);
      state.refuse.publish = detail(422, 'invalid_release_version', 'The first stable release must be 0.1.0.');
      await publish.getByRole('button', { name: 'Publish release' }).click();
      await expect(main.getByText('That isn’t valid (422 · invalid_release_version)')).toBeVisible();
      await capture(page, testInfo, `release-${name}-422`, { height: tall(1500) });
      state.refuse.publish = undefined;
      await main.getByRole('group', { name: 'Publish as a release' }).getByRole('button', { name: 'Publish…' }).click();
      await page.getByRole('dialog').getByLabel('Release version (X.Y.Z)').fill('0.2.0');
      await page.getByRole('dialog').getByLabel('Changelog (required)').fill('More jobs on PRO');
      await page.getByRole('dialog').getByRole('button', { name: 'Publish release' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Pricing 0.2.0', exact: true })).toBeVisible();
      await expect(main.getByText('Release 0.2.0 was published.')).toBeVisible();
      expect(state.sent.publish).toHaveLength(1);

      // A draining release: archive is refused while contracts remain (409), and allowed when they don’t.
      await page.goto('/app/admin/pricing/0.0.9');
      await expect(main.getByRole('heading', { level: 1, name: 'Pricing 0.0.9', exact: true })).toBeVisible();
      await expect(main.getByRole('group', { name: 'Archive' }).getByText('Available')).toBeVisible();
      await expect(main.getByText(/this screen doesn’t send one/)).toBeVisible();
      await capture(page, testInfo, `release-${name}-draining`, { height: tall(2300) });
      state.refuse.archive = detail(409, 'pricing_has_contracts', 'Two contracts are still pinned to 0.0.9.');
      await main.getByRole('group', { name: 'Archive' }).getByRole('button', { name: 'Archive' }).click();
      await page.getByRole('dialog', { name: 'Archive 0.0.9?' }).getByRole('button', { name: 'Archive' }).click();
      await expect(main.getByText('The gateway refused the change (409 · pricing_has_contracts)')).toBeVisible();
      await capture(page, testInfo, `release-${name}-409`, { height: tall(1500) });
      state.refuse.archive = undefined;
      await main.getByRole('group', { name: 'Archive' }).getByRole('button', { name: 'Archive' }).click();
      await page.getByRole('dialog', { name: 'Archive 0.0.9?' }).getByRole('button', { name: 'Archive' }).click();
      await expect(main.getByText('0.0.9: archive done.')).toBeVisible();

      // Make a release LIVE: the one that was LIVE starts draining.
      await page.goto('/app/admin/pricing/0.0.9');
      await main.getByRole('group', { name: 'Make LIVE' }).getByRole('button', { name: 'Make LIVE' }).click();
      await page.getByRole('dialog', { name: 'Make LIVE 0.0.9?' }).getByRole('button', { name: 'Make LIVE' }).click();
      await expect(main.getByText('0.0.9: activate done.')).toBeVisible();
      expect(state.sent.actions.at(-1)).toEqual({ version: '0.0.9', action: 'activate' });

      // A draft is deleted only by typing its exact version.
      await page.goto('/app/admin/pricing/0.3.0-draft.9');
      await expect(main.getByText('No version 0.3.0-draft.9')).toBeVisible();
      await capture(page, testInfo, `release-${name}-404`, { height: tall(1100) });
      await page.goto('/app/admin/pricing/0.2.0-draft.1');
      await main.getByRole('group', { name: 'Delete draft' }).getByRole('button', { name: 'Delete draft…' }).click();
      const remove = page.getByRole('dialog', { name: 'Delete draft 0.2.0-draft.1?' });
      await expect(remove.getByRole('button', { name: 'Delete draft' })).toBeDisabled();
      await remove.getByLabel(/Type the version 0\.2\.0-draft\.1 to confirm/).fill('0.2.0-draft.1');
      await capture(page, testInfo, `release-${name}-delete-dialog`);
      await remove.getByRole('button', { name: 'Delete draft' }).click();
      await expect(main.getByText('Draft 0.2.0-draft.1 deleted')).toBeVisible();
      expect(state.sent.deleted).toEqual(['0.2.0-draft.1']);

      // Content whose fingerprint does not match is not shown, and actions pause.
      state.releases = [structuredClone(DRAFT_RELEASE), structuredClone(LIVE_RELEASE)];
      state.refuse.versionPreview = detail(502, 'pricing_digest_mismatch', 'The digest differs.');
      await page.goto('/app/admin/pricing/0.2.0-draft.1');
      await expect(main.getByText('Actions are paused until the fingerprint mismatch is resolved.')).toBeVisible();
      await expect(main.getByText('The content doesn’t match its fingerprint (502 · pricing_digest_mismatch)').first()).toBeVisible();
      await expect(main.getByRole('list', { name: 'Plans' })).toHaveCount(0);
      await capture(page, testInfo, `release-${name}-mismatch`, { height: tall(1900) });
      expect(critical).toEqual([]);
    });

    test('administration is for administrators: another account is sent away from these screens and sees none of it', async ({ page }) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page, { role: 'user' });
      for (const path of [
        '/app/admin/moderation', '/app/admin/maintenance', '/app/admin/engine-routing', '/app/admin/pricing', '/app/admin/pricing/drafts/new', '/app/admin/pricing/0.1.0',
      ]) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/app\/account$/);
        await expect(page.getByText('Platform admin', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
      }
      expect(critical).toEqual([]);
    });
  });
}
