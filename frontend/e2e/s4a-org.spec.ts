import { expect as baseExpect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';

// S4a · organization and collaboration, part 1: app-home, SPHERE's organization tree (/me/orgs) and creation page (/orgs/new), org-overview, org-settings (General, with the members, run presets and audit sections at /settings/members, /settings/presets and /settings/audit).
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.
// One test per screen and viewport: each walks the states of its screen in order, on one page. The phone gets the
// layout of each screen and of its dialogs; the states are walked on the desktop.

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
const noContent: Handler = route => route.fulfill({ status: 204 });
/** A service that does not answer: a 503 with no machine code, as a proxy in front of the gateway would send it. */
const unavailable: Handler = json({ detail: 'Accounts are not reachable.' }, 503);

/** A pricing token shaped like the gateway's: three dot-separated parts, the middle one a JSON payload. */
const token = (expiresInSeconds: number) =>
  [
    'header',
    Buffer.from(
      JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + expiresInSeconds })
    ).toString('base64'),
    'signature',
  ].join('.');

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

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

interface Org {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  effective_role: Role;
  created_at: string;
}

const org = (n: number, slug: string, name: string, role: Role, over: Partial<Org> = {}): Org => ({
  id: `org-${n}`,
  slug,
  name,
  parent_id: null,
  effective_role: role,
  created_at: '2026-03-03T00:00:00Z',
  ...over,
});

const isaDemo = org(1, 'isa-demo', 'ISA Demo Group', 'OWNER');
const qosLab = org(2, 'qos-lab', 'QoS Lab (sub-organización)', 'OWNER', {
  parent_id: 'org-1',
  created_at: '2026-03-10T00:00:00Z',
});
const consultora = org(3, 'consultora-demo', 'Consultora Demo', 'VIEWER', {
  created_at: '2026-05-01T00:00:00Z',
});
const researchHub = org(4, 'research-hub', 'Research Hub', 'ADMIN', {
  created_at: '2026-06-01T00:00:00Z',
});
const partnerLab = org(5, 'partner-lab', 'Partner Lab', 'OWNER', {
  created_at: '2026-07-01T00:00:00Z',
});

interface Member {
  id: string;
  organization_id: string;
  user_id: string;
  username: string;
  email: string;
  role: Role;
  created_at: string;
}

const person = (
  organization: Org,
  key: string,
  userId: string,
  role: Role,
  created = '2026-03-04T00:00:00Z'
): Member => ({
  id: `${organization.id}-${key}`,
  organization_id: organization.id,
  user_id: userId,
  username: key,
  email: `${key}@example.org`,
  role,
  created_at: created,
});

const membersOf = (): Record<string, Member[]> => ({
  'isa-demo': [
    person(isaDemo, 'lucia.vega', 'user-1', 'OWNER'),
    person(isaDemo, 'marco', 'user-marco', 'MEMBER', '2026-04-12T00:00:00Z'),
    person(isaDemo, 'sofia', 'user-sofia', 'VIEWER', '2026-05-20T00:00:00Z'),
  ],
  'qos-lab': [person(qosLab, 'marco', 'user-marco', 'ADMIN', '2026-04-15T00:00:00Z')],
  'consultora-demo': [
    person(consultora, 'nora', 'user-nora', 'OWNER'),
    person(consultora, 'lucia.vega', 'user-1', 'VIEWER'),
  ],
  'research-hub': [
    person(researchHub, 'nora', 'user-nora', 'OWNER'),
    person(researchHub, 'lucia.vega', 'user-1', 'ADMIN'),
  ],
  'partner-lab': [
    person(partnerLab, 'nora', 'user-nora', 'ADMIN'),
    person(partnerLab, 'lucia.vega', 'user-1', 'OWNER'),
  ],
});

const problem = (n: number, orgId: string, slug: string, name: string) => ({
  id: `problem-${n}`,
  organization_id: orgId,
  slug,
  name,
  description: '',
  created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-10-08T00:00:00Z',
  latest_revision: {
    id: `revision-${n}`,
    revision: 2,
    package_digest: `sha256-${String(n).repeat(64)}`,
    created_at: '2026-10-08T00:00:00Z',
  },
});

const problemsOf = (): Record<string, ReturnType<typeof problem>[]> => ({
  'isa-demo': [
    problem(1, 'org-1', 'checkout-flow', 'Checkout flow'),
    problem(2, 'org-1', 'edge-placement', 'Edge placement'),
  ],
  'qos-lab': [problem(3, 'org-2', 'placement-edge', 'Placement at the edge')],
});

const auditEvents = [
  {
    id: 'e0000000-0000-0000-0000-0000000000e5',
    organizationId: 'org-1',
    actorId: null,
    action: 'organization.invitation.created',
    targetType: 'OrganizationInvitation',
    targetId: 'inv-1',
    detail: {},
    createdAt: '2026-10-08T09:15:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e4',
    organizationId: 'org-1',
    actorId: 'user-1',
    action: 'organization.members.batch_updated',
    targetType: 'Organization',
    targetId: 'org-1',
    detail: {
      changes: [
        { user_id: 'user-marco', role: 'ADMIN' },
        { user_id: 'user-sofia', role: null },
      ],
    },
    createdAt: '2026-09-25T10:00:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e3',
    organizationId: 'org-1',
    actorId: 'user-1',
    action: 'problem.created',
    targetType: 'BindingCase',
    targetId: 'problem-1',
    detail: {},
    createdAt: '2026-04-01T08:30:00Z',
  },
  {
    id: 'e0000000-0000-0000-0000-0000000000e2',
    organizationId: 'org-1',
    actorId: 'user-1',
    action: 'organization.created',
    targetType: 'Organization',
    targetId: 'org-1',
    detail: {},
    createdAt: '2026-03-03T08:00:00Z',
  },
];

/** What the gateway reports for the RESEARCH plan of the pricing 0.2.0: the plan and its limits, with no consumption. */
const researchUsage = () => ({
  plan: 'RESEARCH',
  contract_pending: false,
  features: { collaboration: true, runs: true },
  capabilities: {
    maxConcurrentRuns: 4,
    maxPrivateProjects: 10,
    maxProblems: null,
    maxRepositoryStorage: null,
  },
});

const run = (
  id: string,
  engine: string,
  status: string,
  termination: string | null,
  createdAt: string,
  finishedAt: string | null
) => ({
  id,
  engine_id: engine,
  status,
  termination,
  cancellation_requested: false,
  retry_of_id: null,
  organization_id: 'org-isa-demo',
  created_at: createdAt,
  finished_at: finishedAt,
});

/** The recent runs of the organization Home shows (`listRuns`). */
const jobs = () => ({
  runs: [
    run(
      '00000000-0000-0000-0000-0000000000f2',
      'minizinc',
      'running',
      null,
      '2026-10-08T08:00:00Z',
      null
    ),
    run(
      '00000000-0000-0000-0000-0000000000f6',
      'random-search',
      'completed',
      'INFEASIBLE',
      '2026-10-01T09:00:00Z',
      '2026-10-01T09:00:40Z'
    ),
    run(
      '00000000-0000-0000-0000-0000000000f1',
      'evolutionary',
      'completed',
      'FEASIBLE',
      '2026-09-30T09:00:00Z',
      '2026-09-30T09:01:05Z'
    ),
  ],
  total: 3,
});

const notifications = () => [
  {
    id: 'n1',
    kind: 'contract.changed',
    subject: 'Your OpenBinding agreement changed',
    body: 'Plan: FREE → RESEARCH.',
    payload: {
      reason: 'institutional_agreement',
      previous: { plan: 'FREE', addOns: {} },
      current: { plan: 'RESEARCH', addOns: {} },
      pricingVersion: '0.2.0',
    },
    read_at: null as string | null,
    created_at: hoursAgo(5),
  },
];

type Refusable =
  'jobs' | 'create' | 'patch' | 'remove' | 'problems' | 'batch' | 'invite' | 'audit' | 'usage';

interface State {
  organizations: Org[];
  members: Record<string, Member[]>;
  invitations: Record<string, unknown[]>;
  problems: Record<string, ReturnType<typeof problem>[]>;
  jobs: ReturnType<typeof jobs>;
  notifications: ReturnType<typeof notifications>;
  /** A refusal for one action; unset means the action succeeds. */
  refuse: Partial<Record<Refusable, Handler>>;
}

/** The organizations as `GET /v1/organizations?tree=true` nests them: the top-level ones, each with its `children`. */
function nest(all: Org[]): unknown[] {
  const ids = new Set(all.map(item => item.id));
  const node = (item: Org): unknown => ({
    ...item,
    description: '',
    avatar: { url: null, kind: null, bg_color: null, fg_color: null },
    role_source: null,
    children: all.filter(child => child.parent_id === item.id).map(node),
  });
  return all.filter(item => !item.parent_id || !ids.has(item.parent_id)).map(node);
}

const methodOf = (route: Route) => route.request().method();
const orgPath = (suffix = '') => new RegExp(`^${API}/v1/organizations/([^/?]+)${suffix}(\\?.*)?$`);
const slugOf = (route: Route, suffix = '') =>
  new RegExp(`/v1/organizations/([^/?]+)${suffix}(\\?.*)?$`).exec(route.request().url())?.[1] ?? '';

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, overrides: Partial<State> = {}): Promise<State> {
  const state: State = {
    organizations: [isaDemo, qosLab, consultora, researchHub, partnerLab],
    members: membersOf(),
    invitations: {},
    problems: problemsOf(),
    jobs: jobs(),
    notifications: notifications(),
    refuse: {},
    ...overrides,
  };
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's4a-access');
    localStorage.setItem('openbinding-refresh-token', 's4a-refresh');
  });

  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(
    `${API}/v1/auth/refresh`,
    json({
      access_token: 's4a-access-2',
      refresh_token: 's4a-refresh-2',
      token_type: 'bearer',
      expires_in: 900,
    })
  );
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(`${API}/v1/users/me/usage`, route =>
    state.refuse.usage ? state.refuse.usage(route) : json(researchUsage())(route)
  );

  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), route =>
    json(state.notifications)(route)
  );
  await page.route(new RegExp(`^${API}/v1/notifications/([^/]+)/read$`), async route => {
    const id = /notifications\/([^/]+)\/read/.exec(route.request().url())?.[1];
    state.notifications = state.notifications.map(item =>
      item.id === id ? { ...item, read_at: new Date().toISOString() } : item
    );
    return json(state.notifications.find(item => item.id === id))(route);
  });

  await page.route(new RegExp(`^${API}/v1/organizations(\\?.*)?$`), async route => {
    if (methodOf(route) === 'POST') {
      if (state.refuse.create) return state.refuse.create(route);
      const body = route.request().postDataJSON() as {
        slug?: string;
        name: string;
        parent_id: string | null;
      };
      // The gateway derives the slug from the name when the form leaves it out.
      const slug =
        body.slug ??
        body.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
      const created = org(state.organizations.length + 1, slug, body.name, 'OWNER', {
        parent_id: body.parent_id,
        created_at: new Date().toISOString(),
      });
      state.organizations = [...state.organizations, created];
      state.members[created.slug] = [person(created, 'lucia.vega', 'user-1', 'OWNER')];
      return json(created, 201)(route);
    }
    const tree = new URL(route.request().url()).searchParams.get('tree') === 'true';
    return json(tree ? nest(state.organizations) : state.organizations)(route);
  });

  await page.route(orgPath(), async route => {
    const slug = slugOf(route);
    const found = state.organizations.find(item => item.slug === slug);
    if (methodOf(route) === 'PATCH') {
      if (state.refuse.patch) return state.refuse.patch(route);
      const body = route.request().postDataJSON() as {
        name?: string;
        parent_id?: string;
        move_to_root?: boolean;
      };
      state.organizations = state.organizations.map(item =>
        item.slug === slug
          ? {
              ...item,
              ...(body.name ? { name: body.name } : {}),
              ...(body.move_to_root
                ? { parent_id: null }
                : body.parent_id
                  ? { parent_id: body.parent_id }
                  : {}),
            }
          : item
      );
      return json(state.organizations.find(item => item.slug === slug))(route);
    }
    if (methodOf(route) === 'DELETE') {
      if (state.refuse.remove) return state.refuse.remove(route);
      state.organizations = state.organizations.filter(item => item.slug !== slug);
      return noContent(route);
    }
    return found
      ? json({
          ...found,
          description: '',
          avatar: { url: null, kind: null, bg_color: null, fg_color: null },
          stats: {
            members: state.members[slug]?.length ?? 0,
            sub_organizations: state.organizations.filter(item => item.parent_id === found.id)
              .length,
            compositions: 0,
            problems: state.problems[slug]?.length ?? 0,
            runs: state.jobs.runs.length,
            studies: 0,
          },
        })(route)
      : detail(404, 'not_found', 'Organization not found.')(route);
  });

  await page.route(orgPath('/runs'), route =>
    state.refuse.jobs ? state.refuse.jobs(route) : json(state.jobs)(route)
  );
  await page.route(orgPath('/problems'), route => {
    if (state.refuse.problems) return state.refuse.problems(route);
    const rows = state.problems[slugOf(route, '/problems')] ?? [];
    return json({ problems: rows, total: rows.length, limit: 200, offset: 0 })(route);
  });
  await page.route(orgPath('/studies'), json([]));
  // No organization has a composition yet: Home and the overview show where the first one comes from.
  await page.route(
    orgPath('/compositions'),
    json({ compositions: [], total: 0, limit: 5, offset: 0 })
  );
  await page.route(orgPath('/members'), route =>
    json(state.members[slugOf(route, '/members')] ?? [])(route)
  );
  await page.route(orgPath('/members/batch'), async route => {
    if (state.refuse.batch) return state.refuse.batch(route);
    const slug = slugOf(route, '/members/batch');
    const { changes } = route.request().postDataJSON() as {
      changes: Array<{ user_id: string; role: Role | null }>;
    };
    let next = state.members[slug] ?? [];
    for (const change of changes) {
      next =
        change.role === null
          ? next.filter(item => item.user_id !== change.user_id)
          : next.map(item =>
              item.user_id === change.user_id ? { ...item, role: change.role as Role } : item
            );
    }
    state.members[slug] = next;
    return json(next)(route);
  });
  await page.route(orgPath('/invitations'), async route => {
    const slug = slugOf(route, '/invitations');
    if (methodOf(route) === 'GET') return json(state.invitations[slug] ?? [])(route);
    if (state.refuse.invite) return state.refuse.invite(route);
    const body = (route.request().postDataJSON() ?? {}) as {
      expires_in_days?: number;
      max_uses?: number;
    };
    const created = {
      id: `inv-${(state.invitations[slug]?.length ?? 0) + 1}`,
      organization_id: 'org-1',
      code: `c0de${(state.invitations[slug]?.length ?? 0) + 1}`.padEnd(16, '0'),
      created_by: { id: 'user-1', username: 'lucia.vega', avatar: null },
      expires_at: new Date(Date.now() + (body.expires_in_days ?? 7) * 86_400_000).toISOString(),
      max_uses: body.max_uses ?? null,
      use_count: 0,
      created_at: new Date().toISOString(),
    };
    state.invitations[slug] = [...(state.invitations[slug] ?? []), created];
    return json(created, 201)(route);
  });
  await page.route(orgPath('/hierarchy'), route => {
    const slug = slugOf(route, '/hierarchy');
    const found = state.organizations.find(item => item.slug === slug);
    if (!found) return detail(404, 'not_found', 'Organization not found.')(route);
    let root = found;
    while (root.parent_id) {
      const parent = state.organizations.find(item => item.id === root.parent_id);
      if (!parent) break;
      root = parent;
    }
    const branch: Org[] = [];
    const walk = (item: Org) => {
      branch.push(item);
      state.organizations.filter(child => child.parent_id === item.id).forEach(walk);
    };
    walk(root);
    return json(
      branch.map(item => ({
        id: item.id,
        slug: item.slug,
        name: item.name,
        avatar: {},
        parent_id: item.parent_id,
        has_access: true,
        effective_role: item.effective_role,
      }))
    )(route);
  });
  await page.route(orgPath('/owner'), route => {
    const slug = slugOf(route, '/owner');
    const { user_id } = route.request().postDataJSON() as { user_id: string };
    state.members[slug] = (state.members[slug] ?? []).map(item =>
      item.user_id === user_id
        ? { ...item, role: 'OWNER' as Role }
        : item.role === 'OWNER'
          ? { ...item, role: 'ADMIN' as Role }
          : item
    );
    return json(state.members[slug])(route);
  });
  await page.route(orgPath('/profile'), detail(404, 'not_found', 'Organization not found.'));
  await page.route(orgPath('/presets'), json({ presets: [], total: 0, limit: 200, offset: 0 }));
  await page.route(`${API}/v1/engines`, json({ engines: [] }));
  await page.route(orgPath('/audit'), async route => {
    if (state.refuse.audit) return state.refuse.audit(route);
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const events = action ? auditEvents.filter(item => item.action === action) : auditEvents;
    return json({ events, total: events.length, offset: 0, limit: 50 })(route);
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

/** Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save a full-page picture of the current state for a person to look at. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
  if (process.env.E2E_SCREENSHOTS)
    await page.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
}

const request = (page: Page, method: string, path: string) =>
  page.waitForRequest(
    candidate => candidate.method() === method && candidate.url() === `${API}${path}`
  );

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(120_000);

const viewports = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    deviceScaleFactor: 1,
  },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S4a organizations`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('app-home /app', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/app');
      const main = page.locator('main');

      await expect(page.locator('header.app-header')).toBeVisible();
      await expect(
        main.getByRole('heading', { level: 1, name: 'Hello, lucia.vega' })
      ).toBeVisible();
      await expect(main.getByText('Pick up where you left off.')).toBeVisible();
      await expect(main.getByRole('link', { name: 'New problem' })).toHaveAttribute(
        'href',
        '/app/isa-demo/problems?create=problem'
      );
      await expect(main.getByRole('link', { name: 'New project' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'New organization' })).toHaveAttribute(
        'href',
        '/orgs/new'
      );

      const tree = main.getByRole('list', { name: 'Organizations' });
      await expect(tree.getByRole('link')).toHaveCount(5);
      await expect(
        tree.getByRole('link', { name: /Consultora Demo/ }).getByText('VIEWER')
      ).toBeVisible();
      await expect(tree.getByText('isa-demo · own role')).toBeVisible();
      await expect(tree.getByText('qos-lab · inherited role')).toBeVisible();
      await expect(tree.getByRole('link', { name: /QoS Lab/ }).getByText('OWNER')).toHaveAttribute(
        'title',
        'Inherited from ISA Demo Group'
      );

      const compositions = main.getByRole('region', { name: 'Recent compositions' });
      await expect(compositions.getByText(/^No compositions in .+ yet\.$/)).toBeVisible();
      await expect(
        compositions.getByRole('link', { name: /^All compositions of / })
      ).toHaveAttribute('href', /^\/app\/[^/]+\/compositions$/);
      await expect(main.getByRole('link', { name: 'New composition' })).toHaveAttribute(
        'href',
        /^\/app\/[^/]+\/compositions\?create=composition$/
      );
      const activity = main.getByRole('region', { name: 'Recent activity' });
      await expect(activity.getByText('Running')).toBeVisible();
      await expect(activity.getByText('No feasible binding')).toBeVisible();
      // The runs of the first organization, each opening in it, and the way to all of them; no account-wide run history.
      await expect(activity.getByRole('link', { name: /^All runs of / })).toHaveAttribute(
        'href',
        /^\/app\/[^/]+\/runs$/
      );
      const plan = main.getByRole('region', { name: 'Your plan' });
      await expect(plan.getByText('RESEARCH', { exact: true })).toBeVisible();
      await expect(plan.getByText('Up to 4')).toBeVisible();
      await expect(plan.getByRole('link', { name: 'SPACE' })).toHaveAttribute(
        'href',
        'https://space.score.us.es'
      );
      await expect(plan.getByRole('link', { name: 'SPHERE' })).toHaveAttribute(
        'href',
        'https://sphere.score.us.es'
      );
      await expect(main.getByRole('meter')).toHaveCount(0);
      await expect(main.getByText('Your OpenBinding agreement changed')).toBeVisible();
      await capture(page, testInfo, `home-${name}-success`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // A block that fails does not take the others with it, and can be asked again.
      state.refuse.jobs = unavailable;
      await page.reload();
      await expect(
        main.getByRole('region', { name: 'Recent activity' }).getByRole('alert')
      ).toContainText('Recent runs couldn’t be loaded (503). The other blocks are unaffected.');
      await expect(main.getByRole('list', { name: 'Organizations' }).getByRole('link')).toHaveCount(
        5
      );
      await expect(
        main.getByRole('region', { name: 'Your plan' }).getByText('RESEARCH', { exact: true })
      ).toBeVisible();
      await capture(page, testInfo, `home-${name}-activity-503`);
      state.refuse.jobs = undefined;
      await main
        .getByRole('region', { name: 'Recent activity' })
        .getByRole('button', { name: 'Retry' })
        .click();
      await expect(
        main.getByRole('region', { name: 'Recent activity' }).getByText('Running')
      ).toBeVisible();

      // The plan can be unavailable on its own too.
      state.refuse.usage = detail(503, 'pricing_unavailable', 'The plan cannot be read right now.');
      await page.reload();
      await expect(
        main.getByRole('region', { name: 'Your plan' }).getByRole('alert')
      ).toContainText('Your plan can’t be loaded right now (503 · pricing_unavailable).');
      state.refuse.usage = undefined;
      await main
        .getByRole('region', { name: 'Your plan' })
        .getByRole('button', { name: 'Retry' })
        .click();
      await expect(
        main.getByRole('region', { name: 'Your plan' }).getByText('RESEARCH', { exact: true })
      ).toBeVisible();

      const read = request(page, 'POST', '/v1/notifications/n1/read');
      await main.getByRole('button', { name: 'Mark as read' }).click();
      await read;
      await expect(main.getByText('You’re all caught up.')).toBeVisible();

      // No organizations: the first-organization guide, with the way to the wizard and to an invitation.
      state.organizations = [];
      state.jobs = { runs: [], total: 0 };
      await page.reload();
      await expect(
        main.getByRole('heading', { name: 'Create your first organization' })
      ).toBeVisible();
      await expect(main.getByRole('link', { name: 'Create organization' })).toHaveAttribute(
        'href',
        '/orgs/new'
      );
      await expect(main.getByRole('link', { name: 'I have an invitation' })).toHaveAttribute(
        'href',
        '/invitations/accept'
      );
      await expect(main.getByText('You’re not in any organization yet.')).toBeVisible();
      await expect(main.getByText(/No runs yet/)).toBeVisible();
      await capture(page, testInfo, `home-${name}-first-organization`);
      expect(critical).toEqual([]);
    });

    test('org-list /me/orgs and org-new /orgs/new', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/me/orgs');
      const main = page.locator('main');

      // SPHERE's tree: the top-level organizations, a branch opened on demand, the roles.
      await expect(main.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
      await expect(main.getByText('5 organizations')).toBeVisible();
      await expect(main.getByRole('link', { name: 'ISA Demo Group' })).toBeVisible();
      await main.getByRole('button', { name: 'Expand ISA Demo Group' }).click();
      await expect(main.getByRole('link', { name: /QoS Lab/ })).toBeVisible();
      await main.getByRole('textbox', { name: 'Search organizations' }).fill('research');
      await expect(main.getByRole('link', { name: 'Research Hub' })).toBeVisible();
      await expect(main.getByRole('link', { name: 'ISA Demo Group' })).toHaveCount(0);
      await main.getByRole('textbox', { name: 'Search organizations' }).fill('');
      await capture(page, testInfo, `orgs-${name}-tree`);

      // Moving from the row's menu: the phone's way, and the keyboard's.
      if (!isMobile) {
        await main.getByRole('button', { name: 'Move Partner Lab to…' }).click();
        const move = page.getByRole('dialog', { name: 'Move Partner Lab' });
        await move
          .getByRole('combobox', { name: 'New parent' })
          .selectOption({ label: 'Research Hub (@research-hub)' });
        const moved = request(page, 'PATCH', '/v1/organizations/partner-lab');
        await move.getByRole('button', { name: 'Move' }).click();
        expect((await moved).postDataJSON()).toEqual({ parent_id: 'org-4' });
        await expect(main.getByText('Partner Lab is now part of Research Hub.')).toBeVisible();
      }

      // A new organization, under a parent the account administers.
      await main.getByRole('link', { name: 'New organization' }).click();
      await expect(page).toHaveURL(/\/orgs\/new$/);
      await expect(main.getByRole('heading', { name: 'Create a new organization' })).toBeVisible();
      await main.getByLabel(/^Name/).fill('Distributed Systems Lab');
      await expect(main.getByText('distributed-systems-lab')).toBeVisible();
      await main.getByRole('button', { name: /Parent organization/ }).click();
      await expect(main.getByRole('option', { name: /Consultora Demo/ })).toHaveCount(0);
      await main.getByRole('option', { name: /ISA Demo Group/ }).click();
      await capture(page, testInfo, `create-${name}-page`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // The gateway's refusal of a taken name.
      const create = main.getByRole('button', { name: 'Create organization' });
      state.refuse.create = detail(409, 'slug_conflict', 'That organization slug is in use.');
      await create.click();
      await expect(main.getByRole('alert')).toContainText('That name is taken. Try another one.');

      // Created: the payload carries the parent, and the organization opens.
      state.refuse.create = undefined;
      const posted = request(page, 'POST', '/v1/organizations');
      await create.click();
      expect((await posted).postDataJSON()).toEqual({
        name: 'Distributed Systems Lab',
        parent_id: 'org-1',
      });
      await expect(page).toHaveURL(/\/orgs\/distributed-systems-lab$/);
      await expect(
        page.locator('main').getByRole('heading', { level: 1, name: 'Distributed Systems Lab' })
      ).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('org-detail /orgs/:org: the hero, its tabs and the hierarchy', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/orgs/isa-demo');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'ISA Demo Group' })).toBeVisible();
      await expect(main.getByText('@isa-demo')).toBeVisible();
      await expect(main.getByText('Owner', { exact: true }).first()).toBeVisible();
      await capture(page, testInfo, `org-${name}-overview`);

      // The tabs are in the address: a phone picks them from a select, a desktop from links.
      if (isMobile) {
        await main.getByRole('combobox', { name: 'Section' }).selectOption('hierarchy');
      } else {
        await main
          .getByRole('navigation', { name: 'Organization sections' })
          .getByRole('link', { name: 'Hierarchy' })
          .click();
      }
      await expect(page).toHaveURL(/\/orgs\/isa-demo\/hierarchy$/);
      const tree = main.getByRole('list', { name: 'Organization tree' });
      await expect(tree.getByText('(current)')).toBeVisible();
      await main.getByRole('button', { name: 'Expand ISA Demo Group' }).click();
      await expect(tree.getByRole('link', { name: /QoS Lab/ })).toHaveAttribute(
        'href',
        '/orgs/qos-lab'
      );
      await capture(page, testInfo, `org-${name}-hierarchy`);

      // A tab the address names but does not exist is the in-place 404.
      await page.goto('/orgs/isa-demo/settings');
      await expect(main.getByRole('heading', { name: /not found/i })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('org-detail members /orgs/:org/members', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const state = await mockApi(page);
      await page.goto('/orgs/isa-demo/members');
      const main = page.locator('main');
      const members = main.getByRole('region', { name: 'Members' });
      await expect(members.getByText('@marco')).toBeVisible();
      await capture(page, testInfo, `members-${name}`);
      if (isMobile) {
        expect(critical).toEqual([]);
        return;
      }

      // Drafted changes wait, then go together through the batch.
      await members.getByRole('combobox', { name: 'Role for marco' }).selectOption('ADMIN');
      await members.getByRole('button', { name: 'Remove sofia' }).click();
      await expect(main.getByText('2 member changes ready to save')).toBeVisible();
      const batch = request(page, 'POST', '/v1/organizations/isa-demo/members/batch');
      await members.getByRole('button', { name: 'Save changes' }).click();
      expect((await batch).postDataJSON()).toEqual({
        changes: [
          { user_id: 'user-marco', role: 'ADMIN' },
          { user_id: 'user-sofia', role: null },
        ],
      });
      await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
      await expect(members.getByText('@sofia')).toHaveCount(0);

      // A refused batch says so, and nothing changes.
      state.refuse.batch = detail(409, 'last_owner', 'At least one owner must remain.');
      await members.getByRole('combobox', { name: 'Role for marco' }).selectOption('VIEWER');
      await members.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByRole('alertdialog')).toContainText(
        'The organization keeps one owner (409 · last_owner)'
      );
      await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
      state.refuse.batch = undefined;

      // The crown hands the organization over.
      await members.getByRole('button', { name: 'Transfer ownership to marco' }).click();
      const owner = request(page, 'PUT', '/v1/organizations/isa-demo/owner');
      await page.getByRole('dialog').getByRole('button', { name: 'Transfer ownership' }).click();
      expect((await owner).postDataJSON()).toEqual({ user_id: 'user-marco' });
      expect(critical).toEqual([]);
    });

    test('org-detail invitations /orgs/:org/invitations', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/orgs/isa-demo/invitations');
      const main = page.locator('main');
      await expect(main.getByText('No invitations yet.')).toBeVisible();
      await main.getByRole('button', { name: 'Generate invite' }).click();
      const dialog = page.getByRole('dialog', { name: 'Invite members' });
      await dialog.getByLabel('Max uses (optional)').fill('5');
      const created = request(page, 'POST', '/v1/organizations/isa-demo/invitations');
      await dialog.getByRole('button', { name: 'Generate link' }).click();
      expect((await created).postDataJSON()).toEqual({ expires_in_days: 7, max_uses: 5 });
      await expect(dialog.getByText(/\/orgs\/join\/c0de1/)).toBeVisible();
      await capture(page, testInfo, `invite-${name}`);
      await page.keyboard.press('Escape');
      await expect(main.getByText('0 uses / 5')).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('org-detail audit /orgs/:org/audit', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/orgs/isa-demo/audit');
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 2, name: 'Audit log' })).toBeVisible();
      await expect(
        main.getByRole('list', { name: 'Audit events, newest first' }).getByRole('listitem')
      ).toHaveCount(4);
      await capture(page, testInfo, `audit-${name}`);
      expect(critical).toEqual([]);
    });
  });
}
