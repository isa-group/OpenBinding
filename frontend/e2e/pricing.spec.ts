import { expect as baseExpect, test, type Page, type Request, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';

// S3 · pub-pricing /pricing, with the API answered by page.route() (there is no backend).
// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be looked at after a run.

const API = 'http://localhost:8000';

// Eight browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

const json = (body: unknown, status = 200) => (route: Route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json(failureBody(status, code, error, extra), status);

/** A pricing token shaped like the gateway's, with two features evaluated. */
const token = (expiresInSeconds: number) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64'),
  Buffer.from(JSON.stringify({
    sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    features: { 'openbinding-authoring': { eval: true }, 'openbinding-solve': { eval: false } },
  })).toString('base64'),
  'signature',
].join('.');

const account = (plan: string) => ({
  id: 'user-1', username: 'lucia', email: 'lucia@example.org', role: 'user', is_active: true, plan,
  created_at: '2026-03-02T00:00:00Z', cas_verified: plan === 'RESEARCH', institutional_branding: plan === 'RESEARCH',
});

interface Mocks {
  /** Signed in with this plan. Omit for a visitor. */
  plan?: string;
  catalog?: (route: Route) => Promise<void> | void;
  current?: (route: Route) => Promise<void> | void;
  pricingToken?: string;
}

async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/v1/pricing/catalog`, mocks.catalog ?? json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, mocks.current ?? json(CURRENT_FIXTURE));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  if (mocks.plan) {
    await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 'pricing-access'));
    await page.route(`${API}/v1/users/me`, json(account(mocks.plan)));
    await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: mocks.pricingToken ?? token(3600) }));
    await page.route(`${API}/v1/notifications**`, json([]));
    await page.route(`${API}/v1/organizations`, json([]));
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

/** Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save a full-page picture of the current state for a person to look at. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
}

test.setTimeout(60_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · pub-pricing`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('a visitor reads the live catalog: no price, no checkout, the three limit outcomes', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const requested: string[] = [];
      page.on('request', (request: Request) => requested.push(request.url()));
      await mockApi(page);
      await page.goto('/pricing');
      const main = page.locator('main');

      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Plans for every kind of binding work' })).toBeVisible();
      await expect(main.getByText(/Pricing version\s+0\.1\.0/)).toBeVisible();
      await expect(main.getByText('Published Sep 1, 2026')).toBeVisible();
      await expect(main.getByText('EUR · monthly periods')).toBeVisible();
      await expect(main.getByText('Fingerprint sha256-a1b2…c3d4')).toBeVisible();
      await expect(main.getByText('Development pricing.')).toBeVisible();

      // Four plans in the order of the document; the paid ones are an agreement, never a price.
      const plans = main.getByRole('list', { name: 'Plans' });
      await expect(plans.getByRole('listitem')).toHaveCount(4);
      await expect(plans.getByText('Contact us', { exact: true })).toHaveCount(4);
      await expect(plans.getByText('institutional agreement')).toHaveCount(2);
      await expect(main.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
      await expect(main.getByRole('link', { name: 'Log in with CAS' }).first()).toHaveAttribute('href', '/login');
      expect(await main.innerText()).not.toMatch(/[€$]\s?\d/);

      // Monthly limits are open: the rounded figure with the exact one underneath.
      const monthly = main.getByRole('table', { name: 'Monthly: Renew each month' });
      await expect(monthly.getByRole('row', { name: /Solver time/ })).toContainText('15 min');
      await expect(monthly.getByRole('row', { name: /Solver time/ })).toContainText('900 s');
      await expect(monthly.getByRole('row', { name: /Capacity units/ })).not.toContainText('To confirm');
      await capture(page, testInfo, `pricing-${name}-visitor`);
      if (isMobile) {
        // The plans stack instead of scrolling: the page is as wide as the device, the matrix has nothing to scroll, and no plan is cut off.
        const fit = await page.evaluate((deviceWidth) => {
          const scroller = document.querySelector('.pricing-scroller') as HTMLElement;
          const reach = (selector: string) => Math.max(...Array.from(document.querySelectorAll(selector)).map((element) => element.getBoundingClientRect().right));
          return {
            page: document.documentElement.scrollWidth - deviceWidth,
            scroller: scroller.scrollWidth - scroller.clientWidth,
            tiles: reach('.pricing-plan-tile') - deviceWidth,
            cells: reach('.pricing-table td') - deviceWidth,
          };
        }, viewport.width);
        expect(fit.page, 'the page should not scroll sideways').toBeLessThanOrEqual(1);
        expect(fit.scroller, 'the matrix should not scroll sideways').toBeLessThanOrEqual(1);
        expect(fit.tiles, 'no plan tile should be cut off on the right').toBeLessThanOrEqual(0);
        expect(fit.cells, 'no value should be cut off on the right').toBeLessThanOrEqual(0);
        await expect(plans.getByRole('listitem')).toHaveCount(4);
        expect(critical).toEqual([]);
        return;
      }

      await main.getByRole('button', { name: /Per request/ }).click();
      const perRequest = main.getByRole('table', { name: 'Per request: Ceilings for each job' });
      await expect(perRequest.getByText('8 MiB', { exact: true })).toBeVisible();
      await expect(perRequest.getByText('8,388,608 bytes', { exact: true })).toBeVisible();
      await main.getByRole('button', { name: 'PRO', exact: true }).click();
      await expect(main.getByRole('button', { name: 'PRO', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.pricing-plan-tile.is-picked')).toHaveCount(1);

      await main.getByRole('heading', { name: 'What has to have room before you start' }).scrollIntoViewIfNeeded();
      await expect(main.getByText('Start a federated solve')).toBeVisible();
      await expect(main.getByText('Solves left this month').first()).toBeVisible();
      await expect(main.getByText('BASIC and RESEARCH have no add-ons.')).toBeVisible();
      for (const outcome of ['Reduced', 'Wait', 'Rejected']) await expect(main.getByText(outcome, { exact: true })).toBeVisible();

      // The deprecated YAML endpoint is not used; the catalog and the release are.
      expect(requested.filter((url) => url === `${API}/v1/pricing`)).toEqual([]);
      expect(requested).toContain(`${API}/v1/pricing/catalog`);
      expect(requested).toContain(`${API}/v1/pricing/current`);
      expect(critical).toEqual([]);
    });

    test('Contact us opens a dialog that sends nothing', async ({ page }, testInfo) => {
      await mockApi(page);
      const posts: string[] = [];
      page.on('request', (request) => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) posts.push(request.url()); });
      await page.goto('/pricing');

      const contact = page.getByRole('button', { name: 'Contact us' }).first();
      await contact.focus();
      await contact.click();
      const dialog = page.getByRole('dialog', { name: 'Ask about ADVANCED' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/This page doesn’t send anything/)).toBeVisible();
      await capture(page, testInfo, `pricing-${name}-contact`);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(contact).toBeFocused();
      expect(posts).toEqual([]);
    });

    test('says what it cannot show: loading, no live release, pricing unavailable, digest mismatch', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await mockApi(page, { catalog: async (route) => { await gate; await json(catalogFixture)(route); } });
      await page.goto('/pricing');
      const main = page.locator('main');

      await expect(main.locator('[aria-busy="true"]')).toBeVisible();
      await expect(main.getByRole('list', { name: 'Plans' })).toHaveCount(0);
      await capture(page, testInfo, `pricing-${name}-loading`);
      release();
      await expect(main.getByRole('list', { name: 'Plans' })).toBeVisible();
      if (isMobile) return;

      await page.unroute(`${API}/v1/pricing/current`);
      await page.route(`${API}/v1/pricing/current`, detail(404, 'not_found', 'No public pricing release is live.'));
      await page.reload();
      await expect(main.getByText('No public pricing release is live')).toBeVisible();
      await expect(main.getByText(/Accounts keep the plan they already have/)).toBeVisible();
      await expect(main.getByRole('list', { name: 'Plans' })).toHaveCount(0);
      await page.unroute(`${API}/v1/pricing/current`);
      await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
      await page.unroute(`${API}/v1/pricing/catalog`);
      await page.route(`${API}/v1/pricing/catalog`, detail(503, 'pricing_unavailable', 'SPHERE is not reachable.'));
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('503 · pricing_unavailable');
      await expect(main.getByRole('list', { name: 'Plans' })).toHaveCount(0);
      await capture(page, testInfo, `pricing-${name}-503`);

      await page.unroute(`${API}/v1/pricing/catalog`);
      await page.route(`${API}/v1/pricing/catalog`, detail(502, 'pricing_digest_mismatch', 'SPHERE content no longer matches the release digest.'));
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('502 · pricing_digest_mismatch');

      // Retrying once the catalog is back shows the plans without a reload.
      await page.unroute(`${API}/v1/pricing/catalog`);
      await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
      await main.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('list', { name: 'Plans' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('a signed-in RESEARCH account sees its plan marked and its features from the signed token, never the token', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const signed = token(3600);
      await mockApi(page, { plan: 'RESEARCH', pricingToken: signed });
      await page.goto('/pricing');
      const main = page.locator('main');

      await expect(main.getByText('Your current plan')).toHaveCount(1);
      await expect(main.getByRole('link', { name: 'Link CAS identity' })).toHaveCount(0);
      await expect(main.getByRole('link', { name: 'Manage identities' })).toHaveAttribute('href', '/app/account/identities');
      const mine = main.getByRole('region', { name: 'Available to your account' });
      await expect(mine).toBeVisible();
      await expect(mine.getByText('Read from your signed pricing token for the RESEARCH plan.')).toBeVisible();
      await expect(mine.getByRole('link', { name: 'See my usage' })).toHaveAttribute('href', '/app/account/usage');
      await expect(mine.getByText('Authoring', { exact: true }).locator('..')).toContainText('Enabled');
      await expect(mine.getByText('Solve', { exact: true }).locator('..')).toContainText('Not enabled');
      expect(await page.content()).not.toContain(signed);
      await mine.scrollIntoViewIfNeeded();
      await capture(page, testInfo, `pricing-${name}-research`);
      expect(critical).toEqual([]);
    });

    test('draws the long form of the document with pricing-renderer when asked', async ({ page }) => {
      test.skip(isMobile, 'A behaviour of the page, not of its layout: the desktop run covers it.');
      await mockApi(page);
      await page.goto('/pricing');

      await page.getByRole('button', { name: 'Show the full pricing document' }).click();
      const shell = page.locator('.pricing-renderer-shell');
      await expect(shell.locator('pricing-renderer[data-pr-root]')).toBeVisible();
      await expect(shell).toContainText('BASIC');
      await expect(shell).toContainText('PRO');
      await expect(page.getByRole('link', { name: 'SPHERE' })).toHaveAttribute('href', CURRENT_FIXTURE.url);
    });
  });
}
