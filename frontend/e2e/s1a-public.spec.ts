import { expect as baseExpect, test, type Page, type Route } from '@playwright/test';
import { compositionStore } from './helpers/mockCompositions';
import { authConfig, signedIn } from './helpers/session';

// The dev server compiles each route on first use, so the first assertion of a test can wait for a cold page.
const expect = baseExpect.configure({ timeout: 15_000 });

// S1a · public screens: pub-home, the about pages (pub-team, pub-research, pub-contributions, pub-changelog) with the footer's
// service-status chip that took the place of /status, and the public
// compositions with the page of one (pub-compositions, composition-card), as a visitor reads them.
// There is no backend: the API origin is answered by page.route(). Screenshots go to testInfo.outputPath()
// (test-results/, ignored by git) so they can be looked at after a run.

const API = 'http://localhost:8000';

const ENGINE_DIGEST = `sha256-${'b2c3d4e5'.repeat(8)}`;

const engine = (name: string, mode: string, digest: string) => ({
  id: name,
  name,
  namespace: 'bim.builtin',
  version: '1.0.0',
  digest,
  ref: { namespace: 'bim.builtin', name, version: '1.0.0', digest },
  modes: [
    {
      id: mode,
      profile: 'qos-binding/v1',
      ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
      algorithm: name,
      capabilities: {},
      limits: {},
      guarantees: { termination: ['FEASIBLE'], exact: false },
      optionsSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time_budget_ms: { type: 'integer', default: 30000, unit: 'ms' },
          iterations: { type: 'integer', default: 100000 },
        },
      },
    },
  ],
});

const engines = [
  engine('random-search', 'sampling', ENGINE_DIGEST),
  engine('evolutionary', 'genetic', `sha256-${'c3d4e5f6'.repeat(8)}`),
  engine('minizinc', 'cp', `sha256-${'d4e5f607'.repeat(8)}`),
];

const HEALTHY_READY = {
  status: 'ready',
  dependencies: {
    database: 'ok',
    redis: 'not-required',
    sphere: 'configured',
    space: 'configured',
  },
};
const DEGRADED_READY = {
  detail: { code: 'not_ready', dependencies: { database: 'unavailable', redis: 'not-required' } },
};

const researchUser = {
  id: 'research-user-id',
  username: 'lucia',
  email: 'lucia@example.org',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-09-01T00:00:00Z',
};

interface Mocks {
  signedIn?: boolean;
  ready?: (route: Route) => Promise<void> | void;
  /** Every health probe fails to connect. */
  offline?: boolean;
}

const json =
  (body: unknown, status = 200) =>
  (route: Route) =>
    route.fulfill({ status, json: body });

/** Everything the screens read, answered; anything else on the API origin is an empty 404. */
async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await authConfig(page);
  // The public engine catalogue; a signed-in account gets its own list below.
  await page.route(`${API}/v1/engines`, json({ engines }));
  if (mocks.signedIn) {
    await signedIn(page, 's1a-token');
    await page.route(`${API}/v1/users/me`, json(researchUser));
    await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: 's1a-pricing' }));
    await page.route(
      `${API}/v1/engines`,
      json({
        engines: [...engines, engine('edge-solver', 'sampling', `sha256-${'f1f2f3f4'.repeat(8)}`)],
      })
    );
  }
  await page.route(`${API}/v1/engines/protocol`, json({ profiles: [{ id: 'qos-binding/v1' }] }));
  if (mocks.offline) {
    for (const path of ['/health', '/health/live', '/health/ready'])
      await page.route(`${API}${path}`, route => route.abort('connectionrefused'));
  } else {
    await page.route(`${API}/health`, json({ status: 'ok' }));
    await page.route(`${API}/health/live`, json({ status: 'ok' }));
    await page.route(`${API}/health/ready`, mocks.ready ?? json(HEALTHY_READY));
  }
}

/**
 * The public compositions of every organization (`GET /v1/compositions`) and the reads of an organization's compositions, as the
 * gateway answers a visitor: the shared mock's store (e2e/helpers/mockCompositions.ts), public ones redacted, private ones missing.
 */
async function mockPublicCompositions(page: Page) {
  const store = compositionStore();
  await page.route(
    /^http:\/\/localhost:8000\/v1\/(compositions|organizations\/[^/]+\/compositions)(\/|\?|$)/,
    route => {
      const request = route.request();
      const url = new URL(request.url());
      const parts = url.pathname.split('/').filter(Boolean);
      const known = {
        method: request.method(),
        parts,
        query: url.searchParams,
        body: () => ({}),
        text: () => '',
      };
      if (parts[1] === 'compositions' && parts.length > 2)
        return route.fulfill({ status: 404, json: { detail: 'not mocked' } });
      const reply =
        parts[1] === 'compositions'
          ? store.publicList(known)
          : store.publicRoute(known, parts[2], false);
      return reply.text !== undefined
        ? route.fulfill({
            status: reply.status,
            contentType: reply.type ?? 'text/plain',
            body: reply.text,
          })
        : route.fulfill({ status: reply.status, json: reply.json });
    }
  );
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

async function ready(page: Page) {
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

// Several screens are walked end to end, with full-page screenshots, while the dev server compiles on demand.
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
  test.describe(`${name} · S1a public screens`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('pub-home /: SPHERE’s landing for a visitor', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 1, name: 'Describe. Bind. Reproduce.' })
      ).toBeVisible();
      await ready(page);
      await expect(
        main.getByRole('link', { name: /Explore compositions/ }).first()
      ).toHaveAttribute('href', '/compositions');
      await expect(main.getByRole('link', { name: /Learn Composition2Yaml/ })).toHaveAttribute(
        'href',
        '/language'
      );
      await expect(main.getByRole('link', { name: /Create an account/ })).toHaveAttribute(
        'href',
        '/authentication?view=register'
      );
      await expect(main.getByRole('status', { name: 'Runtime catalogue status' })).toContainText(
        '3 public engine revisions'
      );

      // How it works: choosing a stage changes the call to action.
      await main.getByRole('tab', { name: /Engine/ }).click();
      await expect(main.getByRole('link', { name: 'Browse engines' })).toHaveAttribute(
        'href',
        '/engines'
      );
      await main.getByRole('tab', { name: /Validation/ }).click();
      await expect(main.getByRole('link', { name: 'Validate a package' })).toHaveAttribute(
        'href',
        '/problem-editor'
      );

      // The public engines, from GET /v1/engines.
      const engines = main.getByRole('region', { name: 'Engines anyone can run' });
      await expect(engines.getByRole('link', { name: /3 public engine revisions/ })).toContainText(
        'random-search · evolutionary · minizinc'
      );
      await expect(engines.getByRole('link', { name: 'All engines' })).toHaveAttribute(
        'href',
        '/engines'
      );

      // Plans and the layers of BIM.
      const plans = main.getByRole('region', {
        name: 'Free to start, institutional when you scale',
      });
      for (const plan of ['Free', 'Research', 'Lab'])
        await expect(plans.getByText(plan, { exact: true }).first()).toBeVisible();
      await expect(plans.getByRole('link', { name: 'Compare plans' })).toHaveAttribute(
        'href',
        '/pricing'
      );
      await expect(
        main.getByRole('region', { name: 'A stable core, plural problem families.' })
      ).toBeVisible();

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
      if (!isMobile)
        await page.screenshot({
          path: testInfo.outputPath(`home-${name}-full.png`),
          fullPage: true,
          animations: 'disabled',
        });
    });

    test('pub-home /: the dashboard for a signed-in account', async ({ page }, testInfo) => {
      await mockApi(page, { signedIn: true });
      await page.goto('/');
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1, name: /^Welcome back, / })).toBeVisible();
      await expect(main.getByRole('link', { name: /Create an account/ })).toHaveCount(0);
      await expect(main.getByRole('list', { name: 'Your workspace in numbers' })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`home-${name}-signed-in.png`),
        animations: 'disabled',
      });
    });

    test('the footer holds the service-status chip on every page, and nothing links to /status', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await page.goto('/team');
      const footer = page.locator('footer');

      await expect(footer.getByText('Service status: All systems operational')).toBeVisible();
      await expect(page.locator('footer a[href="/status"], header a[href="/status"]')).toHaveCount(
        0
      );
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath(`status-${name}-ok.png`),
        fullPage: true,
        animations: 'disabled',
      });

      // The same check, now that the database is down.
      await page.route(`${API}/health/ready`, json(DEGRADED_READY, 503));
      await page.goto('/changelog');
      await expect(footer.getByText('Service status: Degraded')).toBeVisible();

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('the service-status chip says a gateway that does not answer, and the page still renders', async ({
      page,
    }, testInfo) => {
      await mockApi(page, { offline: true });
      await page.goto('/research');

      await expect(
        page.locator('footer').getByText('Service status: not available right now')
      ).toBeVisible();
      await expect(
        page.locator('main').getByRole('heading', { level: 1, name: 'Research' })
      ).toBeVisible();
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath(`status-${name}-unreachable.png`),
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('pub-team, pub-research, pub-contributions and pub-changelog: SPHERE’s about pages', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      const main = page.locator('main');

      // Team: SPHERE's member cards.
      await page.goto('/team');
      await expect(main.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
      await expect(
        main.getByRole('article', { name: 'Francisco Javier Cavero López' })
      ).toBeVisible();
      await expect(
        main.getByRole('article', { name: 'José Antonio Parejo Maestre' })
      ).toBeVisible();
      await expect(main.getByText(/\[(Name|Role|Funder|logo)\]/)).toHaveCount(0);
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath(`about-${name}-team.png`),
        fullPage: true,
        animations: 'disabled',
      });
      await expectNoHorizontalOverflow(page);

      // Research: the publication timeline, then Funding.
      await page.goto('/research');
      await expect(
        main.getByRole('heading', { name: 'Sources represented in the executable corpus.' })
      ).toBeVisible();
      await expect(
        main.getByRole('link', {
          name: 'Declarative Composition and Peer-to-Peer Provisioning of Dynamic Web Services',
        })
      ).toHaveAttribute('href', 'https://doi.org/10.1109/ICDE.2002.994738');
      const funding = main.getByRole('region', { name: 'Funding' });
      const sevilla = funding.getByRole('link', { name: /Universidad de Sevilla/ });
      await sevilla.scrollIntoViewIfNeeded();
      await expect(sevilla.getByRole('img', { name: 'Universidad de Sevilla' })).toBeVisible();
      await expect
        .poll(() =>
          sevilla
            .getByRole('img')
            .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
        )
        .toBe(true);
      await expect(
        funding.getByRole('heading', { name: 'What each project contributes' })
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`about-${name}-research.png`),
        fullPage: true,
        animations: 'disabled',
      });
      await expectNoHorizontalOverflow(page);

      // Contributions open in a dialog that Escape closes.
      await page.goto('/contributions');
      const track = main.getByRole('button', { name: /Accessible BPMN binding workbench/ });
      await expect(track).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`about-${name}-contributions.png`),
        fullPage: true,
        animations: 'disabled',
      });
      await track.click();
      const dialog = page.getByRole('dialog', { name: 'Accessible BPMN binding workbench' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('WCAG AA evidence');
      await expect(dialog).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`about-${name}-contribution-dialog.png`),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(track).toBeFocused();
      await expectNoHorizontalOverflow(page);

      // The changelog: OpenBinding | Language.
      await page.goto('/changelog');
      await expect(main.getByRole('tab', { name: 'OpenBinding' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      const release = (title: string) => main.getByRole('heading', { name: title, exact: true });
      await expect(release('OpenBinding platform')).toBeVisible();
      await expect(release('OpenBinding documentation')).toBeVisible();
      await expect(release('Binding language and engines')).toHaveCount(0);
      await main.getByRole('tab', { name: 'Language' }).click();
      await expect(page).toHaveURL(/\/changelog\?tab=language$/);
      await expect(release('Binding language and engines')).toBeVisible();
      await expect(release('OpenBinding platform')).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`about-${name}-changelog.png`),
        fullPage: true,
        animations: 'disabled',
      });

      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
    });

    test('pub-compositions and composition-card: the public list opens the page of a composition', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      await mockApi(page);
      await mockPublicCompositions(page);
      await page.goto('/compositions');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 1, name: 'Public compositions' })
      ).toBeVisible();
      if (!isMobile) {
        const primary = page.getByRole('navigation', { name: 'Primary navigation' });
        await primary.getByRole('button', { name: 'Explore' }).click();
        await expect(primary.getByRole('link', { name: 'Compositions' })).toHaveAttribute(
          'aria-current',
          'page'
        );
        await page.keyboard.press('Escape');
      }
      const list = main;
      await expect(list.getByRole('article')).toHaveCount(2);
      await expect(list.getByText('2 compositions found')).toBeVisible();
      await ready(page);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`public-compositions-${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });

      await list.getByRole('link', { name: 'Order desk' }).click();
      await expect(page).toHaveURL('/compositions/isa-demo/order-desk');
      await expect(main.getByRole('heading', { level: 1, name: 'Order desk' })).toBeVisible();
      await expect(
        main
          .getByRole('navigation', { name: 'Breadcrumb' })
          .getByRole('link', { name: 'ISA Demo Group' })
      ).toBeVisible();
      await expect(main.getByRole('region', { name: 'Value status' })).toContainText('Declared');
      await expect(main.getByRole('region', { name: 'Workflow' })).toBeVisible();
      await expect(main.getByRole('button', { name: /Get composition/ })).toBeVisible();
      if (isMobile) await expect(main.getByRole('button', { name: 'More actions' })).toBeVisible();
      else await expect(main.getByRole('button', { name: 'Fork', exact: true })).toBeVisible();
      await ready(page);
      await expectNoHorizontalOverflow(page);
      expect(critical).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`showcase-${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    });

    test('the footer and the header lead to the about pages, and /about answers Page not found', async ({
      page,
    }) => {
      await mockApi(page);
      await page.goto('/pricing');
      const footer = page.getByRole('navigation', { name: 'Footer navigation' });
      for (const [label, address] of [
        ['Team', '/team'],
        ['Research', '/research'],
        ['Funding', '/research#funding'],
        ['Contributions', '/contributions'],
        ['Changelog', '/changelog'],
      ])
        await expect(footer.getByRole('link', { name: label, exact: true })).toHaveAttribute(
          'href',
          address
        );
      await footer.getByRole('link', { name: 'Funding', exact: true }).click();
      await expect(page).toHaveURL(/\/research#funding$/);
      await expect(page.getByRole('region', { name: 'Funding' })).toBeVisible();

      for (const old of ['/about', '/about?tab=team', '/funding']) {
        await page.goto(old);
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      }
    });
  });
}
