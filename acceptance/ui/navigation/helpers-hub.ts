import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { API, mockApi, organization, project, type MockOptions } from './helpers';

// Mock data, request trackers and locators of the project-tab acceptance specs. There is no
// backend: the API origin is answered by page.route(); routes added here win over the catch-all of mockApi() because
// they are registered later.

const NOW = '2026-09-01T00:00:00Z';
const ROOT = `${API}/v1/organizations/acme/projects/demo`;

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

/** Answers the exact API path (query ignored). */
async function answer(page: Page, path: string, body: unknown, status = 200): Promise<void> {
  await page.route((url) => url.origin + url.pathname === `${API}${path}`, json(body, status));
}

// ---- requests and addresses -----------------------------------------------------------------------------------

export interface Call {
  method: string;
  path: string;
  search: string;
  body: string;
}

/** Every request to the API origin the page sends, in order. Call it before the first navigation. */
export function trackCalls(page: Page): Call[] {
  const seen: Call[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(API)) return;
    const url = new URL(request.url());
    seen.push({ method: request.method(), path: url.pathname, search: url.search, body: request.postData() ?? '' });
  });
  return seen;
}

export const address = (page: Page): string => { const url = new URL(page.url()); return url.pathname + url.search + url.hash; };

/** Waits until the address (path, query and hash) is exactly `expected`. */
export const expectAddress = (page: Page, expected: string) => expect.poll(() => address(page), { message: `address of ${page.url()}` }).toBe(expected);

/** The navigation (links or tabs) that holds all the given labels: a hub, a settings page. */
export const sectionNav = (page: Page, labels: string[]): Locator => {
  let group = page.locator('nav, [role="tablist"]');
  for (const label of labels) group = group.filter({ has: page.getByText(label, { exact: true }) });
  return group.last();
};

/** The entry `name` of a navigation, found as a link, a tab or a button. */
export const navEntry = (group: Locator, name: string): Locator => group.getByRole('link', { name, exact: true })
  .or(group.getByRole('tab', { name, exact: true })).or(group.getByRole('button', { name, exact: true })).first();

/** The entry `name` of a navigation that is marked as the current one. */
export const isCurrent = (group: Locator, name: string): Locator => group
  .locator('[aria-current="page"]')
  .filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).first();

// ---- project --------------------------------------------------------------------------------------------------

export const PROJECT_TABS = ['Overview', 'Problems', 'Runs', 'Studies', 'Settings'];
export const VISITOR_TABS = ['Overview', 'Problems', 'Studies'];

export interface ProjectMockOptions extends MockOptions {
  /** A signed-in person who only reads the public project `demo` of `acme` (access `public_read`). */
  visitor?: boolean;
}

const orgMembers = [
  { id: 'm1', organization_id: 'org-acme', user_id: 'user-1', username: 'lucia', email: 'lucia@example.org', role: 'OWNER', created_at: NOW },
  { id: 'm2', organization_id: 'org-acme', user_id: 'user-2', username: 'tomas', email: 'tomas@example.org', role: 'MEMBER', created_at: NOW },
];

export const MEMBER_NAMES = ['lucia', 'tomas'];

/** The project `demo` of `acme` with empty lists and a package endpoint; returns every request to the API origin. */
export async function mockProject(page: Page, options: ProjectMockOptions = {}): Promise<Call[]> {
  const visitor = options.visitor === true;
  const calls = trackCalls(page);
  const publicProject = { ...project('demo', 'Demo'), visibility: 'public', access: 'public_read', effective_role: null };
  await mockApi(page, visitor ? { ...options, projects: [publicProject] } : options);
  if (visitor) {
    const reader = { ...organization('acme', 'Acme'), effective_role: null };
    await answer(page, '/v1/organizations/acme/projects/demo', publicProject);
    await answer(page, '/v1/organizations/acme', reader);
    await answer(page, '/v1/organizations', [reader]);
    await answer(page, '/v1/organizations/acme/members', []);
  } else {
    await answer(page, '/v1/organizations/acme/members', orgMembers);
  }
  for (const list of ['cases', 'jobs', 'studies']) {
    await answer(page, `/v1/organizations/acme/projects/demo/${list}`, []);
  }
  await page.route(`${ROOT}/package**`, (route) => (route.request().method() === 'POST'
    ? route.fulfill({ json: { imported: true } })
    : route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK\u0005\u0006') })));
  return calls;
}

/** The project tabs: the navigation that holds all the given labels (the six of a member by default). */
export const projectTabs = (page: Page, labels: string[] = PROJECT_TABS): Locator => sectionNav(page, labels);

export const packageCalls = (calls: Call[]): Call[] => calls.filter((call) => call.path === '/v1/organizations/acme/projects/demo/package');

/** Exports the package as ZIP: a ZIP button or link, or a format selector plus an export button. */
export async function exportZip(page: Page): Promise<void> {
  // The section headed `Export package`; the whole page when the section is not a landmark or a fieldset.
  const section = page.locator('section, [role="region"], fieldset, article')
    .filter({ has: page.getByRole('heading', { name: 'Export package' }) })
    .filter({ hasNot: page.getByRole('heading', { name: 'Import package' }) }).last();
  const scope = (await section.count()) ? section : page.locator('body');
  const zip = scope.getByRole('button', { name: /zip/i }).or(scope.getByRole('link', { name: /zip/i })).first();
  if (await zip.count()) {
    await zip.click();
    return;
  }
  await scope.getByRole('combobox', { name: /format/i }).first().selectOption({ value: 'zip' });
  await scope.getByRole('button', { name: /export/i }).first().click();
}

/** Imports a ZIP through the file input, then starts the import when the page asks for it. */
export async function importZip(page: Page): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'package.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0005\u0006') });
  const start = page.getByRole('button', { name: /^(import|upload|start)/i }).first();
  if (await start.count()) await start.click();
}
