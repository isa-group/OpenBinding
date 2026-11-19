import {
  expect as baseExpect,
  test,
  type Page,
  type Request,
  type Route,
  type TestInfo,
} from '@playwright/test';
import { failureBody } from './helpers/problems';
import { PLANS_PRICING_FIXTURE } from '../src/test/fixtures/plansPricing';
import { AGREEMENT_PRICING_FIXTURE } from '../src/test/fixtures/agreementPricing';
import { authConfig, signedIn } from './helpers/session';

// S3 · pub-pricing /pricing: SPHERE's hero, the document drawn by pricing-renderer through the bridge, and OpenBinding's
// comparison and explainers as cards; the API answered by page.route() (there is no backend).
// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be looked at after a run.

const API = 'http://localhost:8000';

// Eight browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

const json =
  (body: unknown, status = 200) =>
  (route: Route) =>
    route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  json(failureBody(status, code, error, extra), status);

/** A pricing token shaped like the gateway's, with two features evaluated and any further claims. */
const token = (expiresInSeconds: number, claims: Record<string, unknown> = {}) =>
  [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64'),
    Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
        features: { 'openbinding-runs': { eval: true }, 'openbinding-studies': { eval: false } },
        ...claims,
      })
    ).toString('base64'),
    'signature',
  ].join('.');

const account = (plan: string) => ({
  id: 'user-1',
  username: 'lucia',
  email: 'lucia@example.org',
  role: 'user',
  is_active: true,
  plan,
  created_at: '2026-03-02T00:00:00Z',
  cas_verified: plan === 'RESEARCH',
});

interface Mocks {
  /** Signed in with this plan. Omit for a visitor. */
  plan?: string;
  pricing?: (route: Route) => Promise<void> | void;
  pricingToken?: string;
}

async function mockApi(page: Page, mocks: Mocks = {}) {
  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await authConfig(page);
  await page.route(`${API}/v1/plans/pricing`, mocks.pricing ?? json(PLANS_PRICING_FIXTURE));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  if (mocks.plan) {
    await signedIn(page, 'pricing-access');
    await page.route(`${API}/v1/users/me`, json(account(mocks.plan)));
    await page.route(
      `${API}/v1/users/me/pricing-token`,
      json({ pricing_token: mocks.pricingToken ?? token(3600) })
    );
    await page.route(`${API}/v1/notifications**`, json([]));
    await page.route(url => url.origin + url.pathname === `${API}/v1/organizations`, json([]));
  }
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

/** Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save a full-page picture of the current state for a person to look at. */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
  if (process.env.E2E_SCREENSHOTS)
    await page.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
}

test.setTimeout(60_000);

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
  test.describe(`${name} · pub-pricing`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('a visitor reads the live catalog: no price, no checkout, the three limit outcomes', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const requested: string[] = [];
      page.on('request', (request: Request) => requested.push(request.url()));
      await mockApi(page);
      await page.goto('/pricing');
      const main = page.locator('main');

      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(
        main.getByRole('heading', { level: 1, name: 'Plans for every kind of binding work' })
      ).toBeVisible();
      await expect(main.getByText(/Pricing version\s+0\.2\.0/)).toBeVisible();
      await expect(main.getByText('Published Oct 22, 2026')).toBeVisible();
      await expect(main.getByText('EUR · monthly periods')).toBeVisible();
      await expect(main).not.toContainText(/fingerprint|sha256-|[0-9a-f]{12}/i);
      await expect(main.getByText('Development pricing.')).toBeVisible();

      // The document, drawn by pricing-renderer through the bridge's commercial preset, under the page's own title.
      const renderer = main.locator('pricing-renderer[data-pr-root]');
      await expect(renderer).toBeVisible();
      await expect(renderer.locator('[data-pr-part="hero"]')).toHaveCount(0);
      await expect(renderer).toContainText('FREE');
      await expect(renderer).toContainText('LAB');

      // Three plans in the order of the document; the paid one is an agreement, never a price.
      const plans = main.getByRole('list', { name: 'Plans' });
      await expect(plans.getByRole('listitem')).toHaveCount(3);
      await expect(plans.getByText('Contact us', { exact: true })).toHaveCount(2);
      await expect(plans.getByText('institutional agreement')).toHaveCount(1);
      await expect(plans.getByRole('link', { name: 'Sign up' })).toHaveAttribute(
        'href',
        '/authentication?view=register'
      );
      await expect(main.getByRole('link', { name: 'Log in with CAS' }).first()).toHaveAttribute(
        'href',
        '/authentication'
      );
      // No price but nothing: the free plans may read €0 in the drawn document, a plan by agreement never has a figure.
      expect(await main.innerText()).not.toMatch(/[€$]\s?[1-9]/);
      expect(
        await main.getByRole('region', { name: 'Plans side by side' }).innerText()
      ).not.toMatch(/[€$]\s?\d/);
      await expect(renderer.locator('[data-pr-part="summary"]')).toHaveCount(0);

      // Monthly limits are open: the rounded figure with the exact one underneath.
      const monthly = main.getByRole('table', { name: 'Monthly: Renew each month' });
      await expect(monthly.getByRole('row', { name: /Generated instances/ })).toContainText(
        '1,000'
      );
      await expect(monthly.getByRole('row', { name: /Solver hours/ })).toContainText('10,000 h');
      await capture(page, testInfo, `pricing-${name}-visitor`);
      if (isMobile) {
        // The plans stack instead of scrolling: the page is as wide as the device, the matrix has nothing to scroll, and no plan is cut off.
        const fit = await page.evaluate(deviceWidth => {
          const scroller = document.querySelector('[data-part="matrix-scroller"]') as HTMLElement;
          const reach = (selector: string) =>
            Math.max(
              ...Array.from(document.querySelectorAll(selector)).map(
                element => element.getBoundingClientRect().right
              )
            );
          return {
            page: document.documentElement.scrollWidth - deviceWidth,
            scroller: scroller.scrollWidth - scroller.clientWidth,
            tiles: reach('[data-part="plan-tile"]') - deviceWidth,
            cells: reach('[data-part="matrix-table"] td') - deviceWidth,
          };
        }, viewport.width);
        expect(fit.page, 'the page should not scroll sideways').toBeLessThanOrEqual(1);
        expect(fit.scroller, 'the matrix should not scroll sideways').toBeLessThanOrEqual(1);
        expect(fit.tiles, 'no plan tile should be cut off on the right').toBeLessThanOrEqual(0);
        expect(fit.cells, 'no value should be cut off on the right').toBeLessThanOrEqual(0);
        await expect(plans.getByRole('listitem')).toHaveCount(3);
        expect(critical).toEqual([]);
        return;
      }

      await main.getByRole('button', { name: /Per request/ }).click();
      const perRequest = main.getByRole('table', { name: 'Per request: Ceilings for each run' });
      await expect(perRequest.getByText('24 h', { exact: true })).toBeVisible();
      await expect(perRequest.getByText('1,440 min', { exact: true })).toBeVisible();
      await main.getByRole('button', { name: 'LAB', exact: true }).click();
      await expect(main.getByRole('button', { name: 'LAB', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await expect(page.locator('[data-part="plan-tile"][data-picked]')).toHaveCount(1);

      await main
        .getByRole('heading', { name: 'What has to have room before you start' })
        .scrollIntoViewIfNeeded();
      await expect(main.getByText('Start a run', { exact: true })).toBeVisible();
      await expect(main.getByText('Solver hours left this month').first()).toBeVisible();
      await expect(main.getByRole('heading', { name: 'Add-ons' })).toHaveCount(0);
      for (const outcome of ['Reduced', 'Wait', 'Rejected'])
        await expect(main.getByText(outcome, { exact: true })).toBeVisible();

      // The published pricing is read once, from /v1/plans/pricing; the retired keyed proxy is never asked.
      expect(requested.filter(url => url.startsWith(`${API}/v1/pricing`))).toEqual([]);
      expect(requested).toContain(`${API}/v1/plans/pricing`);
      expect(critical).toEqual([]);
    });

    test('Contact us opens a dialog that sends nothing', async ({ page }, testInfo) => {
      await mockApi(page);
      const posts: string[] = [];
      page.on('request', request => {
        // Every page asks the session route whether there is a session when it loads; the dialog sends nothing.
        if (
          ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
          !request.url().endsWith('/v1/auth/identity/session')
        )
          posts.push(request.url());
      });
      await page.goto('/pricing');

      // The comparison's action; the drawn document's opens the same dialog (below).
      const contact = page
        .getByRole('list', { name: 'Plans' })
        .getByRole('button', { name: 'Contact us' })
        .first();
      await contact.focus();
      await contact.click();
      const dialog = page.getByRole('dialog', { name: 'Ask about LAB' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/This page doesn’t send anything/)).toBeVisible();
      await capture(page, testInfo, `pricing-${name}-contact`);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(contact).toBeFocused();
      expect(posts).toEqual([]);
    });

    test('says what it cannot show: loading, pricing unavailable, digest mismatch', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      await mockApi(page, {
        pricing: async route => {
          await gate;
          await json(PLANS_PRICING_FIXTURE)(route);
        },
      });
      await page.goto('/pricing');
      const main = page.locator('main');

      await expect(main.locator('[aria-busy="true"]')).toBeVisible();
      await expect(main.getByRole('list', { name: 'Plans' })).toHaveCount(0);
      await capture(page, testInfo, `pricing-${name}-loading`);
      release();
      await expect(main.getByRole('list', { name: 'Plans' })).toBeVisible();
      if (isMobile) return;

      await page.unroute(`${API}/v1/plans/pricing`);
      await page.route(
        `${API}/v1/plans/pricing`,
        detail(503, 'pricing_unavailable', 'SPHERE is not reachable.')
      );
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('503 · pricing_unavailable');
      await expect(main.locator('pricing-renderer')).toHaveCount(0);
      await expect(main.getByRole('list', { name: 'Plans' })).toHaveCount(0);
      await capture(page, testInfo, `pricing-${name}-503`);

      await page.unroute(`${API}/v1/plans/pricing`);
      await page.route(
        `${API}/v1/plans/pricing`,
        detail(
          502,
          'pricing_digest_mismatch',
          'SPHERE content no longer matches the release digest.'
        )
      );
      await page.reload();
      await expect(main.getByRole('alert')).toContainText('502 · pricing_digest_mismatch');

      // Retrying once the pricing is back shows the plans without a reload.
      await page.unroute(`${API}/v1/plans/pricing`);
      await page.route(`${API}/v1/plans/pricing`, json(PLANS_PRICING_FIXTURE));
      await main.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
      await expect(main.getByRole('list', { name: 'Plans' })).toBeVisible();
      expect(critical).toEqual([]);
    });

    test('a signed-in RESEARCH account sees its plan marked and its features from the signed token, never the token', async ({
      page,
    }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const signed = token(3600);
      await mockApi(page, { plan: 'RESEARCH', pricingToken: signed });
      await page.goto('/pricing');
      const main = page.locator('main');

      await expect(main.getByText('Your current plan')).toHaveCount(1);
      await expect(main.getByRole('link', { name: 'Link CAS identity' })).toHaveCount(0);
      await expect(
        main.locator('pricing-renderer [data-pr-part="plan-card"][data-current="true"]')
      ).toHaveCount(1);
      await expect(main.getByRole('link', { name: 'Manage identities' })).toHaveAttribute(
        'href',
        '/me/settings?section=integrations'
      );
      const mine = main.getByRole('region', { name: 'Available to your account' });
      await expect(mine).toBeVisible();
      await expect(
        mine.getByText('Read from your signed pricing token for the RESEARCH plan.')
      ).toBeVisible();
      await expect(mine.getByRole('link', { name: 'See your plan' })).toHaveAttribute(
        'href',
        '/me/settings?section=plan'
      );
      await expect(mine.getByText('Runs', { exact: true }).locator('..')).toContainText('Enabled');
      await expect(mine.getByText('Studies', { exact: true }).locator('..')).toContainText(
        'Not enabled'
      );
      expect(await page.content()).not.toContain(signed);
      await mine.scrollIntoViewIfNeeded();
      await capture(page, testInfo, `pricing-${name}-research`);
      expect(critical).toEqual([]);
    });

    test('every plan of the drawn document offers what the comparison offers for it', async ({
      page,
    }) => {
      test.skip(isMobile, 'A behaviour of the page, not of its layout: the desktop run covers it.');
      await mockApi(page);
      await page.goto('/pricing');

      const renderer = page.locator('pricing-renderer[data-pr-root]');
      await expect(renderer).toBeVisible();
      await expect(page.getByRole('link', { name: 'SPHERE' })).toHaveAttribute(
        'href',
        PLANS_PRICING_FIXTURE.permanentUrl
      );
      await expect(renderer.locator('[data-pr-slot="plan-cta"]')).toHaveText([
        'Sign up',
        'Log in with CAS',
        'Contact us',
      ]);
      await expect(renderer.locator('[data-pr-part="cta"]')).toHaveCount(0);
      await renderer
        .locator('[data-pr-slot="plan-cta"]')
        .nth(2)
        .getByRole('button', { name: 'Contact us' })
        .click();
      await expect(page.getByRole('dialog', { name: 'Ask about LAB' })).toBeVisible();
      await page.getByRole('button', { name: 'Got it' }).click();
    });

    test('in the drawn document, a change of plan that drops an add-on asks first', async ({
      page,
    }) => {
      test.skip(isMobile, 'A behaviour of the page, not of its layout: the desktop run covers it.');
      // The published pricing has no add-ons; the synthetic agreement catalog has four plans and add-ons to drop.
      await mockApi(page, { pricing: json(AGREEMENT_PRICING_FIXTURE) });
      await page.goto('/pricing');
      const renderer = page.locator('pricing-renderer[data-pr-root]');
      await expect(renderer).toBeVisible();

      // The confirmation is a dialog centred on the viewport, not on the section.
      const cards = renderer.locator('[data-pr-part="plan-card"]');
      await cards.nth(3).locator('[data-pr-part="selection-control"]').click();
      await renderer
        .locator('[data-pr-part="add-on-card"]')
        .filter({ hasText: /federation/i })
        .locator('[data-pr-part="selection-control"]')
        .click();
      await cards.nth(1).locator('[data-pr-part="selection-control"]').click();
      const confirm = page.getByRole('dialog', { name: 'Review configuration changes' });
      await expect(confirm).toBeVisible();
      const box = (await confirm.boundingBox())!;
      expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(4);
      await confirm.getByRole('button', { name: 'Cancel' }).click();
    });

    test('marks the plan and add-ons of the account in the drawn document', async ({ page }) => {
      test.skip(isMobile, 'A behaviour of the page, not of its layout: the desktop run covers it.');
      const subscription = {
        contractedServices: { openbinding: PLANS_PRICING_FIXTURE.version },
        subscriptionPlans: { openbinding: 'PRO' },
        subscriptionAddOns: { openbinding: { STORAGE_PACK: 2 } },
        contractVersion: '4',
      };
      // The published pricing has no add-ons; the synthetic agreement catalog has them.
      await mockApi(page, {
        plan: 'PRO',
        pricingToken: token(3600, { subscription }),
        pricing: json(AGREEMENT_PRICING_FIXTURE),
      });
      await page.goto('/pricing');

      const renderer = page.locator('pricing-renderer[data-pr-root]');
      const cards = renderer.locator('[data-pr-part="plan-card"]');
      await expect(cards.nth(3)).toHaveAttribute('data-current', 'true');
      await expect(
        renderer.locator('[data-pr-part="add-on-card"][data-current="true"]')
      ).toHaveCount(1);
      await expect(
        renderer.locator('[data-pr-part="add-on-card"][data-current="true"]')
      ).toContainText(/storage/i);
      await expect(renderer.locator('[data-pr-slot="plan-cta"]')).toHaveText([
        '',
        'Contact us',
        'Link CAS identity',
        '',
      ]);
      await expect(renderer).not.toContainText(/Upgrade|Downgrade|Review change/);
    });
  });
}
