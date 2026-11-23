import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  API,
  FEED_CONSUMER,
  LAUNCH_PATH,
  MAILPIT,
  ORG,
  capture,
  signInByApi,
  watchPageErrors,
} from './support';

/**
 * F4 against the lab, plan §14's F4 chain inside OpenBinding: problem → run → derive → adopt → the application sends with the
 * chosen provider.
 *
 * - J4: as `lab-member`, a random-search run of `tomatometer-email@3` is followed to its result, kept as the next version of
 *   `tomatometer` and adopted in `staging` (members adopt there) in the same step: the derive dialog's "Adopt in Staging in the
 *   same step" makes one proposal of both (F6), confirmed on its card in the same modal; then
 *   as `lab-owner` the run page's "Adopt in environment" adopts that same version in `production`, the environment with a
 *   consumer: the consumer follows that version and the provider of its `binding.dailySummary.candidate` (read from the
 *   version, never a fixed name), mails, and Mailpit's message carries `X-OpenBinding-Composition-Version` and
 *   `X-OpenBinding-Provider` of that version; 1.0.0 is adopted back (also after a failure);
 * - J5: the owner starts `tm-<run>` from the TomatoMeter template, lands on its Overview and its empty Operation tab; the
 *   composition is deleted afterwards and its problem kept.
 */

test.describe.configure({ mode: 'serial' });

const COMPOSITION = 'tomatometer';
const ROOT = `${API}/v1/organizations/${ORG}/compositions/${COMPOSITION}`;
const PRODUCTION = `${ROOT}/environments/production`;

const finishedResult = (page: Page) =>
  page.getByRole('region', { name: 'Run result' }).filter({
    has: page
      .getByRole('region', { name: 'Chosen providers' })
      .or(page.getByRole('heading', { level: 2, name: 'Why no combination works' })),
  });

let ownerToken = '';
let runPath = '';
let derived = '';
let made = '';

async function adoptByApi(request: APIRequestContext, token: string, label: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const read = await request.get(PRODUCTION, { headers });
  const view = (await read.json()) as { inEffect: { version: { label: string } } | null };
  if (view.inEffect?.version.label === label) return;
  const answer = await request.post(`${PRODUCTION}/adopt`, {
    headers: { ...headers, 'If-Match': read.headers()['etag'] ?? '' },
    data: { version: label, note: 'Back to the seed' },
  });
  expect(answer.status(), `adopt ${label}: ${await answer.text()}`).toBe(200);
}

test.afterAll(async ({ playwright }) => {
  if (!ownerToken) return;
  const request = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? 'http://web:8080',
  });
  await adoptByApi(request, ownerToken, '1.0.0').catch(() => {});
  if (made)
    await request
      .delete(`${API}/v1/organizations/${ORG}/compositions/${made}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
      .catch(() => {});
  await request.dispose();
});

test('J4 · a member keeps a run of revision 3 as the next version and adopts it in staging', async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const errors = watchPageErrors(page);
  await signInByApi(page, 'member');
  const main = page.locator('main');
  await page.goto(`${LAUNCH_PATH}&problem=tomatometer-email&revision=3`);
  await expect(
    main
      .getByRole('radiogroup', { name: 'Source' })
      .getByRole('radio', { name: /(TomatoMeter e-mail|tomatometer-email) · version 3/ })
  ).toBeChecked({ timeout: 30_000 });
  await main.getByRole('button', { name: 'Continue' }).click();
  const engines = main.getByRole('radiogroup', { name: 'Engine' });
  await expect(engines).toBeVisible({ timeout: 60_000 });
  await engines
    .getByRole('radio', { name: /^random-search/, disabled: false })
    .first()
    .check({ force: true });
  const iterations = main.getByLabel('Iterations').first();
  if (await iterations.count()) await iterations.fill('50');
  const isLaunch = (response: { url(): string; request(): { method(): string } }) =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith(`/v1/organizations/${ORG}/runs`);
  const [launched] = await Promise.all([
    page.waitForResponse(isLaunch),
    main.getByRole('button', { name: 'Send run' }).click(),
  ]);
  expect(launched.status(), await launched.text()).toBe(202);
  await main.getByRole('link', { name: 'Follow the run' }).click();
  await expect(finishedResult(page)).toBeVisible({ timeout: 300_000 });
  runPath = new URL(page.url()).pathname;

  await main.getByRole('button', { name: 'Keep as composition' }).click();
  const dialog = page.getByRole('dialog', { name: 'Derive a composition' });
  await dialog.getByRole('radio', { name: 'A composition of this organization' }).check();
  await dialog.getByLabel('Composition', { exact: true }).selectOption(COMPOSITION);
  await dialog.getByRole('button', { name: 'Next' }).click();
  derived = await dialog.getByLabel('Version label').inputValue();
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('region', { name: 'Derived composition.yaml' })).toContainText(
    'tomatometer-email@3',
    { timeout: 60_000 }
  );
  // A member is offered the environments members adopt in: staging only, beside sealing alone.
  await expect(dialog.getByRole('radio', { name: /^Adopt in .* in the same step$/ })).toHaveCount(
    1
  );
  await dialog.getByRole('radio', { name: 'Adopt in Staging in the same step' }).check();
  await capture(page, testInfo, 'f4-derive-adopt-step');
  await dialog.getByRole('button', { name: `Propose sealing and adopting ${derived}` }).click();
  const proposing = page.getByRole('dialog', { name: 'Derive and adopt' });
  const card = proposing.getByRole('group', { name: /^Proposal:/ });
  await expect(card).toContainText('Waiting for your confirmation', { timeout: 60_000 });
  await card.getByRole('button', { name: 'Confirm and apply' }).click();
  await expect(card).toContainText('Applied', { timeout: 120_000 });
  await proposing.getByRole('button', { name: 'Open Staging' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/compositions/${ORG}/${COMPOSITION}/operation\\?environment=staging$`)
  );
  await expect(page.getByRole('region', { name: 'In effect', exact: true })).toContainText(
    `In effect: ${derived}`
  );
  expect(errors).toEqual([]);
});

test('J4 · the owner adopts the run’s version in production and the application mails with its provider', async ({
  page,
}, testInfo) => {
  test.skip(!runPath || !derived, 'the member’s walk did not derive a version');
  ownerToken = await signInByApi(page, 'owner');
  const headers = { Authorization: `Bearer ${ownerToken}` };
  const version = (await (
    await page.request.get(`${ROOT}/versions/${derived}?include=document`, { headers })
  ).json()) as { document: { binding: Record<string, { candidate?: string }> } };
  const candidate = version.document.binding.dailySummary?.candidate ?? '';
  const provider = candidate.split('.')[1];
  expect(provider, `the derived version binds an e-mail candidate (${candidate})`).toBeTruthy();

  await page.goto(runPath);
  await page.locator('main').getByRole('button', { name: 'Adopt in environment' }).click();
  const adopt = page.getByRole('dialog', { name: 'Adopt a version' });
  await adopt.getByRole('combobox', { name: 'Environment' }).selectOption('production');
  await capture(page, testInfo, 'f4-run-adopt-dialog');
  await adopt.getByRole('button', { name: `Adopt ${derived}` }).click();
  await expect(
    page.getByText(
      new RegExp(`Version ${derived.replaceAll('.', '\\.')} of .* adopted in Production`)
    )
  ).toBeVisible();

  const view = (await (await page.request.get(PRODUCTION, { headers })).json()) as {
    inEffect: { adoption: number; version: { label: string } };
  };
  expect(view.inEffect.version.label).toBe(derived);
  await expect
    .poll(
      async () => {
        const state = (await (await page.request.get(`${FEED_CONSUMER}/state`)).json()) as {
          version?: string;
          provider?: string;
        };
        return `${state.version}/${state.provider}`;
      },
      { timeout: 30_000, intervals: [1_000] }
    )
    .toBe(`${derived}/${provider}`);
  const sent = await page.request.post(`${FEED_CONSUMER}/send`, { data: {} });
  expect(sent.status()).toBe(200);
  const message = (await sent.json()) as { messageId: string };
  let found: Array<{ ID: string }> = [];
  await expect
    .poll(
      async () => {
        const answer = (await (
          await page.request.get(
            `${MAILPIT}/api/v1/search?query=tag:adoption-${view.inEffect.adoption}`
          )
        ).json()) as { messages?: Array<{ ID: string }> };
        found = answer.messages ?? [];
        return found.some(item => item.ID === message.messageId);
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  const sentHeaders = (await (
    await page.request.get(`${MAILPIT}/api/v1/message/${message.messageId}/headers`)
  ).json()) as Record<string, string[]>;
  const header = (name: string) =>
    sentHeaders[name] ?? sentHeaders[name.replace('OpenBinding', 'Openbinding')] ?? [];
  expect(header('X-OpenBinding-Composition-Version')).toEqual([derived]);
  expect(header('X-OpenBinding-Provider')).toEqual([provider]);

  await adoptByApi(page.request, ownerToken, '1.0.0');
});

test('J5 · the owner starts a composition from the TomatoMeter template', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  ownerToken = await signInByApi(page, 'owner');
  const tag = (runPath.split('/').pop() ?? `${Date.now()}`).slice(0, 8).toLowerCase();
  made = `tm-${tag}`;
  await page.goto(`/compositions/new?org=${ORG}`);
  const card = page.getByRole('article', { name: 'Template TomatoMeter composite' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await capture(page, testInfo, 'f4-template-cards');
  await card.getByRole('button', { name: 'Use this template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start from TomatoMeter composite' });
  await dialog.getByRole('textbox', { name: 'Composition address' }).fill(made);
  await dialog.getByRole('textbox', { name: 'Problem address' }).fill(`${made}-email`);
  await capture(page, testInfo, 'f4-instantiate-dialog');
  await dialog.getByRole('button', { name: 'Start the composition' }).click();
  await expect(page).toHaveURL(`/compositions/${ORG}/${made}`, { timeout: 240_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'TomatoMeter' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Composition sections' })
    .getByRole('link', { name: 'Operation' })
    .click();
  await expect(page.getByText('No environments yet')).toBeVisible();
});
