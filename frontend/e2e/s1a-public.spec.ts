import { expect, test, type Page, type Route } from '@playwright/test';

// S1a · public screens: pub-home, pub-explore, pub-resolve, pub-status, pub-about.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.

const API = 'http://localhost:8000';
const HIDE_FLOATING = '.site-header, .skip-link { visibility: hidden !important; }';

const HEX = 'e5f60718'.repeat(8);
const DIGEST = `sha256-${HEX}`;
const ENGINE_DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;

const projects = [
  { organization: { slug: 'isa-demo', name: 'ISA Demo Group' }, project: { slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: 'Reference binding cases with workflow and placement.' } },
  { organization: { slug: 'score-lab', name: 'SCORE Lab' }, project: { slug: 'service-corpus', name: 'Service corpus', description: 'Cases derived from published service-composition papers.' } },
];

const publications = [
  {
    slug: 'checkout-engines',
    citation: { title: 'Engine comparison at checkout', authors: ['Lucía Vega'], year: 2026 },
    report: { title: 'Engine comparison at checkout', digest: DIGEST, version_id: 'version-1' },
    project: 'qos-benchmarks',
    organization: 'isa-demo',
    publishedAt: '2026-09-25T11:55:00Z',
  },
  {
    slug: 'corpus-baseline',
    citation: { title: 'Baseline results on the service corpus', authors: ['Marco Díaz', 'Sofía Rey'], year: 2026 },
    report: { title: 'Baseline results on the service corpus', digest: `sha256-${'12ab34cd'.repeat(8)}`, version_id: 'version-2' },
    project: 'service-corpus',
    organization: 'score-lab',
    publishedAt: '2026-09-12T08:00:00Z',
  },
];

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

const resolved = {
  verified: true,
  kind: 'report',
  digest: DIGEST,
  canonical_name: 'Engine comparison at checkout',
  media_type: 'application/json',
  size_bytes: 20480,
  created_at: '2026-09-25T11:55:00Z',
  author: { id: 'author-1', username: 'lucia.vega', email: 'lucia@example.invalid' },
  document: { title: 'Engine comparison at checkout', sections: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], schemaVersion: 1, evidence: { runs: 12 } },
  content_url: `/v1/resolve/report/${DIGEST}/content`,
  locations: [{
    organization: { id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group' },
    project: { id: 'project-1', slug: 'qos-benchmarks', name: 'QoS Benchmarks', visibility: 'public' },
    element_id: 'element-1', slug: 'checkout-engines', version_or_revision: 1, created_at: '2026-09-25T11:55:00Z', web_url: '/app/isa-demo/library',
  }],
  pagination: { total: 1, limit: 20, offset: 0, has_more: false },
  citation: null,
};

const HEALTHY_READY = { status: 'ready', dependencies: { database: 'ok', redis: 'not-required', sphere: 'configured', space: 'configured' } };
const DEGRADED_READY = { detail: { code: 'not_ready', dependencies: { database: 'unavailable', redis: 'not-required' } } };

const researchUser = {
  id: 'research-user-id', username: 'lucia', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-09-01T00:00:00Z',
};

interface Mocks {
  signedIn?: boolean;
  /** Answers GET /v1/resolve/report/<digest>. */
  resolve?: (route: Route) => Promise<void> | void;
  projects?: (route: Route) => Promise<void> | void;
  ready?: (route: Route) => Promise<void> | void;
  /** Every health probe fails to connect. */
  offline?: boolean;
}

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });

/** Everything the five screens read, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  if (mocks.signedIn) {
    await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 's1a-token'));
    await page.route(`${API}/v1/users/me`, json(researchUser));
    await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: 's1a-pricing' }));
    await page.route(`${API}/v1/engines`, json({ engines: [...engines, engine('edge-solver', 'sampling', `sha256-${'f1f2f3f4'.repeat(8)}`)] }));
  }
  await page.route(`${API}/v1/profiles`, json({ profiles: [{ id: 'qos-binding/v1' }] }));
  await page.route(`${API}/v1/dialects`, json({ dialects: [{ id: 'qos-binding' }, { id: 'bpmn-workflow' }, { id: 'placement' }] }));
  await page.route(`${API}/v1/explore/projects`, mocks.projects ?? json(projects));
  await page.route(`${API}/v1/explore/publications`, json(publications));
  await page.route(`${API}/v1/explore/engines`, json({ engines }));
  await page.route(new RegExp(`${API}/v1/resolve/report/sha256-[0-9a-f]{64}(\\?.*)?$`), mocks.resolve ?? json(resolved));
  await page.route(`${API}/v1/resolve/report/${DIGEST}/content`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(resolved.document),
  }));
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
      await expect(main.getByRole('link', { name: /Explore published results/ })).toHaveAttribute('href', '/explore');
      await expect(main.getByRole('link', { name: /Create an account/ })).toHaveAttribute('href', '/register');
      await expect(main.getByRole('status', { name: 'Runtime catalogue status' })).toContainText('3 installed dialects');
      await expect(main.getByRole('status', { name: 'Runtime catalogue status' })).toContainText('3 public engine revisions');

      // How it works: choosing a stage changes the call to action.
      await main.getByRole('tab', { name: /Engine/ }).click();
      await expect(main.getByRole('link', { name: 'Browse engines' })).toHaveAttribute('href', '/engines');
      await main.getByRole('tab', { name: /Validation/ }).click();
      await expect(main.getByRole('link', { name: 'Validate a package' }).last()).toHaveAttribute('href', '/workbench');

      // Recently public, from /v1/explore/*.
      const recent = main.getByRole('region', { name: 'Publications and public projects' });
      await expect(recent.getByRole('link', { name: /Engine comparison at checkout/ })).toHaveAttribute('href', `/resolve/report/${DIGEST}`);
      await expect(recent.getByRole('link', { name: /Engine comparison at checkout/ })).toContainText('ISA Demo Group / QoS Benchmarks');
      await expect(recent.locator('a[href="/explore?tab=projects"]').filter({ hasText: 'Service corpus' })).toBeVisible();
      await expect(recent.getByRole('link', { name: /Baseline results on the service corpus/ })).toHaveAttribute('href', `/resolve/report/sha256-${'12ab34cd'.repeat(8)}`);
      await expect(recent.getByRole('link', { name: /3 public engine revisions/ })).toContainText('random-search · evolutionary · minizinc');

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

    test('pub-explore /explore', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/explore');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Public work on OpenBinding' })).toBeVisible();
      await expect(main.getByRole('tab', { name: /Publications/ })).toHaveAttribute('aria-selected', 'true');
      await expect(main.getByRole('tab', { name: /Projects/ })).toContainText('2');
      await expect(main.getByRole('tab', { name: /Engines/ })).toContainText('3');
      const details = main.getByRole('complementary', { name: 'Details' });
      await expect(details.getByRole('heading', { name: 'Engine comparison at checkout' })).toBeVisible();
      await expect(details.getByText(DIGEST)).toBeVisible();
      await expect(details.getByRole('link', { name: 'Open verification' })).toHaveAttribute('href', `/resolve/report/${DIGEST}`);
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`explore-${name}-publications.png`), fullPage: true, animations: 'disabled' });

      // Selecting another publication swaps the details; a search narrows the list.
      await main.getByRole('button', { name: /Baseline results on the service corpus/ }).click();
      await expect(details.getByRole('heading', { name: 'Baseline results on the service corpus' })).toBeVisible();
      await expect(details.getByText('Marco Díaz, Sofía Rey', { exact: true })).toBeVisible();
      await main.getByRole('searchbox', { name: 'Search this tab' }).fill('checkout');
      await expect(main.getByText('1 public publication')).toBeVisible();
      await main.getByRole('searchbox', { name: 'Search this tab' }).fill('no such thing');
      await expect(main.getByText('No public publications match “no such thing”.')).toBeVisible();
      await expect(details.getByText('Select an item to see its citation, digest and where to verify it.')).toBeVisible();

      // Projects: a visitor can see them but must log in to open one.
      await main.getByRole('tab', { name: /Projects/ }).click();
      await expect(page).toHaveURL(/\/explore\?tab=projects$/);
      await expect(details.getByRole('heading', { name: 'QoS Benchmarks' })).toBeVisible();
      await expect(details.getByRole('link', { name: 'Log in to open as a member' })).toHaveAttribute('href', '/login');
      await main.getByRole('button', { name: 'SCORE Lab', exact: true }).click();
      await expect(main.getByRole('button', { name: /QoS Benchmarks/ })).toHaveCount(0);
      await main.getByRole('button', { name: 'All organizations' }).click();
      await page.screenshot({ path: testInfo.outputPath(`explore-${name}-projects.png`), fullPage: true, animations: 'disabled' });

      // Engines.
      await main.getByRole('tab', { name: /Engines/ }).click();
      await expect(details.getByRole('heading', { name: 'bim.builtin/random-search@1.0.0' })).toBeVisible();
      await expect(details.getByText('time_budget_ms (ms, default 30,000); iterations (default 100,000)')).toBeVisible();
      await expect(details.getByRole('link', { name: 'Open engine' })).toHaveAttribute('href', '/engines/bim.builtin/random-search/1.0.0');
      await page.screenshot({ path: testInfo.outputPath(`explore-${name}-engines.png`), fullPage: true, animations: 'disabled' });

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('pub-explore /explore when a list cannot be loaded', async ({ page }, testInfo) => {
      await mockApi(page, { projects: json({ detail: 'database unavailable' }, 503) });
      await page.goto('/explore?tab=projects');
      const main = page.locator('main');

      const alert = main.getByRole('alert');
      await expect(alert).toContainText('Projects couldn’t be loaded (HTTP 503). Your search and filters are kept.');
      await expect(main.getByRole('tab', { name: /Projects/ })).toContainText('–');
      await expect(main.getByRole('tab', { name: /Publications/ })).toContainText('2');
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`explore-${name}-error.png`), fullPage: true, animations: 'disabled' });

      // Retry asks again, and this time the list arrives.
      await page.route(`${API}/v1/explore/projects`, json(projects));
      await alert.getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('button', { name: /QoS Benchmarks/ })).toBeVisible();
      await expect(main.getByRole('alert')).toHaveCount(0);
    });

    test('pub-resolve /resolve/:kind/:digest', async ({ page, context }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mockApi(page);
      await page.goto(`/resolve/report/${DIGEST}`);
      const main = page.locator('main');

      await expect(main.getByText('Verified', { exact: true })).toBeVisible();
      await expect(main.getByText('kind · report')).toBeVisible();
      const identity = main.getByRole('region', { name: 'Identity and provenance' });
      await expect(identity).toContainText('Engine comparison at checkout');
      await expect(identity).toContainText('20 KiB (20,480 bytes)');
      await expect(identity).toContainText('Sep 25, 2026, 11:55 UTC');
      await expect(identity).toContainText('lucia.vega');
      await expect(main.getByText('example.invalid')).toHaveCount(0);
      const locations = main.getByRole('region', { name: 'Locations' });
      await expect(locations).toContainText('ISA Demo Group / QoS Benchmarks');
      await expect(locations.getByRole('link', { name: 'Log in to open' })).toHaveAttribute('href', '/login');
      await expect(main.getByRole('region', { name: 'Content' })).toContainText('Document structure');
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`resolve-${name}-verified.png`), fullPage: true, animations: 'disabled' });

      // Download the content as a file.
      const [download] = await Promise.all([page.waitForEvent('download'), main.getByRole('button', { name: 'Download content' }).click()]);
      expect(download.suggestedFilename()).toBe(`report-${HEX.slice(0, 12)}.json`);
      await expect(main.getByText(/Downloaded \d+ bytes of application\/json\./)).toBeVisible();

      // Cite it.
      const cite = main.getByRole('region', { name: 'Cite this' });
      await cite.getByRole('button', { name: 'Copy for reference manager' }).click();
      await expect(cite.getByRole('button', { name: 'Copied for reference manager' })).toBeVisible();
      const bibtex = await page.evaluate(() => navigator.clipboard.readText());
      expect(bibtex).toContain('@misc{');
      expect(bibtex).toContain(`note         = {SHA-256 digest ${DIGEST}}`);
      expect(bibtex).not.toMatch(/doi/i);

      // Verify another digest from the form.
      await main.getByRole('textbox', { name: 'Digest' }).fill(`SHA256:${'12AB34CD'.repeat(8)}`);
      await main.getByRole('button', { name: 'Verify' }).click();
      await expect(page).toHaveURL(new RegExp(`/resolve/report/sha256-${'12ab34cd'.repeat(8)}$`));

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('pub-resolve · a verified element with no visible location', async ({ page }, testInfo) => {
      await mockApi(page, {
        resolve: json({ ...resolved, locations: [], pagination: { total: 0, limit: 20, offset: 0, has_more: false } }),
      });
      await page.goto(`/resolve/report/${DIGEST}`);
      const main = page.locator('main');

      await expect(main.getByText('Verified', { exact: true })).toBeVisible();
      await expect(main.getByText(/none of the places it lives are visible to you/)).toBeVisible();
      await expect(main.getByRole('region', { name: 'Locations' })).toContainText('0 visible');
      await ready(page);
      await main.getByRole('region', { name: 'Locations' }).screenshot({ path: testInfo.outputPath(`resolve-${name}-no-locations.png`), animations: 'disabled', style: HIDE_FLOATING });
    });

    test('pub-resolve · neutral 404, malformed digest and 503', async ({ page }, testInfo) => {
      await mockApi(page, { resolve: json({ detail: { code: 'not_found', message: 'Element not found.' } }, 404) });
      await page.goto(`/resolve/report/${DIGEST}`);
      const main = page.locator('main');

      await expect(main.getByText('Nothing found for this digest')).toBeVisible();
      await expect(main.getByText('404 · not_found')).toBeVisible();
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`resolve-${name}-not-found.png`), fullPage: true, animations: 'disabled' });

      await page.goto('/resolve/report/not-a-digest');
      await expect(main.getByText('That digest isn’t well formed')).toBeVisible();
      await expect(main.getByRole('textbox', { name: 'Digest' })).toHaveAttribute('aria-invalid', 'true');
      await page.screenshot({ path: testInfo.outputPath(`resolve-${name}-malformed.png`), fullPage: true, animations: 'disabled' });

      await page.route(new RegExp(`${API}/v1/resolve/report/sha256-[0-9a-f]{64}(\\?.*)?$`), json({ detail: { code: 'service_unavailable' } }, 503));
      await page.goto(`/resolve/report/${DIGEST}`);
      await expect(main.getByText(/Verification is unavailable right now \(HTTP 503\)/)).toBeVisible();
      await expect(main.getByRole('button', { name: 'Retry' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`resolve-${name}-unavailable.png`), fullPage: true, animations: 'disabled' });
    });

    test('pub-status /status', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/status');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { name: 'All systems operational' })).toBeVisible();
      const probes = main.getByRole('list', { name: 'Probes' });
      await expect(probes).toContainText('GET /health');
      await expect(probes).toContainText('GET /health/live');
      await expect(probes).toContainText('GET /health/ready');
      const dependencies = main.getByRole('region', { name: 'Required dependencies' });
      await expect(dependencies).toContainText('database');
      await expect(dependencies).toContainText('configured');
      await expect(dependencies).toContainText('not required');
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`status-${name}-ok.png`), fullPage: true, animations: 'disabled' });

      // The incident guide opens on request.
      const guide = main.getByRole('button', { name: 'What to do during an incident' });
      await expect(guide).toHaveAttribute('aria-expanded', 'false');
      await guide.click();
      await expect(main.getByText(/nothing is retried automatically for you/)).toBeVisible();

      // Check again, now that the database is down.
      await page.route(`${API}/health/ready`, json(DEGRADED_READY, 503));
      await main.getByRole('button', { name: 'Check again' }).click();
      await expect(main.getByRole('heading', { name: 'Degraded' })).toBeVisible();
      await expect(main.getByText(/database is unavailable/).first()).toBeVisible();
      await expect(dependencies).toContainText('sign-in and private pages answer 503');
      await page.screenshot({ path: testInfo.outputPath(`status-${name}-degraded.png`), fullPage: true, animations: 'disabled' });

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('pub-status · no connection with the gateway is not a failing dependency', async ({ page }, testInfo) => {
      await mockApi(page, { offline: true });
      await page.goto('/status');
      const main = page.locator('main');

      const alert = main.getByRole('alert');
      await expect(alert).toContainText('No connection with the gateway');
      await expect(alert).toContainText('we can’t tell whether any dependency is down');
      await expect(main.getByRole('heading', { name: 'Degraded' })).toHaveCount(0);
      await expect(main.getByRole('region', { name: 'Required dependencies' })).toHaveCount(0);
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
      await expect(dialog.getByRole('button', { name: 'Close contribution' })).toBeFocused();
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
