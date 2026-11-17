import {
  expect as baseExpect,
  test,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { Job } from '../src/modules/run/api/runsClient';
import type { Study, StudyCell, StudyRun } from '../src/modules/study/api/studiesApi';
import { CURRENT_FIXTURE, catalogFixture } from '../src/test/fixtures/pricingCatalog';
import { jobOf } from '../src/test/fixtures/jobs';
import { presetPage } from '../src/test/fixtures/presets';
import { usageOf } from '../src/test/fixtures/resources';
import {
  CHECKOUT,
  EVOLUTIONARY,
  RANDOM_SEARCH,
  REVISION_1,
  REVISION_2,
  RUN_ID,
  analyticsFixture,
  cellFixture,
  cellsFixture,
  runFixture,
  studyFixture,
} from '../src/test/fixtures/studies';

// S7a · studies: the Studies tab of an organization (/orgs/:org/studies, SPHERE's collection cards), the form study-builder
// (/studies/new) and the card page study-detail (/studies/:org/:study/:tab?) with its tabs Setup, Progress (the run), Results
// (recharts cards, the ranking, the seeds), Front (the gateway's Pareto front in the compare-tray frame) and Settings, a cell in a
// side sheet, and the gateway's CSV and JSON export in the Get menu.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by git)
// so they can be looked at after a run. Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
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
const unavailable: Handler = json({ detail: 'The service is not reachable.' }, 503);

const token = (expiresInSeconds: number) =>
  [
    'header',
    Buffer.from(
      JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })
    ).toString('base64'),
    'signature',
  ].join('.');

const lucia = {
  id: 'user-1',
  username: 'lucia.vega',
  email: 'lucia@example.org',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z',
  cas_verified: true,
};

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

const org = (id: string, slug: string, name: string, role: Role) => ({
  id,
  slug,
  name,
  parent_id: null,
  effective_role: role,
  description: '',
  avatar: { url: null, kind: null, bg_color: null, fg_color: null },
  stats: { members: 1, sub_organizations: 0, compositions: 0, problems: 1, runs: 0, studies: 4 },
  role_source: null,
  children: [],
  created_at: '2026-03-03T00:00:00Z',
});

// --- the studies of the organization

const NEW_RUN_ID = '00000000-0000-4000-8000-000000000102';
const LIVE_RUN_ID = '00000000-0000-4000-8000-000000000111';

const liveStudy = studyFixture({
  id: 'study-live-sweep',
  slug: 'live-sweep',
  name: 'Live sweep',
  definition: {
    revision_ids: [REVISION_2.id],
    engines: [RANDOM_SEARCH],
    parameter_sets: [{}],
    seeds: [1, 2, 3, 4, 5, 6],
  },
});
const placement = studyFixture({
  id: 'study-placement',
  slug: 'placement-sweep',
  name: 'Placement sweep',
  description: 'Pools and latencies on the edge.',
});
const oldStudy = studyFixture({
  id: 'study-old',
  slug: 'old-study',
  name: 'Old study',
  archived: true,
});

/** The cells of the run that is still going: two done, two solving, two waiting; once `done` is set, all of them completed. */
function liveCells(done: boolean): StudyCell[] {
  const metrics = (n: number) => ({
    status: 'completed',
    feasible: true,
    termination: 'FEASIBLE',
    objectives: { cost: 0.1 + n / 100, latency: 400 + n },
    runtimeSeconds: 55 + n,
    engine: 'bim.builtin/random-search@1.0.0',
    seed: n + 1,
  });
  return Array.from({ length: 6 }, (_, n) => {
    const state = done || n < 2 ? 'completed' : n < 4 ? 'running' : 'queued';
    return cellFixture(
      n,
      REVISION_2,
      RANDOM_SEARCH,
      n + 1,
      state,
      state === 'completed' ? metrics(n) : {},
      {
        id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`,
        study_run_id: LIVE_RUN_ID,
      }
    );
  });
}

const liveRun = (done: boolean): StudyRun =>
  runFixture({
    id: LIVE_RUN_ID,
    study_id: liveStudy.id,
    run_number: 1,
    state: done ? 'completed' : 'running',
    cells: 6,
    created_at: '2026-10-09T08:00:00Z',
    finished_at: done ? '2026-10-09T08:06:00Z' : null,
  });

// --- the jobs an account could attach to a cell

const mineJobs: Job[] = [
  jobOf(
    'job-mine-a',
    'random-search',
    'completed',
    'FEASIBLE',
    '2026-10-01T09:00:00Z',
    '2026-10-01T09:01:05Z',
    { created_by: { id: 'user-1', username: 'lucia' } }
  ),
  jobOf(
    'job-mine-b',
    'evolutionary',
    'failed',
    'UNKNOWN',
    '2026-10-02T09:00:00Z',
    '2026-10-02T09:00:20Z',
    { created_by: { id: 'user-1', username: 'lucia' } }
  ),
];
const otherJobs: Job[] = [
  jobOf(
    'job-theirs',
    'minizinc',
    'completed',
    'OPTIMAL',
    '2026-10-03T09:00:00Z',
    '2026-10-03T09:02:00Z',
    { created_by: { id: 'user-2', username: 'ana' } }
  ),
];

// --- what the gateway answers

const mode = (id: string, properties: Record<string, unknown>) => ({
  id,
  profile: 'qos-binding/v1',
  ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
  algorithm: id,
  capabilities: {},
  optionsSchema: { type: 'object', properties, additionalProperties: false },
  limits: {},
  guarantees: { termination: ['FEASIBLE'], exact: false },
});

const engineEntry = (ref: typeof RANDOM_SEARCH) => {
  const { mode: id, ...identity } = ref;
  return {
    ...identity,
    id: `engine-${identity.name}`,
    ref: identity,
    modes: [mode(id, { time_budget_ms: { type: 'integer', default: 30000 } })],
  };
};

type Overridable =
  | 'studies'
  | 'create'
  | 'run'
  | 'cancel'
  | 'retry'
  | 'attach'
  | 'update'
  | 'delete'
  | 'runs'
  | 'cells'
  | 'cell'
  | 'analytics'
  | 'report'
  | 'export';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Overridable, Handler>>;
  /** What each write carried, to check what was sent. */
  sent: {
    create?: unknown;
    run?: string;
    cancel?: string;
    retry: string[];
    attach?: { cell: string; job: unknown };
    update: unknown[];
    ifMatch: Array<string | undefined>;
    deleted: string[];
    report?: unknown;
    exported: string[];
  };
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
    sent: { retry: [], update: [], ifMatch: [], deleted: [], exported: [] },
    // Copies: an edit changes the study in place, and the next test starts from the fixture again.
    studies: [studyFixture(), { ...liveStudy }, { ...placement }, { ...oldStudy }],
    runs: { 'engines-vs-seeds': [runFixture()], 'live-sweep': [liveRun(false)] },
    cells: { [RUN_ID]: cellsFixture(), [LIVE_RUN_ID]: liveCells(false) },
    liveDone: false,
  };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'OWNER'),
    org('org-4', 'read-lab', 'Read Lab', 'VIEWER'),
    org('org-5', 'empty-lab', 'Empty Lab', 'OWNER'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's7a-access');
    localStorage.setItem('openbinding-refresh-token', 's7a-refresh');
  });

  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(
    `${API}/v1/auth/refresh`,
    json({
      access_token: 's7a-access-2',
      refresh_token: 's7a-refresh-2',
      token_type: 'bearer',
      expires_in: 900,
    })
  );
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(
    `${API}/v1/users/me/usage`,
    json(
      usageOf({
        plan: 'RESEARCH',
        capabilities: { maxRunMinutes: 1, maxStudyCells: 5000, maxConcurrentRuns: 3 },
      })
    )
  );
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(
    `${API}/v1/engines`,
    json({ engines: [engineEntry(RANDOM_SEARCH), engineEntry(EVOLUTIONARY)] })
  );

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async route => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , orgSlug, section, runId] = parts;
    // /v1/organizations/{org}/studies/{study}/runs/{run}/cells/{cell}/{verb}
    const [, , , , subId, action, actionId, tail, cellId, verb] = parts;
    const method = route.request().method();
    const found = organizations.find(item => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members' || section === 'invitations' || section === 'hierarchy')
      return json([])(route);
    // The run presets the builder offers as engines: one a study can take, a federated one and one without an optimization.
    if (section === 'presets')
      return json(orgSlug === 'isa-demo' ? presetPage() : presetPage([]))(route);
    if (section === 'runs') {
      // The runs of the organization: the attach dialog offers the finished ones, whoever launched them; a cell's run opens here.
      if (!runId)
        return json({
          runs: [...mineJobs, ...otherJobs],
          total: mineJobs.length + otherJobs.length,
        })(route);
      return json({
        ...mineJobs[0],
        id: runId,
        status: 'completed',
        provenance: {},
        result: { termination: 'FEASIBLE', solutions: [] },
      })(route);
    }
    if (section === 'problems') {
      // The study builder and the matrices name the problem versions of the organization.
      const [, , , , problemSlug, problemSub] = parts;
      if (!problemSlug)
        return json({ problems: [CHECKOUT], total: 1, limit: 200, offset: 0 })(route);
      if (problemSub === 'revisions') return json([REVISION_1, REVISION_2])(route);
      return json(CHECKOUT)(route);
    }
    if (section !== 'studies')
      return json(
        found ?? { detail: { code: 'not_found', error: 'Organization not found.' } },
        found ? 200 : 404
      )(route);

    // --- studies of the organization
    if (!found)
      return detail(
        403,
        'organization_forbidden',
        'This action requires viewer access to the organization.'
      )(route);
    const studies = orgSlug === 'empty-lab' ? [] : state.studies;
    /** A study's revision, as its ETag: it changes with every edit. */
    const etagOf = (study: Study) => `"${study.id}-${state.sent.update.length}"`;
    if (!subId) {
      if (method === 'POST') {
        state.sent.create = bodyOf(route);
        if (state.refuse.create) return state.refuse.create(route);
        const sent = bodyOf(route) as {
          slug: string;
          name: string;
          description: string;
          definition?: Study['definition'];
        };
        if (state.studies.some(item => item.slug === sent.slug))
          return detail(409, 'slug_conflict', 'That study slug is in use.')(route);
        const made = studyFixture({
          id: `study-${sent.slug}`,
          slug: sent.slug,
          name: sent.name,
          description: sent.description,
          ...(sent.definition ? { definition: sent.definition } : {}),
        });
        state.studies.push(made);
        return json(made, 201)(route);
      }
      if (state.refuse.studies) return state.refuse.studies(route);
      // The gateway pages the list (`limit`, `offset`) and counts every study the caller reads in `X-Total-Count`.
      const archived = url.searchParams.get('include_archived') === 'true';
      const listed = studies.filter(item => archived || !item.archived);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? listed.length);
      return route.fulfill({
        status: 200,
        headers: {
          'X-Total-Count': String(listed.length),
          'Access-Control-Expose-Headers': 'X-Total-Count, ETag',
        },
        json: listed.slice(offset, offset + limit),
      });
    }
    if (method === 'GET' && !action && state.refuse.studies) return state.refuse.studies(route);
    const study = studies.find(item => item.slug === subId);
    if (!study) return detail(404, 'not_found', 'Study not found.')(route);
    if (!action) {
      if (method === 'PATCH') {
        const sent = bodyOf(route);
        state.sent.ifMatch.push(route.request().headers()['if-match']);
        if (state.refuse.update) {
          state.sent.update.push(sent);
          return state.refuse.update(route);
        }
        if (
          route.request().headers()['if-match'] &&
          route.request().headers()['if-match'] !== etagOf(study)
        ) {
          return route.fulfill({
            status: 412,
            headers: { ETag: etagOf(study), 'Access-Control-Expose-Headers': 'ETag' },
            json: failureBody(
              412,
              'precondition_failed',
              'The resource changed since it was read; fetch it again and retry.'
            ),
          });
        }
        state.sent.update.push(sent);
        Object.assign(study, sent);
        return route.fulfill({
          status: 200,
          headers: { ETag: etagOf(study), 'Access-Control-Expose-Headers': 'ETag' },
          json: study,
        });
      }
      if (method === 'DELETE') {
        state.sent.deleted.push(study.slug);
        if (state.refuse.delete) return state.refuse.delete(route);
        if ((state.runs[study.slug] ?? []).length > 0)
          return detail(
            409,
            'study_history_retained',
            'Set archived=true for a study with executions; historical runs cannot be deleted.'
          )(route);
        state.studies = state.studies.filter(item => item.slug !== study.slug);
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        status: 200,
        headers: { ETag: etagOf(study), 'Access-Control-Expose-Headers': 'ETag' },
        json: study,
      });
    }
    if (action !== 'runs') return json([])(route);

    // --- runs of a study
    const runs = (): StudyRun[] => {
      if (study.slug === 'live-sweep') return [liveRun(state.liveDone)];
      return state.runs[study.slug] ?? [];
    };
    const cellsOf = (run: string): StudyCell[] =>
      run === LIVE_RUN_ID ? liveCells(state.liveDone) : (state.cells[run] ?? []);
    if (!actionId) {
      if (method === 'POST') {
        state.sent.run = study.slug;
        if (state.refuse.run) return state.refuse.run(route);
        const made = runFixture({
          id: NEW_RUN_ID,
          run_number: 2,
          state: 'queued',
          finished_at: null,
          created_at: '2026-10-09T09:30:00Z',
        });
        state.runs[study.slug] = [made, ...(state.runs[study.slug] ?? [])];
        state.cells[NEW_RUN_ID] = cellsFixture().map(cell => ({
          ...cell,
          id: `00000000-0000-4000-8000-0000000005${String(cell.ordinal).padStart(2, '0')}`,
          study_run_id: NEW_RUN_ID,
          state: 'queued' as const,
          metrics: {},
          job_id: null,
        }));
        return json(made, 202)(route);
      }
      if (state.refuse.runs) return state.refuse.runs(route);
      return json(runs())(route);
    }
    const run = runs().find(item => item.id === actionId);
    if (!tail) return json(run ?? { detail: 'not found' }, run ? 200 : 404)(route);
    if (tail === 'analytics') {
      if (state.refuse.analytics) return state.refuse.analytics(route);
      return json(analyticsBody())(route);
    }
    if (tail === 'export') {
      // The gateway's export of the whole run, as an attachment named by Content-Disposition.
      const format = new URL(route.request().url()).searchParams.get('format') ?? '';
      state.sent.exported.push(format);
      if (state.refuse.export) return state.refuse.export(route);
      const body =
        format === 'csv'
          ? 'cell_id,problem,revision,engine_namespace,engine_name,engine_version,mode,parameters,seed,status,feasible,runtime_seconds,objective.cost,objective.latency\n'
          : JSON.stringify({
              study: { id: study.id, slug: study.slug, name: study.name },
              run: { id: actionId },
              definition: {},
              cells: [],
            });
      return route.fulfill({
        status: 200,
        body,
        contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
        headers: {
          'Content-Disposition': `attachment; filename="${study.slug}-run-${run?.run_number ?? 1}.${format}"`,
          'Access-Control-Expose-Headers': 'Content-Disposition',
        },
      });
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
    const cell = cellsOf(actionId).find(item => item.id === cellId);
    if (!verb) {
      if (state.refuse.cell) return state.refuse.cell(route);
      return cell ? json(cell)(route) : detail(404, 'not_found', 'Study cell not found.')(route);
    }
    if (verb === 'retry') {
      state.sent.retry.push(cellId);
      if (state.refuse.retry) return state.refuse.retry(route);
      return json(
        {
          id: cellId,
          state: 'queued',
          fingerprint: cell?.fingerprint ?? '',
          jobId: 'job-new',
          idempotent: false,
        },
        200
      )(route);
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

/**
 * A capture of the current state: with E2E_SCREENSHOTS=1 the whole page, its first `height` pixels, or one area, saved for a person to
 * look at; always a check that nothing scrolls sideways.
 */
async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { height?: number; area?: Locator } = {}
) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  });
  const path = testInfo.outputPath(`${name}.png`);
  const width = page.viewportSize()?.width ?? 0;
  if (!process.env.E2E_SCREENSHOTS) {
    // No picture: the page is still measured below.
  } else if (options.area) {
    await options.area.screenshot({ path, animations: 'disabled' });
  } else if (options.height) {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({
      path,
      fullPage: true,
      animations: 'disabled',
      clip: { x: 0, y: 0, width, height: Math.min(options.height, total) },
    });
  } else {
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  }
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const overflow = await page.evaluate(
    expected => document.documentElement.scrollWidth - expected,
    width
  );
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);
const viewports = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    deviceScaleFactor: 1,
  },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const TAB = '/orgs/isa-demo/studies';
const STUDY = '/studies/isa-demo/engines-vs-seeds';
// The study page (`study-detail`): Progress and Results of the study run named by `?run=`, and a cell in a side sheet.
const RUN = `${STUDY}/progress?run=${RUN_ID}`;
const RESULTS = `${STUDY}/results?run=${RUN_ID}`;
const FRONT = `${STUDY}/front?run=${RUN_ID}`;
const cells = cellsFixture();
const cellPath = (ordinal: number) => `${RESULTS}&cell=${cells[ordinal].id}`;
/** The cell open in the side sheet. */
const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'Study cell' });

/**
 * An action of the study page's header: a button from `sm` up; on a phone the shell keeps only the Get menu and moves the rest
 * into its ⋯ menu.
 */
async function act(page: Page, mobile: boolean, label: string) {
  if (!mobile) {
    await page.locator('main').getByRole('button', { name: label, exact: true }).click();
    return;
  }
  await page.locator('main').getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S7a studies`, () => {
    // One worker per viewport: with every test in parallel the browsers starve each other and the same walk takes twice as long.
    test.describe.configure({ mode: 'default' });
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('organization tab /orgs/:org/studies · cards, archived ones, archive and delete, with no allowance meter', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(TAB);
      const main = page.locator('main');
      const tab = main.getByRole('region', { name: 'Studies' });
      const card = (title: string) => tab.getByRole('article', { name: title });

      await expect(tab.getByRole('heading', { level: 2, name: 'Studies' })).toBeVisible();
      await expect(tab.getByRole('link', { name: 'New study' })).toHaveAttribute(
        'href',
        '/studies/new?org=isa-demo'
      );
      await expect(tab.getByRole('article')).toHaveCount(3);
      await expect(
        card('Engines × seeds').getByRole('link', { name: 'Engines × seeds' })
      ).toHaveAttribute('href', STUDY);
      await expect(card('Engines × seeds')).toContainText('2 × 2 × 1 × 2 = 8 cells');
      await expect(card('Engines × seeds')).toContainText('Run #1');
      await expect(
        card('Engines × seeds').getByRole('img', {
          name: '6 completed, 1 failed, 1 cancelled of 8 cells',
        })
      ).toBeVisible();
      await expect(
        card('Live sweep').getByRole('img', { name: '2 completed, 2 running, 2 queued of 6 cells' })
      ).toBeVisible();
      await expect(card('Placement sweep')).toContainText('Never run');
      await expect(main.getByText(/study runs this month|Renews/i)).toHaveCount(0);
      await capture(page, testInfo, `tab-${name}-cards`);

      // Archived studies appear on request, in the address.
      await tab.getByRole('checkbox', { name: 'Show archived studies' }).click();
      await expect(page).toHaveURL(`${TAB}?archived=true`);
      await expect(tab.getByRole('checkbox', { name: 'Show archived studies' })).toBeChecked();
      await expect(tab.getByRole('article')).toHaveCount(4);
      await expect(card('Old study')).toContainText('Archived');
      await capture(page, testInfo, `tab-${name}-archived`);
      await tab.getByRole('checkbox', { name: 'Show archived studies' }).click();
      await expect(page).toHaveURL(TAB);

      // Archive one; delete one with runs (the gateway refuses, so it is archived instead).
      await card('Placement sweep')
        .getByRole('button', { name: 'Actions for Placement sweep' })
        .click();
      await page.getByRole('menuitem', { name: 'Archive' }).click();
      await expect(page.getByText(/Study “Placement sweep” archived/)).toBeVisible();
      expect(state.sent.update).toContainEqual({ archived: true });
      await expect(tab.getByRole('article')).toHaveCount(2);

      await card('Engines × seeds')
        .getByRole('button', { name: 'Actions for Engines × seeds' })
        .click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      const confirm = page.getByRole('dialog');
      await expect(confirm).toContainText('Delete Engines × seeds?');
      await capture(page, testInfo, `tab-${name}-delete-confirm`);
      await confirm.getByRole('button', { name: 'Delete study' }).click();
      await expect(
        page.getByText(
          'Engines × seeds has runs, so it was archived instead of deleted. Its runs and results stay intact.'
        )
      ).toBeVisible();
      expect(state.sent.deleted).toEqual(['engines-vs-seeds']);
      expect(critical).toEqual([]);
    });

    test('organization tab /orgs/:org/studies · empty, 503, a viewer and an organization that is not the account’s', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');
      const tab = main.getByRole('region', { name: 'Studies' });

      await page.goto('/orgs/empty-lab/studies');
      await expect(tab.getByText('No studies yet.')).toBeVisible();
      await expect(
        tab.getByText(
          '2 problem versions × 2 engines × 2 seeds = 8 runs, all with the same rules. That’s a study.'
        )
      ).toBeVisible();
      await expect(tab.getByRole('link', { name: 'Build a study' })).toHaveAttribute(
        'href',
        '/studies/new?org=empty-lab'
      );
      await capture(page, testInfo, `tab-${name}-empty`);

      state.refuse.studies = unavailable;
      await page.goto(TAB);
      await expect(tab.getByRole('alert')).toContainText('The studies could not be loaded.');
      await expect(tab.getByText('No studies yet.')).toHaveCount(0);
      await capture(page, testInfo, `tab-${name}-503`);
      state.refuse.studies = undefined;
      await tab.getByRole('button', { name: 'Retry' }).click();
      await expect(tab.getByRole('article')).toHaveCount(3);

      // A viewer reads; nothing on the tab creates, archives or deletes.
      await page.goto('/orgs/read-lab/studies');
      await expect(tab.getByRole('article')).toHaveCount(3);
      await expect(tab.getByRole('link', { name: 'New study' })).toHaveCount(0);
      await expect(tab.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
      await capture(page, testInfo, `tab-${name}-viewer`);

      await page.goto('/orgs/ghost-lab/studies');
      await expect(main.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('study-builder /studies/new · the matrix, what it uses of the plan, created', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/studies/new?org=isa-demo');
      const main = page.locator('main');
      const create = main.getByRole('button', { name: 'Create study' });

      await expect(main.getByRole('heading', { level: 1, name: 'New study' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Organization', exact: true })).toContainText(
        'ISA Demo Group'
      );
      await expect(main.getByRole('checkbox', { name: /Checkout flow · version 2/ })).toBeEnabled();
      await expect(create).toBeDisabled();
      await expect(main.getByRole('list', { name: 'Still needed' })).toContainText(
        'Choose at least one engine mode or run preset.'
      );
      await capture(page, testInfo, `builder-${name}-empty`);

      await main.getByRole('checkbox', { name: /Checkout flow · version 1/ }).check();
      await main.getByRole('checkbox', { name: /Checkout flow · version 2/ }).check();
      await main.getByRole('checkbox', { name: /random-search 1\.0\.0/ }).check();
      await main.getByRole('checkbox', { name: /evolutionary 1\.0\.0/ }).check();
      await main.getByLabel('Study name').fill('Budgets and seeds');
      await expect(main.getByLabel('Address')).toHaveValue('budgets-and-seeds');
      await main.getByRole('button', { name: 'Add a setting' }).click();
      await main.getByLabel('Time budget (seconds)').nth(1).fill('120');
      await expect(
        main.getByText(/Your plan runs at most 60 s per solve, so this setting runs at 60 s/)
      ).toBeVisible();
      await main.getByLabel(/Seeds \(comma-separated/).fill('1-3');

      const aside = main.getByRole('complementary', { name: 'Matrix and plan' });
      await expect(
        aside.getByText('2 problem versions × 2 engines × 2 settings × 3 seeds')
      ).toBeVisible();
      await expect(aside.getByText(/used \+ up to|study runs this month/)).toHaveCount(0);
      await expect(aside.getByText(/your plan lets one solve run for up to 60 s/)).toBeVisible();
      await expect(create).toBeEnabled();
      await capture(page, testInfo, `builder-${name}-filled`);

      // Created, the form lands on the new study.
      await create.click();
      await expect(page).toHaveURL('/studies/isa-demo/budgets-and-seeds/setup');
      expect(state.sent.create).toMatchObject({
        slug: 'budgets-and-seeds',
        name: 'Budgets and seeds',
        description: '',
        definition: {
          revision_ids: [REVISION_1.id, REVISION_2.id],
          parameter_sets: [{}, { time_budget_ms: 120000 }],
          seeds: [1, 2, 3],
        },
      });
      await expect(
        main.getByRole('heading', { level: 1, name: 'Budgets and seeds' })
      ).toBeVisible();
      await expect(
        main.getByText(
          'No runs yet. Running uses 1 study run from your month and runs up to 24 cells.'
        )
      ).toBeVisible();
      await capture(page, testInfo, `builder-${name}-created`);
      expect(critical).toEqual([]);
    });

    test('study-builder /studies/new · run presets as engines, the ones a study cannot take, and how a preset is refused', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/studies/new?org=isa-demo&problem=checkout-flow&revision=2');
      const main = page.locator('main');
      const create = main.getByRole('button', { name: 'Create study' });
      const presets = main.getByRole('group', { name: 'Run presets' });

      await expect(
        presets.getByRole('checkbox', { name: 'Fast sampling · run preset' })
      ).toBeEnabled();
      await expect(
        presets.getByRole('checkbox', { name: 'Edge deployment · run preset' })
      ).toBeDisabled();
      await expect(
        presets.getByRole('checkbox', { name: 'Edge deployment · run preset' })
      ).toHaveAccessibleDescription(/presets of federated engines can’t join a study yet/);
      await expect(presets.getByRole('checkbox', { name: 'No goal · run preset' })).toBeDisabled();
      await expect(
        presets.getByRole('checkbox', { name: 'No goal · run preset' })
      ).toHaveAccessibleDescription(/Names no optimization, which a study engine needs\./);

      await main.getByRole('checkbox', { name: /random-search 1\.0\.0/ }).check();
      await presets.getByRole('checkbox', { name: 'Fast sampling · run preset' }).check();
      await main.getByLabel('Study name').fill('Engines and a preset');
      const aside = main.getByRole('complementary', { name: 'Matrix and plan' });
      await expect(
        aside.getByText('1 problem version × 2 engines × 1 setting × 2 seeds')
      ).toBeVisible();
      await capture(page, testInfo, `builder-${name}-presets`, { height: 1800 });

      // The gateway expands each preset when the study is saved and refuses what no run could expand.
      state.refuse.create = detail(
        422,
        'preset_federated',
        'Presets of federated engines cannot join a study yet.'
      );
      await create.click();
      await expect(
        aside.getByText('A run preset runs on a federated deployment (422 · preset_federated)')
      ).toBeVisible();
      state.refuse.create = detail(
        422,
        'duplicate_study_engines',
        'Two engines of the study (after its presets are expanded) are the same.'
      );
      await create.click();
      await expect(
        aside.getByText('Two engines of the study are the same (422 · duplicate_study_engines)')
      ).toBeVisible();
      await capture(page, testInfo, `builder-${name}-422-preset`, { area: aside });

      state.refuse.create = undefined;
      await create.click();
      await expect(page).toHaveURL('/studies/isa-demo/engines-and-a-preset/setup');
      expect(
        (state.sent.create as { definition: { engines: unknown[] } }).definition.engines
      ).toEqual([
        {
          namespace: RANDOM_SEARCH.namespace,
          name: RANDOM_SEARCH.name,
          version: RANDOM_SEARCH.version,
          digest: RANDOM_SEARCH.digest,
          mode: RANDOM_SEARCH.mode,
          optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
        },
        { preset: 'fast-sampling' },
      ]);

      // The new study names the preset in its matrix: each run expands it.
      await expect(
        main.getByRole('columnheader', { name: 'preset fast-sampling · seed 1' })
      ).toBeVisible();
      await expect(
        main.getByText(
          /Each run expands the run preset fast-sampling into the engine, mode and options it holds then\./
        )
      ).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('study-builder /studies/new · 422, 402, 403 and 409 before and after sending', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/studies/new?org=isa-demo&problem=checkout-flow&revision=2');
      const main = page.locator('main');
      const create = main.getByRole('button', { name: 'Create study' });

      // The version another screen named is already chosen.
      await expect(main.getByRole('checkbox', { name: /Checkout flow · version 2/ })).toBeChecked();
      await expect(
        main.getByRole('checkbox', { name: /Checkout flow · version 1/ })
      ).not.toBeChecked();
      await main.getByRole('checkbox', { name: /random-search 1\.0\.0/ }).check();
      await main.getByLabel('Study name').fill('Refused study');

      // Repeated seeds and repeated settings never leave the page.
      await main.getByLabel(/Seeds \(comma-separated/).fill('1, 2, 2');
      await expect(main.locator('small[role="alert"]')).toContainText(
        'Seed 2 appears twice. Each value can appear once.'
      );
      await expect(create).toBeDisabled();
      await capture(page, testInfo, `builder-${name}-422-seeds`, { height: 1800 });
      await main.getByLabel(/Seeds \(comma-separated/).fill('1-100');
      for (let n = 0; n < 25; n += 1)
        await main.getByRole('button', { name: 'Add a setting' }).click();
      await main.getByRole('checkbox', { name: /evolutionary 1\.0\.0/ }).check();
      await main.getByRole('checkbox', { name: /Checkout flow · version 1/ }).check();
      await expect(main.getByRole('list', { name: 'Still needed' })).toContainText('10,000 limit');
      await expect(create).toBeDisabled();
      await capture(page, testInfo, `builder-${name}-422-too-big`, {
        area: main.getByRole('complementary', { name: 'Matrix and plan' }),
      });

      // What the gateway can still refuse.
      await main.getByLabel(/Seeds \(comma-separated/).fill('1, 2');
      for (let n = 0; n < 25; n += 1)
        await main.getByRole('button', { name: 'Remove setting 2' }).first().click();
      await expect(create).toBeEnabled();
      const side = main.getByRole('complementary', { name: 'Matrix and plan' });

      state.refuse.create = detail(402, 'quota_exceeded', 'Storage exhausted.', {
        quota: { limit_id: 'maxRepositoryStorage', limit: 500, used: 500 },
      });
      await create.click();
      await expect(side.getByText('Out of storage (402 · quota_exceeded)')).toBeVisible();
      await expect(side.getByRole('link', { name: 'Compare plans' })).toHaveAttribute(
        'href',
        '/pricing'
      );
      await capture(page, testInfo, `builder-${name}-402`, { area: side });

      state.refuse.create = detail(
        403,
        'api_key_engine_forbidden',
        'This API key does not grant every exact Engine revision requested by the study.'
      );
      await create.click();
      await expect(
        side.getByText(
          'This API key isn’t allowed to use one of the study’s engines (403 · api_key_engine_forbidden)'
        )
      ).toBeVisible();
      await capture(page, testInfo, `builder-${name}-403`, { area: side });

      state.refuse.create = detail(
        422,
        'engine_mode_incompatible',
        'MiniZinc has no mode that supports this goal type.'
      );
      await create.click();
      await expect(
        side.getByText(/MiniZinc has no mode that supports this goal type\./)
      ).toBeVisible();
      await capture(page, testInfo, `builder-${name}-422-engine`, { area: side });

      state.refuse.create = undefined;
      await main.getByLabel('Study name').fill('Engines × seeds');
      await main.getByLabel('Address').fill('engines-vs-seeds');
      await create.click();
      await expect(
        side.getByText('That address is already used (409 · slug_conflict)')
      ).toBeVisible();
      await capture(page, testInfo, `builder-${name}-409`, { area: side });
      expect(critical).toEqual([]);
    });

    test('study-builder /studies/new · only organizations where the account creates studies, and no shared definition to reuse', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      // A viewer's organization is not offered: the form asks for one where studies can be created.
      await page.goto('/studies/new?org=read-lab');
      await expect(main.getByText(/Choose the organization the study belongs to/)).toBeVisible();
      await expect(main.getByLabel('Study name')).toHaveCount(0);
      await main.getByRole('button', { name: 'Organization', exact: true }).click();
      await expect(main.getByRole('option', { name: /Read Lab/ })).toHaveCount(0);
      await main.getByRole('option', { name: /ISA Demo Group/ }).click();
      await expect(main.getByRole('checkbox', { name: /Checkout flow · version 1/ })).toBeVisible();
      await capture(page, testInfo, `builder-${name}-organization`, { height: 1500 });

      // A study keeps its own definition: the form offers no shared one to reuse.
      await expect(main.getByRole('radio', { name: 'Reuse a shared definition' })).toHaveCount(0);
      await expect(main.getByLabel('Sealed version')).toHaveCount(0);
      expect(state.sent.create).toBeUndefined();
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study/setup · the matrix, its runs and a new run', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${STUDY}/setup`);
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeVisible();
      await expect(main.getByLabel('Matrix', { exact: true })).toHaveText(
        '2 problem versions × 2 engines × 1 setting × 2 seeds = 8 cells'
      );
      await expect(
        main
          .getByRole('navigation', { name: 'Breadcrumb' })
          .getByRole('link', { name: 'ISA Demo Group' })
      ).toHaveAttribute('href', TAB);
      const grid = main.getByRole('region', { name: 'The cells of the matrix' });
      await expect(grid.getByRole('columnheader')).toHaveCount(5);
      await expect(grid.getByText('cell 7')).toBeVisible();
      await expect(
        main.getByText(
          /2 problem versions × 2 engines × 1 setting × 2 seeds = 8 cells\. Settings: 1 · engine defaults\./
        )
      ).toBeVisible();
      await expect(main.getByRole('link', { name: /Run #1/ })).toHaveAttribute('href', RUN);
      const definitionCard = main.getByRole('region', { name: 'Definition', exact: true });
      await expect(
        definitionCard.getByRole('button', { name: 'Copy the definition digest' })
      ).toBeVisible();
      await expect(definitionCard).not.toContainText('sha256-');
      await expect(main.getByRole('region', { name: 'Study definition source' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-top`);
      await main.getByRole('tab', { name: 'Source' }).click();
      const definitionSource = main.getByRole('region', { name: 'Study definition source' });
      await expect(definitionSource).toContainText('"revision_ids"');
      await capture(page, testInfo, `detail-${name}-source`, { area: definitionSource });
      await main.getByRole('tab', { name: 'Overview' }).click();

      // A run is accepted and can be followed.
      await act(page, isMobile, 'Run study');
      await expect(
        main.getByText('Run #2 accepted (202). Cells start as run slots free up.')
      ).toBeVisible();
      await expect(main.getByRole('link', { name: 'Follow run #2' })).toHaveAttribute(
        'href',
        `${STUDY}/progress?run=${NEW_RUN_ID}`
      );
      expect(state.sent.run).toBe('engines-vs-seeds');
      await expect(main.getByRole('link', { name: /Run #2/ }).first()).toBeVisible();
      await capture(page, testInfo, `detail-${name}-run-accepted`);

      // Every way the gateway refuses to start one.
      state.refuse.run = detail(402, 'quota_exceeded', 'Storage exhausted.', {
        quota: { limit_id: 'maxRepositoryStorage', limit: 100, used: 100 },
      });
      await act(page, isMobile, 'Run study');
      await expect(main.getByText('Out of storage (402 · quota_exceeded)')).toBeVisible();
      await expect(
        main.getByText('You’ve used 100 of 100 storage. Nothing was started.')
      ).toBeVisible();
      await capture(page, testInfo, `detail-${name}-402`, { height: 1300 });
      state.refuse.run = route =>
        route.fulfill({
          status: 429,
          headers: { 'Retry-After': '15' },
          json: {
            detail: {
              code: 'concurrency_limit_exceeded',
              error: 'Concurrency limit exceeded.',
              concurrency: { limit_id: 'maxConcurrentRuns', limit: 3, used: 3 },
            },
          },
        });
      await act(page, isMobile, 'Run study');
      await expect(
        main.getByText('All your run slots are busy (429 · concurrency_limit_exceeded)')
      ).toBeVisible();
      state.refuse.run = detail(403, 'feature_not_entitled', 'The plan does not entitle studies.');
      await act(page, isMobile, 'Run study');
      await expect(
        main.getByText('Your plan doesn’t include studies right now (403 · feature_not_entitled)')
      ).toBeVisible();
      state.refuse.run = detail(
        409,
        'study_archived',
        'Restore this study before starting another run.'
      );
      await act(page, isMobile, 'Run study');
      await expect(main.getByText('This study is archived (409 · study_archived)')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-409`, { height: 1300 });
      state.refuse.run = detail(
        403,
        'api_key_engine_forbidden',
        'This key does not grant Evolutionary.'
      );
      await act(page, isMobile, 'Run study');
      await expect(
        main.getByText(
          'This API key isn’t allowed to use one of the study’s engines (403 · api_key_engine_forbidden)'
        )
      ).toBeVisible();
      await capture(page, testInfo, `detail-${name}-403-key`, { height: 1300 });
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study · edit the definition, archive, settings, delete, a viewer and a study that is not there', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      await page.goto(`${STUDY}/setup`);
      await expect(main.getByRole('heading', { level: 1, name: 'Engines × seeds' })).toBeVisible();
      // The definition is edited in place, with the revision it was read at; the runs keep what they froze.
      await act(page, isMobile, 'Edit');
      const editor = page.getByRole('dialog', { name: 'Edit definition' });
      const nextDefinition = { ...studyFixture().definition, seeds: [1, 2, 3] };
      await editor.getByLabel('Definition (JSON)').fill(JSON.stringify(nextDefinition, null, 2));
      await capture(page, testInfo, `detail-${name}-edit-definition`);
      await editor.getByRole('button', { name: 'Save definition' }).click();
      await expect(main.getByText(/Definition saved\. The next run uses it/)).toBeVisible();
      expect(state.sent.update).toContainEqual({ definition: nextDefinition });
      expect(state.sent.ifMatch[state.sent.ifMatch.length - 1]).toBe('"study-engines-vs-seeds-0"');
      await expect(main.getByLabel('Matrix', { exact: true })).toHaveText(
        '2 problem versions × 2 engines × 1 setting × 3 seeds = 12 cells'
      );

      await act(page, isMobile, 'Archive');
      await expect(
        main.getByText('Archived: it can’t start new runs, and existing results stay.')
      ).toBeVisible();
      await expect(
        main.getByText(
          'Archived studies keep their runs and results but can’t start new runs until restored.'
        )
      ).toBeVisible();
      if (!isMobile) await expect(main.getByRole('button', { name: 'Run study' })).toBeDisabled();
      await capture(page, testInfo, `detail-${name}-archived`, { height: 1300 });
      await act(page, isMobile, 'Restore');
      await expect(main.getByText('Restored. It can start new runs again.')).toBeVisible();

      // The name and the description are the Settings tab's, saved with the study's revision.
      await main
        .getByRole('navigation', { name: 'Study sections' })
        .getByRole('link', { name: 'Settings' })
        .click();
      await expect(page).toHaveURL(`${STUDY}/settings`);
      await main.getByLabel('Name').fill('Engines vs seeds');
      await capture(page, testInfo, `detail-${name}-settings`);
      await main.getByRole('button', { name: 'Save' }).click();
      await expect(main.getByText('Details saved.')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Engines vs seeds' })).toBeVisible();

      await act(page, isMobile, 'Delete');
      await page
        .getByRole('dialog', { name: 'Delete Engines vs seeds?' })
        .getByRole('button', { name: 'Delete study' })
        .click();
      await expect(
        main.getByText(
          'This study has runs, so it was archived instead of deleted. Its runs and results stay intact.'
        )
      ).toBeVisible();

      // A viewer reads only.
      await page.goto('/studies/read-lab/old-study/setup');
      await expect(main.getByRole('heading', { level: 1, name: 'Old study' })).toBeVisible();
      await expect(
        main.getByText(
          /You can read this study\. Running, archiving and editing it need MEMBER in Read Lab\./
        )
      ).toBeVisible();
      for (const label of [
        'Run study',
        'Archive',
        'Edit',
        'Edit definition',
        'Delete',
        'More actions',
      ])
        await expect(main.getByRole('button', { name: label, exact: true })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-viewer`, { height: 1400 });

      // Missing, and another organization's, read the same.
      await page.goto('/studies/isa-demo/ghost');
      await expect(main.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await page.goto('/studies/ghost-lab/engines-vs-seeds');
      await expect(main.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await capture(page, testInfo, `detail-${name}-404`);

      state.refuse.studies = unavailable;
      await page.goto(STUDY);
      await expect(main.getByRole('alert')).toContainText('The study couldn’t be loaded.');
      await capture(page, testInfo, `detail-${name}-503`);
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study/progress · the cells as a matrix and a table, retry, and what the run froze', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      // What the run froze when it started: its problem versions, each with the compilation it ran, in Setup.
      await page.goto(`${STUDY}/setup?run=${RUN_ID}`);
      const frozen = main.getByRole('region', { name: 'Frozen definition' });
      await expect(
        frozen.getByRole('list', { name: 'Problem versions of the run' }).getByRole('listitem')
      ).toHaveCount(2);
      await expect(frozen.getByRole('list', { name: 'Engines of the run' })).toContainText(
        'random-search 1.0.0 (sampling)'
      );
      await expect(
        frozen.getByRole('button', { name: 'Copy the digest of the frozen definition' })
      ).toBeVisible();
      await expect(frozen).toContainText('The study’s current definition is this one.');
      await expect(frozen).not.toContainText('sha256-');

      await page.goto(RUN);
      await expect(main.getByRole('heading', { level: 2, name: 'Run #1' })).toBeVisible();
      await expect(
        main.getByText(/Sep 20, 2026, 09:00 UTC → Sep 20, 2026, 09:20 UTC/)
      ).toBeVisible();
      const progress = main.getByRole('region', { name: 'Progress of the run' });
      await expect(
        progress.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })
      ).toBeVisible();
      await expect(progress.getByText('6 of 6 completed are feasible')).toBeVisible();
      await expect(progress.getByText('Finished · not live')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Compare results' })).toHaveAttribute(
        'href',
        RESULTS
      );
      const heat = main.getByRole('region', { name: 'Cells of the run as a matrix' });
      await expect(heat.getByRole('link')).toHaveCount(8);
      await expect(heat.getByRole('link', { name: /Cell 4, .* Cost 0\.104/ })).toHaveAttribute(
        'data-heat',
        '0'
      );
      await expect(heat.getByRole('link', { name: /Cell 1, .* failed$/ })).toContainText(
        'engine_unreachable'
      );
      await capture(page, testInfo, `run-${name}-top`, { height: 1500 });

      await main.getByRole('combobox', { name: 'Colour by' }).selectOption('runtime');
      await expect(
        main.getByRole('heading', { name: 'Cells · time taken (lower is better)' })
      ).toBeVisible();
      await capture(page, testInfo, `run-${name}-runtime`, {
        area: main.locator('section[aria-labelledby="study-heat-title"]'),
      });
      await main.getByRole('combobox', { name: 'Colour by' }).selectOption('cost');

      // A square opens its cell in a side sheet over the tab, and closing it comes back.
      await heat.getByRole('link', { name: /Cell 2, / }).click();
      await expect(sheetOf(page).getByRole('heading', { level: 2, name: 'Cell 2' })).toBeVisible();
      await capture(page, testInfo, `run-${name}-sheet`);
      await sheetOf(page).getByRole('button', { name: 'Close the cell' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      await expect(page).toHaveURL(RUN);

      // The table of every cell, narrowed by state.
      const table = main.getByRole('region', { name: 'Cells of the run', exact: true });
      await expect(table.getByRole('row')).toHaveCount(9);
      await main.getByRole('button', { name: 'Failed (1)' }).click();
      await expect(table.getByRole('row')).toHaveCount(2);
      await capture(page, testInfo, `run-${name}-table-failed`, {
        area: main.locator('section[aria-labelledby="study-cells-title"]'),
      });
      await main.getByRole('button', { name: 'All (8)' }).click();

      // Retry: a refusal is said, then it is queued.
      state.refuse.retry = detail(
        409,
        'cell_not_retryable',
        'Only failed or cancelled cells can be retried.'
      );
      await table.getByRole('button', { name: 'Retry cell 1' }).click();
      await expect(
        main.getByText('This cell can’t be retried (409 · cell_not_retryable)')
      ).toBeVisible();
      await capture(page, testInfo, `run-${name}-409`, { height: 1300 });
      state.refuse.retry = undefined;
      await table.getByRole('button', { name: 'Retry cell 1' }).click();
      await expect(main.getByText('Cell 1 queued again.')).toBeVisible();
      expect(state.sent.retry).toEqual([cells[1].id, cells[1].id]);
      await main.getByRole('button', { name: 'Retry 2 unfinished cells' }).click();
      await expect(main.getByText('2 cells queued again.')).toBeVisible();

      // The report editor is retired: no draft report is offered from the run.
      await expect(main.getByRole('button', { name: 'Create a report' })).toHaveCount(0);
      expect(state.sent.report).toBeUndefined();

      // A viewer sees it all and changes nothing.
      await page.goto(`/studies/read-lab/engines-vs-seeds/progress?run=${RUN_ID}`);
      await expect(main.getByRole('heading', { level: 2, name: 'Run #1' })).toBeVisible();
      for (const label of ['Cancel run', 'Retry cell 1', 'Retry 2 unfinished cells'])
        await expect(main.getByRole('button', { name: label })).toHaveCount(0);
      await capture(page, testInfo, `run-${name}-viewer`, { height: 1300 });
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study/progress · a run that is going, cancel, and the ways it cannot be shown', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const live = `/studies/isa-demo/live-sweep/progress?run=${LIVE_RUN_ID}`;
      const main = page.locator('main');

      await page.goto(live);
      await expect(main.getByRole('heading', { level: 2, name: 'Run #1' })).toBeVisible();
      await expect(main.getByText('Live · every 3 s')).toBeVisible();
      await expect(main.getByRole('checkbox', { name: 'Keep updating' })).toBeChecked();
      await expect(
        main.getByRole('img', { name: '2 completed, 2 running, 2 queued of 6 cells' }).first()
      ).toBeVisible();
      await capture(page, testInfo, `run-${name}-live`, { height: 1500 });

      // Cancelling a run that ended meanwhile is refused.
      state.refuse.cancel = detail(409, 'terminal_run', 'The study run is already terminal.');
      await main.getByRole('button', { name: 'Cancel run' }).click();
      await expect(main.getByText('This run already finished (409 · terminal_run)')).toBeVisible();
      expect(state.sent.cancel).toBe(LIVE_RUN_ID);
      await capture(page, testInfo, `run-${name}-cancel-409`, { height: 1300 });

      // The next reading says it ended; the page notices on its own.
      state.liveDone = true;
      await expect(main.getByText('Finished · not live')).toBeVisible({ timeout: 30_000 });
      await expect(main.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
      await expect(main.getByRole('img', { name: '6 completed of 6 cells' }).first()).toBeVisible();
      await capture(page, testInfo, `run-${name}-finished`, { height: 1500 });

      await page.goto(`${STUDY}/progress?run=ghost`);
      await expect(main.getByRole('heading', { name: 'Run not found' })).toBeVisible();
      await capture(page, testInfo, `run-${name}-404`);

      state.refuse.cells = detail(
        403,
        'api_key_engine_forbidden',
        'This key does not grant Evolutionary.'
      );
      await page.goto(RUN);
      await expect(
        main.getByText(/This API key can’t show this run \(403 · api_key_engine_forbidden\)/)
      ).toBeVisible();
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

    test('study-detail /studies/:org/:study/results · a finished cell in the side sheet and how the engines compare', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(cellPath(2));
      const sheet = sheetOf(page);

      await expect(sheet.getByRole('heading', { level: 2, name: 'Cell 2' })).toBeVisible();
      const inputs = sheet.getByRole('region', { name: 'Frozen inputs' });
      await expect(inputs.getByRole('link', { name: 'Checkout flow · version 1' })).toHaveAttribute(
        'href',
        '/problems/isa-demo/checkout-flow?version=1'
      );
      await expect(inputs.getByText('random-search 1.0.0')).toBeVisible();
      await expect(inputs.getByRole('link', { name: 'Package and compiled form' })).toHaveAttribute(
        'href',
        '/problems/isa-demo/checkout-flow/source?version=1'
      );
      await expect(inputs.getByRole('button', { name: 'Copy cell digest' })).toHaveText(
        'Copy digest'
      );
      await expect(inputs).not.toContainText(/sha256-|[0-9a-f]{12}/);
      const result = sheet.getByRole('region', { name: 'Result' });
      await expect(result.getByText('0.121')).toBeVisible();
      await expect(result.getByText('430')).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Open run' })).toHaveAttribute(
        'href',
        '/runs/isa-demo/00000000-0000-4000-8000-000000000302'
      );
      const rivals = sheet.getByRole('list', { name: 'Cost of each engine on this input' });
      await expect(rivals.getByRole('listitem')).toHaveCount(2);
      await expect(rivals.getByRole('link', { name: 'evolutionary' })).toHaveAttribute(
        'href',
        cellPath(0)
      );
      await expect(
        sheet.getByText('Same engine, other seeds: seed 1 0.121 · seed 2 0.118.')
      ).toBeVisible();
      await capture(page, testInfo, `cell-${name}-top`, { height: 1700 });
      await sheet.getByRole('combobox', { name: 'Compare by' }).selectOption('latency');
      await expect(
        sheet.getByRole('list', { name: 'Latency of each engine on this input' })
      ).toBeVisible();

      // The metrics as the gateway recorded them, only in the Source tab.
      await expect(sheet.getByRole('region', { name: 'Cell metrics source' })).toHaveCount(0);
      await sheet.getByRole('tab', { name: 'Source' }).click();
      const metricsSource = sheet.getByRole('region', { name: 'Cell metrics source' });
      await expect(metricsSource).toContainText('"runtimeSeconds"');
      await sheet.getByRole('tab', { name: 'Result', exact: true }).click();

      await sheet.getByRole('combobox', { name: 'Other cell' }).selectOption(cells[4].id);
      await expect(sheet.getByRole('heading', { level: 2, name: 'Cell 4' })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${cells[4].id}$`));
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(page).toHaveURL(RESULTS);
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study/results · a cell that failed, was cancelled, takes an attached job, a viewer and a cell that is not there', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const sheet = sheetOf(page);

      // A failed cell says why, and a retry can be refused or accepted.
      await page.goto(cellPath(1));
      await expect(sheet.getByRole('heading', { level: 2, name: 'Cell 1' })).toBeVisible();
      await expect(
        sheet.getByText('Failed: The engine deployment didn’t answer in time.')
      ).toBeVisible();
      await expect(sheet.getByText(/Code engine_unreachable · timeout\./)).toBeVisible();
      await capture(page, testInfo, `cell-${name}-failed`, { height: 1500 });
      state.refuse.retry = detail(402, 'quota_exceeded', 'Storage exhausted.', {
        quota: { limit_id: 'maxRepositoryStorage', limit: 50, used: 50 },
      });
      await sheet.getByRole('button', { name: 'Retry this cell' }).click();
      await expect(sheet.getByText('Out of storage (402 · quota_exceeded)')).toBeVisible();
      state.refuse.retry = route =>
        route.fulfill({
          status: 429,
          headers: { 'Retry-After': '15' },
          json: {
            detail: {
              code: 'concurrency_limit_exceeded',
              error: 'Concurrency limit exceeded.',
              concurrency: { limit_id: 'maxConcurrentRuns', limit: 3, used: 3 },
            },
          },
        });
      await sheet.getByRole('button', { name: 'Retry this cell' }).click();
      await expect(
        sheet.getByText('All your run slots are busy (429 · concurrency_limit_exceeded)')
      ).toBeVisible();
      state.refuse.retry = undefined;
      await sheet.getByRole('button', { name: 'Retry this cell' }).click();
      await expect(sheet.getByText('Cell queued again.')).toBeVisible();
      expect(state.sent.retry).toHaveLength(3);

      // A cancelled cell can take the result of a run of the organization, whoever launched it (D10).
      await page.goto(cellPath(5));
      await expect(
        sheet.getByText(
          'Cancelled before it ran. Retry it, or attach the result of a run of the organization with the same inputs.'
        )
      ).toBeVisible();
      await sheet.getByRole('button', { name: 'Use an existing run’s result' }).click();
      const dialog = page.getByRole('dialog', { name: 'Use an existing run’s result' });
      const choices = dialog.getByRole('radiogroup', { name: 'Finished runs' });
      await expect(choices.getByRole('radio')).toHaveCount(3);
      await expect(
        choices.getByRole('radio', { name: /minizinc · completed · by ana/ })
      ).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Attach this result' })).toBeDisabled();
      await choices.getByRole('radio', { name: /random-search · completed/ }).check();
      await capture(page, testInfo, `cell-${name}-attach`);
      state.refuse.attach = detail(
        409,
        'job_already_attached',
        'The job is already the result of another cell.'
      );
      await dialog.getByRole('button', { name: 'Attach this result' }).click();
      await expect(
        dialog.getByText(
          'That run is already the result of another cell (409 · job_already_attached)'
        )
      ).toBeVisible();
      state.refuse.attach = undefined;
      await dialog.getByRole('button', { name: 'Attach this result' }).click();
      await expect(
        sheet.getByText('Result attached. It now counts as this cell’s result.')
      ).toBeVisible();
      expect(state.sent.attach).toEqual({ cell: cells[5].id, job: { job_id: 'job-mine-a' } });

      // A viewer reads only.
      await page.goto(
        `/studies/read-lab/engines-vs-seeds/results?run=${RUN_ID}&cell=${cells[1].id}`
      );
      await expect(
        sheet.getByText('Read-only: retrying and attaching a result need MEMBER in Read Lab.')
      ).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Retry this cell' })).toHaveCount(0);
      await capture(page, testInfo, `cell-${name}-viewer`, { height: 1500 });

      await page.goto(`${RESULTS}&cell=00000000-0000-4000-8000-0000000009ff`);
      await expect(sheet.getByRole('heading', { name: 'Cell not found' })).toBeVisible();
      await expect(sheet.getByText(/No such cell here \(404\)/)).toBeVisible();
      await capture(page, testInfo, `cell-${name}-404`);
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study/results · charts, rankings, seeds and the export in the Get menu', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(RESULTS);
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'Compare results · run #1' })
      ).toBeVisible();
      await expect(
        main.getByText(/Only what the run recorded\. Nothing here is estimated/)
      ).toBeVisible();
      const counters = main.getByLabel('Counts of the run');
      await expect(counters).toContainText('8cells');
      await expect(counters).toContainText('1failed');
      // The stat tile names the shown run's best value.
      await expect(main.locator('dt', { hasText: /^Best$/ }).locator('xpath=..')).toContainText(
        'Cost 0.104'
      );
      await expect(
        main.getByRole('img', {
          name: /^evolutionary: 2 values from 0\.104 to 0\.112, median 0\.108; /,
        })
      ).toBeVisible();
      await expect(
        main.getByRole('img', {
          name: /evolutionary took 1 min 58 s to 2 min; random-search took 58 s to 1 min/,
        })
      ).toBeVisible();
      await expect(
        main.getByRole('img', {
          name: /3 results plotted by Cost and Latency; 2 are best trade-offs/,
        })
      ).toBeVisible();
      // The charts are recharts SVGs, each with its data a click away.
      await expect(main.locator('.recharts-surface').first()).toBeVisible();
      await main.getByRole('button', { name: 'Show data' }).first().click();
      await expect(main.getByRole('region', { name: 'Cost found of each engine' })).toBeVisible();
      await main.getByRole('button', { name: 'Show chart' }).click();
      await capture(page, testInfo, `analytics-${name}-top`, { height: 2200 });

      const ranking = main.getByRole('region', { name: 'Engines ranked by cost' });
      await expect(ranking.getByRole('row')).toHaveCount(3);
      await expect(ranking.getByRole('row').nth(1)).toContainText('evolutionary');
      await capture(page, testInfo, `analytics-${name}-ranking`, {
        area: main.locator('section[aria-labelledby="study-rank-title"]'),
      });
      const seeds = main.getByRole('region', { name: 'Results by seed' });
      await expect(seeds.getByRole('row')).toHaveCount(5);
      await expect(main.getByLabel('Repeatability of each engine')).toContainText('4/4 distinct');
      await expect(main.getByRole('heading', { name: 'Largest search space' })).toBeVisible();

      // One engine, then another measure and the other problem.
      await main.getByRole('button', { name: 'evolutionary' }).click();
      await expect(ranking.getByRole('row')).toHaveCount(2);
      await main.getByRole('button', { name: 'Both engines' }).click();
      await main.getByRole('combobox', { name: 'Measure' }).selectOption('runtime');
      await expect(main.getByRole('heading', { name: 'Time taken, per engine' })).toBeVisible();
      await main.getByRole('combobox', { name: 'Measure' }).selectOption('cost');
      await main.getByRole('combobox', { name: 'Problem' }).selectOption(REVISION_2.id);
      await expect(main.getByText(/Best trade-offs:/)).toContainText(
        'cell 4 (0.104, 420); cell 6 (0.109, 398).'
      );

      // Every cell goes into the gateway's CSV or JSON file, never onto the page, under the name the gateway gives it.
      const get = main.getByRole('button', { name: /Get study/ });
      const downloaded = page.waitForEvent('download');
      await get.click();
      await page.getByRole('menuitem', { name: /Export CSV/ }).click();
      expect((await downloaded).suggestedFilename()).toBe('engines-vs-seeds-run-1.csv');
      const json = page.waitForEvent('download');
      await get.click();
      await page.getByRole('menuitem', { name: /Export JSON/ }).click();
      expect((await json).suggestedFilename()).toBe('engines-vs-seeds-run-1.json');
      expect(state.sent.exported).toEqual(['csv', 'json']);
      state.refuse.export = detail(
        403,
        'api_key_permission_denied',
        'The API key lacks studies:read.'
      );
      await get.click();
      await page.getByRole('menuitem', { name: /Export CSV/ }).click();
      await expect(
        page.getByText('The CSV export couldn’t be made (403 · api_key_permission_denied).')
      ).toBeVisible();
      await page.getByRole('button', { name: 'OK' }).click();

      // Provenance of each cell.
      const provenance = main.getByRole('region', { name: 'Provenance of every cell' });
      await expect(provenance.getByRole('row')).toHaveCount(9);
      await expect(provenance.getByRole('button', { name: 'Copy digest of cell 2' })).toBeVisible();
      await expect(provenance).not.toContainText(/sha256-|[0-9a-f]{12}/);
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study/front · the gateway’s front, the compare tray and a viewer', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(FRONT);
      const main = page.locator('main');

      const front = main.getByRole('region', { name: 'Pareto front' });
      await expect(
        front.getByRole('region', { name: 'Front of checkout-flow · version 1' }).getByRole('row')
      ).toHaveCount(3);
      await expect(
        front.getByRole('region', { name: 'Front of checkout-flow · version 2' })
      ).toContainText('P4');
      const tray = main.getByRole('region', { name: 'Compare', exact: true });
      await expect(tray).toContainText('Hold two configurations to see what differs.');
      const focus = front.getByRole('group', { name: 'Focused point' });
      await focus.getByRole('button', { name: 'Compare this one' }).click();
      await focus.getByRole('button', { name: 'Next' }).click();
      await focus.getByRole('button', { name: 'Compare with A' }).click();
      await expect(main.getByRole('region', { name: 'A compared with B' })).toContainText(
        'Both points need a composition to be compared: derive them first.'
      );
      await capture(page, testInfo, `front-${name}-tray`);

      await page.goto(`/studies/read-lab/engines-vs-seeds/front?run=${RUN_ID}`);
      await expect(
        main.getByText('Read-only: deriving compositions needs MEMBER in Read Lab.')
      ).toBeVisible();
      await expect(main.getByRole('button', { name: 'Derive compositions' })).toHaveCount(0);
      expect(critical).toEqual([]);
    });

    test('study-detail /studies/:org/:study/results · empty, 503, 404 and a viewer', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      state.cells[RUN_ID] = cells.map(cell => ({
        ...cell,
        state: 'cancelled' as const,
        metrics: {},
        job_id: null,
      }));
      await page.goto(RESULTS);
      await expect(
        main.getByText(/No completed cells yet, so there’s nothing to chart\./)
      ).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Engine ranking' })).toHaveCount(0);
      await capture(page, testInfo, `analytics-${name}-empty`);
      state.cells[RUN_ID] = cellsFixture();

      state.refuse.analytics = unavailable;
      await page.goto(RESULTS);
      await expect(
        main.getByRole('alert').filter({ hasText: 'Analytics couldn’t be loaded' })
      ).toContainText('(503)');
      await capture(page, testInfo, `analytics-${name}-503`);
      state.refuse.analytics = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(
        main.getByRole('heading', { level: 2, name: 'Compare results · run #1' })
      ).toBeVisible();

      await page.goto(`${STUDY}/results?run=ghost`);
      await expect(main.getByRole('heading', { name: 'Run not found' })).toBeVisible();
      await expect(main.getByText(/This run doesn’t exist \(404\)/)).toBeVisible();
      await capture(page, testInfo, `analytics-${name}-404`);

      await page.goto(`/studies/read-lab/engines-vs-seeds/results?run=${RUN_ID}`);
      await expect(
        main.getByRole('heading', { level: 2, name: 'Compare results · run #1' })
      ).toBeVisible();
      await expect(main.getByRole('button', { name: 'Create a report' })).toHaveCount(0);
      await capture(page, testInfo, `analytics-${name}-viewer`, { height: 1500 });
      expect(critical).toEqual([]);
    });
  });
}

test.describe('desktop · S7a study-cell, a job that is not a run of the cell', () => {
  test.describe.configure({ mode: 'default' });
  test.use({ viewport: viewports[0].viewport, isMobile: false, deviceScaleFactor: 1 });

  test('study-detail /studies/:org/:study/results · attaching a job that differs from the cell (409 cell_job_mismatch)', async ({
    page,
  }, testInfo) => {
    const critical = watchCriticalErrors(page);
    const state = await mockApi(page);
    const sheet = sheetOf(page);

    await page.goto(cellPath(5));
    await sheet.getByRole('button', { name: 'Use an existing run’s result' }).click();
    const dialog = page.getByRole('dialog', { name: 'Use an existing run’s result' });
    await dialog
      .getByRole('radiogroup', { name: 'Finished runs' })
      .getByRole('radio', { name: /random-search · completed/ })
      .check();
    state.refuse.attach = detail(409, 'cell_job_mismatch', 'The job did not run this cell.', {
      fields: ['engine', 'seed'],
      details: {
        engine: { cell: 'evolutionary', job: 'random-search' },
        seed: { cell: 2, job: 9 },
      },
    });
    await dialog.getByRole('button', { name: 'Attach this result' }).click();
    await expect(
      dialog.getByText('That run isn’t a run of this cell (409 · cell_job_mismatch)')
    ).toBeVisible();
    await expect(dialog.getByText(/It differs in the engine and seed\./)).toBeVisible();
    await expect(
      dialog.getByText('Engine: the cell has evolutionary, the run had random-search')
    ).toBeVisible();
    await expect(dialog.getByText('Seed: the cell has 2, the run had 9')).toBeVisible();
    await capture(page, testInfo, 'cell-desktop-attach-409-mismatch');

    // The dialog stays open, and the same choice goes through once the gateway accepts it.
    state.refuse.attach = undefined;
    await dialog.getByRole('button', { name: 'Attach this result' }).click();
    await expect(
      sheet.getByText('Result attached. It now counts as this cell’s result.')
    ).toBeVisible();
    expect(critical).toEqual([]);
  });
});
