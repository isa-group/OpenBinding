import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { Job, Study, StudyCell, StudyRun } from '../src/api/platform';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { jobOf } from '../src/test/fixtures/jobs';
import { digestOf as resourceDigest, usageOf } from '../src/test/fixtures/resources';
import {
  CHECKOUT, EVOLUTIONARY, RANDOM_SEARCH, REVISION_1, REVISION_2, RUN_ID, VERSION_ID, analyticsFixture, cellFixture, cellsFixture, revisionFixture, runFixture, studyFixture,
} from '../src/test/fixtures/studies';

// S7a · studies: study-list, study-builder, study-detail, study-run, study-cell and study-analytics.
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

// --- the studies of the project

const NEW_RUN_ID = '00000000-0000-4000-8000-000000000102';
const LIVE_RUN_ID = '00000000-0000-4000-8000-000000000111';

const liveStudy = studyFixture({ id: 'study-live-sweep', slug: 'live-sweep', name: 'Live sweep', definition_artifact_id: 'artifact-live-sweep', definition: { case_revision_ids: [REVISION_2.id], engines: [RANDOM_SEARCH], parameter_sets: [{}], seeds: [1, 2, 3, 4, 5, 6] } });
const placement = studyFixture({ id: 'study-placement', slug: 'placement-sweep', name: 'Placement sweep', description: 'Pools and latencies on the edge.', definition_artifact_id: 'artifact-placement' });
const oldStudy = studyFixture({ id: 'study-old', slug: 'old-study', name: 'Old study', archived: true, definition_artifact_id: 'artifact-old' });

/** The cells of the run that is still going: two done, two solving, two waiting; once `done` is set, all of them completed. */
function liveCells(done: boolean): StudyCell[] {
  const metrics = (n: number) => ({ status: 'completed', feasible: true, termination: 'FEASIBLE', objectives: { cost: 0.1 + n / 100, latency: 400 + n }, runtimeSeconds: 55 + n, engine: 'bim.builtin/random-search@1.0.0', seed: n + 1 });
  return Array.from({ length: 6 }, (_, n) => {
    const state = done || n < 2 ? 'completed' : n < 4 ? 'running' : 'queued';
    return cellFixture(n, REVISION_2, RANDOM_SEARCH, n + 1, state, state === 'completed' ? metrics(n) : {}, {
      id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`, study_run_id: LIVE_RUN_ID,
    });
  });
}

const liveRun = (done: boolean): StudyRun => runFixture({
  id: LIVE_RUN_ID, study_id: liveStudy.id, definition_version_id: 'version-live', run_number: 1, state: done ? 'completed' : 'running', cells: 6,
  created_at: '2026-10-09T08:00:00Z', finished_at: done ? '2026-10-09T08:06:00Z' : null,
});

// --- the jobs an account could attach to a cell

const mineJobs: Job[] = [
  jobOf('job-mine-a', 'random-search', 'completed', 'FEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:01:05Z', { project_id: 'project-1' }),
  jobOf('job-mine-b', 'evolutionary', 'failed', 'UNKNOWN', '2026-10-02T09:00:00Z', '2026-10-02T09:00:20Z', { project_id: 'project-1' }),
];
const otherJobs: Job[] = [jobOf('job-theirs', 'minizinc', 'completed', 'OPTIMAL', '2026-10-03T09:00:00Z', '2026-10-03T09:02:00Z', { project_id: 'project-1' })];

// --- what the gateway answers

const mode = (id: string, properties: Record<string, unknown>) => ({
  id, profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm: id, capabilities: {},
  optionsSchema: { type: 'object', properties, additionalProperties: false }, limits: {}, guarantees: { termination: ['FEASIBLE'], exact: false },
});

const engineEntry = (ref: typeof RANDOM_SEARCH) => {
  const { mode: id, ...identity } = ref;
  return { ...identity, id: `engine-${identity.name}`, ref: identity, modes: [mode(id, { time_budget_ms: { type: 'integer', default: 30000 } })] };
};


const artifact = (id: string, kind: string, display: string) => ({
  id, organization_id: 'org-isa-demo', namespace: 'isa-demo', name: id, display_name: display, kind, description: '', labels: {}, archived: false, created_at: '2026-08-01T00:00:00Z',
});

const version = (id: string, artifactId: string, ordinal: number) => ({
  id, artifact_id: artifactId, ordinal, ref: { namespace: 'isa-demo', name: artifactId, version: String(ordinal), versionDigest: resourceDigest('v') },
  contentDigest: resourceDigest('e'), manifest: { mediaType: 'application/json', contracts: [], dependencies: [] }, based_on_id: null, public: false, withdrawn: false,
});

type Overridable = 'studies' | 'create' | 'run' | 'cancel' | 'retry' | 'attach' | 'update' | 'delete' | 'runs' | 'cells' | 'cell' | 'analytics' | 'report';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Overridable, Handler>>;
  /** What each write carried, to check what was sent. */
  sent: { create?: unknown; run?: string; cancel?: string; retry: string[]; attach?: { cell: string; job: unknown }; update: unknown[]; deleted: string[]; report?: unknown };
  studies: Study[];
  runs: Record<string, StudyRun[]>;
  cells: Record<string, StudyCell[]>;
  /** The live run has finished: the next time it is asked about it says so. */
  liveDone: boolean;
}

interface MockOptions {
  /** The account's role in ISA Demo Group. */
  role?: Role;
}

const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

const analyticsBody = () => analyticsFixture();

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = {
    refuse: {},
    sent: { retry: [], update: [], deleted: [] },
    studies: [studyFixture(), liveStudy, placement, oldStudy],
    runs: { 'engines-vs-seeds': [runFixture()], 'live-sweep': [liveRun(false)] },
    cells: { [RUN_ID]: cellsFixture(), [LIVE_RUN_ID]: liveCells(false) },
    liveDone: false,
  };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'OWNER'),
    org('org-4', 'read-lab', 'Read Lab', 'VIEWER', 'user-nora'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's7a-access');
    localStorage.setItem('openbinding-refresh-token', 's7a-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's7a-access-2', refresh_token: 's7a-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf({
    plan: 'RESEARCH',
    capabilities: { maxPayloadBytes: 134_217_728, maxTimeoutSeconds: 60, maxIterations: 1_000_000, studies: 25, concurrentJobs: 3 },
  })));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines`, json({ engines: [engineEntry(RANDOM_SEARCH), engineEntry(EVOLUTIONARY)] }));

  // The versions of the library's artifacts: the study definitions that can be reused and the collections.
  await page.route(new RegExp(`^${API}/v1/artifacts/[^/]+/versions(/.*)?(\\?.*)?$`), (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    const [, , artifactId, , versionId, tail] = parts;
    if (tail === 'content') {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: JSON.stringify({ apiVersion: 'openbinding/study/v1', cases: [{}, {}], engines: [{}, {}], parameter_sets: [{}], seeds: [1, 2] }) });
    }
    if (versionId) return json(version(versionId, artifactId, 1))(route);
    return json([version(artifactId === 'artifact-engines-vs-seeds' ? VERSION_ID : `${artifactId}-v1`, artifactId, 1), version(`${artifactId}-v2`, artifactId, 2)])(route);
  });

  // The jobs of this account, to attach one to a cell.
  await page.route(new RegExp(`^${API}/v1/jobs(\\?.*)?$`), json(mineJobs));
  await page.route(new RegExp(`^${API}/v1/jobs/[^/]+$`), json({ id: 'job-mine-a', status: 'completed', result: { termination: 'FEASIBLE', solutions: [] } }));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , orgSlug, section, projectSlug, sub, subId, action, actionId, tail, cellId, verb] = parts;
    const method = route.request().method();
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'library') {
      return json([
        artifact('artifact-engines-vs-seeds', 'Study', 'Engines × seeds'),
        artifact('artifact-core', 'Collection', 'Core checkout set'),
        artifact('artifact-catalog', 'CandidateCatalog', 'Providers'),
      ])(route);
    }
    if (section === 'members') return json([])(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = projectsOf[orgSlug] ?? [];
    if (!projectSlug) return json(list)(route);
    const current = list.find((item) => item.slug === projectSlug);
    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    if (!sub) return json(current)(route);

    if (sub === 'cases') {
      if (!subId) return json([CHECKOUT])(route);
      if (action === 'revisions') return json([REVISION_1, REVISION_2, revisionFixture(3, { source_snapshot_id: null })])(route);
      return json(CHECKOUT)(route);
    }
    if (sub === 'jobs') return json([...mineJobs, ...otherJobs])(route);
    if (sub === 'reports') {
      if (method === 'POST') {
        state.sent.report = bodyOf(route);
        if (state.refuse.report) return state.refuse.report(route);
        const sent = bodyOf(route);
        return json({
          artifact_id: 'artifact-report', version_id: null, draft_id: 'draft-1', draft_revision: 1, id: 'report-1', project_id: current.id, study_run_id: sent.study_run_id ?? null,
          slug: sent.slug, title: sent.title, document: sent.document, digest: '', state: 'draft', created_at: '2026-10-09T09:00:00Z',
        }, 201)(route);
      }
      return json([])(route);
    }
    if (sub !== 'studies') return json([])(route);

    // --- studies
    const studies = projectSlug === 'checkout-privado' ? [] : state.studies;
    if (!subId) {
      if (method === 'POST') {
        state.sent.create = bodyOf(route);
        if (state.refuse.create) return state.refuse.create(route);
        const sent = bodyOf(route) as { slug: string; name: string; description: string; definition?: Study['definition'] };
        if (state.studies.some((item) => item.slug === sent.slug)) return detail(409, 'slug_conflict', 'That study slug is in use.')(route);
        const made = studyFixture({
          id: `study-${sent.slug}`, slug: sent.slug, name: sent.name, description: sent.description, definition_artifact_id: `artifact-${sent.slug}`,
          ...(sent.definition ? { definition: sent.definition } : {}),
        });
        state.studies.push(made);
        return json(made, 201)(route);
      }
      if (state.refuse.studies) return state.refuse.studies(route);
      return json(studies)(route);
    }
    const study = studies.find((item) => item.slug === subId);
    if (!study) return detail(404, 'not_found', 'Study not found.')(route);
    if (!action) {
      if (method === 'PATCH') {
        const sent = bodyOf(route);
        state.sent.update.push(sent);
        if (state.refuse.update) return state.refuse.update(route);
        Object.assign(study, sent);
        return json(study)(route);
      }
      if (method === 'DELETE') {
        state.sent.deleted.push(study.slug);
        if (state.refuse.delete) return state.refuse.delete(route);
        if ((state.runs[study.slug] ?? []).length > 0) return detail(409, 'study_history_retained', 'Set archived=true for a study with executions; historical runs cannot be deleted.')(route);
        state.studies = state.studies.filter((item) => item.slug !== study.slug);
        return route.fulfill({ status: 204 });
      }
      return json(study)(route);
    }
    if (action !== 'runs') return json([])(route);

    // --- runs of a study
    const runs = (): StudyRun[] => {
      if (study.slug === 'live-sweep') return [liveRun(state.liveDone)];
      return state.runs[study.slug] ?? [];
    };
    const cellsOf = (run: string): StudyCell[] => (run === LIVE_RUN_ID ? liveCells(state.liveDone) : state.cells[run] ?? []);
    if (!actionId) {
      if (method === 'POST') {
        state.sent.run = url.searchParams.get('definition_version_id') ?? '';
        if (state.refuse.run) return state.refuse.run(route);
        const made = runFixture({ id: NEW_RUN_ID, run_number: 2, state: 'queued', finished_at: null, created_at: '2026-10-09T09:30:00Z' });
        state.runs[study.slug] = [made, ...(state.runs[study.slug] ?? [])];
        state.cells[NEW_RUN_ID] = cellsFixture().map((cell) => ({
          ...cell, id: `00000000-0000-4000-8000-0000000005${String(cell.ordinal).padStart(2, '0')}`, study_run_id: NEW_RUN_ID, state: 'queued' as const, metrics: {}, job_id: null,
        }));
        return json(made, 202)(route);
      }
      if (state.refuse.runs) return state.refuse.runs(route);
      return json(runs())(route);
    }
    const run = runs().find((item) => item.id === actionId);
    if (!tail) return json(run ?? { detail: 'not found' }, run ? 200 : 404)(route);
    if (tail === 'analytics') {
      if (state.refuse.analytics) return state.refuse.analytics(route);
      return json(analyticsBody())(route);
    }
    if (tail === 'cancel') {
      state.sent.cancel = actionId;
      if (state.refuse.cancel) return state.refuse.cancel(route);
      return json({ ...(run ?? runFixture()), state: 'cancelled' })(route);
    }
    if (tail !== 'cells') return json([])(route);
    if (!cellId) {
      if (state.refuse.cells) return state.refuse.cells(route);
      return json(cellsOf(actionId))(route);
    }
    const cell = cellsOf(actionId).find((item) => item.id === cellId);
    if (!verb) {
      if (state.refuse.cell) return state.refuse.cell(route);
      return cell ? json(cell)(route) : detail(404, 'not_found', 'Study cell not found.')(route);
    }
    if (verb === 'retry') {
      state.sent.retry.push(cellId);
      if (state.refuse.retry) return state.refuse.retry(route);
      return json({ id: cellId, state: 'queued', fingerprint: cell?.fingerprint ?? '', jobId: 'job-new', idempotent: false }, 200)(route);
    }
    if (verb === 'result') {
      state.sent.attach = { cell: cellId, job: bodyOf(route) };
      if (state.refuse.attach) return state.refuse.attach(route);
      return json({ id: cellId, state: 'completed', metrics: {} })(route);
    }
    return json({})(route);
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
const STUDY = `${ROOT}/studies/engines-vs-seeds`;
const RUN = `${STUDY}/runs/${RUN_ID}`;
const cells = cellsFixture();
const cellPath = (ordinal: number) => `${RUN}/cells/${cells[ordinal].id}`;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S7a studies`, () => {
    // One worker per viewport: with every test in parallel the browsers starve each other and the same walk takes twice as long.
    test.describe.configure({ mode: 'default' });
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('study-list /app/:org/:project/studies · rows, archive and delete, with no allowance meter', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/studies`);
      const main = page.locator('#platform-main');
      const list = main.getByRole('list', { name: 'Studies of the project' });

      await expect(main.getByRole('heading', { level: 1, name: 'Studies' })).toBeVisible();
      await expect(main.getByText(/A study runs every combination of cases × engines × settings × seeds/)).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Studies', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('link', { name: 'New study' })).toHaveAttribute('href', `${ROOT}/studies/new`);
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await expect(list.getByRole('link', { name: 'Last run #1' }).first()).toHaveAttribute('href', RUN);
      await expect(list.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeVisible();
      await expect(list.getByRole('img', { name: '2 completed, 2 running, 2 queued of 6 cells' })).toBeVisible();
      await expect(list.getByText('Never run')).toBeVisible();
      await expect(main.getByText(/study runs this month|Renews/i)).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-rows`);

      // Archived studies appear on request.
      await main.getByRole('checkbox', { name: /Show archived studies/ }).check();
      await expect(list.getByRole('listitem')).toHaveCount(4);
      await expect(list.getByRole('button', { name: 'Restore' })).toBeVisible();
      await capture(page, testInfo, `list-${name}-archived`);
      await main.getByRole('checkbox', { name: /Show archived studies/ }).uncheck();

      // Archive one; delete one with runs (the gateway refuses, so it is archived instead); delete one without.
      const row = (title: string) => list.getByRole('listitem').filter({ hasText: title });
      await row('Placement sweep').getByRole('button', { name: 'Archive' }).click();
      await expect(main.getByText('Archived: it can’t start new runs, and existing results stay.')).toBeVisible();
      expect(state.sent.update).toContainEqual({ archived: true });
      await capture(page, testInfo, `list-${name}-archived-toast`);

      await row('Engines × seeds').getByRole('button', { name: 'Delete' }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete Engines × seeds?' });
      await expect(dialog).toBeVisible();
      await capture(page, testInfo, `list-${name}-delete-dialog`);
      await dialog.getByRole('button', { name: 'Delete study' }).click();
      await expect(main.getByText('This study has runs, so it was archived instead of deleted. Results cited by reports stay intact.')).toBeVisible();
      expect(state.sent.deleted).toEqual(['engines-vs-seeds']);
      await capture(page, testInfo, `list-${name}-delete-archives`);
      expect(critical).toEqual([]);
    });

    test('study-list /app/:org/:project/studies · empty, 503, a viewer and a project that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto('/app/isa-demo/checkout-privado/studies');
      await expect(main.getByText('No studies yet')).toBeVisible();
      await expect(main.getByText('2 case revisions × 2 engines × 2 seeds = 8 runs, all with the same rules. That’s a study.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Build a study' })).toHaveAttribute('href', '/app/isa-demo/checkout-privado/studies/new');
      await capture(page, testInfo, `list-${name}-empty`);

      state.refuse.studies = unavailable;
      await page.goto(`${ROOT}/studies`);
      await expect(main.getByRole('alert').filter({ hasText: 'Studies couldn’t be loaded' })).toContainText('(503)');
      await expect(main.getByText('No studies yet')).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-503`);
      state.refuse.studies = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('list', { name: 'Studies of the project' })).toBeVisible();

      // A viewer reads; nothing on the screen creates, archives or deletes.
      await page.goto('/app/read-lab/bench/studies');
      await expect(main.getByRole('heading', { level: 1, name: 'Studies' })).toBeVisible();
      await expect(main.getByRole('list', { name: 'Studies of the project' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'New study' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Archive' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Delete' })).toHaveCount(0);
      // Nothing is counted per account here, so a viewer is told nothing about the sponsor's plan or usage.
      await expect(main.getByText(/sponsor’s plan|usage isn’t shown/)).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-viewer`);

      await page.goto('/app/isa-demo/ghost/studies');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await capture(page, testInfo, `list-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('study-builder /app/:org/:project/studies/new · the matrix, what it uses of the plan, created', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/studies/new`);
      const main = page.locator('#platform-main');
      const create = main.getByRole('button', { name: 'Create study' });

      await expect(main.getByRole('heading', { level: 1, name: 'New study' })).toBeVisible();
      await expect(main.getByText('Pick the cases, engines, settings and seeds. Every combination becomes one cell.')).toBeVisible();
      await expect(main.getByRole('checkbox', { name: /Checkout flow · revision 3/ })).toBeDisabled();
      await expect(main.getByText(/No compiled snapshot yet, so engines have nothing to run/)).toBeVisible();
      await expect(create).toBeDisabled();
      await expect(main.getByRole('list', { name: 'Still needed' })).toContainText('Choose at least one engine mode.');
      await capture(page, testInfo, `builder-${name}-empty`);

      await main.getByRole('checkbox', { name: /Checkout flow · revision 1/ }).check();
      await main.getByRole('checkbox', { name: /Checkout flow · revision 2/ }).check();
      await main.getByRole('checkbox', { name: /random-search 1\.0\.0/ }).check();
      await main.getByRole('checkbox', { name: /evolutionary 1\.0\.0/ }).check();
      await main.getByLabel('Study name').fill('Budgets and seeds');
      await expect(main.getByLabel('Address')).toHaveValue('budgets-and-seeds');
      await main.getByRole('button', { name: 'Add a setting' }).click();
      await main.getByLabel('Time budget (seconds)').nth(1).fill('120');
      await expect(main.getByText(/Your plan runs at most 60 s per solve, so this setting runs at 60 s/)).toBeVisible();
      await main.getByLabel(/Seeds \(comma-separated/).fill('1-3');

      const aside = main.getByRole('complementary', { name: 'Matrix and plan' });
      await expect(aside.getByText('2 case revisions × 2 engines × 2 settings × 3 seeds')).toBeVisible();
      await expect(aside.getByText(/used \+ up to|study runs this month/)).toHaveCount(0);
      await expect(aside.getByText(/your plan lets one solve run for up to 60 s/)).toBeVisible();
      await expect(create).toBeEnabled();
      await capture(page, testInfo, `builder-${name}-filled`);

      await create.click();
      await expect(main.getByRole('heading', { name: 'Study created' })).toBeVisible();
      expect(state.sent.create).toMatchObject({
        slug: 'budgets-and-seeds', name: 'Budgets and seeds', description: '',
        definition: {
          case_revision_ids: [REVISION_1.id, REVISION_2.id],
          parameter_sets: [{}, { time_budget_ms: 120000 }],
          seeds: [1, 2, 3],
        },
      });
      await expect(main.getByRole('link', { name: 'Open the study' })).toHaveAttribute('href', `${ROOT}/studies/budgets-and-seeds`);
      await capture(page, testInfo, `builder-${name}-created`);

      await main.getByRole('link', { name: 'Open the study' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Budgets and seeds' })).toBeVisible();
      await expect(main.getByText('No runs yet. Running uses 1 study run from your month and runs up to 24 cells.')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('study-builder /app/:org/:project/studies/new · 422, 402, 403 and 409 before and after sending', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${ROOT}/studies/new?case=checkout-flow&revision=2`);
      const main = page.locator('#platform-main');
      const create = main.getByRole('button', { name: 'Create study' });

      // The revision another screen named is already chosen.
      await expect(main.getByRole('checkbox', { name: /Checkout flow · revision 2/ })).toBeChecked();
      await expect(main.getByRole('checkbox', { name: /Checkout flow · revision 1/ })).not.toBeChecked();
      await main.getByRole('checkbox', { name: /random-search 1\.0\.0/ }).check();
      await main.getByLabel('Study name').fill('Refused study');

      // Repeated seeds and repeated settings never leave the page.
      await main.getByLabel(/Seeds \(comma-separated/).fill('1, 2, 2');
      await expect(main.locator('small[role="alert"]')).toContainText('Seed 2 appears twice. Each value can appear once.');
      await expect(create).toBeDisabled();
      await capture(page, testInfo, `builder-${name}-422-seeds`, { height: 1800 });
      await main.getByLabel(/Seeds \(comma-separated/).fill('1-100');
      for (let n = 0; n < 25; n += 1) await main.getByRole('button', { name: 'Add a setting' }).click();
      await main.getByRole('checkbox', { name: /evolutionary 1\.0\.0/ }).check();
      await main.getByRole('checkbox', { name: /Checkout flow · revision 1/ }).check();
      await expect(main.getByRole('list', { name: 'Still needed' })).toContainText('10,000 limit');
      await expect(create).toBeDisabled();
      await capture(page, testInfo, `builder-${name}-422-too-big`, { area: main.getByRole('complementary', { name: 'Matrix and plan' }) });

      // What the gateway can still refuse.
      await main.getByLabel(/Seeds \(comma-separated/).fill('1, 2');
      for (let n = 0; n < 25; n += 1) await main.getByRole('button', { name: 'Remove setting 2' }).first().click();
      await expect(create).toBeEnabled();
      const side = main.getByRole('complementary', { name: 'Matrix and plan' });

      state.refuse.create = detail(402, 'quota_exceeded', 'Study quota exhausted.', { quota: { limit_id: 'studies', limit: 25, used: 25 } });
      await create.click();
      await expect(side.getByText('The sponsor has no study definitions left (402 · quota_exceeded)')).toBeVisible();
      await expect(side.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      await capture(page, testInfo, `builder-${name}-402`, { area: side });

      state.refuse.create = detail(403, 'api_key_engine_forbidden', 'This API key does not grant every exact Engine revision requested by the study.');
      await create.click();
      await expect(side.getByText('This API key isn’t allowed to use one of the study’s engines (403 · api_key_engine_forbidden)')).toBeVisible();
      await capture(page, testInfo, `builder-${name}-403`, { area: side });

      state.refuse.create = detail(422, 'engine_mode_incompatible', 'MiniZinc has no mode that supports this goal type.');
      await create.click();
      await expect(side.getByText(/MiniZinc has no mode that supports this goal type\./)).toBeVisible();
      await capture(page, testInfo, `builder-${name}-422-engine`, { area: side });

      state.refuse.create = undefined;
      await main.getByLabel('Study name').fill('Engines × seeds');
      await main.getByLabel('Address').fill('engines-vs-seeds');
      await create.click();
      await expect(side.getByText('That address is already used (409 · slug_conflict)')).toBeVisible();
      await capture(page, testInfo, `builder-${name}-409`, { area: side });
      expect(critical).toEqual([]);
    });

    test('study-builder /app/:org/:project/studies/new · a viewer, and reusing a shared definition', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto('/app/read-lab/bench/studies/new');
      await expect(main.getByText(/Creating studies needs MEMBER; you’re a VIEWER of Read Lab/)).toBeVisible();
      await main.getByRole('checkbox', { name: /Checkout flow · revision 1/ }).check();
      await expect(main.getByRole('button', { name: 'Create study' })).toBeDisabled();
      await expect(main.getByLabel('Study name')).toBeDisabled();
      await capture(page, testInfo, `builder-${name}-viewer`, { height: 1500 });

      await page.goto(`${ROOT}/studies/new`);
      await main.getByRole('radio', { name: 'Reuse a shared definition' }).check({ force: true });
      await expect(main.getByRole('option', { name: 'Providers' })).toHaveCount(0);
      await main.getByLabel('Study definition').selectOption({ label: 'Engines × seeds' });
      await main.getByLabel('Sealed version').selectOption({ index: 1 });
      await expect(main.getByText(/From the library · 8 cells/)).toBeVisible();
      await expect(main.getByLabel('Address')).toHaveValue('engines-seeds');
      await capture(page, testInfo, `builder-${name}-adopt`);
      await main.getByRole('button', { name: 'Create from this definition' }).click();
      await expect(main.getByRole('heading', { name: 'Study created' })).toBeVisible();
      expect(state.sent.create).toMatchObject({ slug: 'engines-seeds', name: 'Engines × seeds', definition_version_id: VERSION_ID });
      await capture(page, testInfo, `builder-${name}-adopt-created`);
      expect(critical).toEqual([]);
    });

    test('study-detail /app/:org/:project/studies/:study · the matrix, its runs and a new run', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(STUDY);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeVisible();
      await expect(main.getByText('Definition version 1 · sealed', { exact: true })).toBeVisible();
      const grid = main.getByRole('region', { name: 'The cells of the matrix' });
      await expect(grid.getByRole('columnheader')).toHaveCount(5);
      await expect(grid.getByText('cell 7')).toBeVisible();
      await expect(main.getByText(/2 case revisions × 2 engines × 1 setting × 2 seeds = 8 cells\. Settings: 1 · engine defaults\./)).toBeVisible();
      await expect(main.getByRole('link', { name: /Run #1/ })).toHaveAttribute('href', RUN);
      await expect(main.getByRole('link', { name: 'Open the definition in the library' })).toHaveCount(0);
      await expect(main.getByLabel('Study definition source')).toBeHidden();
      await capture(page, testInfo, `detail-${name}-top`);
      await main.getByText('View source').click();
      await expect(main.getByLabel('Study definition source')).toContainText('"case_revision_ids"');
      await capture(page, testInfo, `detail-${name}-source`, { area: main.locator('details.st-source') });

      // A run is accepted and can be followed.
      await main.getByRole('button', { name: 'Run study' }).click();
      await expect(main.getByText('Run #2 accepted (202). Cells start as job slots free up.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Follow run #2' })).toHaveAttribute('href', `${STUDY}/runs/${NEW_RUN_ID}`);
      expect(state.sent.run).toBe(VERSION_ID);
      await expect(main.getByRole('link', { name: /Run #2/ }).first()).toBeVisible();
      await capture(page, testInfo, `detail-${name}-run-accepted`);

      // Every way the gateway refuses to start one.
      state.refuse.run = detail(402, 'quota_exceeded', 'Storage exhausted.', { quota: { limit_id: 'storageBytes', limit: 100, used: 100 } });
      await main.getByRole('button', { name: 'Run study' }).click();
      await expect(main.getByText('Out of storage (402 · quota_exceeded)')).toBeVisible();
      await expect(main.getByText('You’ve used 100 of 100 storage. Nothing was started.')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-402`, { height: 1300 });
      state.refuse.run = (route) => route.fulfill({
        status: 429, headers: { 'Retry-After': '15' },
        json: { detail: { code: 'concurrency_limit_exceeded', error: 'Concurrency limit exceeded.', concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 } } },
      });
      await main.getByRole('button', { name: 'Run study' }).click();
      await expect(main.getByText('All your job slots are busy (429 · concurrency_limit_exceeded)')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-429`, { height: 1300 });
      state.refuse.run = detail(403, 'feature_not_entitled', 'The plan does not entitle studies.');
      await main.getByRole('button', { name: 'Run study' }).click();
      await expect(main.getByText('Your plan doesn’t include studies right now (403 · feature_not_entitled)')).toBeVisible();
      state.refuse.run = detail(409, 'evidence_only_study', 'This gallery contains stored evidence.');
      await main.getByRole('button', { name: 'Run study' }).click();
      await expect(main.getByText('This study only holds stored evidence (409 · evidence_only_study)')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-409`, { height: 1300 });
      state.refuse.run = detail(403, 'api_key_engine_forbidden', 'This key does not grant Evolutionary.');
      await main.getByRole('button', { name: 'Run study' }).click();
      await expect(main.getByText('This API key isn’t allowed to use one of the study’s engines (403 · api_key_engine_forbidden)')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-403-key`, { height: 1300 });
      expect(critical).toEqual([]);
    });

    test('study-detail /app/:org/:project/studies/:study · archive, versions, edit, delete, a viewer and a study that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      await page.goto(STUDY);
      await expect(main.getByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeVisible();
      const select = main.getByRole('combobox', { name: 'Use version' });
      await expect(select).toBeEnabled();
      await select.selectOption({ index: 1 });
      await expect(main.getByText(/The study now uses that definition version/)).toBeVisible();
      expect(state.sent.update).toContainEqual({ definition_version_id: `artifact-engines-vs-seeds-v2` });

      await main.getByRole('button', { name: 'Archive' }).click();
      await expect(main.getByText('Archived: it can’t start new runs, and existing results stay.')).toBeVisible();
      await expect(main.getByText('Archived studies keep their runs and results but can’t start new runs until restored.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Run study' })).toBeDisabled();
      await capture(page, testInfo, `detail-${name}-archived`, { height: 1300 });
      await main.getByRole('button', { name: 'Restore' }).click();
      await expect(main.getByText('Restored. It can start new runs again.')).toBeVisible();

      await main.getByRole('button', { name: 'Edit details' }).click();
      const edit = page.getByRole('dialog', { name: 'Edit details' });
      await edit.getByLabel('Name').fill('Engines vs seeds');
      await capture(page, testInfo, `detail-${name}-edit`);
      await edit.getByRole('button', { name: 'Save' }).click();
      await expect(main.getByText('Details saved.')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Engines vs seeds' })).toBeVisible();

      await main.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog', { name: 'Delete Engines vs seeds?' }).getByRole('button', { name: 'Delete study' }).click();
      await expect(main.getByText('This study has runs, so it was archived instead of deleted. Results cited by reports stay intact.')).toBeVisible();

      // A viewer reads only.
      await page.goto('/app/read-lab/bench/studies/old-study');
      await expect(main.getByRole('heading', { level: 1, name: 'Old study' })).toBeVisible();
      await expect(main.getByText(/You can read this study\. Running, archiving and editing it need MEMBER in Read Lab\./)).toBeVisible();
      for (const label of ['Run study', 'Archive', 'Edit details', 'Delete']) await expect(main.getByRole('button', { name: label })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-viewer`, { height: 1400 });

      await page.goto(`${ROOT}/studies/ghost`);
      await expect(main.getByRole('heading', { name: 'Study not found' })).toBeVisible();
      await expect(main.getByText('No study with this address in QoS Benchmarks (404).')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-404`);

      state.refuse.studies = unavailable;
      await page.goto(STUDY);
      await expect(main.getByRole('alert').filter({ hasText: 'The study couldn’t be loaded' })).toContainText('(503)');
      await capture(page, testInfo, `detail-${name}-503`);
      expect(critical).toEqual([]);
    });

    test('study-run /app/:org/:project/studies/:study/runs/:run · the cells as a matrix and a table, retry and no report', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(RUN);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Run #1' })).toBeVisible();
      await expect(main.getByText(/Sep 20, 2026, 09:00 UTC → Sep 20, 2026, 09:20 UTC/)).toBeVisible();
      const progress = main.getByRole('region', { name: 'Progress of the run' });
      await expect(progress.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeVisible();
      await expect(progress.getByText('6 of 6 completed are feasible')).toBeVisible();
      await expect(progress.getByText('Finished · not live')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Compare results' })).toHaveAttribute('href', `${RUN}/analytics`);
      const heat = main.getByRole('region', { name: 'Cells of the run as a matrix' });
      await expect(heat.getByRole('link')).toHaveCount(8);
      await expect(heat.getByRole('link', { name: /Cell 4, .* Cost 0\.104/ })).toHaveClass(/is-level-0/);
      await expect(heat.getByRole('link', { name: /Cell 1, .* failed$/ })).toContainText('engine_unreachable');
      await capture(page, testInfo, `run-${name}-top`, { height: 1500 });

      await main.getByRole('combobox', { name: 'Colour by' }).selectOption('runtime');
      await expect(main.getByRole('heading', { name: 'Cells · time taken (lower is better)' })).toBeVisible();
      await capture(page, testInfo, `run-${name}-runtime`, { area: main.locator('section[aria-labelledby="st-heat-title"]') });
      await main.getByRole('combobox', { name: 'Colour by' }).selectOption('cost');

      // The table of every cell, narrowed by state.
      const table = main.getByRole('region', { name: 'Cells of the run', exact: true });
      await expect(table.getByRole('row')).toHaveCount(9);
      await main.getByRole('button', { name: 'Failed (1)' }).click();
      await expect(table.getByRole('row')).toHaveCount(2);
      await capture(page, testInfo, `run-${name}-table-failed`, { area: main.locator('section[aria-labelledby="st-cells-title"]') });
      await main.getByRole('button', { name: 'All (8)' }).click();

      // Retry: a sealed report refuses, then it is queued.
      state.refuse.retry = detail(409, 'sealed_evidence', 'This run is evidence of a sealed report.');
      await table.getByRole('button', { name: 'Retry cell 1' }).click();
      await expect(main.getByText('A sealed report cites this run (409 · sealed_evidence)')).toBeVisible();
      await capture(page, testInfo, `run-${name}-409`, { height: 1300 });
      state.refuse.retry = undefined;
      await table.getByRole('button', { name: 'Retry cell 1' }).click();
      await expect(main.getByText('Cell 1 queued again.')).toBeVisible();
      expect(state.sent.retry).toEqual([cells[1].id, cells[1].id]);
      await main.getByRole('button', { name: 'Retry 2 unfinished cells' }).click();
      await expect(main.getByText('2 cells queued again.')).toBeVisible();

      // The report editor is retired: no draft report is offered from the run.
      await expect(main.getByRole('button', { name: 'Create a report' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Open the report' })).toHaveCount(0);
      expect(state.sent.report).toBeUndefined();

      // A viewer sees it all and changes nothing.
      await page.goto('/app/read-lab/bench/studies/engines-vs-seeds/runs/' + RUN_ID);
      await expect(main.getByRole('heading', { level: 1, name: 'Run #1' })).toBeVisible();
      for (const label of ['Cancel run', 'Retry cell 1', 'Retry 2 unfinished cells']) await expect(main.getByRole('button', { name: label })).toHaveCount(0);
      await capture(page, testInfo, `run-${name}-viewer`, { height: 1300 });
      expect(critical).toEqual([]);
    });

    test('study-run /app/:org/:project/studies/:study/runs/:run · a run that is going, cancel, and the ways it cannot be shown', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const live = `${ROOT}/studies/live-sweep/runs/${LIVE_RUN_ID}`;
      const main = page.locator('#platform-main');

      await page.goto(live);
      await expect(main.getByRole('heading', { level: 1, name: 'Run #1' })).toBeVisible();
      await expect(main.getByText('Live · every 3 s')).toBeVisible();
      await expect(main.getByRole('checkbox', { name: 'Keep updating' })).toBeChecked();
      await expect(main.getByRole('img', { name: '2 completed, 2 running, 2 queued of 6 cells' }).first()).toBeVisible();
      await capture(page, testInfo, `run-${name}-live`, { height: 1500 });

      // Cancelling a run whose results a sealed report cites is refused.
      state.refuse.cancel = detail(409, 'sealed_evidence', 'This run is evidence of a sealed report.');
      await main.getByRole('button', { name: 'Cancel run' }).click();
      await expect(main.getByText('A sealed report cites this run (409 · sealed_evidence)')).toBeVisible();
      expect(state.sent.cancel).toBe(LIVE_RUN_ID);
      await capture(page, testInfo, `run-${name}-cancel-409`, { height: 1300 });

      // The next reading says it ended; the page notices on its own.
      state.liveDone = true;
      await expect(main.getByText('Finished · not live')).toBeVisible({ timeout: 30_000 });
      await expect(main.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
      await expect(main.getByRole('img', { name: '6 completed of 6 cells' }).first()).toBeVisible();
      await capture(page, testInfo, `run-${name}-finished`, { height: 1500 });

      await page.goto(`${STUDY}/runs/ghost`);
      await expect(main.getByRole('heading', { name: 'Run not found' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to the study' })).toHaveAttribute('href', STUDY);
      await capture(page, testInfo, `run-${name}-404`);

      state.refuse.cells = detail(403, 'api_key_engine_forbidden', 'This key does not grant Evolutionary.');
      await page.goto(RUN);
      await expect(main.getByText(/This API key can’t show this run \(403 · api_key_engine_forbidden\)/)).toBeVisible();
      await capture(page, testInfo, `run-${name}-403-key`);

      state.refuse.cells = unavailable;
      await page.goto(RUN);
      await expect(main.getByText(/The run couldn’t be loaded \(503\)/)).toBeVisible();
      state.refuse.cells = json([]);
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByText(/This run has no cells, which shouldn’t happen\./)).toBeVisible();
      await capture(page, testInfo, `run-${name}-empty`);
      expect(critical).toEqual([]);
    });

    test('study-cell /app/:org/:project/studies/:study/runs/:run/cells/:cell · a finished cell and how the engines compare', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(cellPath(2));
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Cell 2' })).toBeVisible();
      const inputs = main.getByRole('region', { name: 'Frozen inputs' });
      await expect(inputs.getByRole('link', { name: 'Checkout flow · revision 1' })).toHaveAttribute('href', `${ROOT}/cases/checkout-flow/revisions/1`);
      await expect(inputs.getByText('random-search 1.0.0')).toBeVisible();
      await expect(inputs.getByRole('link', { name: 'snapshot…' })).toHaveAttribute('href', `${ROOT}/snapshots/snapshot-1`);
      await expect(inputs.getByRole('button', { name: 'Copy cell fingerprint' })).toBeVisible();
      const result = main.getByRole('region', { name: 'Result' });
      await expect(result.getByText('0.121')).toBeVisible();
      await expect(result.getByText('430')).toBeVisible();
      await expect(main.getByRole('link', { name: '00000000…0302' })).toHaveAttribute('href', `${ROOT}/jobs/00000000-0000-4000-8000-000000000302`);
      const rivals = main.getByRole('list', { name: 'Cost of each engine on this input' });
      await expect(rivals.getByRole('listitem')).toHaveCount(2);
      await expect(rivals.getByRole('link', { name: 'evolutionary' })).toHaveAttribute('href', cellPath(0));
      await expect(main.getByText('Same engine, other seeds: seed 1 0.121 · seed 2 0.118.')).toBeVisible();
      await capture(page, testInfo, `cell-${name}-top`, { height: 1700 });
      await main.getByRole('combobox', { name: 'Compare by' }).selectOption('latency');
      await expect(main.getByRole('list', { name: 'Latency of each engine on this input' })).toBeVisible();

      // The metrics as the gateway recorded them, only behind View source.
      await expect(main.getByLabel('Cell metrics source')).toBeHidden();
      await main.getByText('View source').click();
      await expect(main.getByLabel('Cell metrics source')).toContainText('"runtimeSeconds"');
      await capture(page, testInfo, `cell-${name}-source`, { area: main.locator('details.st-source') });

      await main.getByRole('combobox', { name: 'Other cell' }).selectOption(cells[4].id);
      await expect(main.getByRole('heading', { level: 1, name: 'Cell 4' })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${cells[4].id}$`));
      expect(critical).toEqual([]);
    });

    test('study-cell /app/:org/:project/studies/:study/runs/:run/cells/:cell · failed, cancelled, attach, a viewer and a cell that is not there', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      // A failed cell says why, and a retry can be refused or accepted.
      await page.goto(cellPath(1));
      await expect(main.getByRole('heading', { level: 1, name: 'Cell 1' })).toBeVisible();
      await expect(main.getByText('Failed: The engine deployment didn’t answer in time.')).toBeVisible();
      await expect(main.getByText(/Code engine_unreachable · timeout\./)).toBeVisible();
      await capture(page, testInfo, `cell-${name}-failed`, { height: 1500 });
      state.refuse.retry = detail(402, 'quota_exceeded', 'Storage exhausted.', { quota: { limit_id: 'storageBytes', limit: 50, used: 50 } });
      await main.getByRole('button', { name: 'Retry this cell' }).click();
      await expect(main.getByText('Out of storage (402 · quota_exceeded)')).toBeVisible();
      await capture(page, testInfo, `cell-${name}-402`, { height: 1500 });
      state.refuse.retry = (route) => route.fulfill({
        status: 429, headers: { 'Retry-After': '15' },
        json: { detail: { code: 'concurrency_limit_exceeded', error: 'Concurrency limit exceeded.', concurrency: { limit_id: 'concurrentJobs', limit: 3, used: 3 } } },
      });
      await main.getByRole('button', { name: 'Retry this cell' }).click();
      await expect(main.getByText('All your job slots are busy (429 · concurrency_limit_exceeded)')).toBeVisible();
      state.refuse.retry = undefined;
      await main.getByRole('button', { name: 'Retry this cell' }).click();
      await expect(main.getByText('Cell queued again.')).toBeVisible();
      expect(state.sent.retry).toHaveLength(3);

      // A cancelled cell can take the result of a job that was already run.
      await page.goto(cellPath(5));
      await expect(main.getByText('Cancelled before it ran. Retry it, or attach the result of a job you already ran with the same inputs.')).toBeVisible();
      await main.getByRole('button', { name: 'Use an existing job’s result' }).click();
      const dialog = page.getByRole('dialog', { name: 'Use an existing job’s result' });
      const choices = dialog.getByRole('radiogroup', { name: 'Finished jobs' });
      await expect(choices.getByRole('radio')).toHaveCount(2);
      await expect(dialog.getByRole('button', { name: 'Attach this result' })).toBeDisabled();
      await choices.getByRole('radio', { name: /random-search · completed/ }).check();
      await capture(page, testInfo, `cell-${name}-attach`);
      state.refuse.attach = detail(409, 'sealed_evidence', 'This run is evidence of a sealed report.');
      await dialog.getByRole('button', { name: 'Attach this result' }).click();
      await expect(dialog.getByText('A sealed report cites this run (409 · sealed_evidence)')).toBeVisible();
      await capture(page, testInfo, `cell-${name}-attach-409`);
      state.refuse.attach = undefined;
      await dialog.getByRole('button', { name: 'Attach this result' }).click();
      await expect(main.getByText('Result attached. It now counts as this cell’s result.')).toBeVisible();
      expect(state.sent.attach).toEqual({ cell: cells[5].id, job: { job_id: 'job-mine-a' } });

      // A viewer reads only.
      await page.goto(`/app/read-lab/bench/studies/engines-vs-seeds/runs/${RUN_ID}/cells/${cells[1].id}`);
      await expect(main.getByText('Read-only: retrying and attaching a result need MEMBER in Read Lab.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Retry this cell' })).toHaveCount(0);
      await capture(page, testInfo, `cell-${name}-viewer`, { height: 1500 });

      await page.goto(`${RUN}/cells/00000000-0000-4000-8000-0000000009ff`);
      await expect(main.getByRole('heading', { name: 'Cell not found' })).toBeVisible();
      await expect(main.getByText(/No such cell here \(404\)/)).toBeVisible();
      await capture(page, testInfo, `cell-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('study-analytics /app/:org/:project/studies/:study/runs/:run/analytics · charts, rankings, seeds and the CSV', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(`${RUN}/analytics`);
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Compare results · run #1' })).toBeVisible();
      await expect(main.getByText(/Only what the run recorded\. Nothing here is estimated/)).toBeVisible();
      const counters = main.getByLabel('Counts of the run');
      await expect(counters).toContainText('8cells');
      await expect(counters).toContainText('1failed');
      await expect(main.getByRole('link', { name: 'Weigh trade-offs' })).toHaveCount(0);
      await expect(main.getByRole('img', { name: 'evolutionary: 2 values from 0.104 to 0.112, median 0.108' })).toBeVisible();
      await expect(main.getByRole('img', { name: /evolutionary took 1 min 58 s to 2 min; random-search took 58 s to 1 min/ })).toBeVisible();
      await expect(main.getByRole('img', { name: /3 results plotted by Cost and Latency; 2 are best trade-offs/ })).toBeVisible();
      await capture(page, testInfo, `analytics-${name}-top`, { height: 2200 });

      const ranking = main.getByRole('region', { name: 'Engines ranked by cost' });
      await expect(ranking.getByRole('row')).toHaveCount(3);
      await expect(ranking.getByRole('row').nth(1)).toContainText('evolutionary');
      await capture(page, testInfo, `analytics-${name}-ranking`, { area: main.locator('section[aria-labelledby="st-rank-title"]') });
      const seeds = main.getByRole('region', { name: 'Results by seed' });
      await expect(seeds.getByRole('row')).toHaveCount(5);
      await expect(main.getByLabel('Repeatability of each engine')).toContainText('4/4 distinct');
      await capture(page, testInfo, `analytics-${name}-seeds`, { area: main.locator('section[aria-labelledby="st-seed-title"]') });
      await expect(main.getByRole('heading', { name: 'Largest search space' })).toBeVisible();
      await capture(page, testInfo, `analytics-${name}-space`, { area: main.locator('section[aria-labelledby="st-space-title"]') });

      // One engine, then another measure and the other case.
      await main.getByRole('button', { name: 'evolutionary' }).click();
      await expect(ranking.getByRole('row')).toHaveCount(2);
      await capture(page, testInfo, `analytics-${name}-engine`, { height: 1800 });
      await main.getByRole('button', { name: 'Both engines' }).click();
      await main.getByRole('combobox', { name: 'Measure' }).selectOption('runtime');
      await expect(main.getByRole('heading', { name: 'Time taken, per engine' })).toBeVisible();
      await main.getByRole('combobox', { name: 'Measure' }).selectOption('cost');
      await main.getByRole('combobox', { name: 'Case' }).selectOption(REVISION_2.id);
      await expect(main.getByText(/Best trade-offs:/)).toContainText('cell 4 (0.104, 420); cell 6 (0.109, 398).');

      // Every cell goes into a CSV file, never onto the page.
      const downloaded = page.waitForEvent('download');
      await main.getByRole('button', { name: 'Export CSV' }).click();
      expect((await downloaded).suggestedFilename()).toBe('engines-vs-seeds-run-1-cells.csv');

      // Provenance of each cell.
      await expect(main.getByRole('region', { name: 'Provenance of every cell' }).getByRole('row')).toHaveCount(9);
      await expect(main.getByRole('button', { name: 'Copy fingerprint of cell 2' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('study-analytics /app/:org/:project/studies/:study/runs/:run/analytics · empty, 503, 404 and a viewer', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      state.cells[RUN_ID] = cells.map((cell) => ({ ...cell, state: 'cancelled' as const, metrics: {}, job_id: null }));
      await page.goto(`${RUN}/analytics`);
      await expect(main.getByText(/No completed cells yet, so there’s nothing to chart\./)).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Engine ranking' })).toHaveCount(0);
      await capture(page, testInfo, `analytics-${name}-empty`);
      state.cells[RUN_ID] = cellsFixture();

      state.refuse.analytics = unavailable;
      await page.goto(`${RUN}/analytics`);
      await expect(main.getByRole('alert').filter({ hasText: 'Analytics couldn’t be loaded' })).toContainText('(503)');
      await capture(page, testInfo, `analytics-${name}-503`);
      state.refuse.analytics = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('heading', { level: 1, name: 'Compare results · run #1' })).toBeVisible();

      await page.goto(`${STUDY}/runs/ghost/analytics`);
      await expect(main.getByRole('heading', { name: 'Run not found' })).toBeVisible();
      await expect(main.getByText('No such run in QoS Benchmarks (404).')).toBeVisible();
      await capture(page, testInfo, `analytics-${name}-404`);

      await page.goto(`/app/read-lab/bench/studies/engines-vs-seeds/runs/${RUN_ID}/analytics`);
      await expect(main.getByRole('heading', { level: 1, name: 'Compare results · run #1' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Create a report' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Export CSV' })).toBeVisible();
      await capture(page, testInfo, `analytics-${name}-viewer`, { height: 1500 });
      expect(critical).toEqual([]);
    });
  });
}

test.describe('desktop · S7a study-cell, a job that is not a run of the cell', () => {
  test.describe.configure({ mode: 'default' });
  test.use({ viewport: viewports[0].viewport, isMobile: false, deviceScaleFactor: 1 });

  test('study-cell /app/:org/:project/studies/:study/runs/:run/cells/:cell · attaching a job that differs from the cell (409 cell_job_mismatch)', async ({ page }, testInfo) => {
    const critical = watchCriticalErrors(page);
    const state = await mockApi(page);
    const main = page.locator('#platform-main');

    await page.goto(cellPath(5));
    await main.getByRole('button', { name: 'Use an existing job’s result' }).click();
    const dialog = page.getByRole('dialog', { name: 'Use an existing job’s result' });
    await dialog.getByRole('radiogroup', { name: 'Finished jobs' }).getByRole('radio', { name: /random-search · completed/ }).check();
    state.refuse.attach = detail(409, 'cell_job_mismatch', 'The job did not run this cell.', {
      fields: ['engine', 'seed'],
      details: { engine: { cell: 'evolutionary', job: 'random-search' }, seed: { cell: 2, job: 9 } },
    });
    await dialog.getByRole('button', { name: 'Attach this result' }).click();
    await expect(dialog.getByText('That job isn’t a run of this cell (409 · cell_job_mismatch)')).toBeVisible();
    await expect(dialog.getByText(/It differs in the engine and seed\./)).toBeVisible();
    await expect(dialog.getByText('Engine: the cell has evolutionary, the job ran random-search')).toBeVisible();
    await expect(dialog.getByText('Seed: the cell has 2, the job ran 9')).toBeVisible();
    await capture(page, testInfo, 'cell-desktop-attach-409-mismatch');

    // The dialog stays open, and the same choice goes through once the gateway accepts it.
    state.refuse.attach = undefined;
    await dialog.getByRole('button', { name: 'Attach this result' }).click();
    await expect(main.getByText('Result attached. It now counts as this cell’s result.')).toBeVisible();
    expect(critical).toEqual([]);
  });
});
