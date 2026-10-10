import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';

// S4a · organization and collaboration, part 1: app-home, org-create, org-overview, org-settings, org-members, org-audit.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: each walks the states of its screen in order, on one page. The phone gets the
// layout of each screen and of its dialogs; the states are walked on the desktop.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json({ detail: { code, error, ...extra } }, status);
const noContent: Handler = (route) => route.fulfill({ status: 204 });
/** A service that does not answer: a 503 with no machine code, as a proxy in front of the gateway would send it. */
const unavailable: Handler = json({ detail: 'Accounts are not reachable.' }, 503);

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
const qosLab = org(2, 'qos-lab', 'QoS Lab (sub-organización)', 'OWNER', { parent_id: 'org-1', created_at: '2026-03-10T00:00:00Z' });
const consultora = org(3, 'consultora-demo', 'Consultora Demo', 'VIEWER', { billing_sponsor_user_id: 'user-nora', created_at: '2026-05-01T00:00:00Z' });
const researchHub = org(4, 'research-hub', 'Research Hub', 'ADMIN', { billing_sponsor_user_id: 'user-nora', created_at: '2026-06-01T00:00:00Z' });
const partnerLab = org(5, 'partner-lab', 'Partner Lab', 'OWNER', { billing_sponsor_user_id: 'user-nora', created_at: '2026-07-01T00:00:00Z' });

interface Member {
  id: string;
  organization_id: string;
  user_id: string;
  username: string;
  email: string;
  role: Role;
  created_at: string;
}

const person = (organization: Org, key: string, userId: string, role: Role, created = '2026-03-04T00:00:00Z'): Member => ({
  id: `${organization.id}-${key}`, organization_id: organization.id, user_id: userId, username: key, email: `${key}@example.org`, role, created_at: created,
});

const membersOf = (): Record<string, Member[]> => ({
  'isa-demo': [person(isaDemo, 'lucia.vega', 'user-1', 'OWNER'), person(isaDemo, 'marco', 'user-marco', 'MEMBER', '2026-04-12T00:00:00Z'), person(isaDemo, 'sofia', 'user-sofia', 'VIEWER', '2026-05-20T00:00:00Z')],
  'qos-lab': [person(qosLab, 'marco', 'user-marco', 'ADMIN', '2026-04-15T00:00:00Z')],
  'consultora-demo': [person(consultora, 'nora', 'user-nora', 'OWNER'), person(consultora, 'lucia.vega', 'user-1', 'VIEWER')],
  'research-hub': [person(researchHub, 'nora', 'user-nora', 'OWNER'), person(researchHub, 'lucia.vega', 'user-1', 'ADMIN')],
  'partner-lab': [person(partnerLab, 'nora', 'user-nora', 'ADMIN'), person(partnerLab, 'lucia.vega', 'user-1', 'OWNER')],
});

const project = (n: number, orgId: string, slug: string, name: string, description: string, visibility: 'public' | 'private') => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description, visibility, created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
});

const projectsOf = (): Record<string, unknown[]> => ({
  'isa-demo': [
    project(1, 'org-1', 'qos-benchmarks', 'QoS Benchmarks', 'Reference binding cases with workflow and placement.', 'public'),
    project(2, 'org-1', 'checkout-privado', 'Checkout (privado)', 'Internal payments case with proprietary candidates.', 'private'),
  ],
  'qos-lab': [project(3, 'org-2', 'placement-edge', 'Placement at the edge', 'Exploration with pools and latencies.', 'private')],
});

const auditEvents = [
  {
    id: 'e0000000-0000-0000-0000-0000000000e5', organizationId: 'org-1', actorId: null, action: 'organization.invitation.created', targetType: 'OrganizationInvitation',
    targetId: 'inv-1', detail: {}, createdAt: '2026-10-08T09:15:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e4', organizationId: 'org-1', actorId: 'user-1', action: 'organization.members.batch_updated', targetType: 'Organization',
    targetId: 'org-1', detail: { changes: [{ user_id: 'user-marco', role: 'ADMIN' }, { user_id: 'user-sofia', role: null }] }, createdAt: '2026-09-25T10:00:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e3', organizationId: 'org-1', actorId: 'user-1', action: 'project.created', targetType: 'Project',
    targetId: 'project-1', detail: {}, createdAt: '2026-04-01T08:30:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e2', organizationId: 'org-1', actorId: 'user-1', action: 'organization.created', targetType: 'Organization',
    targetId: 'org-1', detail: {}, createdAt: '2026-03-03T08:00:00Z',
  },
];

const tracked = (id: string, limit: number, used: number, unit: string, renews: string | null = null) =>
  ({ limit_id: id, limit, used, remaining: Math.max(0, limit - used), unit, renews_at: renews });

const RENEWS = '2026-11-01T00:00:00Z';

/** What the gateway reports for the RESEARCH plan of the pricing 0.1.0, with some of the sponsor's room used. */
const researchUsage = () => ({
  plan: 'RESEARCH',
  contract_pending: false,
  features: { collaboration: true, solve: true },
  capabilities: {
    taskStarts: 50, solverSeconds: 30_000, concurrentJobs: 3, organizations: 5, members: 15, projects: 50, privateProjects: 30, collections: 50, studies: 25, storageBytes: 5_368_709_120,
  },
  limits: {
    taskStarts: tracked('taskStarts', 50, 18, 'solve/month', RENEWS),
    solverSeconds: tracked('solverSeconds', 30_000, 7_420, 'second/month', RENEWS),
    concurrentJobs: tracked('concurrentJobs', 3, 1, 'job'),
    organizations: tracked('organizations', 5, 2, 'organization'),
    members: tracked('members', 15, 3, 'member'),
    projects: tracked('projects', 50, 3, 'project'),
    privateProjects: tracked('privateProjects', 30, 2, 'project'),
    storageBytes: tracked('storageBytes', 5_368_709_120, 52_428_800, 'byte'),
  },
});

const jobs = () => ({
  jobs: [
    { id: '00000000-0000-0000-0000-0000000000f2', engine_id: 'minizinc', status: 'running', termination: null, solutions: null, created_at: '2026-10-08T08:00:00Z', finished_at: null },
    { id: '00000000-0000-0000-0000-0000000000f6', engine_id: 'random-search', status: 'completed', termination: 'INFEASIBLE', solutions: 0, created_at: '2026-10-01T09:00:00Z', finished_at: '2026-10-01T09:00:40Z' },
    { id: '00000000-0000-0000-0000-0000000000f1', engine_id: 'evolutionary', status: 'completed', termination: 'FEASIBLE', solutions: 3, created_at: '2026-09-30T09:00:00Z', finished_at: '2026-09-30T09:01:05Z' },
  ],
  total: 3,
  retention_days: 180,
});

const notifications = () => [{
  id: 'n1', kind: 'contract.changed', subject: 'Your OpenBinding agreement changed', body: 'Plan: BASIC → RESEARCH.',
  payload: { reason: 'institutional_agreement', previous: { plan: 'BASIC', addOns: {} }, current: { plan: 'RESEARCH', addOns: {} }, pricingVersion: '0.1.0' },
  read_at: null as string | null, created_at: hoursAgo(5),
}];

type Refusable = 'jobs' | 'create' | 'patch' | 'remove' | 'projects' | 'batch' | 'invite' | 'audit' | 'usage';

interface State {
  organizations: Org[];
  members: Record<string, Member[]>;
  projects: Record<string, unknown[]>;
  jobs: ReturnType<typeof jobs>;
  notifications: ReturnType<typeof notifications>;
  /** A refusal for one action; unset means the action succeeds. */
  refuse: Partial<Record<Refusable, Handler>>;
}

const methodOf = (route: Route) => route.request().method();
const orgPath = (suffix = '') => new RegExp(`^${API}/v1/organizations/([^/?]+)${suffix}(\\?.*)?$`);
const slugOf = (route: Route, suffix = '') => new RegExp(`/v1/organizations/([^/?]+)${suffix}(\\?.*)?$`).exec(route.request().url())?.[1] ?? '';

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, overrides: Partial<State> = {}): Promise<State> {
  const state: State = {
    organizations: [isaDemo, qosLab, consultora, researchHub, partnerLab],
    members: membersOf(),
    projects: projectsOf(),
    jobs: jobs(),
    notifications: notifications(),
    refuse: {},
    ...overrides,
  };
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's4a-access');
    localStorage.setItem('openbinding-refresh-token', 's4a-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's4a-access-2', refresh_token: 's4a-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(`${API}/v1/users/me/usage`, (route) => (state.refuse.usage ? state.refuse.usage(route) : json(researchUsage())(route)));
  await page.route(new RegExp(`^${API}/v1/users/me/jobs(\\?.*)?$`), (route) => (state.refuse.jobs ? state.refuse.jobs(route) : json(state.jobs)(route)));

  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), (route) => json(state.notifications)(route));
  await page.route(new RegExp(`^${API}/v1/notifications/([^/]+)/read$`), async (route) => {
    const id = /notifications\/([^/]+)\/read/.exec(route.request().url())?.[1];
    state.notifications = state.notifications.map((item) => (item.id === id ? { ...item, read_at: new Date().toISOString() } : item));
    return json(state.notifications.find((item) => item.id === id))(route);
  });

  await page.route(`${API}/v1/organizations`, async (route) => {
    if (methodOf(route) === 'POST') {
      if (state.refuse.create) return state.refuse.create(route);
      const body = route.request().postDataJSON() as { slug: string; name: string; parent_id: string | null; billing_sponsor_user_id: string | null };
      const created = org(state.organizations.length + 1, body.slug, body.name, 'OWNER', {
        parent_id: body.parent_id, billing_sponsor_user_id: body.billing_sponsor_user_id ?? 'user-1', created_at: new Date().toISOString(),
      });
      state.organizations = [...state.organizations, created];
      state.members[created.slug] = [person(created, 'lucia.vega', 'user-1', 'OWNER')];
      return json(created, 201)(route);
    }
    return json(state.organizations)(route);
  });

  await page.route(orgPath(), async (route) => {
    const slug = slugOf(route);
    const found = state.organizations.find((item) => item.slug === slug);
    if (methodOf(route) === 'PATCH') {
      if (state.refuse.patch) return state.refuse.patch(route);
      const body = route.request().postDataJSON() as { name?: string; parent_id?: string; move_to_root?: boolean; billing_sponsor_user_id?: string };
      state.organizations = state.organizations.map((item) => (item.slug === slug ? {
        ...item,
        ...(body.name ? { name: body.name } : {}),
        ...(body.move_to_root ? { parent_id: null } : body.parent_id ? { parent_id: body.parent_id } : {}),
        ...(body.billing_sponsor_user_id ? { billing_sponsor_user_id: body.billing_sponsor_user_id } : {}),
      } : item));
      return json(state.organizations.find((item) => item.slug === slug))(route);
    }
    if (methodOf(route) === 'DELETE') {
      if (state.refuse.remove) return state.refuse.remove(route);
      state.organizations = state.organizations.filter((item) => item.slug !== slug);
      return noContent(route);
    }
    return found ? json(found)(route) : detail(404, 'not_found', 'Organization not found.')(route);
  });

  await page.route(orgPath('/projects'), (route) => (state.refuse.projects ? state.refuse.projects(route) : json(state.projects[slugOf(route, '/projects')] ?? [])(route)));
  await page.route(orgPath('/members'), (route) => json(state.members[slugOf(route, '/members')] ?? [])(route));
  await page.route(orgPath('/members/batch'), async (route) => {
    if (state.refuse.batch) return state.refuse.batch(route);
    const slug = slugOf(route, '/members/batch');
    const { changes } = route.request().postDataJSON() as { changes: Array<{ user_id: string; role: Role | null }> };
    let next = state.members[slug] ?? [];
    for (const change of changes) {
      next = change.role === null
        ? next.filter((item) => item.user_id !== change.user_id)
        : next.map((item) => (item.user_id === change.user_id ? { ...item, role: change.role as Role } : item));
    }
    state.members[slug] = next;
    return json(next)(route);
  });
  await page.route(orgPath('/invitations'), async (route) => {
    if (state.refuse.invite) return state.refuse.invite(route);
    const body = route.request().postDataJSON() as { email: string; role: Role };
    return json({
      id: 'inv-2', organization_id: 'org-1', email: body.email, role: body.role, expires_at: '2026-10-16T09:00:00Z', token: 'obi_a1b2c3d4e5f6_UN-SOLO-USO-DE-PRUEBA-0000',
    }, 201)(route);
  });
  await page.route(orgPath('/audit'), async (route) => {
    if (state.refuse.audit) return state.refuse.audit(route);
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const events = action ? auditEvents.filter((item) => item.action === action) : auditEvents;
    return json({ events, total: events.length, offset: 0, limit: 50 })(route);
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

/** The organization settings side navigation: three destinations, the current one marked. */
async function expectSettingsNav(main: Locator, slug: string, current: string) {
  const nav = main.getByRole('navigation', { name: 'Organization settings' });
  const destinations: Array<[string, string]> = [
    ['General', `/app/${slug}/settings`], ['Members & invitations', `/app/${slug}/settings/members`], ['Audit log', `/app/${slug}/settings/audit`],
  ];
  for (const [label, href] of destinations) await expect(nav.getByRole('link', { name: new RegExp(`^${label}`) })).toHaveAttribute('href', href);
  await expect(nav.getByRole('link', { name: new RegExp(`^${current}`) })).toHaveAttribute('aria-current', 'page');
}

const request = (page: Page, method: string, path: string) => page.waitForRequest((candidate) => candidate.method() === method && candidate.url() === `${API}${path}`);

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(120_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S4a organizations`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('app-home /app', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app');
      const main = page.locator('#platform-main');

      await expect(page.locator('header.app-header')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Hello, lucia.vega' })).toBeVisible();
      await expect(main.getByText('Pick up where you left off.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'New project' })).toHaveAttribute('href', '/app/isa-demo/new-project');

      const tree = main.getByRole('list', { name: 'Organizations' });
      await expect(tree.getByRole('link')).toHaveCount(5);
      await expect(tree.getByRole('link', { name: /Consultora Demo/ }).getByText('VIEWER')).toBeVisible();
      await expect(tree.getByText('isa-demo · you sponsor it · own role')).toBeVisible();
      await expect(tree.getByText('qos-lab · you sponsor it · inherited role')).toBeVisible();
      await expect(tree.getByRole('link', { name: /QoS Lab/ }).getByText('OWNER')).toHaveAttribute('title', 'Inherited from ISA Demo Group');

      const activity = main.getByRole('region', { name: 'Recent activity' });
      await expect(activity.getByText('Running')).toBeVisible();
      await expect(activity.getByText('No feasible binding')).toBeVisible();
      await expect(activity.getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', '/app/jobs');
      await expect(main.getByRole('meter', { name: 'Solver time' })).toHaveAttribute('aria-valuenow', '7420');
      await expect(main.getByText('Monthly limits renew Nov 1, 2026. Job slots free up as runs finish.')).toBeVisible();
      await expect(main.getByText('Your OpenBinding agreement changed')).toBeVisible();
      await capture(page, testInfo, `home-${name}-success`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // A block that fails does not take the others with it, and can be asked again.
      state.refuse.jobs = unavailable;
      await page.reload();
      await expect(main.getByRole('region', { name: 'Recent activity' }).getByRole('alert')).toContainText('Recent jobs couldn’t be loaded (503). The other blocks are unaffected.');
      await expect(main.getByRole('list', { name: 'Organizations' }).getByRole('link')).toHaveCount(5);
      await expect(main.getByRole('meter', { name: 'Solver time' })).toBeVisible();
      await capture(page, testInfo, `home-${name}-activity-503`);
      state.refuse.jobs = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('region', { name: 'Recent activity' }).getByText('Running')).toBeVisible();

      // Limits can be unavailable on their own too.
      state.refuse.usage = detail(503, 'pricing_unavailable', 'Quotas cannot be read right now.');
      await page.reload();
      await expect(main.getByRole('region', { name: 'This month' }).getByRole('alert')).toContainText('Your plan limits can’t be loaded right now (503 · pricing_unavailable).');
      state.refuse.usage = undefined;
      await main.getByRole('region', { name: 'This month' }).getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('meter', { name: 'Solver time' })).toBeVisible();

      const read = request(page, 'POST', '/v1/notifications/n1/read');
      await main.getByRole('button', { name: 'Mark as read' }).click();
      await read;
      await expect(main.getByText('You’re all caught up.')).toBeVisible();

      // No organizations: the first-organization guide, with the way to the wizard and to an invitation.
      state.organizations = [];
      state.jobs = { jobs: [], total: 0, retention_days: 180 };
      await page.reload();
      await expect(main.getByRole('heading', { name: 'Create your first organization' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'Create organization' })).toHaveAttribute('href', '/app/organizations/new');
      await expect(main.getByRole('link', { name: 'I have an invitation' })).toHaveAttribute('href', '/invitations/accept');
      await expect(main.getByText(/organization limit \(5 on RESEARCH\)/)).toBeVisible();
      await expect(main.getByText('You’re not in any organization yet.')).toBeVisible();
      await expect(main.getByText(/No jobs yet/)).toBeVisible();
      await capture(page, testInfo, `home-${name}-first-organization`);
      expect(critical).toEqual([]);
    });

    test('org-create /app/organizations/new', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/organizations/new');
      const main = page.locator('#platform-main');
      const next = () => main.getByRole('button', { name: 'Continue' }).click();

      await expect(main.getByRole('heading', { level: 1, name: 'New organization' })).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('New organization');
      await expect(main.getByRole('list', { name: 'Steps' }).getByRole('button')).toHaveCount(4);
      await expect(main.getByRole('button', { name: 'Continue' })).toBeDisabled();
      await main.getByLabel('Name', { exact: true }).fill('Distributed Systems Lab');
      await expect(main.getByLabel('Address')).toHaveValue('distributed-systems-lab');
      await expect(main.getByText('Available to try · can’t be changed later.')).toBeVisible();
      await capture(page, testInfo, `create-${name}-1-name`);

      await next();
      await expect(main.getByRole('heading', { name: 'Where it sits' })).toBeVisible();
      const parents = main.getByRole('group', { name: 'Parent organization' });
      await expect(parents.getByRole('radio', { name: /Consultora Demo/ })).toBeDisabled();
      await expect(parents.getByText('Needs ADMIN here; your role is VIEWER')).toBeVisible();
      await expect(parents.getByRole('radio', { name: /Research Hub/ })).toBeEnabled();
      await parents.getByRole('radio', { name: /ISA Demo Group/ }).check();
      const preview = main.getByRole('list', { name: 'Organization tree preview' });
      await expect(preview.getByRole('listitem')).toHaveCount(2);
      await expect(preview.getByText('NEW', { exact: true })).toBeVisible();
      await expect(main.getByRole('meter', { name: 'Organizations' })).toHaveAttribute('aria-valuenow', '3');
      await capture(page, testInfo, `create-${name}-2-place`);

      await next();
      await expect(main.getByRole('heading', { name: 'Who sponsors it' })).toBeVisible();
      await expect(main.getByRole('radio', { name: /You \(lucia\.vega\)/ })).toBeChecked();
      await expect(main.getByText('Counts against your RESEARCH plan')).toBeVisible();
      await next();
      await expect(main.getByRole('heading', { name: 'Review' })).toBeVisible();
      await expect(main.getByText('/app/distributed-systems-lab')).toBeVisible();
      await expect(main.getByText('Your role', { exact: true })).toBeVisible();
      await capture(page, testInfo, `create-${name}-4-review`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The gateway's refusals, one by one: 409, 402, 503.
      const create = main.getByRole('button', { name: 'Create organization' });
      state.refuse.create = detail(409, 'slug_conflict', 'That organization slug is in use.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('That address is taken (409 · slug_conflict). Another organization already uses /app/distributed-systems-lab.');
      await capture(page, testInfo, `create-${name}-409`);

      state.refuse.create = detail(402, 'sponsor_quota_exceeded', 'The sponsor contract allows 5 organizations.', { quota: { limit_id: 'organizations', limit: 5, used: 5 } });
      await create.click();
      const full = main.getByRole('alert');
      await expect(full).toContainText('The sponsor has no organizations left (402 · sponsor_quota_exceeded). You already sponsor 5 of 5 organizations.');
      await expect(full.getByRole('link', { name: 'See usage' })).toHaveAttribute('href', '/app/account/usage');
      await expect(full.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');
      await capture(page, testInfo, `create-${name}-402`);

      state.refuse.create = detail(503, 'pricing_unavailable', 'The pricing service is not reachable.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('The sponsor’s limits can’t be checked right now (503 · pricing_unavailable), so nothing was created.');
      await capture(page, testInfo, `create-${name}-503`);

      // Created: the payload carries the parent and the sponsor, and the way on opens the organization.
      state.refuse.create = undefined;
      const posted = request(page, 'POST', '/v1/organizations');
      await main.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
      expect((await posted).postDataJSON()).toEqual({
        name: 'Distributed Systems Lab', slug: 'distributed-systems-lab', parent_id: 'org-1', billing_sponsor_user_id: 'user-1',
      });
      await expect(main.getByText('Distributed Systems Lab is ready')).toBeVisible();
      await expect(main.getByText(/It sits inside ISA Demo Group, so members there keep their roles here\./)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Open organization' })).toHaveAttribute('href', '/app/distributed-systems-lab');
      await expect(main.getByRole('link', { name: 'Create the first project' })).toHaveAttribute('href', '/app/distributed-systems-lab/new-project');
      await capture(page, testInfo, `create-${name}-created`);
      expect(critical).toEqual([]);
    });

    test('org-overview /app/:org', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo');
      const main = page.locator('#platform-main');

      const title = main.getByRole('heading', { level: 1, name: 'ISA Demo Group' });
      await expect(title).toBeVisible();
      const hero = title.locator('xpath=ancestor::header[1]');
      await expect(hero.getByText('/app/isa-demo')).toBeVisible();
      await expect(hero.getByText('OWNER')).toBeVisible();
      await expect(hero.getByText('lucia.vega (you)')).toBeVisible();
      await expect(hero.getByRole('link', { name: 'New project' })).toHaveAttribute('href', '/app/isa-demo/new-project');
      await expect(hero.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
      await expect(hero.getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
      await expect(hero.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/app/isa-demo/settings');

      const card = main.getByRole('link', { name: /QoS Benchmarks/ });
      await expect(card).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
      await expect(card.getByText('Public')).toBeVisible();
      await expect(main.getByRole('link', { name: /Checkout \(privado\)/ }).getByText('Private', { exact: true })).toBeVisible();
      const subs = main.getByRole('heading', { name: 'Sub-organizations' }).locator('xpath=ancestor::section[1]');
      await expect(subs.getByRole('link', { name: /QoS Lab/ })).toHaveAttribute('href', '/app/qos-lab');
      await expect(subs.getByText('Inherited from ISA Demo Group')).toBeVisible();
      const room = main.getByRole('heading', { name: 'Sponsor’s room' }).locator('xpath=ancestor::section[1]');
      await expect(room.getByRole('meter', { name: 'Organizations' })).toHaveAttribute('aria-valuenow', '2');
      await expect(room.getByText('Counted across every organization you sponsor.')).toBeVisible();
      await capture(page, testInfo, `overview-${name}-success`);

      // A VIEWER sees the organization, has no button to create, and is told why.
      await page.goto('/app/consultora-demo');
      await expect(main.getByRole('heading', { level: 1, name: 'Consultora Demo' })).toBeVisible();
      await expect(main.getByText('No projects yet')).toBeVisible();
      await expect(main.getByText('You’re a VIEWER here, so you can’t create projects. A MEMBER or above can.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'New project' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Create the first project' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Audit' })).toHaveCount(0);
      await expect(main.getByText(/nora’s usage is visible only to them/)).toBeVisible();
      await capture(page, testInfo, `overview-${name}-viewer-empty`);

      // The same neutral message for an organization that does not exist and one the account is not in.
      await page.goto('/app/ghost-lab');
      await expect(main.getByRole('heading', { name: 'Organization not available' })).toBeVisible();
      await expect(main.getByText(/It doesn’t exist, or you’re not a member\./)).toBeVisible();
      await expect(main.getByRole('link', { name: 'Explore public projects' })).toHaveAttribute('href', '/explore');
      await capture(page, testInfo, `overview-${name}-not-available`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The projects block fails on its own: the rest of the page is there. The workspace shell reads the same list, so its
      // own banner appears too; that is what a real outage looks like.
      state.refuse.projects = unavailable;
      await page.goto('/app/isa-demo');
      await expect(main.getByText('Projects couldn’t be loaded (503). Sub-organizations and usage are unaffected.')).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Sub-organizations' })).toBeVisible();
      await expect(main.getByRole('meter', { name: 'Organizations' })).toBeVisible();
      await capture(page, testInfo, `overview-${name}-projects-503`);
      state.refuse.projects = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('link', { name: /QoS Benchmarks/ })).toBeVisible();

      // Search, and the selector that moves to another organization.
      await main.getByRole('searchbox', { name: 'Find a project' }).fill('checkout');
      await expect(main.getByRole('link', { name: /QoS Benchmarks/ })).toHaveCount(0);
      await main.getByRole('searchbox', { name: 'Find a project' }).fill('zzz');
      await expect(main.getByText('No project matches “zzz”.')).toBeVisible();
      await main.getByLabel('Switch organization').selectOption('qos-lab');
      await expect(page).toHaveURL(/\/app\/qos-lab$/);
      await expect(main.getByRole('heading', { level: 1, name: /QoS Lab/ })).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
      expect(critical).toEqual([]);
    });

    test('org-settings /app/:org/settings', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo/settings');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await expectSettingsNav(main, 'isa-demo', 'General');
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('ISA Demo Group');
      await expect(main.getByText('/app/isa-demo', { exact: true })).toBeVisible();
      await expect(main.getByText('Current sponsor · RESEARCH plan')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save name' })).toBeDisabled();
      const impact = main.getByLabel('What deleting removes');
      await expect(impact).toContainText('projects2');
      await expect(impact).toContainText('sub-organization1');
      await expect(impact).toContainText('direct members3');
      await capture(page, testInfo, `settings-${name}-success`);

      // Read-only below ADMIN, with the reason.
      await page.goto('/app/consultora-demo/settings');
      await expect(main.getByText(/these settings are read-only/)).toBeVisible();
      await expect(main.getByLabel('Name', { exact: true })).toBeDisabled();
      await expect(main.getByRole('button', { name: 'Save name' })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Delete organization' })).toHaveCount(0);
      await expect(main.getByText('Needs OWNER. Your role here is VIEWER.')).toBeVisible();
      await expect(main.getByRole('navigation', { name: 'Organization settings' }).getByText('ADMIN')).toBeVisible();
      await capture(page, testInfo, `settings-${name}-read-only`);
      if (isMobile) {
        await page.goto('/app/isa-demo/settings');
        await main.getByRole('button', { name: 'Delete organization' }).click();
        await expect(page.getByRole('dialog', { name: 'Delete ISA Demo Group?' })).toBeVisible();
        await capture(page, testInfo, `settings-${name}-delete-dialog`);
        expect(critical).toEqual([]);
        return;
      }

      // Rename.
      await page.goto('/app/isa-demo/settings');
      await main.getByLabel('Name', { exact: true }).fill('ISA Research Group');
      const renamed = request(page, 'PATCH', '/v1/organizations/isa-demo');
      await main.getByRole('button', { name: 'Save name' }).click();
      expect((await renamed).postDataJSON()).toEqual({ name: 'ISA Research Group' });
      await expect(main.getByText('Name saved as “ISA Research Group”. An audit entry was recorded.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'See it in the audit log' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
      await capture(page, testInfo, `settings-${name}-renamed`);

      // Moving: a loop and a parent without ADMIN are refused up front; the gateway's 409 still reads clearly.
      const places = main.getByRole('group', { name: 'New parent' });
      await expect(places.getByRole('radio', { name: /QoS Lab/ })).toBeDisabled();
      await expect(places.getByText('It sits inside this organization: moving here would make a loop')).toBeVisible();
      await expect(places.getByRole('radio', { name: /Consultora Demo/ })).toBeDisabled();
      await expect(places.getByText('Needs ADMIN there; you’re VIEWER')).toBeVisible();
      await places.getByRole('radio', { name: /Research Hub/ }).check();
      const tree = main.getByRole('list', { name: 'Organization tree after the move' });
      await expect(tree.getByRole('listitem')).toHaveCount(3);
      await expect(main.getByText('Members of Research Hub will inherit their roles here.')).toBeVisible();
      state.refuse.patch = detail(409, 'organization_cycle', 'An organization cannot be moved below one of its descendants.');
      await main.getByRole('button', { name: 'Move organization' }).click();
      await expect(main.getByRole('alert')).toContainText('That move would put the organization inside itself (409 · organization_cycle). Choose another parent.');
      await capture(page, testInfo, `settings-${name}-move-409`);
      state.refuse.patch = undefined;
      const moved = request(page, 'PATCH', '/v1/organizations/isa-demo');
      await main.getByRole('button', { name: 'Move organization' }).click();
      expect((await moved).postDataJSON()).toEqual({ parent_id: 'org-4' });
      await expect(main.getByText('Moved ISA Research Group inside Research Hub.')).toBeVisible();

      // Sponsor: only an OWNER changes it; the gateway checks the new sponsor's room first.
      await page.goto('/app/partner-lab/settings');
      await expect(main.getByText('nora', { exact: true })).toBeVisible();
      await main.getByLabel('New sponsor').selectOption('self');
      state.refuse.patch = detail(402, 'sponsor_quota_exceeded', 'The sponsor contract allows 15 members.', { quota: { limit_id: 'members', limit: 15, used: 16 } });
      await main.getByRole('button', { name: 'Change sponsor' }).click();
      await expect(main.getByRole('alert')).toContainText('The new sponsor has no room left for this organization’s projects and members (402 · sponsor_quota_exceeded). members: 16 of 15. Nothing changed.');
      await capture(page, testInfo, `settings-${name}-sponsor-402`);
      state.refuse.patch = detail(422, 'invalid_sponsor', 'Sponsor must be active.');
      await main.getByRole('button', { name: 'Change sponsor' }).click();
      await expect(main.getByRole('alert')).toContainText('That account can’t sponsor this organization (422 · invalid_sponsor).');
      state.refuse.patch = detail(503, 'pricing_unavailable', 'Limits cannot be checked.');
      await main.getByRole('button', { name: 'Change sponsor' }).click();
      await expect(main.getByRole('alert')).toContainText('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed.');
      state.refuse.patch = undefined;
      const sponsored = request(page, 'PATCH', '/v1/organizations/partner-lab');
      await main.getByRole('button', { name: 'Change sponsor' }).click();
      expect((await sponsored).postDataJSON()).toEqual({ billing_sponsor_user_id: 'user-1' });
      await expect(main.getByText('Sponsor changed. Size limits now come from the new sponsor’s plan.')).toBeVisible();

      // An ADMIN can edit, but the sponsor stays locked.
      await page.goto('/app/research-hub/settings');
      await expect(main.getByText('Needs OWNER. Your role here is ADMIN.')).toBeVisible();
      await expect(main.getByRole('button', { name: 'Save name' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('org-settings /app/:org/settings · deleting', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      const main = page.locator('#platform-main');

      // Deleting asks for the address and the gateway refuses sealed history.
      await page.goto('/app/isa-demo/settings');
      await main.getByRole('button', { name: 'Delete organization' }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete ISA Demo Group?' });
      const confirm = dialog.getByRole('button', { name: 'Delete permanently' });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Type isa-demo to confirm').fill('isa-dem');
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Type isa-demo to confirm').fill('isa-demo');
      await expect(confirm).toBeEnabled();
      state.refuse.remove = detail(409, 'historical_references', 'Organizations with sealed library history cannot be deleted.');
      await confirm.click();
      await expect(dialog.getByRole('alert')).toContainText('It has sealed history, so it can’t be deleted (409 · historical_references).');
      await capture(page, testInfo, `settings-${name}-delete-409`);
      state.refuse.remove = undefined;
      const deleted = request(page, 'DELETE', '/v1/organizations/isa-demo');
      await confirm.click();
      await deleted;
      await expect(page).toHaveURL(/\/app$/);
      await expect(main.getByText('ISA Demo Group was deleted, together with everything inside it.')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('org-members /app/:org/settings/members', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo/settings/members');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
      await expect(main.getByText('ISA Demo Group · 3 people with a role')).toBeVisible();
      await expectSettingsNav(main, 'isa-demo', 'Members & invitations');
      const table = main.getByRole('table');
      await expect(table.getByRole('columnheader')).toHaveText(['Person', 'Role here', 'Effective role', 'Added', 'Actions']);
      await expect(table.getByRole('row', { name: /lucia\.vega@example\.org/ }).getByText('(you)')).toBeVisible();
      await expect(main.getByLabel('Role for marco')).toHaveValue('MEMBER');
      await expect(table.getByRole('row', { name: /marco@example\.org/ }).getByText('Apr 12, 2026')).toBeVisible();
      await expect(main.getByText(/Unique members across everything you sponsor:/)).toContainText('3 of 15');
      await expect(main.getByText('To confirm')).toHaveCount(0);
      await capture(page, testInfo, `members-${name}-success`);

      // Own and inherited roles, side by side.
      await page.goto('/app/qos-lab/settings/members');
      await expect(main.getByText('QoS Lab (sub-organización) · 3 people with a role')).toBeVisible();
      await expect(table.getByRole('row', { name: /lucia\.vega@example\.org/ }).getByText('Inherited from ISA Demo Group')).toBeVisible();
      await expect(main.getByLabel('Role for lucia.vega')).toHaveValue('__none');
      await expect(table.getByRole('row', { name: /marco@example\.org/ }).getByText('Own role (higher than inherited MEMBER)')).toBeVisible();
      await capture(page, testInfo, `members-${name}-inherited`);

      if (isMobile) {
        await page.goto('/app/isa-demo/settings/members');
        await main.getByRole('button', { name: 'Invite by email' }).click();
        await expect(page.getByRole('dialog', { name: 'Invite to ISA Demo Group' })).toBeVisible();
        await capture(page, testInfo, `members-${name}-invite-dialog`);
        expect(critical).toEqual([]);
        return;
      }

      // The queue: stage a change and an undo, then apply one batch.
      await page.goto('/app/isa-demo/settings/members');
      const queue = main.getByRole('complementary', { name: /Pending changes/ });
      await expect(queue.getByText('Change a role or remove someone in the table. Changes wait here until you apply them.')).toBeVisible();
      await expect(queue.getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();
      await main.getByLabel('Role for marco').selectOption('ADMIN');
      await main.getByRole('button', { name: 'Remove sofia' }).click();
      await expect(queue.getByRole('button', { name: 'Apply 2 changes' })).toBeEnabled();
      await expect(queue.getByText('Removed', { exact: true })).toBeVisible();
      await capture(page, testInfo, `members-${name}-queued`);
      await queue.getByRole('button', { name: 'Undo change for sofia' }).click();
      await expect(queue.getByRole('button', { name: 'Apply 1 change' })).toBeEnabled();

      // The gateway's refusals, one by one: 409 last owner, 402 seats, 422 mismatch, 503 pricing.
      await main.getByLabel('Role for lucia.vega').selectOption('VIEWER');
      state.refuse.batch = detail(409, 'last_owner', 'The last owner cannot be removed.');
      await queue.getByRole('button', { name: 'Apply 2 changes' }).click();
      await expect(main.getByRole('alert')).toContainText('At least one OWNER must remain (409 · last_owner). Keep someone as OWNER, or make another person OWNER in the same batch.');
      await capture(page, testInfo, `members-${name}-409`);
      state.refuse.batch = detail(402, 'sponsor_quota_exceeded', 'The sponsor contract allows 15 members.', { quota: { limit_id: 'members', limit: 15, used: 15 } });
      await queue.getByRole('button', { name: 'Apply 2 changes' }).click();
      const seats = main.getByRole('alert');
      await expect(seats).toContainText('The sponsor has no member seats left (402 · sponsor_quota_exceeded): 15 of 15 used. Nothing changed.');
      await expect(seats.getByRole('link', { name: 'See sponsor usage' })).toHaveAttribute('href', '/app/account/usage');
      await expect(seats.getByRole('link', { name: 'Change sponsor' })).toHaveAttribute('href', '/app/isa-demo/settings');
      await capture(page, testInfo, `members-${name}-402`);
      state.refuse.batch = detail(422, 'member_mismatch', 'Path and payload user differ.');
      await queue.getByRole('button', { name: 'Apply 2 changes' }).click();
      await expect(main.getByRole('alert')).toContainText('One of these people isn’t a member of this organization (422 · member_mismatch).');
      state.refuse.batch = detail(503, 'pricing_unavailable', 'Limits cannot be checked.');
      await queue.getByRole('button', { name: 'Apply 2 changes' }).click();
      await expect(main.getByRole('alert')).toContainText('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed; try again in a moment.');

      state.refuse.batch = undefined;
      await queue.getByRole('button', { name: 'Undo change for lucia.vega' }).click();
      const applied = request(page, 'POST', '/v1/organizations/isa-demo/members/batch');
      await queue.getByRole('button', { name: 'Apply 1 change' }).click();
      expect((await applied).postDataJSON()).toEqual({ changes: [{ user_id: 'user-marco', role: 'ADMIN' }] });
      await expect(main.getByText('1 change applied together. They’re recorded in the audit log.')).toBeVisible();
      await expect(main.getByLabel('Role for marco')).toHaveValue('ADMIN');
      await capture(page, testInfo, `members-${name}-applied`);

      // Inviting: the one-time code is shown once, and the invitation is listed as pending.
      await main.getByRole('button', { name: 'Invite by email' }).click();
      const invite = page.getByRole('dialog', { name: 'Invite to ISA Demo Group' });
      await invite.getByLabel('Email').fill('nope');
      await invite.getByRole('button', { name: 'Create invitation' }).click();
      await expect(invite.getByRole('alert')).toContainText('Enter a valid email address (422).');
      await invite.getByLabel('Email').fill('invitada@example.org');
      await invite.getByLabel('Role when they join').selectOption('ADMIN');
      await capture(page, testInfo, `members-${name}-invite-dialog`);
      const invited = request(page, 'POST', '/v1/organizations/isa-demo/invitations');
      await invite.getByRole('button', { name: 'Create invitation' }).click();
      expect((await invited).postDataJSON()).toEqual({ email: 'invitada@example.org', role: 'ADMIN' });
      const created = page.getByRole('dialog', { name: 'Invitation created' });
      await expect(created.getByText('obi_a1b2c3d4e5f6_UN-SOLO-USO-DE-PRUEBA-0000')).toBeVisible();
      await expect(created.getByText(/Shown only once\./)).toBeVisible();
      await expect(created.getByRole('link', { name: 'accept invitation' })).toHaveAttribute('href', '/invitations/accept');
      await capture(page, testInfo, `members-${name}-invite-code`);
      await created.getByRole('button', { name: 'I’ve saved it' }).click();
      await expect(created).toBeHidden();
      await expect(page.getByText('obi_a1b2c3d4e5f6_UN-SOLO-USO-DE-PRUEBA-0000')).toHaveCount(0);
      const pending = table.getByRole('row', { name: /invitada@example\.org/ });
      await expect(pending.getByText('Invitation pending')).toBeVisible();
      await expect(pending.getByText('Expires Oct 16, 2026')).toBeVisible();

      // Read-only below ADMIN.
      await page.goto('/app/consultora-demo/settings/members');
      await expect(main.getByText(/you can see who’s in, but changing roles and inviting need ADMIN/)).toBeVisible();
      await expect(main.getByLabel('Role for nora')).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Invite by email' })).toHaveCount(0);
      await expect(main.getByText('Only admins can change roles.')).toBeVisible();
      await capture(page, testInfo, `members-${name}-read-only`);
      expect(critical).toEqual([]);
    });

    test('org-audit /app/:org/settings/audit', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app/isa-demo/settings/audit');
      const main = page.locator('#platform-main');

      await expect(main.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
      await expect(main.getByText('Who did what in ISA Demo Group.')).toBeVisible();
      await expectSettingsNav(main, 'isa-demo', 'Audit log');
      const timeline = main.getByRole('list', { name: 'Audit events, newest first' });
      await expect(timeline.getByRole('listitem')).toHaveCount(4);
      await expect(timeline.getByRole('listitem').first()).toContainText('Invitation created');
      await expect(timeline.getByRole('listitem').first()).toContainText('Oct 8, 2026, 09:15 UTC');
      await expect(main.getByText('Showing 1–4 of 4 · newest first')).toBeVisible();
      await expect(main.getByText('Action is filtered by the server; actor and period are filtered in this view.')).toBeVisible();
      await capture(page, testInfo, `audit-${name}-success`);

      await timeline.getByRole('button', { name: /2 member changes applied together/ }).click();
      const open = timeline.getByRole('listitem').filter({ hasText: '2 member changes applied together' });
      await expect(open).toContainText('lucia.vega');
      await expect(open).toContainText('organization.members.batch_updated');
      await expect(open.getByText('marco → ADMIN')).toBeVisible();
      await expect(open.getByText('sofia → removed')).toBeVisible();
      await capture(page, testInfo, `audit-${name}-expanded`);

      // Below ADMIN the log is closed, and the explanation names the role.
      await page.goto('/app/consultora-demo/settings/audit');
      await expect(main.getByRole('alert')).toContainText('The audit log needs ADMIN (403)');
      await expect(main.getByRole('alert')).toContainText('Your role in Consultora Demo is VIEWER.');
      await expect(main.getByRole('button', { name: 'Export this view' })).toHaveCount(0);
      await capture(page, testInfo, `audit-${name}-403`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The action filter is the server's: the request carries it.
      await page.goto('/app/isa-demo/settings/audit');
      const filtered = page.waitForRequest((candidate) => candidate.url().startsWith(`${API}/v1/organizations/isa-demo/audit`) && candidate.url().includes('action=project.created'));
      await main.getByLabel('Action').selectOption('project.created');
      await filtered;
      await expect(timeline.getByRole('listitem')).toHaveCount(1);
      await expect(timeline.getByRole('listitem').first()).toContainText('Project created');
      await capture(page, testInfo, `audit-${name}-filtered`);

      // Actor in the view; and a filter nothing matches.
      await main.getByLabel('Action').selectOption('');
      await expect(timeline.getByRole('listitem')).toHaveCount(4);
      await main.getByLabel('Actor').selectOption('__none');
      await expect(timeline.getByRole('listitem')).toHaveCount(1);
      await main.getByLabel('Actor').selectOption('');
      await main.getByLabel('Action').selectOption('project.deleted');
      await expect(main.getByText(/No events match these filters\./)).toBeVisible();
      await capture(page, testInfo, `audit-${name}-empty`);
      await main.getByRole('button', { name: 'Clear filters' }).click();
      await expect(timeline.getByRole('listitem')).toHaveCount(4);

      // Failure, and the way to try again.
      state.refuse.audit = unavailable;
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('The audit log couldn’t be loaded (503).');
      await capture(page, testInfo, `audit-${name}-503`);
      state.refuse.audit = undefined;
      await main.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('list', { name: 'Audit events, newest first' }).getByRole('listitem')).toHaveCount(4);
      expect(critical).toEqual([]);
    });
  });
}
