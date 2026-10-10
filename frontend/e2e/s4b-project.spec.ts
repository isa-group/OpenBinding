import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { REPORT_MARKER, samplePackage } from '../src/pages/Project/packageFixture';

// S4b · organization and collaboration, part 2: proj-create, proj-overview, proj-settings, proj-package.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: the desktop walks the states of the screen, the phone gets its layout and its dialogs.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json({ detail: { code, error, ...extra } }, status);
const noContent: Handler = (route) => route.fulfill({ status: 204 });
/** A service that does not answer: a 503 with no machine code, as a proxy in front of the gateway would send it. */
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

interface Org {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  billing_sponsor_user_id: string;
  effective_role: Role;
  created_at: string;
}

const org = (n: number, slug: string, name: string, role: Role, over: Partial<Org> = {}): Org => ({
  id: `org-${n}`, slug, name, parent_id: null, billing_sponsor_user_id: 'user-1', effective_role: role, created_at: '2026-03-03T00:00:00Z', ...over,
});

const isaDemo = org(1, 'isa-demo', 'ISA Demo Group', 'OWNER');
const consultora = org(3, 'consultora-demo', 'Consultora Demo', 'VIEWER', { billing_sponsor_user_id: 'user-nora' });
const memberLab = org(4, 'member-lab', 'Member Lab', 'MEMBER', { billing_sponsor_user_id: 'user-nora' });

interface Project {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

const project = (n: number, orgId: string, slug: string, name: string, description: string, visibility: 'public' | 'private'): Project => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description, visibility, created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
});

const projectsOf = (): Record<string, Project[]> => ({
  'isa-demo': [
    project(1, 'org-1', 'qos-benchmarks', 'QoS Benchmarks', 'Reference binding cases with workflow and placement.', 'public'),
    project(2, 'org-1', 'checkout-privado', 'Checkout (privado)', 'Internal payments case with proprietary candidates.', 'private'),
  ],
  'consultora-demo': [project(3, 'org-3', 'client-case', 'Client case', 'Work for a client.', 'private')],
  'member-lab': [project(4, 'org-4', 'bench', 'Bench', 'A bench.', 'private')],
});

const digest = (char: string) => `sha256-${char.repeat(64)}`;

/** What the gateway reports for the RESEARCH plan, with some of the sponsor's room used. */
const researchUsage = () => ({
  plan: 'RESEARCH',
  contract_pending: false,
  features: { collaboration: true, solve: true },
  capabilities: { taskStarts: 50, concurrentJobs: 3, organizations: 5, members: 15, projects: 50, privateProjects: 30, maxPayloadBytes: 134_217_728 },
  limits: {
    projects: { limit_id: 'projects', limit: 50, used: 3, remaining: 47, unit: 'project', renews_at: null },
    privateProjects: { limit_id: 'privateProjects', limit: 30, used: 2, remaining: 28, unit: 'project', renews_at: null },
  },
});

/** The jobs of the account (its history) and of the project: only two of the three project jobs were launched by this account. */
const ownJobs = () => ({
  jobs: [
    { id: '00000000-0000-0000-0000-0000000000f2', engine_id: 'minizinc', status: 'running', termination: null, solutions: null, created_at: '2026-10-08T08:00:00Z', finished_at: null },
    { id: '00000000-0000-0000-0000-0000000000f6', engine_id: 'random-search', status: 'completed', termination: 'INFEASIBLE', solutions: 0, created_at: '2026-10-01T09:00:00Z', finished_at: '2026-10-01T09:00:40Z' },
  ],
  total: 2,
  retention_days: 180,
});

const projectJob = (id: string, engine: string, status: string, termination: string | null, createdAt: string, finishedAt: string | null) => ({
  id, engine_id: engine, status, cancellation_requested: false, retry_of_id: null, organization_id: 'org-1', project_id: 'project-1',
  created_at: createdAt, finished_at: finishedAt, termination,
});

const qosJobs = () => [
  projectJob('00000000-0000-0000-0000-0000000000f2', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null),
  projectJob('00000000-0000-0000-0000-0000000000f6', 'random-search', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z'),
  projectJob('00000000-0000-0000-0000-0000000000f9', 'evolutionary', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z'),
];

const checkoutCase = { id: 'case-1', project_id: 'project-1', slug: 'flujo-checkout', name: 'Flujo de checkout', description: 'Catalog grown from 5 to 8 candidates for the payment task.', created_by_id: 'user-1', created_at: '2026-08-01T00:00:00Z' };
const caseRevisions = [
  { id: 'rev-1', binding_case_id: 'case-1', revision: 1, digest: digest('1'), document: {}, source_snapshot_id: null, created_at: '2026-08-01T00:00:00Z' },
  { id: 'rev-2', binding_case_id: 'case-1', revision: 2, digest: digest('2'), document: {}, source_snapshot_id: null, created_at: '2026-08-20T00:00:00Z' },
];
const study = {
  archived: false, id: 'study-1', definition_version_id: 'sv-1', definition_artifact_id: 'sa-1', project_id: 'project-1', slug: 'engines-seeds', name: 'Engines × seeds', description: '',
  definition: { case_revision_ids: ['rev-1', 'rev-2'], engines: [{}, {}], parameter_sets: [{}], seeds: [1, 2] }, state: 'active', created_by_id: 'user-1', created_at: '2026-09-20T00:00:00Z',
};
const studyRun = { id: 'run-1', definition_version_id: 'sv-1', study_id: 'study-1', run_number: 1, state: 'partial', matrix_digest: digest('d'), cells: 8, summary: {}, created_at: '2026-09-21T00:00:00Z', finished_at: null };
const cells = [...Array.from({ length: 6 }, () => 'completed'), 'failed', 'cancelled'].map((state, index) => ({
  id: `cell-${index}`, study_run_id: 'run-1', ordinal: index, binding_case_revision_id: 'rev-1', engine_ref: {}, parameters: {}, seed: index, fingerprint: 'f', job_id: null, state, metrics: {},
}));
const report = (slug: string, title: string, state: 'frozen' | 'draft') => ({
  artifact_id: `artifact-${slug}`, version_id: state === 'frozen' ? `version-${slug}` : null, draft_id: null, draft_revision: state === 'draft' ? 3 : null, id: `report-${slug}`,
  project_id: 'project-1', study_run_id: null, slug, title, document: {}, digest: digest('e'), state, created_at: '2026-09-25T00:00:00Z',
});

type Refusable = 'jobs' | 'create' | 'project' | 'patch' | 'remove' | 'export' | 'import';

interface State {
  organizations: Org[];
  projects: Record<string, Project[]>;
  /** Content per project slug; a project not listed here is empty. */
  filled: Set<string>;
  /** A refusal for one action; unset means the action succeeds. */
  refuse: Partial<Record<Refusable, Handler>>;
}

const methodOf = (route: Route) => route.request().method();

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, overrides: Partial<State> = {}): Promise<State> {
  const state: State = {
    organizations: [isaDemo, consultora, memberLab],
    projects: projectsOf(),
    filled: new Set(['qos-benchmarks']),
    refuse: {},
    ...overrides,
  };
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's4b-access');
    localStorage.setItem('openbinding-refresh-token', 's4b-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's4b-access-2', refresh_token: 's4b-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(`${API}/v1/users/me/usage`, json(researchUsage()));
  await page.route(new RegExp(`^${API}/v1/users/me/jobs(\\?.*)?$`), json(ownJobs()));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/explore/projects`, json([{ organization: { slug: 'consultora-demo', name: 'Consultora Demo' }, project: { slug: 'public-card', name: 'Public card', description: '' } }]));

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/projects/{project}/{sub}/{subId}/{subSub}/…
    const [, , orgSlug, section, projectSlug, sub, subId, subSub] = parts;
    const method = methodOf(route);
    const found = state.organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(state.organizations)(route);
    if (section === 'members') return json([])(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = state.projects[orgSlug] ?? [];
    if (!projectSlug) {
      if (method === 'POST') {
        if (state.refuse.create) return state.refuse.create(route);
        const body = route.request().postDataJSON() as { slug: string; name: string; description: string; visibility: 'public' | 'private' };
        const created = { ...project(list.length + 10, found?.id ?? 'org-1', body.slug, body.name, body.description, body.visibility), created_at: new Date().toISOString() };
        state.projects[orgSlug] = [...list, created];
        return json(created, 201)(route);
      }
      return json(list)(route);
    }

    const current = list.find((item) => item.slug === projectSlug);
    if (!sub) {
      if (!current) return detail(404, 'not_found', 'Project not found.')(route);
      if (method === 'PATCH') {
        if (state.refuse.patch) return state.refuse.patch(route);
        const body = route.request().postDataJSON() as Partial<Project>;
        const next = { ...current, ...body };
        state.projects[orgSlug] = list.map((item) => (item.slug === projectSlug ? next : item));
        return json(next)(route);
      }
      if (method === 'DELETE') {
        if (state.refuse.remove) return state.refuse.remove(route);
        state.projects[orgSlug] = list.filter((item) => item.slug !== projectSlug);
        return noContent(route);
      }
      return state.refuse.project ? state.refuse.project(route) : json(current)(route);
    }

    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    const filled = state.filled.has(projectSlug);
    switch (sub) {
      case 'cases':
        if (subId && subSub === 'revisions') return json(filled ? caseRevisions : [])(route);
        return json(filled ? [checkoutCase] : [])(route);
      case 'jobs':
        return state.refuse.jobs ? state.refuse.jobs(route) : json(filled ? qosJobs() : [])(route);
      case 'studies':
        if (subId && subSub === 'runs' && parts.includes('cells')) return json(cells)(route);
        if (subId && subSub === 'runs') return json([studyRun])(route);
        return json(filled ? [study] : [])(route);
      case 'reports':
        return json(filled ? [report('comparativa', 'Engine comparison', 'frozen'), report('borrador', 'Draft: placement', 'draft')] : [])(route);
      case 'publications':
        return json(filled ? [{ version_id: 'version-comparativa', withdrawn: false, id: 'pub-1', project_id: 'project-1', report_id: 'report-comparativa', slug: 'comparativa', citation: {}, published_at: '2026-09-25T00:00:00Z' }] : [])(route);
      case 'blobs':
        return json([])(route);
      case 'package':
        if (method === 'POST') return state.refuse.import ? state.refuse.import(route) : json({ imported: { cases: 1, caseRevisions: 2, reports: 1, artifacts: 1 }, packageDigest: digest('a') })(route);
        if (state.refuse.export) return state.refuse.export(route);
        return route.fulfill({ status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ apiVersion: 'openbinding.dev/package/v1', note: REPORT_MARKER })) });
      default:
        return detail(404, 'not_found', 'Not mocked.')(route);
    }
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

/** Full-page capture of the current state, after checking that nothing scrolls sideways. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
}

const request = (page: Page, method: string, path: string) => page.waitForRequest((candidate) => candidate.method() === method && candidate.url().startsWith(`${API}${path}`));

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(120_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S4b projects`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('proj-create /app/:org/new-project', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo/new-project');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'New project in ISA Demo Group' })).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
      await expect(main.getByRole('button', { name: 'Create project' })).toBeDisabled();
      await main.getByLabel('Name', { exact: true }).fill('Placement multi-región');
      await expect(main.getByLabel('Address')).toHaveValue('placement-multi-region');
      await expect(main.getByText('Looks good · can’t be changed later.')).toBeVisible();
      await expect(main.getByRole('meter', { name: 'Projects', exact: true })).toHaveAttribute('aria-valuenow', '4');
      await expect(main.getByRole('meter', { name: 'Private projects' })).toHaveAttribute('aria-valuenow', '3');
      await main.getByLabel(/^Description/).fill('Pools and latencies at the edge.');
      await capture(page, testInfo, `create-${name}-form`);

      // A VIEWER can look at the form and not create.
      await page.goto('/app/consultora-demo/new-project');
      await expect(main.getByRole('note')).toContainText('You’re a VIEWER in Consultora Demo, so you can look at this form but not create a project (403).');
      await expect(main.getByLabel('Name', { exact: true })).toBeDisabled();
      await expect(main.getByRole('button', { name: 'Create project' })).toBeDisabled();
      await expect(main.getByText(/nora’s usage is visible only to them|Sponsor’s room/).first()).toBeVisible();
      await capture(page, testInfo, `create-${name}-viewer`);
      if (isMobile) {
        await page.goto('/app/isa-demo/new-project');
        await main.getByLabel('Name', { exact: true }).fill('Placement');
        await main.getByRole('radio', { name: /^Public/ }).check({ force: true });
        await capture(page, testInfo, `create-${name}-public`);
        expect(critical).toEqual([]);
        return;
      }

      // The gateway's refusals, one by one: 409, 402, 503.
      await page.goto('/app/isa-demo/new-project');
      await main.getByLabel('Name', { exact: true }).fill('Placement multi-región');
      const create = main.getByRole('button', { name: 'Create project' });
      state.refuse.create = detail(409, 'slug_conflict', 'That project slug is in use.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('That address is already used in ISA Demo Group (409 · slug_conflict).');
      await capture(page, testInfo, `create-${name}-409`);

      state.refuse.create = detail(402, 'sponsor_quota_exceeded', 'The sponsor contract allows 30 private projects.', { quota: { limit_id: 'privateProjects', limit: 30, used: 30 } });
      await create.click();
      const full = main.getByRole('alert');
      await expect(full).toContainText('The sponsor has no private projects left (402 · sponsor_quota_exceeded). 30 of 30 private projects.');
      await expect(full.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/app/account/usage');
      await capture(page, testInfo, `create-${name}-402`);

      state.refuse.create = detail(503, 'pricing_unavailable', 'The pricing service is not reachable.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('Limits can’t be checked right now (503 · pricing_unavailable). Nothing was created.');
      await capture(page, testInfo, `create-${name}-503`);

      // "Make it public instead" after the 402, then it is created: the payload carries what was typed.
      state.refuse.create = detail(402, 'sponsor_quota_exceeded', 'The sponsor contract allows 30 private projects.', { quota: { limit_id: 'privateProjects', limit: 30, used: 30 } });
      await create.click();
      await main.getByRole('button', { name: 'Make it public instead' }).click();
      await expect(main.getByRole('radio', { name: /^Public/ })).toBeChecked();
      state.refuse.create = undefined;
      const posted = request(page, 'POST', '/v1/organizations/isa-demo/projects');
      await create.click();
      expect((await posted).postDataJSON()).toEqual({ name: 'Placement multi-región', slug: 'placement-multi-region', description: '', visibility: 'public' });
      await expect(main.getByText('Placement multi-región is ready')).toBeVisible();
      await expect(main.getByText('Public: its card now appears in Explore.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open project' })).toHaveAttribute('href', '/app/isa-demo/placement-multi-region');
      await capture(page, testInfo, `create-${name}-created`);

      // A missing organization reads the same as one the account is not in.
      await page.goto('/app/ghost-lab/new-project');
      await expect(main.getByRole('heading', { name: 'Organization not available' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('proj-overview /app/:org/:project', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo/qos-benchmarks');
      const main = page.locator('#platform-main');

      const title = main.getByRole('heading', { level: 1, name: 'QoS Benchmarks' });
      await expect(title).toBeVisible();
      const band = main.locator('.proj-band');
      await expect(band.getByText('Public', { exact: true })).toBeVisible();
      await expect(band.getByText('OWNER')).toBeVisible();
      await expect(band.getByRole('link', { name: 'New case' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/cases');
      await expect(band.getByRole('link', { name: 'Export package' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/package');
      const tabs = main.getByRole('navigation', { name: 'Project sections' });
      await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
      await expect(tabs.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/settings');

      const strip = main.getByRole('region', { name: 'What’s sealed and what’s still a draft' });
      await expect(strip.getByRole('list', { name: 'Sealed and draft items' }).getByRole('listitem')).toHaveText(['2 case revisions', '1 study run', '1 frozen report', '1 report draft']);
      const cases = main.getByRole('region', { name: 'Cases' });
      await expect(cases.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/cases/flujo-checkout');
      await expect(cases.getByText('2 revisions')).toBeVisible();
      const jobs = main.getByRole('list', { name: 'Recent jobs' });
      await expect(jobs.getByRole('listitem')).toHaveCount(3);
      await expect(jobs.getByRole('link')).toHaveCount(2);
      await expect(jobs.getByText('Owner only')).toBeVisible();
      await expect(jobs.getByText('No feasible binding')).toBeVisible();
      const studies = main.getByRole('region', { name: 'Studies' });
      await expect(studies.getByText('Run #1 · partial')).toBeVisible();
      await expect(studies.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8' })).toBeVisible();
      const reports = main.getByRole('region', { name: 'Reports' });
      await expect(reports.getByText('Published', { exact: true })).toBeVisible();
      await expect(reports.getByRole('link', { name: 'Verify Engine comparison' })).toHaveAttribute('href', `/resolve/report/${digest('e')}`);
      await capture(page, testInfo, `overview-${name}-success`);

      // A VIEWER reads everything and cannot create.
      await page.goto('/app/consultora-demo/client-case');
      await expect(main.getByRole('heading', { level: 1, name: 'Client case' })).toBeVisible();
      await expect(band.getByText('VIEWER', { exact: true })).toBeVisible();
      await expect(band.getByText('New case')).toHaveAttribute('aria-disabled', 'true');
      await expect(band.getByRole('link', { name: 'Export package' })).toBeVisible();
      await expect(main.getByText('You’re a VIEWER: you can read everything here and export the package; creating needs MEMBER.')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Get started' })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-viewer-empty`);

      // The gateway answers the same whether the project is missing or the account is not in it.
      await page.goto('/app/isa-demo/ghost');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await expect(main.getByText(/Even public projects open here only for members\./)).toBeVisible();
      await capture(page, testInfo, `overview-${name}-not-found`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // A public project the account is not in: the gate points to its card in Explore.
      await page.goto('/app/consultora-demo/public-card');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'See its public card in Explore' })).toHaveAttribute('href', '/explore');
      await capture(page, testInfo, `overview-${name}-public-gate`);

      // The role is too low.
      state.refuse.project = detail(403, 'organization_forbidden', 'Your role does not reach this.');
      await page.goto('/app/isa-demo/qos-benchmarks');
      await expect(main.getByRole('heading', { name: 'Your role doesn’t reach this (403 · organization_forbidden)' })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-403`);
      state.refuse.project = undefined;

      // The jobs card fails on its own: the rest of the page is there, and it loads on retry.
      state.refuse.jobs = unavailable;
      await page.goto('/app/isa-demo/qos-benchmarks');
      const jobsCard = main.getByRole('region', { name: 'Recent jobs' });
      await expect(jobsCard.getByRole('alert')).toContainText('Jobs couldn’t be loaded (503). The rest of the page is unaffected.');
      await expect(main.getByRole('link', { name: /Flujo de checkout/ })).toBeVisible();
      await expect(main.getByRole('region', { name: 'Reports' }).getByText('Published', { exact: true })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-jobs-503`);
      state.refuse.jobs = undefined;
      await jobsCard.getByRole('button', { name: 'Retry' }).click();
      await expect(jobsCard.getByRole('list', { name: 'Recent jobs' }).getByRole('listitem')).toHaveCount(3);
      expect(critical).toEqual([]);
    });

    test('proj-settings /app/:org/:project/settings', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo/qos-benchmarks/settings');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Project settings' })).toBeVisible();
      await expect(main.getByText('QoS Benchmarks · your role')).toBeVisible();
      const settingsTab = main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Settings' });
      await expect(settingsTab).toHaveAttribute('aria-current', 'page');
      // On a phone the row of tabs scrolls: the current one is brought into view, not left cut off at the edge.
      await expect(settingsTab).toBeInViewport({ ratio: 1 });
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('QoS Benchmarks');
      await expect(main.getByText('/app/isa-demo/qos-benchmarks', { exact: true })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save' })).toBeDisabled();
      // The project has case revisions, study runs and a frozen report: deleting is blocked up front, and says why.
      await expect(main.getByRole('note')).toContainText('Deleting is blocked: this project has sealed history (2 case revisions, 1 study run, 1 frozen report), including 1 published report.');
      await expect(main.getByRole('button', { name: 'Delete project' })).toBeDisabled();
      await capture(page, testInfo, `settings-${name}-success`);

      // Below ADMIN the page is read-only, with the reason.
      await page.goto('/app/member-lab/bench/settings');
      await expect(main.getByText(/this page is read-only/)).toContainText('You’re a MEMBER, so this page is read-only. Editing and deleting a project need ADMIN in Member Lab.');
      await expect(main.getByLabel('Name', { exact: true })).toBeDisabled();
      await expect(main.getByRole('button', { name: 'Save' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Change visibility' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Delete project' })).toHaveCount(0);
      await capture(page, testInfo, `settings-${name}-read-only`);
      if (isMobile) {
        await page.goto('/app/isa-demo/checkout-privado/settings');
        await main.getByRole('button', { name: 'Delete project' }).click();
        await expect(page.getByRole('dialog', { name: 'Delete Checkout (privado)?' })).toBeVisible();
        await capture(page, testInfo, `settings-${name}-delete-dialog`);
        expect(critical).toEqual([]);
        return;
      }

      // Rename.
      await page.goto('/app/isa-demo/qos-benchmarks/settings');
      await main.getByLabel('Name', { exact: true }).fill('QoS Reference');
      state.refuse.patch = detail(503, 'pricing_unavailable', 'Limits cannot be checked.');
      await main.getByRole('button', { name: 'Save' }).click();
      await expect(main.getByRole('alert')).toContainText('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed.');
      await capture(page, testInfo, `settings-${name}-save-503`);
      state.refuse.patch = undefined;
      const renamed = request(page, 'PATCH', '/v1/organizations/isa-demo/projects/qos-benchmarks');
      await main.getByRole('button', { name: 'Save' }).click();
      expect((await renamed).postDataJSON()).toEqual({ name: 'QoS Reference' });
      await expect(main.getByText('Saved. An audit entry was recorded.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
      await capture(page, testInfo, `settings-${name}-saved`);

      // Visibility: public to private is checked against the sponsor's private projects (402), and the effect is spelled out.
      await main.getByRole('radio', { name: 'Private' }).check({ force: true });
      await expect(main.getByRole('meter', { name: 'Private projects' })).toHaveAttribute('aria-valuenow', '3');
      await expect(main.getByText('It counts as a private project for the sponsor')).toBeVisible();
      state.refuse.patch = detail(402, 'sponsor_quota_exceeded', 'The sponsor contract allows 30 private projects.', { quota: { limit_id: 'privateProjects', limit: 30, used: 30 } });
      await main.getByRole('button', { name: 'Change visibility' }).click();
      await expect(main.getByRole('alert')).toContainText('The sponsor has no private projects left (402 · sponsor_quota_exceeded).');
      await expect(main.getByRole('alert').getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/app/account/usage');
      await capture(page, testInfo, `settings-${name}-visibility-402`);
      state.refuse.patch = undefined;
      const hidden = request(page, 'PATCH', '/v1/organizations/isa-demo/projects/qos-benchmarks');
      await main.getByRole('button', { name: 'Change visibility' }).click();
      expect((await hidden).postDataJSON()).toEqual({ visibility: 'private' });
      await expect(main.getByText('Visibility changed to private. An audit entry was recorded.')).toBeVisible();

      // Deleting asks for the address; the gateway refuses sealed history that appeared meanwhile.
      await page.goto('/app/isa-demo/checkout-privado/settings');
      await expect(main.getByRole('note')).toHaveCount(0);
      await main.getByRole('button', { name: 'Delete project' }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete Checkout (privado)?' });
      const confirm = dialog.getByRole('button', { name: 'Delete permanently' });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Type checkout-privado to confirm').fill('checkout');
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Type checkout-privado to confirm').fill('checkout-privado');
      await expect(confirm).toBeEnabled();
      state.refuse.remove = detail(409, 'historical_references', 'A project with sealed case revisions cannot be deleted.');
      await confirm.click();
      await expect(dialog.getByRole('alert')).toContainText('so it can’t be deleted (409 · historical_references)');
      await capture(page, testInfo, `settings-${name}-delete-409`);
      state.refuse.remove = undefined;
      const deleted = request(page, 'DELETE', '/v1/organizations/isa-demo/projects/checkout-privado');
      await confirm.click();
      await deleted;
      await expect(main.getByRole('heading', { name: 'Checkout (privado) was deleted' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
      expect(critical).toEqual([]);
    });

    test('proj-package /app/:org/:project/package', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo/qos-benchmarks/package');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Portable package' })).toBeVisible();
      const packageTab = main.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Package' });
      await expect(packageTab).toHaveAttribute('aria-current', 'page');
      await expect(packageTab).toBeInViewport({ ratio: 1 });
      await expect(main.getByText('case with 2 sealed revisions')).toBeVisible();
      await expect(main.getByText('People and roles')).toBeVisible();
      await expect(main.getByText('ZIP, JSON or YAML package · up to 128 MiB on your plan')).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Known limits' })).toBeVisible();
      await capture(page, testInfo, `package-${name}-success`);

      // A package with its fingerprints sound: the report is on the page, the content is not.
      const upload = (pkg: Record<string, unknown>, fileName = 'qos.openbinding.json') => page.setInputFiles('input[aria-label="Package file"]', {
        name: fileName, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pkg)),
      });
      await upload(await samplePackage());
      const report = main.getByRole('list', { name: 'Import verification report' });
      await expect(report.getByRole('listitem')).toHaveCount(5);
      await expect(main.getByText('3 verified')).toBeVisible();
      await expect(main.getByText('2 new')).toBeVisible();
      await expect(report.getByText('Package manifest')).toBeVisible();
      await expect(main.getByText(REPORT_MARKER)).toHaveCount(0);
      await capture(page, testInfo, `package-${name}-review`);
      if (isMobile) {
        await main.getByRole('button', { name: 'Cancel' }).click();
        await upload(await samplePackage({ tamperAfterSealing: true }));
        await expect(main.getByRole('alert')).toContainText('Fingerprint doesn’t match');
        await capture(page, testInfo, `package-${name}-fingerprint`);
        expect(critical).toEqual([]);
        return;
      }

      // Importing writes only after confirming; the payload is the file itself.
      const imported = request(page, 'POST', '/v1/organizations/isa-demo/projects/qos-benchmarks/package');
      await main.getByRole('button', { name: 'Import into QoS Benchmarks' }).click();
      expect((await imported).headers()['content-type']).toContain('application/json');
      await expect(main.getByText('Import complete')).toBeVisible();
      await expect(main.getByText('5 items added (1 cases, 2 case revisions, 1 reports, 1 artifacts).')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to the project' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
      await capture(page, testInfo, `package-${name}-done`);

      // A fingerprint that does not match is refused before anything is sent.
      await main.getByRole('button', { name: 'Import another package' }).click();
      await upload(await samplePackage({ tamperAfterSealing: true }));
      await expect(main.getByRole('alert')).toContainText('Fingerprint doesn’t match');
      await expect(main.getByRole('alert')).toContainText('nothing was imported');
      await capture(page, testInfo, `package-${name}-fingerprint`);

      // A name already used with different content, found by comparing with what the project holds.
      await main.getByRole('button', { name: 'Choose another package' }).click();
      await upload(await samplePackage({ caseSlug: 'flujo-checkout', conflicting: true }));
      await expect(main.getByRole('alert')).toContainText('Name already used with different content');
      await expect(main.getByRole('alert')).toContainText('“Flujo de checkout · revision 2” exists in this project with a different fingerprint.');
      await capture(page, testInfo, `package-${name}-collision`);
      await main.getByRole('button', { name: 'Choose another package' }).click();

      // The same case with the same fingerprints is reused, not added again.
      await upload(await samplePackage({ caseSlug: 'flujo-checkout' }));
      await expect(main.getByText('2 already here · reused')).toBeVisible();
      await expect(main.getByText('0 new')).toBeVisible();
      await capture(page, testInfo, `package-${name}-reuse`);
      await main.getByRole('button', { name: 'Cancel' }).click();

      // The gateway's refusals, one by one: 409 unpublished, 413, 403.
      await upload(await samplePackage());
      await expect(main.getByRole('button', { name: 'Import into QoS Benchmarks' })).toBeVisible();
      state.refuse.import = detail(409, 'unpublished_import', 'Publish the exact report version before importing its public citation.');
      await main.getByRole('button', { name: /^Import into/ }).click();
      await expect(main.getByRole('alert')).toContainText('Unpublished items from another organization (409 · unpublished_import)');
      await capture(page, testInfo, `package-${name}-409`);
      await main.getByRole('button', { name: 'Choose another package' }).click();
      await upload(await samplePackage());
      state.refuse.import = detail(413, 'package_too_large', 'Portable packages are limited to 128 MB compressed.');
      await main.getByRole('button', { name: /^Import into/ }).click();
      await expect(main.getByRole('alert')).toContainText('Package too large (413 · package_too_large)');
      await capture(page, testInfo, `package-${name}-413`);
      await main.getByRole('button', { name: 'Choose another package' }).click();
      await upload(await samplePackage());
      state.refuse.import = detail(403, 'forbidden', 'This API key cannot write projects.');
      await main.getByRole('button', { name: /^Import into/ }).click();
      await expect(main.getByRole('alert')).toContainText('This account or API key can’t import (403 · forbidden)');
      await main.getByRole('button', { name: 'Choose another package' }).click();
      await expect(main.getByRole('note')).toContainText('so importing is off. Export still works.');
      await expect(main.getByRole('button', { name: 'Choose package' })).toBeDisabled();
      await capture(page, testInfo, `package-${name}-403`);

      // Export: the file goes to disk, with the name and type chosen; the content is never on the page.
      await page.goto('/app/isa-demo/qos-benchmarks/package');
      await main.getByRole('radio', { name: /Single JSON file/ }).check();
      const download = page.waitForEvent('download');
      await main.getByRole('button', { name: 'Export package' }).click();
      expect((await download).suggestedFilename()).toBe('qos-benchmarks.openbinding.json');
      await expect(main.getByText('Downloaded qos-benchmarks.openbinding.json.')).toBeVisible();
      await expect(main.getByText(REPORT_MARKER)).toHaveCount(0);
      state.refuse.export = detail(403, 'forbidden', 'Your key cannot read this project.');
      await main.getByRole('button', { name: 'Export again' }).click();
      await expect(main.getByText('Your credential can’t read this project (403 · forbidden), so nothing was exported.')).toBeVisible();

      // A VIEWER cannot import, and can still export.
      await page.goto('/app/consultora-demo/client-case/package');
      await expect(main.getByRole('note')).toContainText('Importing needs MEMBER; you’re a VIEWER here. You can still export.');
      await expect(main.getByRole('button', { name: 'Choose package' })).toBeDisabled();
      await expect(main.getByRole('button', { name: 'Export package' })).toBeEnabled();
      await capture(page, testInfo, `package-${name}-viewer`);
      expect(critical).toEqual([]);
    });
  });
}
