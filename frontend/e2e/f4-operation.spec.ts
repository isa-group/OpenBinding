import { expect as baseExpect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// J1 · operate a composition and J2 · switch the provider: TomatoMeter's Operation tab lists its environments as cards
// (production with 1.0.0 in effect, adoption #3; staging with nothing adopted), an environment's detail shows its adoption
// history, and adopting 1.1.0 in production sends the environment's ETag as If-Match and moves the card to 1.1.0, adoption #4,
// while a re-evaluation on the Versions tab moves nothing. There is no backend: e2e/helpers/mockApi.ts answers the API origin
// with the gateway's F4 fixtures (src/test/fixtures/core/tomatometer.*.json, e2e/helpers/operationMock.ts), and nothing
// reaches another origin.

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

const OPERATION = '/compositions/isa-demo/tomatometer/operation';

function watchOrigins(page: Page) {
  const outside: string[] = [];
  page.on('request', request => {
    const origin = new URL(request.url()).origin;
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) outside.push(request.url());
  });
  return outside;
}

const card = (page: Page, name: string) =>
  page.locator('main').getByRole('article', { name: `Environment ${name}` });

test.describe('J1 · operate a composition, J2 · switch the provider', () => {
  test('an admin reads the environments, adopts 1.1.0 in production and sees the history; a re-evaluation moves nothing', async ({
    page,
  }) => {
    const handle = await installMockApi(page, 'admin', { tomatometer: true });
    const outside = watchOrigins(page);
    await page.goto(OPERATION);

    await expect(page.getByRole('heading', { level: 2, name: 'Environments' })).toBeVisible();
    await expect(card(page, 'Production')).toContainText('In effect1.0.0');
    await expect(card(page, 'Production')).toContainText('Adoption #3');
    await expect(card(page, 'Production')).toContainText('Operator: fixtures');
    await expect(card(page, 'Staging')).toContainText('Nothing adopted yet');

    // J2: adopt 1.1.0 in production, from the card.
    await card(page, 'Production').getByRole('button', { name: 'Adopt…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Adopt a version' });
    await expect(dialog.getByRole('combobox', { name: 'Environment' })).toHaveValue('production');
    await expect(dialog).toContainText('In effect now: 1.0.0 (adoption #3).');
    await expect(dialog.getByRole('radio', { name: /1\.0\.0/ })).toBeDisabled();
    await dialog.getByRole('radio', { name: /1\.1\.0/ }).check();
    await dialog.getByRole('textbox', { name: 'Note' }).fill('Switch to Resend');
    await expect(dialog).toContainText(
      'The feed changes when you adopt: the application reads 1.1.0 on its next poll.'
    );
    await dialog.getByRole('button', { name: 'Adopt 1.1.0' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Version 1.1.0 adopted in Production')).toBeVisible();
    await expect(card(page, 'Production')).toContainText('In effect1.1.0');
    await expect(card(page, 'Production')).toContainText('Adoption #4');
    const sent = handle.operation?.adopted.at(-1);
    expect(sent?.environment).toBe('production');
    expect(sent?.ifMatch).toMatch(/^"env-production-\d+"$/);

    // The detail: the history, newest first, with the version it replaced and the way to compare them.
    await card(page, 'Production').getByRole('link', { name: 'Production' }).click();
    await expect(page).toHaveURL(/\?environment=production$/);
    const latest = page.getByRole('listitem', { name: 'Adoption 4' });
    await expect(latest).toContainText('1.0.0 → 1.1.0');
    await expect(latest).toContainText('In effect');
    await expect(latest).toContainText('Switch to Resend');
    await expect(latest.getByRole('link', { name: 'Compare previous' })).toHaveAttribute(
      'href',
      '/compositions/isa-demo/tomatometer/versions?from=1.0.0&to=1.1.0'
    );
    await expect(page.getByRole('listitem', { name: 'Adoption 1' })).toContainText('Go live');

    // A re-evaluation on the Versions tab changes no adoption.
    await page
      .getByRole('navigation', { name: 'Composition sections' })
      .getByRole('link', { name: 'Versions' })
      .click();
    const row = page.getByRole('listitem', { name: 'Version 1.0.0' });
    await expect(row.getByRole('button', { name: 'Adopt…' })).toBeVisible();
    await row.getByRole('button', { name: 'Re-evaluate' }).click();
    await expect(
      page.getByText(/Version 1\.0\.0 (re-evaluated|was already evaluated)/)
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Composition sections' })
      .getByRole('link', { name: 'Operation' })
      .click();
    await expect(card(page, 'Production')).toContainText('In effect1.1.0');
    await expect(card(page, 'Production')).toContainText('Adoption #4');
    expect(handle.operation?.adopted).toHaveLength(1);

    expect(outside).toEqual([]);
    expect(handle.unmocked).toEqual([]);
  });

  test('a stale adoption offers to read the environment again instead of adopting over it', async ({
    page,
  }) => {
    const handle = await installMockApi(page, 'admin', { tomatometer: true });
    await page.goto(OPERATION);
    await card(page, 'Production').getByRole('button', { name: 'Adopt…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Adopt a version' });
    await expect(dialog).toContainText('In effect now: 1.0.0');
    // Somebody else adopts first: the ETag the dialog read is old now.
    await page.evaluate(async () => {
      const root =
        'http://localhost:8000/v1/organizations/isa-demo/compositions/tomatometer/environments/production';
      const headers = {
        Authorization: 'Bearer gallery-access',
        'Content-Type': 'application/json',
      };
      const read = await fetch(root, { headers });
      await fetch(`${root}/adopt`, {
        method: 'POST',
        headers: { ...headers, 'If-Match': read.headers.get('ETag') ?? '' },
        body: JSON.stringify({ version: '1.1.0', note: 'elsewhere' }),
      });
    });
    await dialog.getByRole('radio', { name: /1\.1\.0/ }).check();
    await dialog.getByRole('button', { name: 'Adopt 1.1.0' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Someone adopted in Production or changed it since you opened it.'
    );
    await dialog.getByRole('button', { name: 'Read it again' }).click();
    await expect(dialog).toContainText('In effect now: 1.1.0 (adoption #4).');
    await expect(dialog.getByRole('radio', { name: /1\.1\.0/ })).toBeDisabled();
    expect(handle.unmocked).toEqual([]);
  });
});
