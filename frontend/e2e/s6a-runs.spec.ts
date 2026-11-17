import {
  expect as baseExpect,
  test,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { Job } from '../src/api/platform';
import type { Problem, ProblemRevision } from '../src/api/problems';
import {
  ENGINE,
  NEIGHBORHOOD,
  PROBLEM_FACTS,
  REGISTRATION,
  detailOf,
  jobOf,
  provenanceOf,
} from '../src/test/fixtures/jobs';
import { CURRENT_FIXTURE, catalogFixture } from '../src/test/fixtures/pricingCatalog';
import { digestOf, usageOf } from '../src/test/fixtures/resources';
import { FEDERATED_PRESET, presetFixture, presetPage } from '../src/test/fixtures/presets';

// S6a · execution: run-launch (`/runs/new`, with run presets), the organization's Runs tab (`/orgs/:org/runs`) and run-detail
// (`/runs/:org/:run`, with deriving a composition from a finished run).
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
  created_at: '2026-03-03T00:00:00Z',
});

// --- the problem a run can start from (the one the runs of the fixtures name)

const checkout: Problem = {
  id: 'case-checkout-flow',
  organization_id: 'org-isa-demo',
  slug: 'checkout-flow',
  name: 'Checkout flow',
  description: '',
  created_by_id: 'user-1',
  created_at: '2026-04-02T00:00:00Z',
  updated_at: '2026-04-02T00:00:00Z',
};

const problemRevision = (n: number): ProblemRevision => ({
  id: `rev-checkout-${n}`,
  problem_id: checkout.id,
  revision: n,
  package_digest: digestOf(String(n)),
  package_size: 2048,
  created_by_id: 'user-1',
  created_at: `2026-08-0${n}T10:00:00Z`,
});

// --- the runs

const mine = {
  organization_id: 'org-isa-demo',
  created_by: { id: 'user-1', username: 'lucia.vega' },
};
const rows = {
  feasible: jobOf(
    'job-feasible-1',
    'random-search',
    'completed',
    'FEASIBLE',
    '2026-09-30T09:00:00Z',
    '2026-09-30T09:01:05Z',
    mine
  ),
  running: jobOf('job-running-2', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null, mine),
  queued: jobOf(
    'job-queued-3',
    'random-search',
    'queued',
    null,
    '2026-10-08T08:10:00Z',
    null,
    mine
  ),
  failed: jobOf(
    'job-failed-4',
    'evolutionary',
    'failed',
    'UNKNOWN',
    '2026-10-07T15:00:00Z',
    '2026-10-07T15:00:20Z',
    mine
  ),
  cancelled: jobOf(
    'job-cancelled-5',
    'random-search',
    'cancelled',
    null,
    '2026-10-06T12:00:00Z',
    '2026-10-06T12:00:03Z',
    mine
  ),
  infeasible: jobOf(
    'job-infeasible-6',
    'minizinc',
    'completed',
    'INFEASIBLE',
    '2026-10-01T09:00:00Z',
    '2026-10-01T09:00:40Z',
    mine
  ),
  routed: jobOf(
    'job-routed-7',
    'evolutionary-heuristics',
    'completed',
    'OPTIMAL',
    '2026-10-03T11:00:00Z',
    '2026-10-03T11:00:12Z',
    mine
  ),
  theirs: jobOf(
    'job-theirs-8',
    'evolutionary',
    'completed',
    'OPTIMAL',
    '2026-10-02T10:00:00Z',
    '2026-10-02T10:02:00Z',
    { ...mine, created_by: { id: 'user-2', username: 'ana' } }
  ),
  live: jobOf('job-live-10', 'minizinc', 'running', null, '2026-10-09T08:00:00Z', null, mine),
};

/** The runs of ISA Demo Group, as `listRuns` lists them: every member sees all of them. */
const orgRows: Job[] = [
  rows.running,
  rows.queued,
  rows.failed,
  rows.cancelled,
  rows.feasible,
  rows.infeasible,
  rows.routed,
  rows.theirs,
];

/** What `getRun` answers for each run of ISA Demo Group (its summary and its detail), given the state of the test; `null` is a 404. */
function runOf(id: string, state: State): Record<string, unknown> | null {
  const found = detailTable[id]?.(state);
  const summary =
    [...Object.values(rows)].find(row => row.id === id) ??
    jobOf(id, 'random-search', 'queued', null, '2026-10-09T09:00:00Z', null, mine);
  return found ? { ...summary, ...found } : null;
}

const detailTable: Record<string, (state: State) => ReturnType<typeof detailOf> | null> = {
  'job-feasible-1': () => detailOf('job-feasible-1', 'completed'),
  'job-running-2': () => detailOf('job-running-2', 'running'),
  'job-queued-3': () => detailOf('job-queued-3', 'queued'),
  'job-failed-4': () => detailOf('job-failed-4', 'failed'),
  'job-cancelled-5': () => detailOf('job-cancelled-5', 'cancelled'),
  'job-infeasible-6': () =>
    detailOf('job-infeasible-6', 'completed', {
      result: {
        termination: 'INFEASIBLE',
        solutions: [
          {
            violations: [
              {
                constraint: 'sla-latencia',
                message: 'Total latency is 742 ms; at most 600 ms is allowed.',
              },
            ],
          },
        ],
      },
    }),
  'job-routed-7': () => detailOf('job-routed-7', 'completed'),
  'job-theirs-8': () => detailOf('job-theirs-8', 'completed'),
  'job-live-10': state => detailOf('job-live-10', state.liveDone ? 'completed' : 'running'),
  'job-new-9': () =>
    detailOf('job-new-9', 'queued', {
      provenance: provenanceOf({
        requestedOptions: { time_budget_ms: 600000 },
        options: { time_budget_ms: 60000 },
      }),
    }),
};

// --- what the gateway answers

const EDGE = {
  namespace: 'edge-lab',
  name: 'edge-solver',
  version: '0.3.1',
  digest: digestOf('e'),
};
const EDGE_REGISTRATION = {
  namespace: 'edge-lab',
  name: 'edge-solver-eu',
  version: '1',
  digest: digestOf('r'),
};
const MINIZINC = {
  namespace: 'bim.builtin',
  name: 'minizinc',
  version: '1.0.0',
  digest: digestOf('m'),
};
const MINIZINC_REGISTRATION = {
  namespace: 'bim.builtin',
  name: 'minizinc-deployment',
  version: '1.0.0+builtin.m',
  digest: digestOf('n'),
};

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

const engines = [
  {
    ...ENGINE,
    id: 'engine-1',
    ref: ENGINE,
    modes: [
      mode('sampling', {
        time_budget_ms: { type: 'integer', default: 30000 },
        iterations: { type: 'integer', default: 100000 },
      }),
    ],
  },
  {
    ...MINIZINC,
    id: 'engine-2',
    ref: MINIZINC,
    modes: [mode('cp', { time_budget_ms: { type: 'integer', default: 60000 } })],
  },
];

/** The compilation of a version by the installed toolchain: its analysis and the engine modes that can run it. */
const analysisBody = () => ({
  id: 'compilation-2',
  revision_id: 'rev-checkout-2',
  compilation_digest: digestOf('9'),
  compiler_digest: digestOf('8'),
  ir_digest: digestOf('c'),
  binding_space: '125892',
  created_at: '2026-08-02T10:00:00Z',
  current: true,
  toolchain: {},
  resources: {},
  compatible_modes: [
    { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
    { engine: MINIZINC, registration: MINIZINC_REGISTRATION, mode: 'cp', compatible: true },
    {
      engine: EDGE,
      registration: EDGE_REGISTRATION,
      mode: 'placement',
      compatible: false,
      diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }],
    },
  ],
  analysis: { tasks: 6, candidates: 24, constraints: 2, placement: false, bindingSpace: '125892' },
});

// --- deriving a composition from a run: the organization has none yet, so the version goes to a new one

const newComposition = (body: Record<string, unknown>) => ({
  id: `composition-${String(body.slug)}`,
  slug: body.slug,
  name: body.name,
  description: '',
  kind: body.kind ?? 'application',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: 'user-1',
  created_at: '2026-10-09T09:00:00Z',
  updated_at: '2026-10-09T09:00:00Z',
  version_count: 0,
  latest_version: null,
});

/** The document a derivation of the first solution would seal (`seal: false`), as the gateway answers it. */
const derivedDraft = (body: Record<string, unknown>) => {
  const content = [
    "syntaxVersion: '1.0'",
    'composition: checkout-plan',
    `version: ${String(body.version)}`,
    'kind: application',
    'problem:',
    '  ref: isa-demo/problems/checkout-flow@2',
    `  compilation: ${digestOf('9')}`,
    'workflow:',
    '  seq: [t1, t2, t3]',
    'binding:',
    '  t1:',
    '    candidate: c1',
    '  t2:',
    '    candidate: c3',
    '  t3:',
    '    candidate: c4',
    'values:',
    '  cost:',
    '    value: 9.5',
    '    unit: EUR',
    '  latency:',
    '    value: 420',
    '    unit: ms',
    'evidence:',
    `  run: ${String(body.run)}`,
    `  point: ${String(body.point)}`,
    '',
  ].join('\n');
  return {
    content,
    document: {},
    values: { cost: { value: 9.5, unit: 'EUR' }, latency: { value: 420, unit: 'ms' } },
    diagnostics: [],
  };
};

type Overridable =
  | 'launch'
  | 'cancel'
  | 'retry'
  | 'compilation'
  | 'runs'
  | 'detail'
  | 'neighborhood'
  | 'seal'
  | 'preset';

interface State {
  /** A handler that replaces the default answer of one call. */
  refuse: Partial<Record<Overridable, Handler>>;
  /** The last body or key each write carried, to check what was sent. */
  sent: {
    launch?: unknown;
    key?: string;
    cancel?: string;
    retry?: string;
    create?: unknown;
    derive: unknown[];
    preset?: unknown;
  };
  /** The live run has finished: the next time it is asked about it says so. */
  liveDone: boolean;
}

interface MockOptions {
  /** The account's role in ISA Demo Group. */
  role?: Role;
}

const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<State> {
  const state: State = { refuse: {}, sent: { derive: [] }, liveDone: false };
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'OWNER'),
    org('org-4', 'read-lab', 'Read Lab', 'VIEWER'),
    org('org-5', 'empty-lab', 'Empty Lab', 'MEMBER'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's6a-access');
    localStorage.setItem('openbinding-refresh-token', 's6a-refresh');
  });

  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(
    `${API}/v1/auth/refresh`,
    json({
      access_token: 's6a-access-2',
      refresh_token: 's6a-refresh-2',
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
        capabilities: { maxRunMinutes: 1, maxConcurrentRuns: 3 },
      })
    )
  );
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines`, json({ engines }));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async route => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , orgSlug, section] = parts;
    const found = organizations.find(item => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section === 'presets') {
      // The run presets of the organization: the launcher lists them and saves the settings chosen by hand as a new one.
      if (!found) return detail(404, 'not_found', 'Organization not found.')(route);
      if (route.request().method() === 'POST') {
        state.sent.preset = bodyOf(route);
        const body = bodyOf(route) as { slug: string; name: string };
        return (
          state.refuse.preset ??
          json(presetFixture({ id: 'preset-new', slug: body.slug, name: body.name }), 201)
        )(route);
      }
      return json(
        orgSlug === 'isa-demo' ? presetPage([presetFixture(), FEDERATED_PRESET]) : presetPage([])
      )(route);
    }
    if (section === 'runs') {
      // The runs of the organization: the list, one run, and what a member does to one.
      const [, , , , id, action] = parts;
      const method = route.request().method();
      if (!found) return detail(404, 'not_found', 'Organization not found.')(route);
      const own = orgSlug === 'isa-demo' ? orgRows : [];
      if (!id) {
        if (method === 'POST') {
          state.sent.launch = bodyOf(route);
          state.sent.key = route.request().headers()['idempotency-key'];
          return (
            state.refuse.launch ??
            json(
              {
                id: 'job-new-9',
                status: 'queued',
                profile: 'qos-binding/v1',
                irDigest: digestOf('c'),
              },
              202
            )
          )(route);
        }
        if (state.refuse.runs) return state.refuse.runs(route);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const wantedState = url.searchParams.get('state');
        const wantedEngine = url.searchParams.get('engine');
        const matching = own.filter(
          row =>
            (!wantedState || row.status === wantedState) &&
            (!wantedEngine || row.engine_id === wantedEngine)
        );
        return json({ runs: matching.slice(offset, offset + limit), total: matching.length })(
          route
        );
      }
      if (action === 'cancel') {
        state.sent.cancel = id;
        return (state.refuse.cancel ?? json({ ...rows.running, id, cancellation_requested: true }))(
          route
        );
      }
      if (action === 'retry') {
        state.sent.retry = id;
        return (
          state.refuse.retry ??
          json(
            jobOf('job-new-9', 'evolutionary', 'queued', null, '2026-10-09T09:00:00Z', null, {
              ...mine,
              retry_of_id: id,
            }),
            202
          )
        )(route);
      }
      if (action === 'neighborhood')
        return (state.refuse.neighborhood ?? json({ ...NEIGHBORHOOD, jobId: id }))(route);
      if (state.refuse.detail) return state.refuse.detail(route);
      const run = orgSlug === 'isa-demo' ? runOf(id, state) : null;
      return run ? json(run)(route) : detail(404, 'not_found', 'Run not found.')(route);
    }
    if (section === 'problems') {
      // The problems of the organization: the list, the versions of one, its compilation, and the facts and the IR of that.
      const [, , , , problemSlug, , revisionRef, tail] = parts;
      const own = orgSlug === 'isa-demo' ? [checkout] : [];
      if (!problemSlug)
        return json({ problems: own, total: own.length, limit: 200, offset: 0 })(route);
      if (problemSlug !== checkout.slug || orgSlug !== 'isa-demo')
        return detail(404, 'not_found', 'Problem not found.')(route);
      if (!revisionRef) return json([problemRevision(1), problemRevision(2)])(route);
      if (tail === 'compilation') return (state.refuse.compilation ?? json(analysisBody()))(route);
      if (tail === 'compilations' && parts.at(-1) === 'facts') return json(PROBLEM_FACTS)(route);
      if (tail === 'compilations')
        return json({
          id: 'compilation-2',
          ir_digest: digestOf('c'),
          ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
          source_map: {},
        })(route);
      return json({
        ...problemRevision(Number(revisionRef)),
        document: {},
        files: [],
        resource_digests: {},
        compilations: [],
      })(route);
    }
    if (section === 'compositions') {
      // The organization has no composition: a derivation creates one, previews its document and seals it.
      const [, , , , slug, action] = parts;
      if (!slug && route.request().method() === 'POST') {
        state.sent.create = bodyOf(route);
        return json(newComposition(bodyOf(route)), 201)(route);
      }
      if (!slug) return json({ compositions: [], total: 0, limit: 200, offset: 0 })(route);
      if (action === 'derive') {
        const body = bodyOf(route);
        state.sent.derive.push(body);
        if (body.seal === false) return json(derivedDraft(body))(route);
        return (state.refuse.seal ?? detail(404, 'not_found', 'Composition not found.'))(route);
      }
    }
    if (!section)
      return json(
        found ?? { detail: { code: 'not_found', error: 'Organization not found.' } },
        found ? 200 : 404
      )(route);
    return json([])(route);
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

const RUNS = '/orgs/isa-demo/runs';
const RUN = (id: string) => `/runs/isa-demo/${id}`;
const LAUNCH = '/runs/new?org=isa-demo';
const NOT_FOUND = 'Page not found';

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S6a execution`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    /** An action of the run page: a button from `sm` up, an item of the ⋯ menu on a phone. */
    const press = async (page: Page, label: string) => {
      const main = page.locator('main');
      if (isMobile) {
        await main.getByRole('button', { name: 'More actions' }).click();
        await main.getByRole('menuitem', { name: label }).click();
      } else await main.getByRole('button', { name: label }).click();
    };
    /** Whether the run page offers an action, wherever the width puts it. */
    const expectOffered = async (page: Page, label: string, offered: boolean) => {
      const main = page.locator('main');
      if (!isMobile) {
        await expect(main.getByRole('button', { name: label })).toHaveCount(offered ? 1 : 0);
        return;
      }
      const more = main.getByRole('button', { name: 'More actions' });
      if (!offered && (await more.count()) === 0) return;
      await more.click();
      await expect(main.getByRole('menuitem', { name: label })).toHaveCount(offered ? 1 : 0);
      await page.keyboard.press('Escape');
    };
    /** Opens a tab of the run page. */
    const tab = (page: Page, label: string) =>
      page.locator('main').getByRole('navigation', { name: 'Run sections' }).getByRole('link', {
        name: label,
      });

    test('run-list /orgs/:org/runs · the Runs tab: every run, who launched it, status chips, filters and retry', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(RUNS);
      const main = page.locator('main');
      const panel = main.getByRole('region', { name: 'Runs' });
      const list = panel.getByRole('list', { name: 'Runs of the organization' });

      await expect(panel.getByRole('heading', { level: 2, name: /Runs/ })).toBeVisible();
      await expect(panel.getByText(/Every engine run launched in ISA Demo Group\./)).toBeVisible();
      await expect(panel.getByRole('link', { name: 'Start a run' })).toHaveAttribute(
        'href',
        LAUNCH
      );
      await expect(list.getByRole('listitem')).toHaveCount(8);
      await expect(list.getByRole('link', { name: /^Open run/ })).toHaveCount(8);
      await expect(list.getByText('Owner only')).toHaveCount(0);
      await expect(list.getByText('ana', { exact: true })).toHaveCount(1);
      await expect(list.getByRole('button', { name: 'Retry' })).toHaveCount(2);
      await expect(panel.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await capture(page, testInfo, `list-${name}-rows`);

      // Narrowing by status (a gateway filter, kept in the address) and by engine.
      await panel.getByRole('button', { name: 'Running', exact: true }).click();
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await expect(page).toHaveURL(`${RUNS}?state=running`);
      await capture(page, testInfo, `list-${name}-filtered`);
      await panel.getByRole('button', { name: 'All', exact: true }).click();
      await panel.getByRole('button', { name: /^Filters/ }).click();
      await panel
        .getByRole('group', { name: 'Filters' })
        .getByRole('combobox', { name: 'Engine' })
        .selectOption('minizinc');
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await capture(page, testInfo, `list-${name}-engine`);
      await panel
        .getByRole('group', { name: 'Filters' })
        .getByRole('combobox', { name: 'Engine' })
        .selectOption('');
      await page.keyboard.press('Escape');
      await expect(list.getByRole('listitem')).toHaveCount(8);

      // A retry of a failed run of its own, then one the account cannot afford.
      await list.getByRole('button', { name: 'Retry' }).first().click();
      await expect(panel.getByText('Retry queued.')).toBeVisible();
      await expect(panel.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute(
        'href',
        RUN('job-new-9')
      );
      expect(state.sent.retry).toBe('job-failed-4');
      await capture(page, testInfo, `list-${name}-retry`);
      state.refuse.retry = detail(402, 'quota_exceeded', 'Storage exhausted.', {
        quota: { limit_id: 'maxRepositoryStorage', limit: 50, used: 50 },
      });
      await list.getByRole('button', { name: 'Retry' }).last().click();
      await expect(
        panel.getByText('Retry refused: Out of storage (402 · quota_exceeded)')
      ).toBeVisible();
      await expect(panel.getByRole('link', { name: 'Compare plans' })).toHaveAttribute(
        'href',
        '/pricing'
      );
      await capture(page, testInfo, `list-${name}-402`);
      expect(critical).toEqual([]);
    });

    test('run-list /orgs/:org/runs · empty, 503 and a viewer', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      await page.goto('/orgs/empty-lab/runs');
      await expect(main.getByText('No runs yet')).toBeVisible();
      await expect(main.getByText('Pick a problem version and an engine to run it.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Start a run' }).last()).toHaveAttribute(
        'href',
        '/runs/new?org=empty-lab'
      );
      await capture(page, testInfo, `list-${name}-empty`);

      state.refuse.runs = unavailable;
      await page.goto(RUNS);
      await expect(
        main.getByRole('alert').filter({ hasText: 'Runs can’t be loaded right now' })
      ).toContainText('(503)');
      await expect(main.getByText('No runs yet')).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-503`);
      state.refuse.runs = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('list', { name: 'Runs of the organization' })).toBeVisible();

      // A viewer reads the runs; nothing on the screen starts one.
      await page.goto('/orgs/read-lab/runs');
      await expect(main.getByText('No runs yet')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Start a run' })).toHaveCount(0);
      await capture(page, testInfo, `list-${name}-viewer`);
      expect(critical).toEqual([]);
    });

    test('run-detail /runs/:org/:run · a finished run, its result and what it ran on', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto(RUN('job-feasible-1'));
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 1, name: 'random-search run' })
      ).toBeVisible();
      const crumbs = main.getByRole('navigation', { name: 'Breadcrumb' });
      await expect(crumbs.getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
        'href',
        '/orgs/isa-demo'
      );
      await expect(crumbs.getByRole('link', { name: 'Runs' })).toHaveAttribute('href', RUNS);
      await expect(main.getByText('Feasible: meets every must-hold rule')).toBeVisible();
      await expect(
        main.getByText(/launched by you · problem Checkout flow · version 2/)
      ).toBeVisible();
      await expect(main.getByText(/· started .* ago/)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Analyze' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-top`, { height: 1700 });

      // The authoritative result: figures and a table of providers; the raw JSON only behind View source.
      const best = main.getByRole('region', { name: 'Run result' });
      await expect(
        best.getByRole('list', { name: 'Quality of this combination' }).getByRole('listitem')
      ).toHaveCount(2);
      await expect(
        best.getByRole('region', { name: 'Chosen providers' }).getByRole('row')
      ).toHaveCount(4);
      // The table names each candidate and its values from the facts of the run's compilation.
      await expect(
        best.getByRole('region', { name: 'Chosen providers' }).getByRole('row', { name: /^t1/ })
      ).toContainText('120');
      const solutionSource = main.getByRole('region', { name: 'Solution 1 source' });
      await expect(solutionSource).toBeHidden();
      await capture(page, testInfo, `detail-${name}-result`, { area: best });
      await best.getByText('View source').first().click();
      await expect(solutionSource).toContainText('"c1"');
      await capture(page, testInfo, `detail-${name}-result-source`, { area: best });

      // Single swaps on request; the engine's own report is loaded with the run and shown as the claimed and evaluated values.
      const swaps = main.getByRole('region', { name: 'What if one task used another provider?' });
      await swaps.getByRole('button', { name: 'Check single swaps' }).click();
      await expect(swaps.getByRole('list', { name: 'Single-task swaps' })).toContainText(
        'catalog · fastpay'
      );
      await expect(swaps.getByText('Better', { exact: true })).toBeVisible();
      await capture(page, testInfo, `detail-${name}-swaps`, { area: swaps });
      const report = best.getByRole('region', { name: 'Claimed and evaluated values' });
      await expect(report).toBeVisible();
      await capture(page, testInfo, `detail-${name}-report`, { area: report });

      // The Get run menu: the compiled problem it ran.
      await main.getByRole('button', { name: 'Get run' }).click();
      const downloaded = page.waitForEvent('download');
      await main.getByRole('menuitem', { name: /Download compiled problem/ }).click();
      expect((await downloaded).suggestedFilename()).toBe('run-compiled-problem.json');
      await page.keyboard.press('Escape');

      // Settings, provenance and timeline are tabs of their own.
      await tab(page, 'Settings').click();
      await expect(page).toHaveURL(`${RUN('job-feasible-1')}?tab=settings`);
      const settings = main.getByRole('region', { name: 'Settings asked and used' });
      await expect(settings.getByRole('row', { name: /Time budget/ })).toContainText('600 s');
      await expect(settings.getByRole('row', { name: /Time budget/ })).toContainText(
        'Reduced to the plan’s ceiling'
      );
      await capture(page, testInfo, `detail-${name}-settings`);

      await tab(page, 'Provenance').click();
      const where = main.getByRole('region', { name: 'Where this result comes from' });
      await expect(where.getByRole('link', { name: 'Source and compiled form' })).toBeVisible();
      await expect(where).not.toContainText(/sha256-|[0-9a-f]{12}/);
      await expect(where.getByRole('link', { name: 'Checkout flow · version 2' })).toBeVisible();
      await expect(where.getByRole('link', { name: 'Add to a report' })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-provenance`, { area: where });

      await tab(page, 'Timeline').click();
      await expect(
        main.getByRole('region', { name: 'Timeline' }).getByText('Finished · not live')
      ).toBeVisible();
      await capture(page, testInfo, `detail-${name}-timeline`);
      expect(critical).toEqual([]);
    });

    test('run-detail /runs/:org/:run · a member keeps a finished run as a composition; a viewer is not offered to', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(RUN('job-feasible-1'));
      const main = page.locator('main');

      await expect(main.getByRole('region', { name: 'Run result' })).toBeVisible();
      await press(page, 'Keep as composition');
      const dialog = page.getByRole('dialog', { name: 'Derive a composition' });
      await expect(
        dialog.getByRole('radio', { name: 'A composition of this organization' })
      ).toBeDisabled();
      await dialog.getByLabel('Name').fill('Checkout plan');
      await expect(dialog.getByLabel('Address')).toHaveValue('checkout-plan');
      await dialog.getByRole('button', { name: 'Next' }).click();

      // The run's two solutions, as its result gives them, and the first label of a new composition.
      const points = dialog.getByRole('region', { name: 'Solutions of the run' });
      await expect(points.getByRole('row')).toHaveCount(3);
      await expect(points.getByRole('row', { name: /Solution 2/ })).toContainText('560');
      await points.getByRole('radio', { name: 'Solution 2' }).check();
      await expect(dialog.getByLabel('Version label')).toHaveValue('1.0.0');
      await capture(page, testInfo, `detail-${name}-derive-what`, { area: dialog });
      await dialog.getByRole('button', { name: 'Preview' }).click();

      await expect(dialog.getByRole('region', { name: 'Derived composition.yaml' })).toContainText(
        'point: 1'
      );
      await expect(dialog.getByRole('region', { name: 'Values' })).toContainText('9.5 EUR');
      expect(state.sent.create).toEqual({
        slug: 'checkout-plan',
        name: 'Checkout plan',
        kind: 'application',
        description: '',
      });
      expect(state.sent.derive).toEqual([
        { run: 'job-feasible-1', point: 1, version: '1.0.0', seal: false },
      ]);
      await capture(page, testInfo, `detail-${name}-derive-preview`, { area: dialog });

      // Another document holds 1.0.0: the label says so, and nothing leaves the run.
      state.refuse.seal = detail(
        409,
        'version_label_taken',
        'Version 1.0.0 already holds another content.'
      );
      await dialog.getByRole('button', { name: 'Seal 1.0.0' }).click();
      await expect(
        dialog.getByText('1.0.0 already holds another document. Choose another label.')
      ).toBeVisible();
      expect(state.sent.derive.at(-1)).toEqual({
        run: 'job-feasible-1',
        point: 1,
        version: '1.0.0',
        seal: true,
      });
      await expect(page).toHaveURL(RUN('job-feasible-1'));
      await dialog.getByRole('button', { name: 'Back' }).click();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);

      expect(critical).toEqual([]);

      // A viewer of the organization reads the run and its result, and is not offered a derivation.
      const viewer = await page.context().newPage();
      await mockApi(viewer, { role: 'VIEWER' });
      await viewer.goto(RUN('job-feasible-1'));
      const result = viewer.locator('main').getByRole('region', { name: 'Run result' });
      await expect(
        result.getByRole('heading', { name: 'What if one task used another provider?' })
      ).toBeVisible();
      await expect(
        viewer.locator('main').getByRole('button', { name: 'Keep as composition' })
      ).toHaveCount(0);
      await expect(
        viewer.locator('main').getByRole('button', { name: 'More actions' })
      ).toHaveCount(0);
      await viewer.close();
    });

    test('run-detail /runs/:org/:run · a live run follows its state until it finishes', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${RUN('job-live-10')}?tab=timeline`);
      const main = page.locator('main');

      await expect(main.getByText('Live · connected')).toBeVisible();
      await expectOffered(page, 'Cancel run', true);
      await expect(
        main.getByText(
          'Live updates report status changes only; there’s no progress percentage to show.'
        )
      ).toBeVisible();
      await capture(page, testInfo, `detail-${name}-live`, { height: 1400 });
      await tab(page, 'Result').click();
      await expect(
        main.getByText('No result yet. It appears here when the run finishes.')
      ).toBeVisible();

      // The next reading says it ended; the page notices on its own, without being asked to reload.
      state.liveDone = true;
      await expect(main.getByRole('region', { name: 'Run result' })).toBeVisible({
        timeout: 30_000,
      });
      await expectOffered(page, 'Cancel run', false);
      await tab(page, 'Timeline').click();
      await expect(main.getByText('Finished · not live')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-finished-live`, { height: 1400 });
      expect(critical).toEqual([]);
    });

    test('run-detail /runs/:org/:run · cancel, retry and the ways a run ends without a result', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      // Cancelling a run that is going, and a run that had already finished (409).
      await page.goto(RUN('job-running-2'));
      await press(page, 'Cancel run');
      await expect(
        main.getByText('Cancellation requested. The engine stops at its next check.')
      ).toBeVisible();
      await expectOffered(page, 'Cancel run', false);
      expect(state.sent.cancel).toBe('job-running-2');
      await capture(page, testInfo, `detail-${name}-cancel`, { height: 1300 });
      state.refuse.cancel = detail(409, 'terminal_job', 'The job is already terminal.');
      await page.reload();
      await press(page, 'Cancel run');
      await expect(main.getByText('Already finished (409 · terminal_job)')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-409`, { height: 1300 });

      // A failed run says why, and a retry is a new attempt.
      await page.goto(RUN('job-failed-4'));
      await expect(main.getByRole('alert').filter({ hasText: 'The run failed' })).toContainText(
        'Retrying starts a new attempt.'
      );
      await press(page, 'Retry');
      await expect(main.getByText('Retry queued as a new attempt.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Follow the new run' })).toHaveAttribute(
        'href',
        RUN('job-new-9')
      );
      expect(state.sent.retry).toBe('job-failed-4');
      await capture(page, testInfo, `detail-${name}-failed-retry`, { height: 1500 });
      state.refuse.retry = json(
        {
          detail: {
            code: 'concurrency_limit_exceeded',
            error: 'Concurrency limit exceeded.',
            concurrency: { limit_id: 'maxConcurrentRuns', limit: 3, used: 3 },
          },
        },
        429
      );
      await press(page, 'Retry');
      await expect(
        main.getByText(/Retry refused: All your run slots are busy \(429/)
      ).toBeVisible();
      await capture(page, testInfo, `detail-${name}-429`, { height: 1500 });

      // Cancelled, and infeasible with the rule it breaks.
      await page.goto(RUN('job-cancelled-5'));
      await expect(main.getByText('Cancelled before producing a result.')).toBeVisible();
      await capture(page, testInfo, `detail-${name}-cancelled`, { height: 1300 });
      await page.goto(RUN('job-infeasible-6'));
      const why = main.getByRole('region', { name: 'Why no combination works' });
      await expect(why).toContainText('Total latency is 742 ms');
      await expect(why.getByRole('link', { name: 'See the rules' })).toBeVisible();
      await expect(
        main.getByRole('heading', { name: 'What if one task used another provider?' })
      ).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-infeasible`, { height: 1700 });
      expect(critical).toEqual([]);
    });

    test('run-detail /runs/:org/:run · a teammate’s run, a run that is not there and a key without access', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      // A teammate's run opens for every member, with who launched it.
      await page.goto(RUN('job-theirs-8'));
      await expect(main.getByRole('heading', { level: 1, name: 'evolutionary run' })).toBeVisible();
      await expect(main.getByText(/launched by ana/)).toBeVisible();

      // A run of another organization, or one that does not exist: the same in-place 404, even for an administrator.
      await page.goto(RUN('job-ghost-11'));
      await expect(main.getByRole('heading', { name: NOT_FOUND })).toBeVisible();
      await capture(page, testInfo, `detail-${name}-404`);
      await page.goto('/runs/ghost/job-feasible-1');
      await expect(main.getByRole('heading', { name: NOT_FOUND })).toBeVisible();

      state.refuse.detail = detail(
        403,
        'api_key_forbidden',
        'The API key does not include jobs:read.'
      );
      await page.goto(RUN('job-feasible-1'));
      await expect(
        main.getByText(/This API key can’t read runs or doesn’t include this engine \(403/)
      ).toBeVisible();
      await capture(page, testInfo, `detail-${name}-403-key`);

      state.refuse.detail = unavailable;
      await page.goto(RUN('job-feasible-1'));
      await expect(main.getByText(/The run couldn’t be loaded \(503/)).toBeVisible();
      await expect(main.getByRole('heading', { name: NOT_FOUND })).toHaveCount(0);
      await capture(page, testInfo, `detail-${name}-503`);
      expect(critical).toEqual([]);
    });
    test('run-launch /runs/new · from a revision: four steps, what the plan reduces, accepted', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${LAUNCH}&problem=checkout-flow&revision=2`);
      const main = page.locator('main');
      const next = main.getByRole('button', { name: 'Continue' });

      await expect(main.getByRole('heading', { level: 1, name: 'New run' })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Organization', exact: true })).toContainText(
        'ISA Demo Group'
      );
      await expect(main.getByRole('link', { name: 'Back to the runs' })).toHaveAttribute(
        'href',
        RUNS
      );
      const source = main.getByRole('radiogroup', { name: 'Source' });
      await expect(source.getByRole('radio', { name: /Checkout flow · version 2/ })).toBeChecked();
      await expect(source.getByRole('radio')).toHaveCount(2);
      await capture(page, testInfo, `launch-${name}-step1`);

      await next.click();
      const engineGroup = main.getByRole('radiogroup', { name: 'Engine' });
      await expect(
        engineGroup.getByRole('radio', { name: /^random-search.*Can run this/ })
      ).toBeChecked();
      await expect(
        engineGroup.getByRole('radio', { name: /^edge-solver.*It cannot read a RoutingOverlay\./ })
      ).toBeDisabled();
      await expect(engineGroup.getByRole('radio')).toHaveCount(3);
      await capture(page, testInfo, `launch-${name}-step2`);

      const budget = main.getByLabel('Time budget');
      await expect(budget).toHaveValue('30');
      await budget.fill('600');
      await expect(main.getByText('60 s (reduced)', { exact: true })).toBeVisible();
      await expect(
        main.getByText(
          'Values above your plan run at the ceiling and the run carries a note; it isn’t an error.'
        )
      ).toBeVisible();
      await capture(page, testInfo, `launch-${name}-step3`);

      await expect(main.getByRole('heading', { name: 'Before you send' })).toBeVisible();
      await expect(
        main.getByText('Time budget 60 s (reduced) · Iterations 100,000 iterations')
      ).toBeVisible();
      await expect(main.getByText(/used \+ up to/)).toHaveCount(0);
      await expect(
        main.getByText('≈ 10^5.1 combinations · this deployment sets the ceiling')
      ).toBeVisible();
      await capture(page, testInfo, `launch-${name}-step4`);

      await main.getByRole('button', { name: 'Send run' }).click();
      await expect(main.getByRole('heading', { name: 'Run accepted · queued' })).toBeVisible();
      await expect(
        main.getByText(
          /Time budget was reduced to 60 s, what your plan allows; the run carries that note\./
        )
      ).toBeVisible();
      expect(state.sent.launch).toMatchObject({
        revision: 'rev-checkout-2',
        engine: ENGINE,
        registration: REGISTRATION,
        mode: 'sampling',
        options: { time_budget_ms: 600000, iterations: 100000 },
      });
      expect(state.sent.key).toMatch(/^[0-9a-f-]{36}$/);
      await capture(page, testInfo, `launch-${name}-accepted`);

      await main.getByRole('link', { name: 'Follow the run' }).click();
      await expect(page).toHaveURL(new RegExp(`${RUN('job-new-9')}$`));
      await expect(
        main.getByRole('heading', { level: 1, name: 'random-search run' })
      ).toBeVisible();
      await tab(page, 'Timeline').click();
      await expect(main.getByText('Live · connected')).toBeVisible();
      await tab(page, 'Settings').click();
      await expect(
        main
          .getByRole('region', { name: 'Settings asked and used' })
          .getByRole('row', { name: /Time budget/ })
      ).toContainText('Reduced to the plan’s ceiling');
      await capture(page, testInfo, `launch-${name}-followed`, { height: 1500 });
      expect(critical).toEqual([]);
    });

    test('run-launch /runs/new · an exact engine from the latest version and every way the gateway refuses', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(LAUNCH);
      const main = page.locator('main');
      const next = main.getByRole('button', { name: 'Continue' });

      const source = main.getByRole('radio', { name: /Checkout flow · version 2/ });
      await expect(source).toBeChecked();
      await expect(source).not.toHaveAccessibleName(/sha256-|[0-9a-f]{12}/);
      await next.click();
      await expect(
        main
          .getByRole('radiogroup', { name: 'Engine' })
          .getByRole('radio', { name: /^random-search/ })
      ).toBeChecked();
      const send = main.getByRole('button', { name: 'Send run' });

      // 402: out of an allowance.
      state.refuse.launch = detail(402, 'quota_exceeded', 'Storage exhausted.', {
        quota: { limit_id: 'maxRepositoryStorage', limit: 50, used: 50 },
      });
      await send.click();
      // An error is an alert; a refusal that is about the plan or the credential is a status. Either way it is the one notice on screen.
      const refusal = main.locator('.ui-notice');
      await expect(refusal).toContainText('Out of storage (402 · quota_exceeded)');
      await expect(refusal).toContainText('You’ve used 50 of 50 storage. Nothing was started.');
      await expect(refusal.getByRole('link', { name: 'See your plan' })).toHaveAttribute(
        'href',
        '/me/settings?section=plan'
      );
      await expect(send).toBeEnabled();
      await capture(page, testInfo, `launch-${name}-402`);
      expect(state.sent.launch).toMatchObject({
        revision: 'rev-checkout-2',
        engine: ENGINE,
        mode: 'sampling',
      });

      // 422: over the deployment's size limit, whatever the plan.
      state.refuse.launch = detail(
        422,
        'binding_space_over_technical_limit',
        'instance binding space exceeds the deployment limit',
        {
          quota: {
            limit_id: 'MAX_BINDING_SPACE_LOG10',
            state: 'exhausted',
            source: 'technical',
            limit: 20,
            used: 23,
          },
        }
      );
      await send.click();
      await expect(refusal).toContainText(
        'Over this deployment’s size limit (422 · binding_space_over_technical_limit)'
      );
      await expect(refusal.getByRole('link', { name: 'Compare plans' })).toHaveCount(0);
      await capture(page, testInfo, `launch-${name}-422-size`);

      // 429: job slots busy, with the time to wait.
      state.refuse.launch = route =>
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
      await send.click();
      await expect(refusal).toContainText(
        'All your run slots are busy (429 · concurrency_limit_exceeded)'
      );
      await expect(refusal).toContainText('You can have 3 runs going at once.');
      await expect(refusal.getByRole('timer')).toContainText('A slot should free up in about');
      await capture(page, testInfo, `launch-${name}-429`);

      // 403: the plan does not include it, and a key without the permission.
      state.refuse.launch = detail(
        403,
        'feature_not_entitled',
        'Federated runs need the federated engines feature.'
      );
      await send.click();
      await expect(refusal).toContainText('Not included in your plan (403 · feature_not_entitled)');
      await capture(page, testInfo, `launch-${name}-403-plan`);
      state.refuse.launch = detail(
        403,
        'api_key_forbidden',
        'The API key does not include engines:execute.'
      );
      await send.click();
      await expect(refusal).toContainText(
        'This credential can’t start runs (403 · api_key_forbidden)'
      );
      await expect(refusal.getByText('engines:execute', { exact: true })).toBeVisible();
      await capture(page, testInfo, `launch-${name}-403-key`);

      // 422: the mode cannot run it; 404: the key does not allow the engine; 409; 503.
      state.refuse.launch = json(
        {
          title: 'engine_mode_incompatible',
          status: 422,
          detail: 'The mode cannot run it.',
          diagnostics: [{ message: 'The mode cannot place a RoutingOverlay.' }],
        },
        422
      );
      await send.click();
      await expect(refusal).toContainText('This engine can’t run this problem');
      await expect(refusal).toContainText('The mode cannot place a RoutingOverlay.');
      await capture(page, testInfo, `launch-${name}-422`);
      state.refuse.launch = detail(404, 'not_found', 'Engine revision not found.');
      await send.click();
      await expect(refusal).toContainText('Engine not available with this key (404 · not_found)');
      state.refuse.launch = detail(
        503,
        'pricing_unavailable',
        'The pricing service is not reachable.'
      );
      await send.click();
      await expect(refusal).toContainText(
        'Limits can’t be checked right now (503 · pricing_unavailable)'
      );
      await expect(main.getByRole('heading', { name: /Run accepted/ })).toHaveCount(0);
      await capture(page, testInfo, `launch-${name}-503`);
      expect(critical).toEqual([]);
    });

    test('run-launch /runs/new · from a run preset, detached with Edit, and the settings saved as a new preset', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto(`${LAUNCH}&problem=checkout-flow&revision=2`);
      const main = page.locator('main');
      const next = main.getByRole('button', { name: 'Continue' });

      // Start from a preset: the engine, mode, options and optimization come from it, read-only.
      await next.click();
      const picker = main.getByLabel('Start from a preset');
      await expect(picker).toBeEnabled();
      await picker.selectOption('fast-sampling');
      const attached = main.getByRole('region', { name: 'Run preset Fast sampling' });
      await expect(attached).toContainText('random-search 1.0.0 · mode sampling');
      await expect(attached).toContainText('time budget 30 s · iterations 5,000');
      await expect(attached).toContainText('Can run this');
      await expect(main.getByRole('radiogroup', { name: 'Engine' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Manage run presets' })).toHaveAttribute(
        'href',
        '/orgs/isa-demo/presets'
      );
      await capture(page, testInfo, `launch-${name}-preset`);
      await expect(
        main.getByText(
          'The settings come from the preset Fast sampling: time budget 30 s · iterations 5,000.'
        )
      ).toBeVisible();
      await expect(main.getByText('Fast sampling (fast-sampling)')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save as preset' })).toHaveCount(0);
      await capture(page, testInfo, `launch-${name}-preset-review`);
      await main.getByRole('button', { name: 'Send run' }).click();
      await expect(main.getByRole('heading', { name: 'Run accepted · queued' })).toBeVisible();
      expect(state.sent.launch).toEqual({ revision: 'rev-checkout-2', preset: 'fast-sampling' });

      // Edit detaches it: the settings move into the form, and every one of them is sent.
      await page.goto(`${LAUNCH}&problem=checkout-flow&revision=2&preset=fast-sampling`);
      await next.click();
      await main
        .getByRole('region', { name: 'Run preset Fast sampling' })
        .getByRole('button', { name: 'Edit' })
        .click();
      await expect(
        main
          .getByRole('radiogroup', { name: 'Engine' })
          .getByRole('radio', { name: /^random-search/ })
      ).toBeChecked();
      await expect(main.getByLabel('Time budget')).toHaveValue('30');
      await expect(main.getByLabel('Iterations')).toHaveValue('5000');

      // Save as preset (MEMBER).
      await main.getByRole('button', { name: 'Save as preset' }).click();
      const dialog = page.getByRole('dialog', { name: 'Save as a run preset' });
      await dialog.getByLabel('Preset name').fill('Checkout sampling');
      await expect(dialog.getByLabel('Preset address')).toHaveValue('checkout-sampling');
      await capture(page, testInfo, `launch-${name}-save-preset`);
      await dialog.getByRole('button', { name: 'Save preset' }).click();
      await expect(main.getByText(/Saved as the run preset Checkout sampling\./)).toBeVisible();
      expect(state.sent.preset).toEqual({
        slug: 'checkout-sampling',
        name: 'Checkout sampling',
        description: '',
        engine: ENGINE,
        registration: null,
        mode: 'sampling',
        options: { time_budget_ms: 30000, iterations: 5000 },
        optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
      });

      // A taken address keeps the dialog open and says so.
      state.refuse.preset = detail(
        409,
        'slug_conflict',
        'That preset slug is in use in this organization.'
      );
      await page.goto(`${LAUNCH}&problem=checkout-flow&revision=2`);
      await next.click();
      await main.getByRole('button', { name: 'Save as preset' }).click();
      await dialog.getByLabel('Preset name').fill('Fast sampling');
      await dialog.getByRole('button', { name: 'Save preset' }).click();
      await expect(dialog.getByRole('alert')).toContainText(
        'Another preset of this organization has that address (409 · slug_conflict).'
      );
      await capture(page, testInfo, `launch-${name}-save-preset-409`);
      expect(critical).toEqual([]);
    });

    test('run-launch /runs/new · a viewer, a version that is gone and a problem too big for the deployment', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('main');

      await page.goto('/runs/new?org=read-lab');
      await expect(main.getByRole('note')).toContainText(
        'You’re a VIEWER of Read Lab. You can look through the steps, but starting a run needs MEMBER.'
      );
      await expect(main.getByText(/Nothing to solve yet\./)).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save as preset' })).toHaveCount(0);
      await capture(page, testInfo, `launch-${name}-viewer`);

      state.refuse.compilation = detail(404, 'not_found', 'Problem revision not found.');
      await page.goto(`${LAUNCH}&problem=checkout-flow&revision=2`);
      await main.getByRole('button', { name: 'Continue' }).click();
      await expect(main.getByText('Problem version not found (404)')).toBeVisible();
      await expect(main.getByRole('radiogroup', { name: 'Engine' })).toHaveCount(0);
      await capture(page, testInfo, `launch-${name}-revision-404`);

      state.refuse.compilation = detail(
        422,
        'binding_space_over_technical_limit',
        'instance binding space exceeds the deployment limit',
        {
          quota: {
            limit_id: 'MAX_BINDING_SPACE_LOG10',
            state: 'exhausted',
            source: 'technical',
            limit: 20,
            used: 23,
          },
        }
      );
      await page.goto(`${LAUNCH}&problem=checkout-flow&revision=2`);
      await main.getByRole('button', { name: 'Continue' }).click();
      await expect(main.getByRole('alert')).toContainText(
        'Over this deployment’s size limit (422 · binding_space_over_technical_limit)'
      );
      await expect(
        main
          .getByRole('radiogroup', { name: 'Engine' })
          .getByRole('radio', { name: /^random-search.*Checked when you send/ })
      ).toBeEnabled();
      await capture(page, testInfo, `launch-${name}-422-analysis`);
      expect(critical).toEqual([]);
    });
  });
}
