import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';

// The dev server compiles each route on first use, so the first assertion of a test can wait for a cold page.
const expect = baseExpect.configure({ timeout: 15_000 });

// S1a · public screens: pub-home and pub-about (with the service-status note that took the place of /status).
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.

const API = 'http://localhost:8000';
const HIDE_FLOATING = '.site-header, .skip-link { visibility: hidden !important; }';

const ENGINE_DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;

const engine = (name: string, mode: string, digest: string) => ({
  id: name, name, namespace: 'bim.builtin', version: '1.0.0', digest, ref: { namespace: 'bim.builtin', name, version: '1.0.0', digest },
  modes: [{
    id: mode, profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm: name,
    capabilities: {}, limits: {}, guarantees: { termination: ['FEASIBLE'], exact: false },
    optionsSchema: { type: 'object', additionalProperties: false, properties: { time_budget_ms: { type: 'integer', default: 30000, unit: 'ms' }, iterations: { type: 'integer', default: 100000 } } },
  }],
});

const engines = [
  engine('random-search', 'sampling', ENGINE_DIGEST),
  engine('evolutionary', 'genetic', `sha256-${'c3d4e5f6'.repeat(8)}`),
  engine('minizinc', 'cp', `sha256-${'d4e5f607'.repeat(8)}`),
];

const HEALTHY_READY = { status: 'ready', dependencies: { database: 'ok', redis: 'not-required', sphere: 'configured', space: 'configured' } };
const DEGRADED_READY = { detail: { code: 'not_ready', dependencies: { database: 'unavailable', redis: 'not-required' } } };

const researchUser = {
  id: 'research-user-id', username: 'lucia', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-09-01T00:00:00Z',
};

interface Mocks {
  signedIn?: boolean;
  ready?: (route: Route) => Promise<void> | void;
  /** Every health probe fails to connect. */
  offline?: boolean;
}

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

/** Everything the screens read, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  // The public engine catalogue; a signed-in account gets its own list below.
  await page.route(`${API}/v1/engines`, json({ engines }));
  if (mocks.signedIn) {
    await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 's1a-token'));
    await page.route(`${API}/v1/users/me`, json(researchUser));
    await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: 's1a-pricing' }));
    await page.route(`${API}/v1/engines`, json({ engines: [...engines, engine('edge-solver', 'sampling', `sha256-${'f1f2f3f4'.repeat(8)}`)] }));
  }
  await page.route(`${API}/v1/profiles`, json({ profiles: [{ id: 'qos-binding/v1' }] }));
  await page.route(`${API}/v1/dialects`, json({ dialects: [{ id: 'qos-binding' }, { id: 'bpmn-workflow' }, { id: 'placement' }] }));
  if (mocks.offline) {
    for (const path of ['/health', '/health/live', '/health/ready']) await page.route(`${API}${path}`, (route) => route.abort('connectionrefused'));
  } else {
    await page.route(`${API}/health`, json({ status: 'ok' }));
    await page.route(`${API}/health/live`, json({ status: 'ok' }));
    await page.route(`${API}/health/ready`, mocks.ready ?? json(HEALTHY_READY));
  }
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

async function ready(page: Page) {
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

// Several screens are walked end to end, with full-page screenshots, while the dev server compiles on demand.
test.setTimeout(120_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · S1a public screens`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('pub-home /', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Describe. Bind. Reproduce.' })).toBeVisible();
      await ready(page);
      await expect(main.getByRole('link', { name: /Validate a package/ })).toHaveAttribute('href', '/workbench');
      await expect(main.getByRole('link', { name: /Browse the engines/ })).toHaveAttribute('href', '/engines');
      await expect(main.getByRole('link', { name: /Create an account/ })).toHaveAttribute('href', '/register');
      await expect(main.getByRole('status', { name: 'Runtime catalogue status' })).toContainText('3 installed dialects');
      await expect(main.getByRole('status', { name: 'Runtime catalogue status' })).toContainText('3 public engine revisions');

      // How it works: choosing a stage changes the call to action.
      await main.getByRole('tab', { name: /Engine/ }).click();
      await expect(main.getByRole('link', { name: 'Browse engines' })).toHaveAttribute('href', '/engines');
      await main.getByRole('tab', { name: /Validation/ }).click();
      await expect(main.getByRole('link', { name: 'Validate a package' }).last()).toHaveAttribute('href', '/workbench');

      // The public engines, from GET /v1/engines.
      const recent = main.getByRole('region', { name: 'Engines anyone can run' });
      await expect(recent.getByRole('link', { name: /3 public engine revisions/ })).toContainText('random-search · evolutionary · minizinc');
      await expect(recent.getByRole('link', { name: 'All engines' })).toHaveAttribute('href', '/engines');
      await expect(main.locator('a[href^="/explore"]')).toHaveCount(0);

      // Plans.
      const plans = main.getByRole('region', { name: 'Free to start, institutional when you scale' });
      for (const plan of ['Basic', 'Research', 'Advanced', 'Pro']) await expect(plans.getByText(plan, { exact: true })).toBeVisible();
      await expect(plans.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing');

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);

      await main.locator('.home-hero').screenshot({ path: testInfo.outputPath(`home-${name}-hero.png`), animations: 'disabled', style: HIDE_FLOATING });
      await main.locator('section').nth(1).screenshot({ path: testInfo.outputPath(`home-${name}-pipeline.png`), animations: 'disabled', style: HIDE_FLOATING });
      await recent.screenshot({ path: testInfo.outputPath(`home-${name}-recent.png`), animations: 'disabled', style: HIDE_FLOATING });
      await plans.screenshot({ path: testInfo.outputPath(`home-${name}-plans.png`), animations: 'disabled', style: HIDE_FLOATING });
      await main.getByRole('region', { name: 'A stable core, plural problem families.' }).screenshot({ path: testInfo.outputPath(`home-${name}-extensibility.png`), animations: 'disabled', style: HIDE_FLOATING });
      if (!isMobile) await page.screenshot({ path: testInfo.outputPath(`home-${name}-full.png`), fullPage: true, animations: 'disabled' });
    });

    test('pub-home / for a signed-in account', async ({ page }, testInfo) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/');
      const main = page.locator('main');

      const card = main.getByRole('link', { name: /Go to your workspace/ });
      await expect(card).toHaveAttribute('href', '/app');
      await expect(card).toContainText('Signed in as lucia · RESEARCH plan');
      await expect(main.getByRole('link', { name: /Create an account/ })).toHaveCount(0);
      await expect(main.getByRole('status', { name: 'Runtime catalogue status' })).toContainText('4 engine revisions');
      await ready(page);
      await main.locator('.home-hero').screenshot({ path: testInfo.outputPath(`home-${name}-signed-in.png`), animations: 'disabled', style: HIDE_FLOATING });
    });

    test('/status is replaced by /about, which holds the service-status note', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/pricing');
      await page.goto('/status?probe=1');
      const main = page.locator('main');

      // The query of the retired address is dropped.
      await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe('/about');
      await expect(main.getByText('Service status: All systems operational')).toBeVisible();
      await expect(page.locator('footer a[href="/status"], header a[href="/status"]')).toHaveCount(0);
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`status-${name}-ok.png`), fullPage: true, animations: 'disabled' });

      // The same check, now that the database is down.
      await page.route(`${API}/health/ready`, json(DEGRADED_READY, 503));
      await page.goto('/about');
      await expect(main.getByText('Service status: Degraded')).toBeVisible();

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('/about · a gateway that does not answer is said so, and the page still renders', async ({ page }, testInfo) => {
      await mockApi(page, { offline: true });
      await page.goto('/about');
      const main = page.locator('main');

      await expect(main.getByText('Service status: not available right now')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'People, research and changes behind OpenBinding' })).toBeVisible();
      await expect(main.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`status-${name}-unreachable.png`), fullPage: true, animations: 'disabled' });
    });

    test('pub-about /about', async ({ page, context }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mockApi(page);
      await page.goto('/about');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'People, research and changes behind OpenBinding' })).toBeVisible();
      await expect(main.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true');
      await expect(main.getByRole('heading', { name: 'Francisco Javier Cavero López' })).toBeVisible();
      await expect(main.getByRole('heading', { name: 'José Antonio Parejo Maestre' })).toBeVisible();
      await expect(main.getByText(/\[(Name|Role|Funder|logo)\]/)).toHaveCount(0);
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`about-${name}-team.png`), fullPage: true, animations: 'disabled' });

      await main.getByRole('tab', { name: 'Research' }).click();
      await expect(page).toHaveURL(/\/about\?tab=research$/);
      await expect(main.getByRole('heading', { name: 'Sources represented in the executable corpus.' })).toBeVisible();
      await expect(main.getByRole('link', { name: /DOI 10\.1109\/ICDE\.2002\.994738/ })).toHaveAttribute('href', 'https://doi.org/10.1109/ICDE.2002.994738');
      await page.screenshot({ path: testInfo.outputPath(`about-${name}-research.png`), fullPage: true, animations: 'disabled' });

      await main.getByRole('tab', { name: 'Funding' }).click();
      const sevilla = main.getByRole('link', { name: /Universidad de Sevilla/ });
      await expect(sevilla.getByRole('img', { name: 'Universidad de Sevilla' })).toBeVisible();
      await expect.poll(() => sevilla.getByRole('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await expect(main.getByRole('heading', { name: 'What each project contributes' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`about-${name}-funding.png`), fullPage: true, animations: 'disabled' });

      // Contributions open in a dialog that Escape closes.
      await main.getByRole('tab', { name: 'Contributions' }).click();
      const track = main.getByRole('button', { name: /Accessible BPMN binding workbench/ });
      await page.screenshot({ path: testInfo.outputPath(`about-${name}-contributions.png`), fullPage: true, animations: 'disabled' });
      await track.click();
      const dialog = page.getByRole('dialog', { name: 'Accessible BPMN binding workbench' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('WCAG AA evidence');
      await expect(dialog).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`about-${name}-contribution-dialog.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(track).toBeFocused();

      // The changelog filters by stream.
      await main.getByRole('tab', { name: 'Changelog' }).click();
      await expect(page).toHaveURL(/\/about\?tab=changelog$/);
      await expect(main.getByText('Binding language and engines')).toBeVisible();
      await main.getByRole('button', { name: 'Platform' }).click();
      await expect(main.getByText('Binding language and engines')).toHaveCount(0);
      await expect(main.getByText('Add collaborative binding analysis platform')).toBeVisible();
      await main.getByRole('button', { name: 'All' }).click();
      await page.screenshot({ path: testInfo.outputPath(`about-${name}-changelog.png`), fullPage: true, animations: 'disabled' });

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('pub-about · the footer and header addresses land on the right tab', async ({ page }) => {
      await mockApi(page);
      await page.goto('/about?tab=funding');

      await expect(page.getByRole('tab', { name: 'Funding' })).toHaveAttribute('aria-selected', 'true');
      await page.goto('/about?tab=contrib');
      await expect(page.getByRole('tab', { name: 'Contributions' })).toHaveAttribute('aria-selected', 'true');
      await page.goto('/about?tab=changelog');
      await expect(page.getByRole('tab', { name: 'Changelog' })).toHaveAttribute('aria-selected', 'true');
      for (const old of ['/team', '/research', '/funding', '/contributions', '/changelog']) {
        await page.goto(old);
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      }
    });
  });
}
