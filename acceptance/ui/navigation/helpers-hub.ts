import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { API, mockApi, organization, project, type MockOptions } from './helpers';

// Mock data, request trackers and locators of the Verify, language-hub and project-tab acceptance specs. There is no
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

/** The addresses the main frame went through (full loads and history changes), in order. */
export function trackAddresses(page: Page): string[] {
  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(new URL(frame.url()).pathname);
  });
  return seen;
}

export const address = (page: Page): string => { const url = new URL(page.url()); return url.pathname + url.search + url.hash; };

/** Waits until the address (path, query and hash) is exactly `expected`. */
export const expectAddress = (page: Page, expected: string) => expect.poll(() => address(page), { message: `address of ${page.url()}` }).toBe(expected);

/** The distinct paths of the resolve lookups (GET), whatever their number: React strict mode may send one twice. */
export const resolvePaths = (calls: Call[]): string[] => [...new Set(calls
  .filter((call) => call.method === 'GET' && call.path.startsWith('/v1/resolve/') && !call.path.endsWith('/content'))
  .map((call) => call.path))];

export const verifierCalls = (calls: Call[]): Call[] => calls.filter((call) => call.path.startsWith('/v1/verifier/'));
export const resourceCalls = (calls: Call[]): Call[] => calls.filter((call) => call.path.startsWith('/v1/resources'));

// ---- Verify ---------------------------------------------------------------------------------------------------

/** `D` of the scenarios: `sha256-` and 64 times the digit 1. */
export const D = `sha256-${'1'.repeat(64)}`;

export const KINDS = [
  'case-revision', 'resource-revision', 'collection-revision', 'report', 'artifact', 'engine', 'dialect',
  'registered-resource', 'instance-snapshot', 'binding-ir',
];

export const PUBLISHED_TITLE = 'Engine comparison';
export const MATCH_TITLE = 'Routing matches';
/** In the canonical JSON the verifier answers with; it is not in the pasted document. */
export const CANONICAL_MARK = 'canonical-marker-7';
/** In the pasted document and the uploaded file. */
export const DOCUMENT_MARK = 'pasted-marker-3';
export const DOCUMENT = { name: DOCUMENT_MARK, version: 1 };

export interface VerifyMockOptions extends MockOptions {
  /** `found` (default), `missing` (404) or `private` (404 for an element the visitor may not read). */
  resolve?: 'found' | 'missing' | 'private';
}

const inspected = (digest: string) => ({
  status: 'verified', digest, matches: true, verified_at: NOW, detail: null,
  canonical_json: JSON.stringify({ canonical: CANONICAL_MARK }, null, 2), citation: null,
  entities: [{
    entity_type: 'case_revision', id: 'entity-1', title_or_name: MATCH_TITLE, organization_slug: 'acme', project_slug: 'demo',
    slug: 'routing', revision: 2, created_at: NOW,
  }],
});

/** The gateway as the Verify page uses it: the resolver (public) and the verifier. */
export async function mockVerify(page: Page, options: VerifyMockOptions = {}): Promise<Call[]> {
  const calls = trackCalls(page);
  await mockApi(page, options);
  await page.route((url) => url.origin === API && url.pathname.startsWith('/v1/resolve/'), (route) => {
    const [, , , kind = 'report', digest = D] = new URL(route.request().url()).pathname.split('/');
    if (options.resolve === 'missing' || options.resolve === 'private') {
      return route.fulfill({
        status: 404, contentType: 'application/problem+json',
        json: { type: 'about:blank', title: 'Not Found', status: 404, detail: options.resolve === 'private' ? 'The element is private' : 'No element has this digest' },
      });
    }
    return route.fulfill({
      json: {
        verified: true, kind, digest, content_url: `/v1/resolve/${kind}/${digest}/content`, media_type: 'application/json',
        canonical_name: PUBLISHED_TITLE, created_at: NOW, size_bytes: 128, author: null, locations: [],
        document: { title: PUBLISHED_TITLE, name: PUBLISHED_TITLE },
        citation: {
          title: PUBLISHED_TITLE, authors: ['Lucia'], bibtex: `@misc{${PUBLISHED_TITLE}}`, markdown_badge: '[badge](x)',
          doi: null, url: `/resolve/${kind}/${digest}`, venue: null, year: 2026,
        },
        pagination: { total: 0, limit: 20, offset: 0, has_more: false },
      },
    });
  });
  await page.route(`${API}/v1/verifier/inspect`, (route) => {
    const body = route.request().postDataJSON() as { digest?: string | null } | null;
    return route.fulfill({ json: inspected(body?.digest ?? D) });
  });
  await page.route(`${API}/v1/verifier/inspect-file`, json(inspected(D)));
  return calls;
}

// ---- Verify locators ------------------------------------------------------------------------------------------

const content = (page: Page): Locator => page.locator('main').first();

/** A mode control of the Verify form: a tab, a radio or a button. */
export const mode = (page: Page, name: string): Locator => {
  const scope = content(page);
  return scope.getByRole('tab', { name, exact: true })
    .or(scope.getByRole('radio', { name, exact: true }))
    .or(scope.getByRole('button', { name, exact: true })).first();
};

/** The field that takes a permanent link or a digest. */
export const linkField = (page: Page): Locator => content(page).getByRole('textbox').first();

/** The field that takes a pasted document. */
export const documentField = (page: Page): Locator => content(page).locator('textarea').first();

/** The button that submits the form of the current mode. */
export const submitButton = (page: Page): Locator => content(page)
  .getByRole('button', { name: /check|verify|inspect|look ?up|resolve|submit|search|open/i }).last();

/** The value of every field of the page. */
export const fieldValues = (page: Page): Promise<string[]> => page.locator('input, textarea, select').evaluateAll(
  (elements) => elements.map((element) => (element as HTMLInputElement).value),
);

/** Chooses a resolver kind in the kind selector (native or ARIA combobox). */
export async function chooseKind(page: Page, kind: string): Promise<void> {
  const selector = page.getByRole('combobox', { name: /kind/i }).first();
  await expect(selector).toBeVisible();
  const isSelect = await selector.evaluate((element) => element.tagName === 'SELECT');
  const words = [kind, kind.replace(/-/g, ' '), ...(kind === 'case-revision' ? ['problem version'] : [])];
  if (isSelect) {
    const value = await selector.evaluate((element, wanted) => {
      const options = Array.from((element as HTMLSelectElement).options);
      const found = options.find((option) => option.value === wanted[0])
        ?? options.find((option) => wanted.includes((option.textContent ?? '').trim().toLowerCase()));
      return found?.value ?? null;
    }, words);
    expect(value, `an option for ${kind}`).not.toBeNull();
    await selector.selectOption({ value: value! });
    return;
  }
  await selector.click();
  await page.getByRole('option', { name: new RegExp(`^(${words.join('|')})$`, 'i') }).first().click();
}

/** The `pre` elements of the page that are not inside a named region holding a `Copy <label>` button. */
export const rawPres = (page: Page): Promise<string[]> => page.evaluate(() => {
  const nameOf = (element: Element): string => {
    const label = element.getAttribute('aria-label');
    if (label) return label.trim();
    const by = element.getAttribute('aria-labelledby');
    return by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim() : '';
  };
  const offenders: string[] = [];
  document.querySelectorAll('pre').forEach((pre, index) => {
    let node = pre.parentElement;
    while (node) {
      const role = node.getAttribute('role');
      if ((role === 'region' || (!role && node.tagName === 'SECTION')) && nameOf(node)) break;
      node = node.parentElement;
    }
    const label = node ? nameOf(node) : '';
    const copy = node ? Array.from(node.querySelectorAll('button')).some((button) => {
      const text = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
      return text === `Copy ${label}`;
    }) : false;
    if (!node || !copy) offenders.push(`pre #${index + 1}: ${(pre.textContent ?? '').slice(0, 40)}`);
  });
  return offenders;
});

/** What the page stores about where the person was: web storage and the history state, as one string. */
export const storedState = (page: Page): Promise<string> => page.evaluate(() => JSON.stringify({
  local: { ...localStorage }, session: { ...sessionStorage }, history: history.state,
}));

// ---- language hub ---------------------------------------------------------------------------------------------

/** The gateway as the Language hub uses it, with empty profile and dialect catalogues. */
export async function mockLanguage(page: Page, options: MockOptions = {}): Promise<Call[]> {
  const calls = trackCalls(page);
  await mockApi(page, options);
  await answer(page, '/v1/profiles', { profiles: [] });
  await answer(page, '/v1/dialects', { dialects: [] });
  await answer(page, '/v1/resources', { resources: [] });
  await page.route((url) => url.origin === API && url.pathname.startsWith('/v1/schemas/'), (route) => {
    const kind = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? 'Application');
    return route.fulfill({ json: { $schema: 'https://json-schema.org/draft/2020-12/schema', title: kind, type: 'object', properties: {} } });
  });
  return calls;
}

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

export const PROJECT_TABS = ['Overview', 'Problems', 'Collections', 'Runs', 'Studies', 'Published', 'Settings'];
export const VISITOR_TABS = ['Overview', 'Problems', 'Collections', 'Studies', 'Published'];

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
  for (const list of ['cases', 'jobs', 'collections', 'studies', 'publications', 'reports']) {
    await answer(page, `/v1/organizations/acme/projects/demo/${list}`, []);
  }
  await page.route(`${ROOT}/package**`, (route) => (route.request().method() === 'POST'
    ? route.fulfill({ json: { imported: true } })
    : route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK\u0005\u0006') })));
  return calls;
}

/** The project tabs: the navigation that holds all the given labels (the seven of a member by default). */
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
