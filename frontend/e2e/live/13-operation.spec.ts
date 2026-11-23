import { expect, test, type Page } from '@playwright/test';
import {
  API,
  FEED_CONSUMER,
  MAILPIT,
  ORG,
  adoptByApi,
  capture,
  consumerUntil,
  feedEtag,
  signInByApi,
  watchPageErrors,
} from './support';

/**
 * F4 against the lab: the operation of the seeded `lab-main/tomatometer` (its template, two versions, `production` with 1.0.0
 * adopted and a feed key, `staging` empty), as its owner, a member and a viewer.
 *
 * - J1: the Operation tab's cards and `production`'s detail (in effect, the margin per plan with a loss on the basic plan, the
 *   adoption history), read only: what the seed and the smoke adopted is not asserted by number;
 * - J3: "Check now" against the lab's SPHERE (its stand-in, F6-C, which serves Brevo, Dropbox, Resend and `sphere/tomatometer`
 *   as recorded plus any scenario published since, such as smoke step 19's TomatoMeter 1.2.0): each row is the latest or
 *   newer, with the copy its status says (never a fixed upstream release), and nothing moves;
 * - J2: the owner adopts 1.1.0 in production: the lab's feed consumer (TomatoMeter's stand-in) follows Resend, mails through
 *   it, and Mailpit finds the message tagged `provider-resend`; re-evaluating 1.0.0 moves neither the adoption nor the feed's
 *   ETag (read with the environment's own key, derived from the seed password as the seed derives it);
 * - a viewer sees no "Adopt" and no feed keys; then 1.0.0 is adopted back (also after a failure), so later walks start from
 *   the seed's state.
 */

test.describe.configure({ mode: 'serial' });

const COMPOSITION = 'tomatometer';
const OPERATION = `/compositions/${ORG}/${COMPOSITION}/operation`;
const ROOT = `${API}/v1/organizations/${ORG}/compositions/${COMPOSITION}`;

const card = (page: Page, name: string) =>
  page.locator('main').getByRole('article', { name: `Environment ${name}` });

/** The adoption number a card or a detail shows ("Adoption #3"). */
async function adoptionOf(text: Promise<string | null>): Promise<number> {
  const match = /Adoption #(\d+)/.exec((await text) ?? '');
  expect(match, 'an adoption number is shown').not.toBeNull();
  return Number(match![1]);
}

let ownerToken = '';

test.afterAll(async ({ playwright }) => {
  if (!ownerToken) return;
  const request = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? 'http://web:8080',
  });
  await adoptByApi(request, ownerToken, '1.0.0').catch(() => {});
  await request.dispose();
});

test('J1 · the owner reads the environments, what is in effect in production and its margins', async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  ownerToken = await signInByApi(page, 'owner');
  await adoptByApi(page.request, ownerToken, '1.0.0');
  await page.goto(OPERATION);
  await expect(page.getByRole('heading', { level: 2, name: 'Environments' })).toBeVisible();
  await expect(card(page, 'Production')).toContainText('In effect1.0.0');
  await expect(card(page, 'Production')).toContainText('Operator: ');
  await expect(card(page, 'Staging')).toBeVisible();
  await capture(page, testInfo, 'f4-operation');

  await card(page, 'Production').getByRole('link', { name: 'Production' }).click();
  const inEffect = page.getByRole('region', { name: 'In effect', exact: true });
  await expect(inEffect).toContainText('In effect: 1.0.0');
  await expect(inEffect.getByRole('list', { name: 'Binding in effect' })).toContainText(
    'email.brevo.professional'
  );
  const margins = page.getByRole('region', { name: 'Margin per plan' });
  await expect(margins.getByRole('row')).toHaveCount(8, { timeout: 30_000 });
  await expect(margins.locator('caption')).toContainText('1,000 users');
  await expect(margins.getByRole('row').nth(1)).toContainText('loss');
  await expect(page.getByRole('heading', { level: 3, name: 'Adoption history' })).toBeVisible();
  await expect(page.getByRole('listitem', { name: /^Adoption \d+$/ }).first()).toContainText(
    'In effect'
  );
  await expect(page.locator('main')).not.toContainText(/sha256-/);
  await capture(page, testInfo, 'f4-operation-detail');
  expect(errors).toEqual([]);
});

test('J3 · check now reads the sources against live SPHERE and changes nothing', async ({
  page,
}, testInfo) => {
  ownerToken = await signInByApi(page, 'owner');
  await page.goto(`${OPERATION}?environment=production`);
  const before = await adoptionOf(
    page.getByRole('region', { name: 'In effect', exact: true }).textContent()
  );
  const etag = await feedEtag(page.request);
  const sources = page.getByRole('region', { name: 'Sources' });
  const report = sources.getByRole('list', { name: 'Check report' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await sources.getByRole('button', { name: 'Check now' }).click();
    const busy = sources.getByRole('alert').filter({ hasText: /sphere_busy|busy/i });
    await expect(report.or(busy)).toBeVisible({ timeout: 60_000 });
    if (await report.isVisible()) break;
    await page.waitForTimeout(10_000);
  }
  await expect(report).toBeVisible();
  const rows = report.getByRole('listitem');
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    const text = (await row.textContent()) ?? '';
    if (/Latest$/.test(text)) expect(text).toMatch(/is the latest/);
    else if (/Newer$/.test(text)) expect(text).toMatch(/is newer than/);
    else if (/Valid$/.test(text)) expect(text).toMatch(/Valid on the installed toolchain/);
    else
      expect(text, 'each source is the latest, newer or the binding').toMatch(
        /Unavailable$|Not stored$/
      );
  }
  await expect(sources).toContainText('Nothing was changed.');
  await capture(page, testInfo, 'f4-check-result');
  expect(await feedEtag(page.request)).toBe(etag);
  await page.reload();
  expect(
    await adoptionOf(page.getByRole('region', { name: 'In effect', exact: true }).textContent())
  ).toBe(before);
});

test('J2 · adopting 1.1.0 switches the application to Resend, and a re-evaluation moves nothing', async ({
  page,
}, testInfo) => {
  ownerToken = await signInByApi(page, 'owner');
  await page.goto(OPERATION);
  const before = await adoptionOf(card(page, 'Production').textContent());
  await consumerUntil(page.request, state => state.provider === 'brevo');

  await card(page, 'Production').getByRole('button', { name: 'Adopt…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Adopt a version' });
  await expect(dialog).toContainText('In effect now: 1.0.0');
  await dialog.getByRole('radio', { name: /1\.1\.0/ }).check();
  await dialog.getByRole('textbox', { name: 'Note' }).fill('Switch to Resend (walk 13)');
  await expect(dialog).toContainText('The feed changes when you adopt');
  await capture(page, testInfo, 'f4-adopt-dialog');
  await dialog.getByRole('button', { name: 'Adopt 1.1.0' }).click();
  await expect(card(page, 'Production')).toContainText('In effect1.1.0');
  expect(await adoptionOf(card(page, 'Production').textContent())).toBe(before + 1);

  const state = await consumerUntil(page.request, current => current.provider === 'resend');
  expect(state.version).toBe('1.1.0');
  const sent = await page.request.post(`${FEED_CONSUMER}/send`, { data: {} });
  expect(sent.status()).toBe(200);
  const message = (await sent.json()) as { provider: string; messageId: string };
  expect(message.provider).toBe('resend');
  await expect
    .poll(
      async () => {
        const found = (await (
          await page.request.get(`${MAILPIT}/api/v1/search?query=tag:provider-resend`)
        ).json()) as { messages?: Array<{ ID: string }> };
        return (found.messages ?? []).some(item => item.ID === message.messageId);
      },
      { timeout: 30_000 }
    )
    .toBe(true);

  // Re-evaluating 1.0.0 moves neither the adoption nor the feed.
  const etag = await feedEtag(page.request);
  await page
    .getByRole('navigation', { name: 'Composition sections' })
    .getByRole('link', { name: 'Versions' })
    .click();
  const row = page.getByRole('listitem', { name: 'Version 1.0.0' });
  const reevaluate = row.getByRole('button', { name: 'Re-evaluate' });
  if (await reevaluate.count()) {
    await reevaluate.click();
    await expect(
      page.getByText(/Version 1\.0\.0 (re-evaluated|was already evaluated)/)
    ).toBeVisible({
      timeout: 60_000,
    });
  } else {
    const evaluated = await page.request.post(`${ROOT}/versions/1.0.0/evaluations`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect([200, 201]).toContain(evaluated.status());
  }
  expect(await feedEtag(page.request)).toBe(etag);
  await page.goto(OPERATION);
  expect(await adoptionOf(card(page, 'Production').textContent())).toBe(before + 1);

  await adoptByApi(page.request, ownerToken, '1.0.0');
  await consumerUntil(page.request, current => current.provider === 'brevo');
});

test('J1 · the owner creates an environment, shows a feed key once, revokes it and deletes the environment', async ({
  page,
}, testInfo) => {
  ownerToken = await signInByApi(page, 'owner');
  const slug = `canary-${Date.now().toString(36)}`;
  await page.goto(OPERATION);
  await page.getByRole('button', { name: 'New environment' }).click();
  const form = page.getByRole('dialog', { name: 'New environment' });
  await form.getByRole('textbox', { name: 'Name' }).fill('Canary');
  await form.getByRole('textbox', { name: 'Slug' }).fill(slug);
  await capture(page, testInfo, 'f4-environment-form');
  await form.getByRole('button', { name: 'Create environment' }).click();
  try {
    await page.goto(`${OPERATION}?environment=${slug}`);
    const feed = page.getByRole('region', { name: 'Feed', exact: true });
    await expect(feed).toContainText(`/environments/${slug}/composition`);
    await feed.getByRole('button', { name: 'Create key' }).click();
    await feed.getByRole('textbox', { name: 'Key label' }).fill('walk 13');
    await feed.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(feed.getByLabel('Secret')).toHaveText(/^obe_[0-9a-f]{8}_/);
    await capture(page, testInfo, 'f4-key-reveal');
    await feed.getByRole('button', { name: 'Dismiss' }).click();
    await expect(feed.getByLabel('Secret')).toHaveCount(0);
    const keys = feed.getByRole('list', { name: 'Feed keys' });
    await expect(keys).toContainText('never used');
    await capture(page, testInfo, 'f4-key-dismissed');
    await keys.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke key' }).click();
    await expect(keys).toContainText('Revoked');
  } finally {
    await page.goto(`${OPERATION}?environment=${slug}`);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const remove = page.getByRole('dialog', { name: 'Delete Canary?' });
    await remove.getByRole('textbox').fill(slug);
    await remove.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(card(page, 'Canary')).toHaveCount(0);
  }
});

test('a viewer reads the environments without Adopt or feed keys, and a member checks', async ({
  page,
  browser,
}) => {
  await signInByApi(page, 'viewer');
  await page.goto(OPERATION);
  await expect(card(page, 'Production')).toContainText('In effect');
  await expect(page.getByRole('button', { name: 'Adopt…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New environment' })).toHaveCount(0);
  await card(page, 'Production').getByRole('link', { name: 'Production' }).click();
  await expect(page.getByRole('region', { name: 'Feed', exact: true })).toContainText(
    '/environments/production/composition'
  );
  await expect(page.getByRole('list', { name: 'Feed keys' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check now' })).toHaveCount(0);

  const member = await browser.newPage();
  await signInByApi(member, 'member');
  await member.goto(`${OPERATION}?environment=production`);
  await expect(member.getByRole('button', { name: 'Check now' })).toBeVisible();
  // Production is adopted in by admins: a member is not offered it.
  await expect(member.getByRole('button', { name: 'Adopt…' })).toHaveCount(0);
  await expect(member.getByRole('list', { name: 'Feed keys' })).toHaveCount(0);
  await member.close();
});
