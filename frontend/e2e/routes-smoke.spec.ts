import { expect, test, type Page } from '@playwright/test';
import { countLiveCalls, dropOptionalSegments, readAreaSources, readMovedAddresses } from './helpers/galleryRoutes';

// Visits every screen of the route registry (src/routes/areas/*.tsx) with example parameter values, and every moved address
// (`moved('id', '/from', '/to'…` lines of the same files) to see that it ends on its new address.
// There is no backend: the API origin is answered by page.route(), signed in only for /app screens.

const API = 'http://localhost:8000';

interface Screen {
  id: string;
  path: string;
  requireAdmin: boolean;
  area: string;
}

/** Reads `live('id', '/path', …)` lines from the area files. */
function readRegistry(): Screen[] {
  return readAreaSources().flatMap(({ area, source }) => [...source.matchAll(/^\s*live\('([a-z0-9-]+)',\s*'(\/[^']*)'(.*)$/gm)].map((match) => ({
    id: match[1],
    path: match[2],
    requireAdmin: match[3].includes('requireAdmin: true'),
    area,
  })));
}

const screens = readRegistry();
const movedAddresses = readMovedAddresses();

/** The base address of a pattern: an optional segment (`:section?`) is dropped with its slash before the parameters are filled. */
const exampleUrl = (path: string) => dropOptionalSegments(path)
  .replace(':org', 'isa-demo')
  .replace(':project', 'qos')
  .replace(/:[A-Za-z]+/g, 'sample');

/** Example values for a moved address: the organization and the project the mock knows, every other parameter its own name. */
const namedUrl = (path: string) => dropOptionalSegments(path)
  .replace(':org', 'isa-demo')
  .replace(':project', 'qos')
  .replace(/:([A-Za-z]+)/g, '$1');

const account = (role: 'user' | 'admin') => ({
  id: 'smoke-user-id',
  username: 'lucia',
  email: 'lucia@example.org',
  role,
  is_active: true,
  plan: 'FREE',
  created_at: '2026-09-01T00:00:00Z',
});

const organization = {
  id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null,
  billing_sponsor_user_id: 'smoke-user-id', effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z',
};

const project = {
  id: 'project-1', organization_id: 'org-1', slug: 'qos', name: 'QoS Benchmarks', description: 'Smoke project',
  visibility: 'private', created_by_id: 'smoke-user-id', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  access: 'member', effective_role: 'OWNER',
};

async function mockApi(page: Page, role: 'user' | 'admin' | null) {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  if (!role) return;
  await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 'routes-smoke-token'));
  await page.route(`${API}/v1/users/me`, (route) => route.fulfill({ json: account(role) }));
  await page.route(`${API}/v1/users/me/pricing-token`, (route) => route.fulfill({ json: { pricing_token: 'smoke-token' } }));
  await page.route(`${API}/v1/organizations`, (route) => route.fulfill({ json: [organization] }));
  await page.route(`${API}/v1/organizations/isa-demo/projects`, (route) => route.fulfill({ json: [project] }));
  await page.route(`${API}/v1/notifications**`, (route) => route.fulfill({ json: [] }));
}

/**
 * Uncaught exceptions and React error reports are critical. Failed requests are not:
 * the API is not there, and a screen that reports it is behaving.
 */
function watchCriticalErrors(page: Page) {
  const critical: string[] = [];
  page.on('pageerror', (error) => {
    if (!/not mocked/i.test(error.message)) critical.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|net::ERR_|not mocked/i.test(text)) return;
    // What the error boundary reports (“A screen failed to render”) is critical too, with the error it caught.
    if (/The above error occurred|Minified React error|Maximum update depth|Uncaught|A screen failed to render/i.test(text)) critical.push(`console: ${text.slice(0, 400)}`);
  });
  return critical;
}

/** The screens whose text may say `publication`: the engine registration, where it is the step that publishes an engine (design.md §11.18). */
const PUBLICATION_SCREENS = new Set(['eng-register', 'eng-registrations', 'eng-registration-detail']);

const FORBIDDEN_WORDS = /\b(?:jobs?|cases?)\b/gi;
const FORBIDDEN_PUBLICATION = /\bpublications?\b/gi;

/**
 * The visible text of the page, one entry per text node, leaving out what the vocabulary rule excludes: `code` elements and the
 * `SourceView` and `LogPanel` regions (and the scripts, styles and hidden parts nobody sees).
 */
async function visibleTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const skipped = 'code, pre, script, style, noscript, .rendering-source, .rendering-log';
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!parent || !text || parent.closest(skipped) || !parent.checkVisibility()) continue;
      texts.push(text);
    }
    return texts;
  });
}

/** The words of the vocabulary rule found in `texts`, each with the text node that holds it. */
function forbiddenIn(screenId: string, texts: string[]): string[] {
  const patterns = PUBLICATION_SCREENS.has(screenId) ? [FORBIDDEN_WORDS] : [FORBIDDEN_WORDS, FORBIDDEN_PUBLICATION];
  return texts.flatMap((text) => patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => `"${match[0]}" in "${text.slice(0, 120)}"`)));
}

/** A route pattern (`/app/:org/:project/problems/:case/:tab?`) as a regular expression over a pathname. */
function patternRegex(pattern: string): RegExp {
  const segments = pattern.split('/').filter(Boolean).map((segment) => {
    if (!segment.startsWith(':')) return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    return segment.endsWith('?') ? '(?:/[^/]+)?' : '/[^/]+';
  });
  return new RegExp(`^${segments.join('')}/?$`);
}

const screenPatterns = screens.map((screen) => patternRegex(screen.path));
const isScreenAddress = (pathname: string) => screenPatterns.some((pattern) => pattern.test(pathname));

test.describe('route registry', () => {
  test('lists every screen of the area files, each with its own id and path', () => {
    expect(screens.length).toBeGreaterThan(0);
    expect(screens).toHaveLength(countLiveCalls());
    expect(new Set(screens.map((screen) => screen.id)).size).toBe(screens.length);
    expect(new Set(screens.map((screen) => screen.path)).size).toBe(screens.length);
    expect(screens.filter((screen) => screen.requireAdmin).every((screen) => screen.id.startsWith('admin-'))).toBe(true);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  test('rejects the six words, whatever their letter case, except the engine registration publication text', () => {
    expect(forbiddenIn('job-list', ['Jobs', 'my case', 'Cases and JOB'])).toHaveLength(4);
    expect(forbiddenIn('pub-home', ['Publications and public projects'])).toEqual(['"Publications" in "Publications and public projects"']);
    expect(forbiddenIn('proj-publications', ['A publication'])).toHaveLength(1);
    expect(forbiddenIn('eng-registration-detail', ['Publication', 'Request publication'])).toEqual([]);
    expect(forbiddenIn('eng-registration-detail', ['Jobs'])).toHaveLength(1);
    expect(forbiddenIn('case-list', ['Problems', 'showcase', 'Runs', 'Published'])).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  test('knows which pathnames are screens of the registry', () => {
    expect(isScreenAddress('/app/isa-demo/qos/problems/checkout')).toBe(true);
    expect(isScreenAddress('/app/runs')).toBe(true);
    expect(isScreenAddress('/explore')).toBe(true);
    expect(isScreenAddress('/')).toBe(true);
    expect(isScreenAddress('/app/isa-demo/qos/cases/checkout/compare')).toBe(false);
    expect(isScreenAddress('/no-such-screen')).toBe(false);
  });
});

// One worker: every page is light (the API is a mock), and eight browsers asking one development server for the same cold
// modules at once is slower and flakier than one after another (the pages take a minute or two in turn).
test.describe.configure({ mode: 'serial' });

for (const screen of screens) {
  test(`${screen.area} ${screen.id} ${screen.path} loads`, async ({ page }) => {
    test.setTimeout(90_000);
    const underApp = screen.path === '/app' || screen.path.startsWith('/app/');
    const critical = watchCriticalErrors(page);
    await mockApi(page, underApp ? (screen.requireAdmin ? 'admin' : 'user') : null);

    await page.goto(exampleUrl(screen.path), { waitUntil: 'domcontentloaded' });

    // Both layouts render a header; app screens render the application header.
    await expect(page.locator(underApp ? 'header.app-header' : 'header.site-header')).toBeVisible({ timeout: 30_000 });
    // A detail page whose entity cannot be loaded (the mocked API answers 404) reports it instead of showing a heading.
    const heading = page.locator('main').getByRole('heading').or(page.getByText('HTTP 404: not mocked')).first();
    await expect(heading, `${screen.path} should show a heading or the API error`).toBeVisible({ timeout: 30_000 });

    // No screen is a placeholder any more, and none may have fallen into the error boundary (the message says what it caught).
    await expect(page.getByText('This screen is being rebuilt')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Something went wrong' }), `${screen.path} fell into the error boundary: ${critical.join(' || ')}`).toHaveCount(0);

    // A signed-in session is never bounced to the sign-in page, and nothing blew up.
    if (underApp) expect(new URL(page.url()).pathname).not.toBe('/login');
    expect(critical, `${screen.path} should not raise critical console errors`).toEqual([]);

    // The vocabulary of the interface: Problem and Run, never case or job (nor publication outside the engine registration).
    // [utest->req~frontend-nav-vocabulary-text~1]
    expect(forbiddenIn(screen.id, await visibleTexts(page)), `${screen.id} (${screen.path}) shows words the vocabulary rules out`).toEqual([]);
  });
}

for (const address of movedAddresses) {
  test(`${address.area} moved ${address.id} ${address.from} -> ${address.to}`, async ({ page }) => {
    test.setTimeout(90_000);
    const isApp = (path: string) => path === '/app' || path.startsWith('/app/');
    const admin = /^\/app\/admin(\/|$)/.test(address.to);
    await mockApi(page, isApp(address.from) || isApp(address.to) ? (admin ? 'admin' : 'user') : null);

    const start = namedUrl(address.from);
    await page.goto(start, { waitUntil: 'domcontentloaded' });

    if (address.customTarget) {
      // The target is computed: only the old address has to be left behind.
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).not.toBe(new URL(start, 'http://localhost').pathname);
      await expect.poll(() => isScreenAddress(new URL(page.url()).pathname), { message: `${address.id} should land on a screen of the registry`, timeout: 30_000 }).toBe(true);
      return;
    }
    // The old address is replaced by the new one, each parameter keeping its own value.
    const expected = new URL(namedUrl(address.to), 'http://localhost');
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe(expected.pathname);
    if (expected.search) expect(new URL(page.url()).search).toContain(expected.search);
    // And the new address is a screen of the registry, not a missing page.
    expect(isScreenAddress(expected.pathname), `${address.id} leads to ${expected.pathname}, which no screen of the registry has`).toBe(true);
  });
}
