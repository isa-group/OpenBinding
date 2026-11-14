import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { usageOf } from '../src/test/fixtures/resources';
import { RUN_ID, cellsFixture, runFixture, studyFixture } from '../src/test/fixtures/studies';

// S7b · the redirect of the retired analysis addresses.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath() (test-results/, ignored by git)
// so they can be looked at after a run. Every test walks a screen through its states on a desktop and on a phone.

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Handler => json(failureBody(status, code, error, extra), status);

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

const org = (id: string, slug: string, name: string, role: Role, sponsor = 'user-1') => ({
  id, slug, name, parent_id: null, billing_sponsor_user_id: sponsor, effective_role: role, created_at: '2026-03-03T00:00:00Z',
});

const project = (n: number, orgId: string, slug: string, name: string) => ({
  id: `project-${n}`, organization_id: orgId, slug, name, description: '', visibility: 'private', created_by_id: 'user-1',
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z',
  // The contract's `ProjectView.access`: these specs reach every project as a member.
  access: 'member' as const, effective_role: 'OWNER' as Role,
});

const projectsOf: Record<string, ReturnType<typeof project>[]> = {
  'isa-demo': [project(1, 'org-isa-demo', 'qos-benchmarks', 'QoS Benchmarks'), project(2, 'org-isa-demo', 'checkout-privado', 'Checkout (privado)')],
  'read-lab': [project(4, 'org-4', 'bench', 'Bench')],
};

// --- what the gateway answers

interface MockOptions {
  /** The account's role in ISA Demo Group. */
  role?: Role;
}

/** Everything these screens read and write, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, options: MockOptions = {}): Promise<void> {
  const organizations = [
    org('org-isa-demo', 'isa-demo', 'ISA Demo Group', options.role ?? 'OWNER'),
    org('org-4', 'read-lab', 'Read Lab', 'VIEWER', 'user-nora'),
  ];
  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 's7b-access');
    localStorage.setItem('openbinding-refresh-token', 's7b-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 's7b-access-2', refresh_token: 's7b-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json(lucia));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf({ plan: 'RESEARCH', capabilities: {} })));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(`${API}/v1/engines`, json({ engines: [] }));

  // --- projects and studies
  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , orgSlug, section, projectSlug, sub, subId, action] = parts;
    const found = organizations.find((item) => item.slug === orgSlug);

    if (!orgSlug) return json(organizations)(route);
    if (section === 'members' || section === 'library') return json([])(route);
    if (section !== 'projects') return json(found ?? { detail: { code: 'not_found', error: 'Organization not found.' } }, found ? 200 : 404)(route);

    const list = projectsOf[orgSlug] ?? [];
    if (!projectSlug) return json(list)(route);
    const current = list.find((item) => item.slug === projectSlug);
    if (!current) return detail(404, 'not_found', 'Project not found.')(route);
    if (!sub) return json(current)(route);
    const empty = projectSlug === 'checkout-privado';

    if (sub === 'studies') {
      if (!subId) return json(empty ? [] : [studyFixture()])(route);
      if (action === 'runs') {
        const [, , , , , , , , runId, tail, cellId] = parts;
        if (!runId) return json([runFixture()])(route);
        if (tail === 'cells' && cellId) {
          const cell = cellsFixture().find((item) => item.id === cellId);
          return cell ? json(cell)(route) : detail(404, 'not_found', 'Study cell not found.')(route);
        }
        if (tail === 'cells') return json(cellsFixture())(route);
        return json(runFixture())(route);
      }
      return json(studyFixture())(route);
    }

    return json([])(route);
  });
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

/**
 * A capture of the current state: with E2E_SCREENSHOTS=1 the whole page, its first `height` pixels, or one area, saved for a person to
 * look at; always a check that nothing scrolls sideways.
 */
async function capture(page: Page, testInfo: TestInfo, name: string, options: { height?: number; area?: Locator } = {}) {
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
    await page.screenshot({ path, fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width, height: Math.min(options.height, total) } });
  } else {
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  }
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

// Each test walks a screen through its states while the dev server compiles on demand.
test.setTimeout(150_000);
const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

const ROOT = '/app/isa-demo/qos-benchmarks';

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S7b analysis`, () => {
    // One worker per viewport: with every test in parallel the browsers starve each other and the same walk takes twice as long.
    test.describe.configure({ mode: 'default' });
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('retired analysis screens · old links land on the run history or on the study run', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);

      await page.goto('/app/analysis');
      await expect(page).toHaveURL(/\/app\/runs$/);
      await page.goto('/app/analysis/workspace?job=x');
      await expect(page).toHaveURL(/\/app\/runs$/);

      await page.goto(`/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=${RUN_ID}`);
      await expect(page).toHaveURL(new RegExp(`${ROOT}/studies/engines-vs-seeds/progress\\?run=${RUN_ID}$`));
      await capture(page, testInfo, `analysis-${name}-old-link`, { height: 900 });
      expect(critical).toEqual([]);
    });
  });
}
