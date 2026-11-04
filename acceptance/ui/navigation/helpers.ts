import { expect, type Locator, type Page, type Route } from '@playwright/test';

// Shared helpers of the m26-navigation acceptance specs. There is no backend: the API origin is answered by page.route().

export const API = 'http://localhost:8000';

export type Role = 'user' | 'admin';

export interface Recorded {
  method: string;
  path: string;
  search: string;
  body: string;
}

export interface MockOptions {
  /** null: no session. */
  role?: Role | null;
  /** The projects of `acme`; defaults to the project `demo`. */
  projects?: unknown[];
  /** Every dependency up (default), or a gateway that does not answer. */
  gateway?: 'up' | 'down';
}

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

const NOW = '2026-09-01T00:00:00Z';

const account = (role: Role) => ({
  id: 'user-1', username: 'lucia', email: 'lucia@example.org', role, is_active: true, plan: 'RESEARCH', created_at: NOW,
});

export const organization = (slug: string, name: string) => ({
  id: `org-${slug}`, slug, name, parent_id: null, billing_sponsor_user_id: 'user-1', effective_role: 'OWNER', created_at: NOW,
});

export const project = (slug: string, name: string) => ({
  id: `project-${slug}`, organization_id: 'org-acme', slug, name, description: '', visibility: 'private',
  created_by_id: 'user-1', created_at: NOW, updated_at: NOW, access: 'member', effective_role: 'OWNER',
});

const members = [
  { id: 'm1', organization_id: 'org-acme', user_id: 'user-1', username: 'lucia', email: 'lucia@example.org', role: 'OWNER', created_at: NOW },
];

// Slices 13 and 14 renamed the app address segments to `problems` and `runs`; the HTTP API keeps `cases` and `jobs`.
export const PROBLEMS_SEGMENT = 'problems';
export const RUNS_SEGMENT = 'runs';
export const PROBLEMS = `/app/acme/demo/${PROBLEMS_SEGMENT}`;
export const RUN_NEW = `/app/acme/demo/${RUNS_SEGMENT}/new`;
export const RUNS_ALL = `/app/${RUNS_SEGMENT}`;

export const EXAMPLES =['demo/01_simple_seq', 'demo/02_parallel', 'placement/01_small_placement'];

/**
 * Answers the API origin: the user, the organization `acme` with its project `demo`, notifications and the few public
 * lists the screens read. Anything else is a 404 `not mocked`. Returns the non-GET requests that reached it.
 */
export async function mockApi(page: Page, options: MockOptions = {}): Promise<Recorded[]> {
  const role = options.role === undefined ? 'user' : options.role;
  const requests: Recorded[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(API) || request.method() === 'GET') return;
    const url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname, search: url.search, body: request.postData() ?? '' });
  });

  await page.route(`${API}/**`, json({ detail: 'not mocked' }, 404));
  await page.route(`${API}/v1/examples`, json({ examples: EXAMPLES }));
  await page.route(`${API}/v1/profiles`, json({ profiles: [{ id: 'qos-binding/v1' }] }));
  await page.route(`${API}/v1/dialects`, json({ dialects: [{ id: 'qos-binding' }] }));
  await page.route(`${API}/v1/explore/projects`, json({ projects: [], pagination: { total: 0, limit: 20, offset: 0, has_more: false } }));
  await page.route(`${API}/v1/explore/engines`, json({ engines: [] }));
  await page.route(`${API}/v1/explore/publications`, json({ publications: [], pagination: { total: 0, limit: 20, offset: 0, has_more: false } }));
  await page.route(`${API}/v1/engines`, json({ engines: [] }));
  if (options.gateway === 'down') {
    for (const path of ['/health', '/health/live', '/health/ready']) await page.route(`${API}${path}`, (route) => route.abort('connectionrefused'));
  } else {
    await page.route(`${API}/health`, json({ status: 'ok' }));
    await page.route(`${API}/health/live`, json({ status: 'ok' }));
    await page.route(`${API}/health/ready`, json({ status: 'ready', dependencies: { database: 'ok', redis: 'not-required', sphere: 'configured', space: 'configured' } }));
  }
  if (!role) return requests;

  await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 'navigation-token'));
  await page.route(`${API}/v1/users/me`, json(account(role)));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: 'navigation-pricing' }));
  await page.route(`${API}/v1/notifications**`, json([]));
  await page.route(`${API}/v1/organizations`, (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 201, json: organization('lab-two', 'lab-two') })
    : route.fulfill({ json: [organization('acme', 'Acme')] })));
  await page.route(`${API}/v1/organizations/acme`, json(organization('acme', 'Acme')));
  await page.route(`${API}/v1/organizations/lab-two`, json(organization('lab-two', 'lab-two')));
  await page.route(`${API}/v1/organizations/acme/projects/demo-two`, json(project('demo-two', 'demo-two')));
  await page.route(`${API}/v1/organizations/acme/members`, json(members));
  await page.route(`${API}/v1/organizations/acme/projects`, (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 201, json: project('demo-two', 'demo-two') })
    : route.fulfill({ json: options.projects ?? [project('demo', 'Demo')] })));
  await page.route(`${API}/v1/organizations/acme/projects/demo`, json(project('demo', 'Demo')));
  return requests;
}

/** A link or a menu item of a scope, by exact accessible name. */
export const entry = (scope: Locator | Page, name: string): Locator => scope.getByRole('link', { name, exact: true })
  .or(scope.getByRole('menuitem', { name, exact: true })).first();

/** The places an opened header menu lives in: the header itself or an element with the role `menu`. */
export const menuScope = (page: Page): Locator => page.getByRole('banner').or(page.getByRole('menu')).or(page.getByRole('dialog'));

/** The link `name` that is marked as the current page. */
export const current = (page: Page, name: string): Locator => page.getByRole('link', { name, exact: true })
  .and(page.locator('[aria-current="page"]')).first();

/** Asserts that the locators appear one after another on the screen, left to right or top to bottom. */
export async function expectInOrder(locators: Locator[]): Promise<void> {
  const boxes = [];
  for (const locator of locators) {
    await expect(locator).toBeVisible();
    boxes.push(await locator.boundingBox());
  }
  for (let i = 1; i < boxes.length; i += 1) {
    const before = boxes[i - 1]!;
    const after = boxes[i]!;
    const later = Math.abs(after.y - before.y) > 8 ? after.y > before.y : after.x > before.x;
    expect(later, `entry ${i + 1} should come after entry ${i}`).toBe(true);
  }
}

export const pathOf = (page: Page) => new URL(page.url()).pathname;
export const pathAndSearch = (page: Page) => { const url = new URL(page.url()); return url.pathname + url.search; };
