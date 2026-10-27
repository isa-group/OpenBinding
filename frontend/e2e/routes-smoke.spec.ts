import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Visits every screen of the route registry (src/routes/d1.tsx .. d8.tsx) with example parameter values.
// There is no backend: the API origin is answered by page.route(), signed in only for /app screens.

const API = 'http://localhost:8000';
const DOMAIN_FILES = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];

interface Screen {
  id: string;
  path: string;
  requireAdmin: boolean;
  domain: string;
}

/** Reads `live('id', '/path', …)` lines from the domain files. */
function readRegistry(): Screen[] {
  return DOMAIN_FILES.flatMap((domain) => {
    const source = readFileSync(new URL(`../src/routes/${domain}.tsx`, import.meta.url), 'utf8');
    return [...source.matchAll(/^\s*live\('([a-z0-9-]+)',\s*'(\/[^']*)'(.*)$/gm)].map((match) => ({
      id: match[1],
      path: match[2],
      requireAdmin: match[3].includes('requireAdmin: true'),
      domain: domain.toUpperCase(),
    }));
  });
}

const screens = readRegistry();

const exampleUrl = (path: string) => path
  .replace(':org', 'isa-demo')
  .replace(':project', 'qos')
  .replace(/:[A-Za-z]+/g, 'sample');

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

test.describe('route registry', () => {
  test('lists all 69 screens of the prototype', () => {
    expect(screens).toHaveLength(69);
    expect(new Set(screens.map((screen) => screen.id)).size).toBe(69);
    expect(new Set(screens.map((screen) => screen.path)).size).toBe(69);
    expect(screens.filter((screen) => screen.requireAdmin).every((screen) => screen.id.startsWith('admin-'))).toBe(true);
  });
});

// One worker: every page is light (the API is a mock), and eight browsers asking one development server for the same cold
// modules at once is slower and flakier than one after another (69 pages take about a minute and a half in turn).
test.describe.configure({ mode: 'serial' });

for (const screen of screens) {
  test(`${screen.domain} ${screen.id} ${screen.path} loads`, async ({ page }) => {
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
  });
}
