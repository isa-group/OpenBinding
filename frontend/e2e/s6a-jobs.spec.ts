import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { BindingCase, CaseRevision, Job } from '../src/api/platform';
import { ENGINE, INSTANCE, NEIGHBORHOOD, PROBLEM, REGISTRATION, REPORT, detailOf, jobOf, provenanceOf } from '../src/test/fixtures/jobs';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { digestOf, usageOf } from '../src/test/fixtures/resources';

// S6a · execution: job-launch, job-list, job-detail and job-history.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by git)
// so they can be looked at after a run. Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);
const unavailable: Handler = json({ detail: 'The service is not reachable.' }, 503);

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

const lucia = {
  id: 'user-1', username: 'lucia.vega', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z', cas_verified: true, institutional_branding: true,
};

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const org = (id: string, slug: string, name: string, role: Role, sponsor = 'user-1') => ({
  id, slug, name, parent_id: null, billing_sponsor_user_id: sponsor, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});

const project = (n: number, orgId: string, slug: string, name: string) => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility: 'private', created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
  // The contract's `ProjectView.access`: these specs reach every project as a member.
  access: 'member' as const, effective_role: 'OWNER' as Role,
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, 'org-isa-demo', 'qos-benchmarks', 'QoS Benchmarks'), project(2, 'org-isa-demo', 'checkout-privado', 'Checkout (privado)')],
  'read-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- the case a run can start from

const flujo: BindingCase = {
  id: 'case-flujo-checkout', project_id: 'project-1', slug: 'flujo-checkout', name: 'Flujo de checkout', description: '', created_by_id: 'user-1', created_at: '2026-04-02T00:00:00Z',
};

const caseRevision = (n: number): CaseRevision => ({
  id: `case-flujo-checkout-r${n}`, binding_case_id: flujo.id, revision: n, digest: digestOf(String(n)), document: {},
  source_snapshot_id: `snapshot-${n}`, created_at: `2026-08-0${n}T10:00:00Z`,
});

// --- the runs

const mine = { project_id: 'project-1', organization_id: 'org-isa-demo' };
const rows = {
  feasible: jobOf('job-feasible-1', 'random-search', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z', mine),
  running: jobOf('job-running-2', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null, mine),
  queued: jobOf('job-queued-3', 'random-search', 'queued', null, '2026-10-08T08:10:00Z', null, mine),
  failed: jobOf('job-failed-4', 'evolutionary', 'failed', 'UNKNOWN', '2026-10-07T15:00:00Z', '2026-10-07T15:00:20Z', mine),
  cancelled: jobOf('job-cancelled-5', 'random-search', 'cancelled', null, '2026-10-06T12:00:00Z', '2026-10-06T12:00:03Z', mine),
  infeasible: jobOf('job-infeasible-6', 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z', mine),
  routed: jobOf('job-routed-7', 'evolutionary-heuristics', 'completed', 'OPTIMAL', '2026-10-03T11:00:00Z', '2026-10-03T11:00:12Z', mine),
  theirs: jobOf('job-theirs-8', 'evolutionary', 'completed', 'OPTIMAL', '2026-10-02T10:00:00Z', '2026-10-02T10:02:00Z', mine),
  live: jobOf('job-live-10', 'minizinc', 'running', null, '2026-10-09T08:00:00Z', null, mine),
};

const projectRows: Job[] = [rows.running, rows.queued, rows.failed, rows.cancelled, rows.feasible, rows.infeasible, rows.theirs];
const ownRows: Job[] = [rows.running, rows.queued, rows.failed, rows.cancelled, rows.feasible, rows.infeasible, rows.routed, rows.live];

/** What `GET /v1/jobs/{id}` answers for each run, given the state of the test; `null` is a 404. */
const detailTable: Record<string, (state: State) => ReturnType<typeof detailOf> | null> = {
  'job-feasible-1': () => detailOf('job-feasible-1', 'completed'),
  'job-running-2': () => detailOf('job-running-2', 'running'),
  'job-queued-3': () => detailOf('job-queued-3', 'queued'),
  'job-failed-4': () => detailOf('job-failed-4', 'failed'),
  'job-cancelled-5': () => detailOf('job-cancelled-5', 'cancelled'),
  'job-infeasible-6': () => detailOf('job-infeasible-6', 'completed', {
    result: { termination: 'INFEASIBLE', solutions: [{ violations: [{ constraint: 'sla-latencia', message: 'Total latency is 742 ms; at most 600 ms is allowed.' }] }] },
  }),
  'job-routed-7': () => detailOf('job-routed-7', 'completed'),
  'job-live-10': (state) => detailOf('job-live-10', state.liveDone ? 'completed' : 'running'),
  'job-new-9': () => detailOf('job-new-9', 'queued', { provenance: provenanceOf({ requestedOptions: { time_budget_ms: 600000 }, options: { time_budget_ms: 60000 } }) }),
};

// --- what the gateway answers

const EDGE = { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: digestOf('e') };
const EDGE_REGISTRATION = { namespace: 'lucia-vega', name: 'edge-solver-eu', version: '1', digest: digestOf('r') };
const MINIZINC = { namespace: 'bim.builtin', name: 'minizinc', version: '1.0.0', digest: digestOf('m') };
const MINIZINC_REGISTRATION = { namespace: 'bim.builtin', name: 'minizinc-deployment', version: '1.0.0+builtin.m', digest: digestOf('n') };

const mode = (id: string, properties: Record<string, unknown>) => ({
  id, profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm: id, capabilities: {},
  optionsSchema: { type: 'object', properties, additionalProperties: false }, limits: {}, guarantees: { termination: ['FEASIBLE'], exact: false },
});

const engines = [
  { ...ENGINE, id: 'engine-1', ref: ENGINE, modes: [mode('sampling', { time_budget_ms: { type: 'integer', default: 30000 }, iterations: { type: 'integer', default: 100000 } })] },
  { ...MINIZINC, id: 'engine-2', ref: MINIZINC, modes: [mode('cp', { time_budget_ms: { type: 'integer', default: 60000 } })] },
];

const analysisBody = () => ({
  valid: true, instanceDigest: digestOf('d'), packageDigest: digestOf('e'), irDigest: digestOf('c'), fileDigests: {}, resourceDigests: {}, diagnostics: [],
  compatibleModes: [
    { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
    { engine: MINIZINC, registration: MINIZINC_REGISTRATION, mode: 'cp', compatible: true },
    { engine: EDGE, registration: EDGE_REGISTRATION, mode: 'placement', compatible: false, diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] },
  ],
  analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
});


const summaryOf = (row: Job) => ({
  id: row.id, engine_id: row.engine_id, status: row.status, termination: row.termination ?? null,
  solutions: row.status === 'completed' ? (row.termination === 'INFEASIBLE' ? 0 : 1) : null, created_at: row.created_at, finished_at: row.finished_at,
});

type Overridable = 'launch' | 'cancel' | 'retry' | 'validate' | 'projectJobs' | 'history' | 'detail' | 'neighborhood';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Overridable, Handler>>;
  /** The last body or key each write carried, to check what was sent. */
  sent: { launch?: unknown; key?: string; cancel?: string; retry?: string };
  /** The live run has finished: the next time it is asked about it says so. */
  liveDone: boolean;
  /** How many days the plan keeps finished runs; `null` is the gateway not saying. */
  retention: number | null;
  history: Job[];
}

interface MockOptions {
  /** The account's role in ISA Demo Group. */
  role?: Role;
}

const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = { refuse: {}, sent: {}, liveDone: false, retention: 180, history: ownRows };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'OWNER'),
    org('org-4', 'read-lab', 'Read Lab', 'VIEWER', 'user-nora'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's6a-access');
    localStorage.setItem('openbinding-refresh-token', 's6a-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's6a-access-2', refresh_token: 's6a-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf({
    plan: 'RESEARCH',
    capabilities: { maxPayloadBytes: 134_217_728, maxTimeoutSeconds: 60, maxIterations: 1_000_000, maxInstanceComplexityLog10: 20, concurrentJobs: 3 },
  })));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines`, json({ engines }));

  // The jobs of this account across projects, with how long they are kept.
  await page.route(new RegExp(`^${API}/v1/users/me/jobs(\\?.*)?$`), (route) => {
    if (state.refuse.history) return state.refuse.history(route);
    const limit = Number(new URL(route.request().url()).searchParams.get('limit') ?? 50);
    return json({ jobs: state.history.slice(0, limit).map(summaryOf), total: state.history.length, retention_days: state.retention })(route);
  });

  await page.route(`${API}/v1/validate`, (route) => (state.refuse.validate ?? json(analysisBody()))(route));
  await page.route(`${API}/v1/instances`, json({ id: 'snapshot-made', irDigest: digestOf('c') }, 201));

  await page.route(new RegExp(`^${API}/v1/jobs(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const [, , , id, action, sub] = url.pathname.split('/');
    const method = route.request().method();
    if (!id) {
      if (method === 'POST') {
        state.sent.launch = bodyOf(route);
        state.sent.key = route.request().headers()['idempotency-key'];
        return (state.refuse.launch ?? json({ id: 'job-new-9', status: 'queued', profile: 'qos-binding/v1', irDigest: digestOf('c') }, 202))(route);
      }
      return json(ownRows)(route);
    }
    if (action === 'cancel') {
      state.sent.cancel = id;
      return (state.refuse.cancel ?? json({ ...rows.running, id, cancellation_requested: true }))(route);
    }
    if (action === 'retry') {
      state.sent.retry = id;
      return (state.refuse.retry ?? json(jobOf('job-new-9', 'evolutionary', 'queued', null, '2026-10-09T09:00:00Z', null, { ...mine, retry_of_id: id }), 202))(route);
    }
    if (action === 'instance') return json(INSTANCE)(route);
    if (action === 'ir') return json(PROBLEM)(route);
    if (action === 'report') return json({ ...REPORT, id })(route);
    if (action === 'analysis' && sub === 'neighborhood') return (state.refuse.neighborhood ?? json({ ...NEIGHBORHOOD, jobId: id }))(route);
    if (state.refuse.detail) return state.refuse.detail(route);
    const found = detailTable[id]?.(state) ?? null;
    return found ? json(found)(route) : detail(404, 'not_found', 'Job not found.')(route);
  });

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , orgSlug, section, projectSlug, sub, subId, action] = parts;
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = projectsOf[orgSlug] ?? [];
    if (!projectSlug) return json(list)(route);
    const current = list.find((item) => item.slug === projectSlug);
    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    if (!sub) return json(current)(route);

    if (sub === 'cases') {
      if (!subId) return json(projectSlug === 'qos-benchmarks' ? [flujo] : [])(route);
      if (action === 'revisions') return json(subId === flujo.slug ? [caseRevision(1), caseRevision(2)] : [])(route);
      return json(subId === flujo.slug ? flujo : { detail: 'not found' }, subId === flujo.slug ? 200 : 404)(route);
    }
    if (sub === 'jobs') {
      if (state.refuse.projectJobs) return state.refuse.projectJobs(route);
      if (projectSlug !== 'qos-benchmarks') return json([])(route);
      const wanted = url.searchParams.get('job_id');
      return json(wanted ? projectRows.filter((row) => row.id === wanted) : projectRows)(route);
    }
    return json([])(route);
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

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const ROOT = '/app/isa-demo/qos-benchmarks';

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S6a execution`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('job-list /app/:org/:project/jobs · summaries, owner actions, filters and retry', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/jobs`);
      const main = page.locator('#platform-main');
      const table = main.getByRole('region', { name: 'Jobs of the project' });

      await expect(main.getByRole('heading', { level: 1, name: 'Jobs' })).toBeVisible();
      await expect(main.getByText(/Every run in QoS Benchmarks\. Anyone in the project sees the summary/)).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Jobs', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('link', { name: 'New run' })).toHaveAttribute('href', `${ROOT}/jobs/new`);
      await expect(table.getByRole('row')).toHaveCount(8);
      await expect(table.getByRole('link', { name: /^Open job/ })).toHaveCount(6);
      await expect(table.getByText('Owner only')).toHaveCount(1);
      await expect(table.getByText('Another member')).toHaveCount(1);
      await expect(table.getByRole('button', { name: 'Retry' })).toHaveCount(2);
      await expect(main.getByText('Kept for 180 days on your RESEARCH plan')).toBeVisible();
      await expect(main.getByRole('button', { name: 'All (7)' })).toHaveAttribute('aria-pressed', 'true');
      await capture(page, testInfo, `list-${name}-rows`);

      // Narrowing by status and by engine.
      await main.getByRole('button', { name: 'Running (1)' }).click();
      await expect(table.getByRole('row')).toHaveCount(2);
      await capture(page, testInfo, `list-${name}-filtered`);
      await main.getByRole('button', { name: 'All (7)' }).click();
      await main.getByRole('combobox', { name: 'Engine' }).selectOption('evolutionary');
      await expect(table.getByRole('row')).toHaveCount(3);
      await main.getByRole('combobox', { name: 'Engine' }).selectOption('');

      // A retry of a failed run of its own, then one the account cannot afford.
      await table.getByRole('button', { name: 'Retry' }).first().click();
      await expect(main.getByText('Retry queued.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/jobs/job-new-9`);
      expect(state.sent.retry).toBe('job-failed-4');
      await capture(page, testInfo, `list-${name}-retry`);
      state.refuse.retry = detail(402, 'quota_exceeded', 'Storage exhausted.', {
        quota: { limit_id: 'storageBytes', limit: 50, used: 50 },
      });
      await table.getByRole('button', { name: 'Retry' }).last().click();
      await expect(main.getByText('Retry refused: Out of storage (402 · quota_exceeded)')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      await capture(page, testInfo, `list-${name}-402`);
      expect(critical).toEqual([]);
    });

    test('job-list /app/:org/:project/jobs · empty, 503, a viewer and a project that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto('/app/isa-demo/checkout-privado/jobs');
      await expect(main.getByText('No runs yet')).toBeVisible();
      await expect(main.getByText('Pick a case revision and an engine to run it.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Start a run' })).toHaveAttribute('href', '/app/isa-demo/checkout-privado/jobs/new');
      await capture(page, testInfo, `list-${name}-empty`);

      state.refuse.projectJobs = unavailable;
      await page.goto(`${ROOT}/jobs`);
      await expect(main.getByRole('alert').filter({ hasText: 'Jobs can’t be loaded right now' })).toContainText('(503)');
      await expect(main.getByText('No runs yet')).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-503`);
      state.refuse.projectJobs = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('region', { name: 'Jobs of the project' })).toBeVisible();

      // A viewer reads the summaries; nothing on the screen starts a run.
      await page.goto('/app/read-lab/bench/jobs');
      await expect(main.getByRole('heading', { level: 1, name: 'Jobs' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'New run' })).toHaveCount(0);
      await expect(main.getByText('No runs yet')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Start a run' })).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-viewer`);

      await page.goto('/app/isa-demo/ghost/jobs');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await capture(page, testInfo, `list-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('job-detail /app/:org/:project/jobs/:job · a finished run, its result and what it ran on', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(`${ROOT}/jobs/job-feasible-1`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'random-search run' })).toBeVisible();
      await expect(main.getByText('Feasible: meets every must-hold rule')).toBeVisible();
      await expect(main.getByText(/launched Sep 30, 2026, 09:00 UTC by you · case Flujo de checkout/)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Analyze' })).toHaveCount(0);
      await expect(main.getByRole('region', { name: 'Timeline' }).getByText('Finished · not live')).toBeVisible();
      const settings = main.getByRole('region', { name: 'Settings asked and used' });
      await expect(settings.getByRole('row', { name: /Time budget/ })).toContainText('600 s');
      await expect(settings.getByRole('row', { name: /Time budget/ })).toContainText('Reduced to the plan’s ceiling');
      await capture(page, testInfo, `detail-${name}-top`, { height: 1700 });

      // The authoritative result: figures and a table of providers; the raw JSON only behind View source.
      const best = main.getByRole('region', { name: 'Run result' });
      await expect(best.getByRole('list', { name: 'Quality of this combination' }).getByRole('listitem')).toHaveCount(2);
      await expect(best.getByRole('region', { name: 'Chosen providers' }).getByRole('row')).toHaveCount(4);
      const solutionSource = main.getByRole('region', { name: 'Solution 1 source' });
      await expect(solutionSource).toBeHidden();
      await capture(page, testInfo, `detail-${name}-result`, { area: best });
      await best.getByText('View source').first().click();
      await expect(solutionSource).toContainText('"c1"');
      await capture(page, testInfo, `detail-${name}-result-source`, { area: best });

      // What it ran on.
      const where = main.getByRole('region', { name: 'Where this result comes from' });
      await expect(where.getByRole('link', { name: /^Snapshot snapshot/ })).toHaveAttribute('href', `${ROOT}/snapshots/snapshot-2`);
      await expect(where.getByRole('link', { name: 'Flujo de checkout · revision 2' })).toHaveAttribute('href', `${ROOT}/cases/flujo-checkout/revisions/2`);
      await expect(where.getByRole('link', { name: 'Add to a report' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-provenance`, { area: where });
      const downloaded = page.waitForEvent('download');
      await where.getByRole('button', { name: 'Download compiled problem' }).click();
      expect((await downloaded).suggestedFilename()).toBe('job-job-feas-compiled-problem.json');

      // Single swaps on request; the engine's own report is loaded with the run and shown as the claimed and evaluated values.
      const swaps = main.getByRole('region', { name: 'What if one task used another provider?' });
      await swaps.getByRole('button', { name: 'Check single swaps' }).click();
      await expect(swaps.getByRole('list', { name: 'Single-task swaps' })).toContainText('catalog · fastpay');
      await expect(swaps.getByText('Better', { exact: true })).toBeVisible();
      await capture(page, testInfo, `detail-${name}-swaps`, { area: swaps });
      const report = best.getByRole('region', { name: 'Claimed and evaluated values' });
      await expect(report).toBeVisible();
      await capture(page, testInfo, `detail-${name}-report`, { area: report });
      expect(critical).toEqual([]);
    });

    test('job-detail /app/:org/:project/jobs/:job · a live run follows its state until it finishes', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/jobs/job-live-10`);
      const main = page.locator('#platform-main');

      await expect(main.getByText('Live · connected')).toBeVisible();
      await expect(main.getByText('No result yet. It appears here when the run finishes.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Cancel run' })).toBeVisible();
      await expect(main.getByText('Live updates report status changes only; there’s no progress percentage to show.')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-live`, { height: 1400 });

      // The next reading says it ended; the page notices on its own, without being asked to reload.
      state.liveDone = true;
      await expect(main.getByText('Finished · not live')).toBeVisible({ timeout: 30_000 });
      await expect(main.getByRole('region', { name: 'Run result' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-finished-live`, { height: 1400 });
      expect(critical).toEqual([]);
    });

    test('job-detail /app/:org/:project/jobs/:job · cancel, retry and the ways a run ends without a result', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      // Cancelling a run that is going, and a run that had already finished (409).
      await page.goto(`${ROOT}/jobs/job-running-2`);
      await main.getByRole('button', { name: 'Cancel run' }).click();
      await expect(main.getByText('Cancellation requested. The engine stops at its next check.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
      expect(state.sent.cancel).toBe('job-running-2');
      await capture(page, testInfo, `detail-${name}-cancel`, { height: 1300 });
      state.refuse.cancel = detail(409, 'terminal_job', 'The job is already terminal.');
      await page.reload();
      await main.getByRole('button', { name: 'Cancel run' }).click();
      await expect(main.getByText('Already finished (409 · terminal_job)')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-409`, { height: 1300 });

      // A failed run says why, and a retry is a new attempt.
      await page.goto(`${ROOT}/jobs/job-failed-4`);
      await expect(main.getByRole('alert').filter({ hasText: 'The run failed' })).toContainText('Retrying starts a new attempt.');
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByText('Retry queued as a new attempt.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/jobs/job-new-9`);
      expect(state.sent.retry).toBe('job-failed-4');
      await capture(page, testInfo, `detail-${name}-failed-retry`, { height: 1500 });
      state.refuse.retry = json({ detail: { code: 'concurrency_limit_exceeded', error: 'Concurrency limit exceeded.', concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 } } }, 429);
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByText(/Retry refused: All your job slots are busy \(429/)).toBeVisible();
      await capture(page, testInfo, `detail-${name}-429`, { height: 1500 });

      // Cancelled, and infeasible with the rule it breaks.
      await page.goto(`${ROOT}/jobs/job-cancelled-5`);
      await expect(main.getByText('Cancelled before producing a result.')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-cancelled`, { height: 1300 });
      await page.goto(`${ROOT}/jobs/job-infeasible-6`);
      const why = main.getByRole('region', { name: 'Why no combination works' });
      await expect(why).toContainText('Total latency is 742 ms');
      await expect(why.getByRole('link', { name: 'See the rules' })).toHaveAttribute('href', `${ROOT}/cases/flujo-checkout/revisions/2`);
      await expect(main.getByRole('heading', { name: 'What if one task used another provider?' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-infeasible`, { height: 1700 });
      expect(critical).toEqual([]);
    });

    test('job-detail /app/:org/:project/jobs/:job · a run that is not yours and a key without access', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      // A run of another member, or one that does not exist: the same neutral answer, even for an administrator.
      await page.goto(`${ROOT}/jobs/job-theirs-8`);
      await expect(main.getByRole('heading', { name: 'Job not found' })).toBeVisible();
      await expect(main.getByText(/Everyone else, including platform administrators, gets this same answer\./)).toBeVisible();
      await expect(main.getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', `${ROOT}/jobs`);
      await capture(page, testInfo, `detail-${name}-404`);

      state.refuse.detail = detail(403, 'api_key_forbidden', 'The API key does not include jobs:read.');
      await page.goto(`${ROOT}/jobs/job-feasible-1`);
      await expect(main.getByText(/This API key can’t read jobs or doesn’t include this engine \(403/)).toBeVisible();
      await capture(page, testInfo, `detail-${name}-403-key`);

      state.refuse.detail = unavailable;
      await page.goto(`${ROOT}/jobs/job-feasible-1`);
      await expect(main.getByText(/The job couldn’t be loaded \(503/)).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Job not found' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-503`);
      expect(critical).toEqual([]);
    });

    test('job-launch /app/:org/:project/jobs/new · from a revision: four steps, what the plan reduces, accepted', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/jobs/new?case=flujo-checkout&revision=2`);
      const main = page.locator('#platform-main');
      const next = main.getByRole('button', { name: 'Continue' });

      await expect(main.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Jobs', exact: true })).toHaveAttribute('aria-current', 'page');
      const source = main.getByRole('radiogroup', { name: 'Source' });
      await expect(source.getByRole('radio', { name: /Flujo de checkout · revision 2/ })).toBeChecked();
      await expect(source.getByRole('radio')).toHaveCount(2);
      await capture(page, testInfo, `launch-${name}-step1`);

      await next.click();
      const engineGroup = main.getByRole('radiogroup', { name: 'Engine' });
      await expect(engineGroup.getByRole('radio', { name: /^random-search.*Can run this/ })).toBeChecked();
      await expect(engineGroup.getByRole('radio', { name: /^edge-solver.*It cannot read a RoutingOverlay\./ })).toBeDisabled();
      await expect(engineGroup.getByRole('radio')).toHaveCount(3);
      await capture(page, testInfo, `launch-${name}-step2`);

      await next.click();
      const budget = main.getByLabel('Time budget');
      await expect(budget).toHaveValue('30');
      await budget.fill('600');
      await expect(main.getByText('60 s (reduced)')).toBeVisible();
      await expect(main.getByText('Values above your plan run at the ceiling and the job carries a note; it isn’t an error.')).toBeVisible();
      await capture(page, testInfo, `launch-${name}-step3`);

      await next.click();
      await expect(main.getByRole('heading', { name: 'Before you send' })).toBeVisible();
      await expect(main.getByText('Time budget 60 s (reduced) · Iterations 100,000 iterations')).toBeVisible();
      await expect(main.getByText(/used \+ up to/)).toHaveCount(0);
      await expect(main.getByText('≈ 10^5.1 of up to 10^20 on your RESEARCH plan')).toBeVisible();
      await capture(page, testInfo, `launch-${name}-step4`);

      await main.getByRole('button', { name: 'Send run' }).click();
      await expect(main.getByRole('heading', { name: 'Run accepted · queued' })).toBeVisible();
      await expect(main.getByText(/Time budget was reduced to 60 s, what your plan allows; the job carries that note\./)).toBeVisible();
      expect(state.sent.launch).toMatchObject({ snapshot: 'snapshot-2', engine: ENGINE, registration: REGISTRATION, mode: 'sampling', options: { time_budget_ms: 600000, iterations: 100000 } });
      expect(state.sent.key).toMatch(/^[0-9a-f-]{36}$/);
      await capture(page, testInfo, `launch-${name}-accepted`);

      await main.getByRole('link', { name: 'Follow the run' }).click();
      await expect(page).toHaveURL(new RegExp(`${ROOT}/jobs/job-new-9$`));
      await expect(main.getByRole('heading', { level: 1, name: 'random-search run' })).toBeVisible();
      await expect(main.getByText('Live · connected')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Settings asked and used' }).getByRole('row', { name: /Time budget/ })).toContainText('Reduced to the plan’s ceiling');
      await capture(page, testInfo, `launch-${name}-followed`, { height: 1500 });
      expect(critical).toEqual([]);
    });

    test('job-launch /app/:org/:project/jobs/new · an exact engine from a snapshot and every way the gateway refuses', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/jobs/new?snapshot=snapshot-2`);
      const main = page.locator('#platform-main');
      const next = main.getByRole('button', { name: 'Continue' });

      await expect(main.getByRole('radio', { name: /Snapshot snapshot/ })).toBeChecked();
      await next.click();
      await expect(main.getByRole('radiogroup', { name: 'Engine' }).getByRole('radio', { name: /^random-search/ })).toBeChecked();
      await next.click();
      await next.click();
      const send = main.getByRole('button', { name: 'Send run' });

      // 402: out of an allowance.
      state.refuse.launch = detail(402, 'quota_exceeded', 'Storage exhausted.', { quota: { limit_id: 'storageBytes', limit: 50, used: 50 } });
      await send.click();
      // An error is an alert; a refusal that is about the plan or the credential is a status. Either way it is the one notice on screen.
      const refusal = main.locator('.ui-notice');
      await expect(refusal).toContainText('Out of storage (402 · quota_exceeded)');
      await expect(refusal).toContainText('You’ve used 50 of 50 storage. Nothing was started.');
      await expect(refusal.getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/app/account/usage');
      await expect(send).toBeEnabled();
      await capture(page, testInfo, `launch-${name}-402`);
      expect(state.sent.launch).toMatchObject({ snapshot: 'snapshot-2', engine: ENGINE, mode: 'sampling' });

      // 402: too big for the plan.
      state.refuse.launch = detail(402, 'instance_complexity_too_large', 'instance binding space exceeds the caller plan limit', { quota: { limit_id: 'maxInstanceComplexityLog10', limit: 9 } });
      await send.click();
      await expect(refusal).toContainText('Too big for your plan (402 · instance_complexity_too_large)');
      await capture(page, testInfo, `launch-${name}-402-size`);

      // 429: job slots busy, with the time to wait.
      state.refuse.launch = (route) => route.fulfill({
        status: 429, headers: { 'Retry-After': '15' },
        json: { detail: { code: 'concurrency_limit_exceeded', error: 'Concurrency limit exceeded.', concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 } } },
      });
      await send.click();
      await expect(refusal).toContainText('All your job slots are busy (429 · concurrency_limit_exceeded)');
      await expect(refusal).toContainText('You can run 3 jobs at once.');
      await expect(refusal.getByRole('timer')).toContainText('A slot should free up in about');
      await capture(page, testInfo, `launch-${name}-429`);

      // 403: the plan does not include it, and a key without the permission.
      state.refuse.launch = detail(403, 'feature_not_entitled', 'Federated runs need the federated engines feature.');
      await send.click();
      await expect(refusal).toContainText('Not included in your plan (403 · feature_not_entitled)');
      await capture(page, testInfo, `launch-${name}-403-plan`);
      state.refuse.launch = detail(403, 'api_key_forbidden', 'The API key does not include engines:execute.');
      await send.click();
      await expect(refusal).toContainText('This credential can’t start runs (403 · api_key_forbidden)');
      await expect(refusal.getByText('engines:execute', { exact: true })).toBeVisible();
      await capture(page, testInfo, `launch-${name}-403-key`);

      // 422: the mode cannot run it; 404: the key does not allow the engine; 409; 503.
      state.refuse.launch = json({ title: 'engine_mode_incompatible', status: 422, detail: 'The mode cannot run it.', diagnostics: [{ message: 'The mode cannot place a RoutingOverlay.' }] }, 422);
      await send.click();
      await expect(refusal).toContainText('This engine can’t run this problem');
      await expect(refusal).toContainText('The mode cannot place a RoutingOverlay.');
      await capture(page, testInfo, `launch-${name}-422`);
      state.refuse.launch = detail(404, 'not_found', 'Engine revision not found.');
      await send.click();
      await expect(refusal).toContainText('Engine not available with this key (404 · not_found)');
      state.refuse.launch = detail(503, 'pricing_unavailable', 'The pricing service is not reachable.');
      await send.click();
      await expect(refusal).toContainText('Limits can’t be checked right now (503 · pricing_unavailable)');
      await expect(main.getByRole('heading', { name: /Run accepted/ })).toHaveCount(0);
      await capture(page, testInfo, `launch-${name}-503`);
      expect(critical).toEqual([]);
    });

    test('job-launch /app/:org/:project/jobs/new · a viewer, a snapshot that is not there and a problem too big for the plan', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto('/app/read-lab/bench/jobs/new');
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER of Read Lab. You can look through the steps, but starting a run needs MEMBER.');
      await expect(main.getByText(/Nothing to solve yet\./)).toBeVisible();
      await capture(page, testInfo, `launch-${name}-viewer`);

      state.refuse.validate = detail(404, 'not_found', 'Snapshot not found.');
      await page.goto(`${ROOT}/jobs/new?snapshot=snapshot-ghost`);
      await main.getByRole('button', { name: 'Continue' }).click();
      await expect(main.getByText('Snapshot not found (404)')).toBeVisible();
      await expect(main.getByRole('radiogroup', { name: 'Engine' })).toHaveCount(0);
      await capture(page, testInfo, `launch-${name}-snapshot-404`);

      state.refuse.validate = detail(402, 'instance_complexity_too_large', 'instance binding space exceeds the caller plan limit', { quota: { limit_id: 'maxInstanceComplexityLog10', limit: 9 } });
      await page.goto(`${ROOT}/jobs/new?case=flujo-checkout&revision=2`);
      await main.getByRole('button', { name: 'Continue' }).click();
      await expect(main.getByRole('alert')).toContainText('Too big for your plan (402 · instance_complexity_too_large)');
      await expect(main.getByRole('radiogroup', { name: 'Engine' }).getByRole('radio', { name: /^random-search.*Checked when you send/ })).toBeEnabled();
      await capture(page, testInfo, `launch-${name}-402-analysis`);
      expect(critical).toEqual([]);
    });

    test('job-history /app/jobs · my jobs across projects, retention, filters and actions', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/jobs');
      const main = page.locator('#platform-main');
      const list = main.getByRole('list', { name: 'Your jobs' });

      await expect(main.getByRole('heading', { level: 1, name: 'My jobs' })).toBeVisible();
      await expect(main.getByText('Everything you’ve run, across projects.')).toBeVisible();
      await expect(list.getByRole('listitem')).toHaveCount(8);
      await expect(list.getByRole('link', { name: 'random-search on QoS Benchmarks' }).first()).toHaveAttribute('href', `${ROOT}/jobs/job-queued-3`);
      await expect(main.getByText('8 in total')).toBeVisible();
      const retention = main.getByRole('region', { name: 'How long runs are kept' });
      await expect(retention.getByText('Finished jobs are kept 180 days on your RESEARCH plan')).toBeVisible();
      await expect(retention.getByText('Longer retention comes with larger plans, arranged by agreement.')).toBeVisible();
      await expect(retention.getByText('PRO', { exact: true })).toBeVisible();
      await expect(list.getByRole('button', { name: 'Cancel' })).toHaveCount(3);
      await expect(list.getByRole('button', { name: 'Retry' })).toHaveCount(2);
      await expect(list.getByRole('link', { name: 'Analyze' })).toHaveCount(0);
      await capture(page, testInfo, `history-${name}-list`);

      await main.getByRole('button', { name: 'Completed (3)' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await main.getByRole('combobox', { name: 'Engine' }).selectOption('minizinc');
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await capture(page, testInfo, `history-${name}-filtered`);
      await main.getByRole('button', { name: 'All (8)' }).click();
      await main.getByRole('combobox', { name: 'Engine' }).selectOption('');

      // Cancel one that is going, retry one that failed, and one the account cannot afford.
      await list.getByRole('listitem').filter({ hasText: 'minizinc' }).first().getByRole('button', { name: 'Cancel' }).click();
      await expect(main.getByText('Cancellation requested.')).toBeVisible();
      expect(state.sent.cancel).toBe('job-running-2');
      await capture(page, testInfo, `history-${name}-cancel`);
      await list.getByRole('listitem').filter({ hasText: 'evolutionary' }).first().getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByText('Retry queued.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute('href', `${ROOT}/jobs/job-new-9`);
      state.refuse.retry = detail(402, 'quota_exceeded', 'Storage exhausted.', { quota: { limit_id: 'storageBytes', limit: 10, used: 10 } });
      await list.getByRole('listitem').filter({ hasText: 'random-search' }).getByRole('button', { name: 'Retry' }).first().click();
      await expect(main.getByText('Retry refused: Out of storage (402 · quota_exceeded)')).toBeVisible();
      await capture(page, testInfo, `history-${name}-402`);
      expect(critical).toEqual([]);
    });

    test('job-history /app/jobs · empty, retention unknown, a key without access and a page that does not load', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      state.history = [];
      state.retention = 7;
      await page.goto('/app/jobs');
      await expect(main.getByText('Nothing within your retention window')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Start a run' })).toBeVisible();
      await expect(main.getByText('Finished jobs are kept 7 days on your RESEARCH plan')).toBeVisible();
      await capture(page, testInfo, `history-${name}-empty`);

      state.history = ownRows;
      state.retention = null;
      await page.goto('/app/jobs');
      await expect(main.getByText('Retention can’t be confirmed right now')).toBeVisible();
      await expect(main.getByText('Your list still loads; only the retention figure is missing.')).toBeVisible();
      await expect(main.getByRole('list', { name: 'Your jobs' }).getByRole('listitem')).toHaveCount(8);
      await capture(page, testInfo, `history-${name}-retention-503`);

      state.refuse.history = detail(403, 'api_key_forbidden', 'The API key does not include jobs:read.');
      await page.goto('/app/jobs');
      await expect(main.getByText(/This API key doesn’t include “read jobs” \(403/)).toBeVisible();
      await expect(main.getByRole('list', { name: 'Your jobs' })).toHaveCount(0);
      await capture(page, testInfo, `history-${name}-403-key`);

      state.refuse.history = unavailable;
      await page.goto('/app/jobs');
      await expect(main.getByText(/Your jobs can’t be loaded right now \(503/)).toBeVisible();
      await capture(page, testInfo, `history-${name}-503`);
      state.refuse.history = undefined;
      state.retention = 180;
      await main.getByRole('button', { name: 'Try again' }).click();
      await expect(main.getByRole('list', { name: 'Your jobs' })).toBeVisible();
      expect(critical).toEqual([]);
    });
  });
}
