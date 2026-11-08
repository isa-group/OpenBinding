import { expect as baseExpect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { failureBody } from './helpers/problems';
import type { AdminUserView } from '../src/api/auth';
import { CURRENT_FIXTURE, catalogFixture } from '../src/pages/Pricing/pricingFixture';
import { ALEX, SAM, USERS, subscriptionOf, usageOf } from '../src/test/fixtures/admin';

// admin-user-detail /app/admin/users/:user · the review of a subscription change, drawn by pricing-renderer's <pricing-change-review>.
// In jsdom the element never takes its properties, so this is where its drawing is checked: plan, price, add-ons, features and limits
// side by side, Back to the form and Confirm to the gateway. There is no backend: the API origin is answered by page.route(), and the
// signed-in account is a platform administrator. With E2E_SCREENSHOTS=1, pictures go to testInfo.outputPath() (test-results/).

const API = 'http://localhost:8000';

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

type Handler = (route: Route) => Promise<void> | void;
const json = (body: unknown, status = 200): Handler => (route) => route.fulfill({ status, json: body });
const detail = (status: number, code: string, error: string): Handler => json(failureBody(status, code, error), status);
const bodyOf = (route: Route) => route.request().postDataJSON() as Record<string, unknown>;

const token = (expiresInSeconds: number) => [
  'header',
  Buffer.from(JSON.stringify({ sub: ALEX.id, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString('base64'),
  'signature',
].join('.');

interface Sent {
  subscription: Array<{ id: string; body: Record<string, unknown>; ifMatch: string | null }>;
  plan: Array<{ id: string; plan: string; ifMatch: string | null }>;
}

/** An answer with the `ETag` of a subscription, which the page can read across origins because the gateway exposes it. */
const withEtag = (status: number, body: unknown, etag: string): Handler => (route) => route.fulfill({
  status, json: body, headers: { ETag: etag, 'Access-Control-Expose-Headers': 'ETag' },
});

/**
 * What the account screen reads and writes, answered; anything else on the API origin is an empty 404. A subscription has a revision,
 * as in the gateway: a write that names another one is refused with 412 and changes nothing. Returns what was sent, and a way to change
 * a subscription from somewhere else (another administrator).
 */
async function mockApi(page: Page): Promise<{ sent: Sent; changeElsewhere: (id: string, plan: string) => void }> {
  const sent: Sent = { subscription: [], plan: [] };
  const users: AdminUserView[] = structuredClone(USERS);
  const addOns: Record<string, Record<string, number>> = {};
  const revisions: Record<string, number> = {};
  const etagOf = (id: string) => `"contract-${revisions[id] ?? 1}"`;
  const moved = (id: string) => { revisions[id] = (revisions[id] ?? 1) + 1; };
  const stale = (ifMatch: string | null, id: string) => ifMatch !== null && ifMatch !== etagOf(id);
  const precondition = (id: string) => withEtag(412, failureBody(412, 'precondition_failed', 'The resource changed since it was read; fetch it again and retry.'), etagOf(id));

  await page.addInitScript(() => {
    localStorage.setItem('openbinding-access-token', 'review-access');
    localStorage.setItem('openbinding-refresh-token', 'review-refresh');
  });

  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/health**`, json({ status: 'ok' }));
  await page.route(`${API}/v1/auth/refresh`, json({ access_token: 'review-access-2', refresh_token: 'review-refresh-2', token_type: 'bearer', expires_in: 900 }));
  await page.route(`${API}/v1/pricing/catalog`, json(catalogFixture));
  await page.route(`${API}/v1/pricing/current`, json(CURRENT_FIXTURE));
  await page.route(`${API}/v1/users/me`, json({ ...ALEX, institutional_branding: false }));
  await page.route(`${API}/v1/users/me/usage`, json(usageOf('PRO')));
  await page.route(`${API}/v1/users/me/pricing-token`, json({ pricing_token: token(3600) }));
  await page.route(new RegExp(`^${API}/v1/notifications(\\?.*)?$`), json([]));
  await page.route(new RegExp(`^${API}/v1/organizations(/.*)?(\\?.*)?$`), json([]));

  await page.route(new RegExp(`^${API}/v1/admin/.*`), async (route) => {
    const parts = new URL(route.request().url()).pathname.slice('/v1/admin/'.length).split('/');
    const method = route.request().method();
    const account = parts[0] === 'users' ? users.find((user) => user.id === parts[1]) : undefined;
    const rest = parts.slice(2).join('/');
    if (!account) return detail(404, 'not_found', 'not mocked')(route);
    const ifMatch = route.request().headers()['if-match'] ?? null;
    if (rest === 'subscription' && method === 'GET') return withEtag(200, subscriptionOf(account, addOns[account.id] ?? {}), etagOf(account.id))(route);
    if (rest === 'subscription' && method === 'POST') {
      const body = bodyOf(route);
      sent.subscription.push({ id: account.id, body, ifMatch });
      if (stale(ifMatch, account.id)) return precondition(account.id)(route);
      if (body.plan === 'RESEARCH' && !account.cas_verified) {
        return detail(409, 'research_requires_us_cas', 'RESEARCH requires a verified Universidad de Sevilla CAS identity.')(route);
      }
      account.plan = String(body.plan);
      addOns[account.id] = body.add_ons as Record<string, number>;
      moved(account.id);
      return withEtag(200, { ...subscriptionOf(account, addOns[account.id]), changed: true }, etagOf(account.id))(route);
    }
    if (rest === 'plan' && method === 'POST') {
      const body = bodyOf(route);
      sent.plan.push({ id: account.id, plan: String(body.plan), ifMatch });
      if (stale(ifMatch, account.id)) return precondition(account.id)(route);
      account.plan = String(body.plan);
      moved(account.id);
      return withEtag(200, account, etagOf(account.id))(route);
    }
    if (rest === 'usage') return json(usageOf(account.plan))(route);
    return detail(404, 'not_found', 'not mocked')(route);
  });
  return {
    sent,
    changeElsewhere: (id, plan) => {
      const account = users.find((user) => user.id === id);
      if (!account) throw new Error(`no account ${id} in this mock`);
      account.plan = plan;
      moved(id);
    },
  };
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
 * Check that nothing scrolls sideways and, with E2E_SCREENSHOTS=1, save what the screen shows for a person to look at: the viewport
 * as it is, since a picture of the whole review would stitch its sticky actions and the site header into the middle of it.
 */
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' });
  // Against the width of the device, not window.innerWidth: a phone widens its layout viewport to fit a page that overflows.
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((expected) => document.documentElement.scrollWidth - expected, width);
  expect(overflow, `${name} should not scroll sideways`).toBeLessThanOrEqual(1);
}

/** The row of the review that names `name`, inside one of its sections. */
const row = (section: Locator, name: string) => section.locator('[data-pr-part="change-row"]').filter({ has: section.page().getByText(name, { exact: true }) });

test.setTimeout(120_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} · admin-user-detail change review`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('an administrator sees plan, price, add-ons, features and limits change side by side, goes back, then confirms', async ({ page }, testInfo) => {
      const critical = watchCriticalErrors(page);
      const { sent } = await mockApi(page);
      await page.goto(`/app/admin/users/${SAM.id}`);
      const main = page.locator('#platform-main');
      await expect(main.getByRole('heading', { level: 1, name: 'sam.okafor', exact: true })).toBeVisible();

      const plans = main.getByRole('radiogroup', { name: 'New plan' });
      await plans.getByRole('radio', { name: /^ADVANCED/ }).click();
      await main.getByRole('button', { name: 'More collaboration pack' }).click();
      await main.getByLabel(/^Detail/).fill('Agreement 2026-14');
      await main.getByRole('button', { name: 'Apply agreement', exact: true }).click();

      // The review replaces the form, takes the focus on its heading, and nothing has been sent yet.
      const review = main.locator('pricing-change-review');
      await expect(main.getByRole('region', { name: 'Review the change for sam.okafor' })).toBeVisible();
      await expect(review.locator('[data-pr-part="review-title"]')).toBeFocused();
      await expect(plans).toHaveCount(0);
      expect(sent.subscription).toEqual([]);

      // The plan, without an Upgrade or Downgrade badge: OpenBinding's plans are not a ladder.
      const plan = review.locator('[data-pr-part="review-plan"]');
      await expect(plan).toContainText('BASIC → ADVANCED');
      await expect(plan.locator('[data-pr-part="change-badge"]')).toHaveCount(0);
      await expect(review).not.toContainText(/Upgrade|Downgrade/);

      // The price as the document gives it: BASIC is free, ADVANCED is arranged by agreement, so no difference is claimed.
      const price = review.locator('[data-pr-part="review-price"]');
      await expect(price).toContainText('€0');
      await expect(price).toContainText('By agreement');
      await expect(price).toContainText('No difference is shown: paid plans and add-ons are arranged by agreement.');
      await expect(price.locator('[data-pr-part="price-difference"]')).toHaveCount(0);

      // Add-ons, features and limits under the names the form uses, in the words of the interface.
      await expect(row(review.locator('[data-pr-part="review-add-ons"]'), 'Collaboration pack')).toContainText('Added');
      await expect(row(review.locator('[data-pr-part="review-features"]'), 'Advanced analytics')).toContainText('Gained');
      const limits = review.locator('[data-pr-part="review-limits"]');
      await expect(row(limits, 'Concurrent runs')).toContainText('1 run → 2 runs (+1 run)');
      await expect(row(limits, 'API keys')).toContainText('1 key → 15 keys (+14 keys)');
      await expect(row(limits, 'Projects')).toContainText('3 projects → 35 projects (+32 projects)');
      await expect(review).not.toContainText(/\bjobs?\b/i);
      await expect(review.locator('[data-pr-part="review-unchanged"]')).toContainText('10 features and 0 usage limits stay the same.');

      // What the request carries besides the contract.
      const notices = review.locator('[data-pr-part="review-notices"]');
      await expect(notices).toContainText('Reason: institutional agreement. Detail: “Agreement 2026-14”.');
      await expect(notices).toContainText('sam.okafor is notified, and the change is recorded in the audit log with your name.');

      // Confirm and Back stay reachable however tall the comparison is, and nothing above the review traps what it positions.
      const actions = review.locator('[data-pr-part="change-actions"]');
      await expect(actions).toHaveCSS('position', 'sticky');
      expect(await review.evaluate((element) => {
        const transformed: string[] = [];
        for (let node = element.parentElement; node; node = node.parentElement) {
          if (getComputedStyle(node).transform !== 'none') transformed.push(`${node.tagName.toLowerCase()}.${node.className}`);
        }
        return transformed;
      })).toEqual([]);
      await capture(page, testInfo, `change-review-${name}`);

      // Back returns to the form with every choice kept, and the focus on the button that opened the review.
      await actions.getByRole('button', { name: 'Back' }).click();
      await expect(review).toHaveCount(0);
      await expect(plans.getByRole('radio', { name: /^ADVANCED/ })).toBeChecked();
      await expect(main.getByLabel('Collaboration pack quantity')).toHaveText('1');
      await expect(main.getByLabel(/^Detail/)).toHaveValue('Agreement 2026-14');
      await expect(main.getByRole('button', { name: 'Apply agreement', exact: true })).toBeFocused();
      expect(sent.subscription).toEqual([]);

      // Confirm sends the request the form always sent, once, with the revision of the subscription the review was drawn from.
      await main.getByRole('button', { name: 'Apply agreement', exact: true }).click();
      await review.locator('[data-pr-part="review-confirm"]').click();
      await expect(main.getByText(/Agreement updated for sam\.okafor \(institutional agreement\)/)).toBeVisible();
      expect(sent.subscription).toEqual([{
        id: SAM.id,
        body: { plan: 'ADVANCED', add_ons: { COLLABORATION_PACK: 1 }, reason: 'institutional_agreement', detail: 'Agreement 2026-14' },
        ifMatch: '"contract-1"',
      }]);
      await expect(review).toHaveCount(0);
      await expect(main.getByRole('radio', { name: /^ADVANCED · current/ })).toBeChecked();
      expect(critical).toEqual([]);
    });

    test('an open limit reads as unlimited, a refusal stays in the review, and a plan change keeps the add-ons', async ({ page }) => {
      test.skip(isMobile, 'A behaviour of the review, not of its layout: the desktop run covers it.');
      const critical = watchCriticalErrors(page);
      const { sent } = await mockApi(page);
      await page.goto(`/app/admin/users/${SAM.id}`);
      const main = page.locator('#platform-main');
      const plans = main.getByRole('radiogroup', { name: 'New plan' });
      const review = main.locator('pricing-change-review');

      // PRO leaves API keys open (`.inf`, served as null): the review says Unlimited, never a dash.
      await plans.getByRole('radio', { name: /^PRO/ }).click();
      await main.getByRole('button', { name: 'Apply agreement', exact: true }).click();
      const limits = review.locator('[data-pr-part="review-limits"]');
      await expect(row(limits, 'API keys')).toContainText('1 key → Unlimited');
      await expect(row(limits, 'Max problem size')).toContainText('Unlimited');
      await expect(limits).not.toContainText('—');
      await review.locator('[data-pr-part="review-back"]').click();

      // RESEARCH needs a CAS identity: the refusal is said in the review, which keeps Confirm for another try.
      await plans.getByRole('radio', { name: /^RESEARCH/ }).click();
      await main.getByRole('button', { name: 'Apply agreement', exact: true }).click();
      await review.locator('[data-pr-part="review-confirm"]').click();
      const error = review.locator('[data-pr-part="review-error"]');
      await expect(error).toContainText('The change couldn’t be applied.');
      await expect(error).toContainText('RESEARCH needs a verified CAS identity (409 · research_requires_us_cas).');
      await expect(review.locator('[data-pr-part="review-confirm"]')).toBeFocused();
      await review.locator('[data-pr-part="review-back"]').click();
      await expect(main.getByText('RESEARCH needs a verified CAS identity (409 · research_requires_us_cas)')).toBeVisible();

      // “Plan only” is reviewed too, and sends the plan alone.
      await plans.getByRole('radio', { name: /^ADVANCED/ }).click();
      await main.getByRole('button', { name: 'Change plan only, keep add-ons' }).click();
      await expect(review.locator('[data-pr-part="review-plan"]')).toContainText('BASIC → ADVANCED');
      await expect(review.locator('[data-pr-part="review-notices"]')).toContainText('Reason: administrative decision. The add-ons stay as they are.');
      await review.getByRole('button', { name: 'Change plan' }).click();
      await expect(main.getByText(/Agreement updated for sam\.okafor \(administrative decision\)/)).toBeVisible();
      expect(sent.plan).toEqual([{ id: SAM.id, plan: 'ADVANCED', ifMatch: '"contract-1"' }]);
      expect(sent.subscription.map((request) => request.body.plan)).toEqual(['RESEARCH']);
      expect(critical).toEqual([]);
    });

    test('a change decided on a subscription that has moved is refused, the review says so and is drawn again, and only the administrator sends it again', async ({ page }) => {
      test.skip(isMobile, 'A behaviour of the review, not of its layout: the desktop run covers it.');
      const critical = watchCriticalErrors(page);
      const { sent, changeElsewhere } = await mockApi(page);
      await page.goto(`/app/admin/users/${SAM.id}`);
      const main = page.locator('#platform-main');
      const plans = main.getByRole('radiogroup', { name: 'New plan' });
      const review = main.locator('pricing-change-review');
      const plan = review.locator('[data-pr-part="review-plan"]');

      await plans.getByRole('radio', { name: /^ADVANCED/ }).click();
      await main.getByLabel(/^Detail/).fill('Agreement 2026-14');
      await main.getByRole('button', { name: 'Apply agreement', exact: true }).click();
      await expect(plan).toContainText('BASIC → ADVANCED');

      // Another administrator moves the account while this review is open, and the reading that follows is held for a moment.
      changeElsewhere(SAM.id, 'PRO');
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let holding = true;
      await page.route(`${API}/v1/admin/users/${SAM.id}/subscription`, async (route) => {
        if (route.request().method() === 'GET' && holding) {
          holding = false;
          await held;
        }
        await route.fallback();
      });
      await review.locator('[data-pr-part="review-confirm"]').click();

      const error = review.locator('[data-pr-part="review-error"]');
      await expect(error).toContainText('The change couldn’t be applied.');
      await expect(error).toContainText('The subscription changed meanwhile (412 · precondition_failed).');
      await expect(error).toContainText('so nothing was changed');
      await expect(main.getByText(/Agreement updated/)).toHaveCount(0);
      expect(sent.subscription.map((request) => request.ifMatch)).toEqual(['"contract-1"']);

      // While it is read again nothing can be confirmed, and the review says why.
      const confirm = review.locator('[data-pr-part="review-confirm"]');
      await expect(review.locator('[data-pr-part="review-status"]')).toHaveText('Reading the subscription again…');
      await expect(confirm).toHaveAttribute('aria-disabled', 'true');
      await expect(plan).toContainText('BASIC → ADVANCED');

      // Once it is read, the review compares with the subscription as it is and keeps the choices. It takes the focus on its heading,
      // far above the refusal, so the heading says what happened. Nothing has been sent again.
      release();
      await expect(plan).toContainText('PRO → ADVANCED');
      const title = review.locator('[data-pr-part="review-title"]');
      await expect(title).toBeFocused();
      await expect(title).toHaveText('Review the change for sam.okafor again: the subscription changed meanwhile, so nothing was changed');
      await expect(review.locator('[data-pr-part="review-status"]')).toHaveText('');
      await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
      await expect(error).toContainText('The subscription changed meanwhile (412 · precondition_failed).');
      expect(sent.subscription).toHaveLength(1);

      // Confirming again is the administrator's to do, with the revision of what the review now shows.
      await confirm.click();
      await expect(main.getByText(/Agreement updated for sam\.okafor \(institutional agreement\)/)).toBeVisible();
      expect(sent.subscription).toEqual([
        { id: SAM.id, body: { plan: 'ADVANCED', add_ons: {}, reason: 'institutional_agreement', detail: 'Agreement 2026-14' }, ifMatch: '"contract-1"' },
        { id: SAM.id, body: { plan: 'ADVANCED', add_ons: {}, reason: 'institutional_agreement', detail: 'Agreement 2026-14' }, ifMatch: '"contract-2"' },
      ]);
      await expect(review).toHaveCount(0);
      await expect(main.getByRole('radio', { name: /^ADVANCED · current/ })).toBeChecked();
      expect(critical).toEqual([]);
    });
  });
}
