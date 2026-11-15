import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';

// S4b · organization and collaboration, part 2: the New project dialog (was proj-create), proj-overview, proj-settings.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: the desktop walks the states of the screen, the phone gets its layout and its dialogs.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);
const noContent: Handler = (route) => route.fulfill({ status: 204 });
/** Too many reads of public projects: a 429 with `Retry-After`, which the gateway exposes to the browser. */
const rateLimited = (seconds: number): Handler => (route) => route.fulfill({
  status: 429,
  headers: { 'Retry-After': String(seconds), 'Access-Control-Expose-Headers': 'Retry-After' },
  json: { type: 'https://openbinding.dev/problems/rate_limit_exceeded', title: 'rate_limit_exceeded', status: 429, code: 'rate_limit_exceeded', detail: { code: 'rate_limit_exceeded', error: 'Too many reads of public projects.' } },
});
/** A service that does not answer: a 503 with no machine code, as a proxy in front of the gateway would send it. */
const unavailable: Handler = json({ detail: 'The service is not reachable.' }, 503);

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

const lucia = {
  id: 'user-1', username: 'lucia.vega', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH',
  created_at: '2026-03-02T00:00:00Z', cas_verified: true,
};

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

interface Org {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  effective_role: Role;
  created_at: string;
}

const org = (n: number, slug: string, name: string, role: Role, over: Partial<Org> = {}): Org => ({
  id: `org-${n}`, slug, name, parent_id: null, effective_role: role, created_at: '2026-03-03T00:00:00Z', ...over,
});

const isaDemo = org(1, 'isa-demo', 'ISA Demo Group', 'OWNER');
const consultora = org(3, 'consultora-demo', 'Consultora Demo', 'VIEWER');
const memberLab = org(4, 'member-lab', 'Member Lab', 'MEMBER');

interface Project {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  /** The contract's `ProjectView.access`: a member, or `public_read` for a visitor of a public project. */
  access: 'member' | 'public_read';
  effective_role: Role | null;
}

const project = (n: number, orgId: string, slug: string, name: string, description: string, visibility: 'public' | 'private', role: Role = 'OWNER'): Project => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description, visibility, created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z', access: 'member', effective_role: role,
});

/** A public project of an organization the account is not in: read-only, no role, no creator (the contract's `public_read`). */
const openBench: Project = {
  ...project(5, 'org-open', 'open-bench', 'Open bench', 'A public project anyone can read.', 'public'),
  created_by_id: null, access: 'public_read', effective_role: null,
};

const projectsOf = (): Record<string, Project[]> => ({
  'isa-demo': [
    project(1, 'org-1', 'qos-benchmarks', 'QoS Benchmarks', 'Reference binding cases with workflow and placement.', 'public'),
    project(2, 'org-1', 'checkout-privado', 'Checkout (privado)', 'Internal payments case with proprietary candidates.', 'private'),
  ],
  'consultora-demo': [project(3, 'org-3', 'client-case', 'Client case', 'Work for a client.', 'private', 'VIEWER')],
  'member-lab': [project(4, 'org-4', 'bench', 'Bench', 'A bench.', 'private', 'MEMBER')],
});

const digest = (char: string) => `sha256-${char.repeat(64)}`;

/** What the gateway reports for the RESEARCH plan: the plan and its limits, with no consumption. */
const researchUsage = () => ({
  plan: 'RESEARCH',
  contract_pending: false,
  features: { collaboration: true, runs: true },
  capabilities: { maxConcurrentRuns: 4, maxPrivateProjects: 10, maxProblems: null, maxRepositoryStorage: null },
});

/** The jobs of the account (its history) and of the project: only two of the three project jobs were launched by this account. */
const ownJobs = () => ({
  jobs: [
    { id: '00000000-0000-0000-0000-0000000000f2', engine_id: 'minizinc', status: 'running', termination: null, solutions: null, created_at: '2026-10-08T08:00:00Z', finished_at: null },
    { id: '00000000-0000-0000-0000-0000000000f6', engine_id: 'random-search', status: 'completed', termination: 'INFEASIBLE', solutions: 0, created_at: '2026-10-01T09:00:00Z', finished_at: '2026-10-01T09:00:40Z' },
  ],
  total: 2,
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

const study = {
  archived: false, id: 'study-1', definition_version_id: 'sv-1', definition_artifact_id: 'sa-1', project_id: 'project-1', slug: 'engines-seeds', name: 'Engines × seeds', description: '',
  definition: { case_revision_ids: ['rev-1', 'rev-2'], engines: [{}, {}], parameter_sets: [{}], seeds: [1, 2] }, state: 'active', created_by_id: 'user-1', created_at: '2026-09-20T00:00:00Z',
};
const studyRun = { id: 'run-1', definition_version_id: 'sv-1', study_id: 'study-1', run_number: 1, state: 'partial', matrix_digest: digest('d'), cells: 8, summary: {}, created_at: '2026-09-21T00:00:00Z', finished_at: null };
const cells = [...Array.from({ length: 6 }, () => 'completed'), 'failed', 'cancelled'].map((state, index) => ({
  id: `cell-${index}`, study_run_id: 'run-1', ordinal: index, binding_case_revision_id: 'rev-1', engine_ref: {}, parameters: {}, seed: index, fingerprint: 'f', job_id: null, state, metrics: {},
}));

/** The members of every organization of the mock: the project settings list them. */
const orgMembers = [
  { id: 'member-1', organization_id: 'org-1', user_id: 'user-1', username: 'lucia.vega', email: 'lucia@example.org', role: 'OWNER', created_at: '2026-03-03T00:00:00Z' },
  { id: 'member-2', organization_id: 'org-1', user_id: 'user-2', username: 'tomas.ruiz', email: 'tomas@example.org', role: 'MEMBER', created_at: '2026-03-05T00:00:00Z' },
];

type Refusable = 'jobs' | 'create' | 'project' | 'patch' | 'remove';

interface State {
  organizations: Org[];
  projects: Record<string, Project[]>;
  /** Public projects of organizations the account is not in, by organization address. */
  visitor: Record<string, Project[]>;
  /** The answer to opening one of those (a 429, say); unset means it opens. */
  visitorRefusal?: Handler;
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
    visitor: { 'open-lab': [openBench] },
    filled: new Set(['qos-benchmarks', 'open-bench']),
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

  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/').filter(Boolean);
    // /v1/organizations/{org}/projects/{project}/{sub}/{subId}/{subSub}/…
    const [, , orgSlug, section, projectSlug, sub, subId, subSub] = parts;
    const method = methodOf(route);
    const found = state.organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(state.organizations)(route);
    if (section === 'members') return json(orgMembers)(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const visitorList = state.visitor[orgSlug];
    // An organization the account is not in: its public projects open read-only; anything else is refused the same way.
    if (!found && projectSlug && !visitorList) return detail(403, 'organization_forbidden', 'This action requires viewer access to the organization.')(route);
    if (visitorList && projectSlug && !sub && state.visitorRefusal) return state.visitorRefusal(route);
    const list = state.projects[orgSlug] ?? visitorList ?? [];
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
      case 'jobs':
        // A visitor never reads the jobs of a project; the screen must not ask.
        if (visitorList) return detail(403, 'organization_forbidden', 'Jobs are for members.')(route);
        return state.refuse.jobs ? state.refuse.jobs(route) : json(filled ? qosJobs() : [])(route);
      case 'studies':
        if (subId && subSub === 'runs' && parts.includes('cells')) return json(cells)(route);
        if (subId && subSub === 'runs') return json([studyRun])(route);
        return json(filled ? [study] : [])(route);
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
test.setTimeout(180_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S4b projects`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('proj-create dialog /app/:org?create=project', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await page.goto('/app/isa-demo?create=project');

      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/^In ISA Demo Group\./)).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
      await dialog.getByLabel('Name', { exact: true }).fill('Placement multi-región');
      await expect(dialog.getByLabel('Address')).toHaveValue('placement-multi-region');
      await expect(dialog.getByText('Looks good · can’t be changed later.')).toBeVisible();
      await expect(dialog.getByText(/sponsor/i)).toHaveCount(0);
      await expect(dialog.getByRole('meter')).toHaveCount(0);
      await dialog.getByLabel(/^Description/).fill('Pools and latencies at the edge.');
      await capture(page, testInfo, `create-${name}-form`);

      // A VIEWER can look at the form and not create.
      await page.goto('/app/consultora-demo?create=project');
      await expect(dialog.getByRole('note')).toContainText('You’re a VIEWER in Consultora Demo, so you can look at this form but not create a project (403).');
      await expect(dialog.getByLabel('Name', { exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
      await capture(page, testInfo, `create-${name}-viewer`);
      if (isMobile) {
        await page.goto('/app/isa-demo?create=project');
        await dialog.getByLabel('Name', { exact: true }).fill('Placement');
        await dialog.getByRole('radio', { name: /^Public/ }).check({ force: true });
        await capture(page, testInfo, `create-${name}-public`);
        expect(critical).toEqual([]);
        return;
      }

      // Cancel goes back to the organization and creates nothing.
      await page.goto('/app/isa-demo?create=project');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/app\/isa-demo$/);
      await expect(main.getByRole('button', { name: 'New project' })).toBeFocused();

      // The gateway's refusal of a taken address.
      await main.getByRole('button', { name: 'New project' }).click();
      await expect(page).toHaveURL(/\/app\/isa-demo\?create=project$/);
      await dialog.getByLabel('Name', { exact: true }).fill('Placement multi-región');
      const create = dialog.getByRole('button', { name: 'Create project' });
      state.refuse.create = detail(409, 'slug_conflict', 'That project slug is in use.');
      await create.click();
      await expect(dialog.getByRole('alert')).toContainText('That address is already used in ISA Demo Group (409 · slug_conflict).');
      await capture(page, testInfo, `create-${name}-409`);

      // Then it is created: the payload carries what was typed, the dialog closes and the project opens.
      await dialog.getByRole('radio', { name: /^Public/ }).check({ force: true });
      state.refuse.create = undefined;
      const posted = request(page, 'POST', '/v1/organizations/isa-demo/projects');
      await create.click();
      expect((await posted).postDataJSON()).toEqual({ name: 'Placement multi-región', slug: 'placement-multi-region', description: '', visibility: 'public' });
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/\/app\/isa-demo\/placement-multi-region$/);

      // A missing organization reads the same as one the account is not in.
      await page.goto('/app/ghost-lab?create=project');
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
      // Problems and the Workbench belong to the organization.
      await expect(band.getByRole('link', { name: 'Problems' })).toHaveAttribute('href', '/app/isa-demo/problems');
      await expect(band.getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', '/app/isa-demo/workbench');
      await expect(band.getByRole('link', { name: 'Export package' })).toHaveCount(0);
      const tabs = main.getByRole('navigation', { name: 'Project sections' });
      await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Runs', 'Studies', 'Settings']);
      await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
      await expect(tabs.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/settings');

      const strip = main.getByRole('region', { name: 'What’s sealed and what’s still a draft' });
      await expect(strip.getByRole('list', { name: 'Sealed and draft items' }).getByRole('listitem')).toHaveText(['1 study run']);
      await expect(main.getByRole('region', { name: 'Problems' })).toHaveCount(0);
      const jobs = main.getByRole('list', { name: 'Recent runs' });
      await expect(jobs.getByRole('listitem')).toHaveCount(3);
      await expect(jobs.getByRole('link')).toHaveCount(2);
      await expect(jobs.getByText('Owner only')).toBeVisible();
      await expect(jobs.getByText('No feasible binding')).toBeVisible();
      const studies = main.getByRole('region', { name: 'Studies' });
      await expect(studies.getByText('Run #1 · partial')).toBeVisible();
      await expect(studies.getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8' })).toBeVisible();
      // The report editor is retired: no Reports card, no New report action, no All reports link.
      await expect(main.getByRole('region', { name: 'Reports' })).toHaveCount(0);
      await expect(main.getByText('New report')).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'All reports' })).toHaveCount(0);
      await capture(page, testInfo, `overview-${name}-success`);

      // A VIEWER reads everything and cannot create.
      await page.goto('/app/consultora-demo/client-case');
      await expect(main.getByRole('heading', { level: 1, name: 'Client case' })).toBeVisible();
      await expect(band.getByText('VIEWER', { exact: true })).toBeVisible();
      await expect(band.getByText('Run', { exact: true })).toHaveAttribute('aria-disabled', 'true');
      await expect(main.getByText('You’re a VIEWER: you can read everything here; creating needs MEMBER.')).toBeVisible();
      await expect(main.getByRole('region', { name: 'Get started' })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-viewer-empty`);

      // The gateway answers the same whether the project is missing or the account is not in it.
      await page.goto('/app/isa-demo/ghost');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await expect(main.getByText(/It doesn’t exist, or it’s private and you’re not a member of its organization\./)).toBeVisible();
      await capture(page, testInfo, `overview-${name}-not-found`);

      // A private project of an organization the account is not in reads the same: 403, and no hint that it exists.
      await page.goto('/app/secret-lab/hidden');
      await expect(main.getByRole('heading', { name: 'Project not found' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/app');

      // A public project of an organization the account is not in opens read-only: no gate in front of it.
      await page.goto('/app/open-lab/open-bench');
      await expect(main.getByRole('heading', { level: 1, name: 'Open bench' })).toBeVisible();
      await expect(main.getByText('You are viewing a public project (read-only).')).toBeVisible();
      const publicTabs = main.getByRole('navigation', { name: 'Project sections' });
      await expect(publicTabs.getByRole('link')).toHaveText(['Overview', 'Studies']);
      for (const hidden of ['Problems', 'Run', 'New study', 'New report', 'Export package']) await expect(band.getByText(hidden, { exact: true })).toHaveCount(0);
      await expect(main.getByRole('region', { name: 'Recent runs' })).toHaveCount(0);
      await expect(main.getByRole('region', { name: 'Studies' })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-public-read`);

      // Its members-only parts show the neutral gate, not the screens.
      for (const part of ['runs', 'settings']) {
        await page.goto(`/app/open-lab/open-bench/${part}`);
        await expect(main.getByRole('heading', { name: 'Members only' })).toBeVisible();
        await expect(main.getByRole('link', { name: 'Back to the project' })).toHaveAttribute('href', '/app/open-lab/open-bench');
      }
      await capture(page, testInfo, `overview-${name}-public-read-members-only`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Reading other people’s public projects too fast: 429 with a countdown, then it can be asked again.
      state.visitorRefusal = rateLimited(4);
      await page.goto('/app/open-lab/open-bench');
      await expect(main.getByRole('heading', { name: 'You’re reading public projects too fast' })).toBeVisible();
      await expect(main.getByText('Retry is available when the countdown ends.')).toBeVisible();
      await capture(page, testInfo, `overview-${name}-public-read-429`);
      state.visitorRefusal = undefined;
      const retry = main.getByRole('button', { name: 'Retry now' });
      await expect(retry).toBeEnabled({ timeout: 10_000 });
      await retry.click();
      await expect(main.getByRole('heading', { level: 1, name: 'Open bench' })).toBeVisible();

      // The role is too low.
      state.refuse.project = detail(403, 'organization_forbidden', 'Your role does not reach this.');
      await page.goto('/app/isa-demo/qos-benchmarks');
      await expect(main.getByRole('heading', { name: 'Your role doesn’t reach this (403 · organization_forbidden)' })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-403`);
      state.refuse.project = undefined;

      // The jobs card fails on its own: the rest of the page is there, and it loads on retry.
      state.refuse.jobs = unavailable;
      await page.goto('/app/isa-demo/qos-benchmarks');
      const jobsCard = main.getByRole('region', { name: 'Recent runs' });
      await expect(jobsCard.getByRole('alert')).toContainText('Runs couldn’t be loaded (503). The rest of the page is unaffected.');
      await expect(main.getByRole('region', { name: 'Studies' }).getByText('Run #1 · partial')).toBeVisible();
      await capture(page, testInfo, `overview-${name}-jobs-503`);
      state.refuse.jobs = undefined;
      await jobsCard.getByRole('button', { name: 'Retry' }).click();
      await expect(jobsCard.getByRole('list', { name: 'Recent runs' }).getByRole('listitem')).toHaveCount(3);
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
      const sections = main.getByRole('navigation', { name: 'Settings sections' });
      await expect(sections.getByRole('link')).toHaveText(['General', 'Members']);
      await expect(sections.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('heading', { name: 'Export package' })).toHaveCount(0);
      await expect(main.getByRole('heading', { name: 'Import package' })).toHaveCount(0);
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('QoS Benchmarks');
      await expect(main.getByText('/app/isa-demo/qos-benchmarks', { exact: true })).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save' })).toBeDisabled();
      // The project has study runs: deleting is blocked up front, and says why.
      await expect(main.getByRole('note')).toContainText('Deleting is blocked: this project has sealed history (1 study run).');
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

      // Members: the people of the organization, and the way to manage them.
      await page.goto('/app/isa-demo/qos-benchmarks/settings/members');
      await expect(main.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
      await expect(main.getByRole('list', { name: 'Members of ISA Demo Group' }).getByRole('listitem')).toHaveCount(2);
      await expect(main.getByText('tomas.ruiz')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Manage members' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
      await capture(page, testInfo, `settings-${name}-members`);
      await page.goto('/app/isa-demo/qos-benchmarks/settings/billing');
      await expect(main.getByRole('heading', { name: 'Page not found' })).toBeVisible();

      // Rename.
      await page.goto('/app/isa-demo/qos-benchmarks/settings');
      await main.getByLabel('Name', { exact: true }).fill('QoS Reference');
      state.refuse.patch = detail(503, 'pricing_unavailable', 'Limits cannot be checked.');
      await main.getByRole('button', { name: 'Save' }).click();
      await expect(main.getByRole('alert')).toContainText('(503 · pricing_unavailable)');
      await expect(main.getByRole('alert')).toContainText(/nothing changed/i);
      await capture(page, testInfo, `settings-${name}-save-503`);
      state.refuse.patch = undefined;
      const renamed = request(page, 'PATCH', '/v1/organizations/isa-demo/projects/qos-benchmarks');
      await main.getByRole('button', { name: 'Save' }).click();
      expect((await renamed).postDataJSON()).toEqual({ name: 'QoS Reference' });
      await expect(main.getByText('Saved. An audit entry was recorded.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
      await capture(page, testInfo, `settings-${name}-saved`);

      // Visibility: public to private, with no sponsor to count it against.
      await main.getByRole('radio', { name: 'Private' }).check({ force: true });
      await expect(main.getByText(/sponsor/i)).toHaveCount(0);
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

  });
}
