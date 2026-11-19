import { expect as baseExpect, test } from '@playwright/test';
import { API, installMockApi } from './helpers/mockApi';

// J5 · start from a template: "New composition" lists the composition templates of the catalog (TomatoMeter composite, the
// fleet management system); starting one asks for the composition's and the problem's addresses, says a taken address at its
// field, and opens the new composition, whose Operation tab is empty until an admin creates an environment. With SPHERE
// turned off, the TomatoMeter card stays listed, disabled, with its reason. There is no backend: e2e/helpers/mockApi.ts
// answers with the gateway's catalog fixtures (src/test/fixtures/core/templates.json, template.tomatometer.json).

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

test.describe('J5 · start from a template', () => {
  test('a member starts TomatoMeter from its template under a free address, and lands on its Overview', async ({
    page,
  }) => {
    const mock = await installMockApi(page, 'admin', { tomatometer: true });
    await page.goto('/compositions/new?org=isa-demo');
    const templates = page.getByRole('region', { name: 'Start from a template' });
    await expect(
      templates.getByRole('article', { name: 'Template Fleet management system' })
    ).toBeVisible();
    const card = templates.getByRole('article', { name: 'Template TomatoMeter composite' });
    await expect(card).toContainText('Uses SPHERE · has an offering');
    await expect(card).toContainText('dailySummary');
    await card.getByRole('button', { name: 'Use this template' }).click();

    const dialog = page.getByRole('dialog', { name: 'Start from TomatoMeter composite' });
    await expect(dialog.getByRole('textbox', { name: 'Composition address' })).toHaveValue(
      'tomatometer'
    );
    await expect(dialog.getByRole('textbox', { name: 'Problem address' })).toHaveValue(
      'tomatometer-email'
    );
    await expect(dialog).toContainText('TomatoMeter e-mail with its 3 versions');
    await dialog.getByRole('button', { name: 'Start the composition' }).click();
    await expect(
      dialog.getByText('tomatometer is already a composition of ISA Demo Group.')
    ).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Composition address' }).fill('tm-demo');
    await dialog.getByRole('textbox', { name: 'Problem address' }).fill('tm-demo-email');
    await dialog.getByRole('button', { name: 'Start the composition' }).click();

    await expect(page).toHaveURL('/compositions/isa-demo/tm-demo');
    await expect(
      page.getByText(/started from the TomatoMeter composite template, version 1\.0\.0 sealed/)
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Composition sections' })
      .getByRole('link', { name: 'Operation' })
      .click();
    await expect(page.getByText('No environments yet')).toBeVisible();
    expect(mock.unmocked).toEqual([]);
  });

  test('with SPHERE turned off, the TomatoMeter template is listed disabled with its reason', async ({
    page,
  }) => {
    await installMockApi(page, 'admin');
    await page.route(`${API}/v1/compositions/templates`, route =>
      route.fulfill({
        json: {
          templates: [
            {
              id: 'tomatometer',
              title: 'TomatoMeter composite',
              summary: 'TomatoMeter’s back end.',
              kind: 'application',
              tasks: ['login', 'dailySummary', 'export', 'quotes'],
              hasOffering: true,
              available: false,
              unavailableReason: 'sphere_disabled',
            },
          ],
        },
      })
    );
    await page.goto('/compositions/new?org=isa-demo');
    const card = page.getByRole('article', { name: 'Template TomatoMeter composite' });
    await expect(card.getByRole('button', { name: 'Use this template' })).toBeDisabled();
    await expect(card).toContainText('It reads SPHERE, which this installation has turned off.');
  });
});
