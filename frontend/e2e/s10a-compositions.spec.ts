import { expect as baseExpect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// S10a · the compositions of an organization: composition-list (/app/:org/compositions) and the composition page composition-detail
// with its Overview, the catalog of the version shown. The smoke grows with the blocks that build the composition screens: list,
// create and overview here; the editor, the comparison of versions, analysis and settings later.
// There is no backend: e2e/helpers/mockApi.ts answers the API origin, with the compositions of e2e/helpers/mockCompositions.ts.

// Several browsers share one development server, so a screen can take longer than the default five seconds to settle.
const expect = baseExpect.configure({ timeout: 15_000 });

const LIST = '/app/isa-demo/compositions';
const main = (page: Page) => page.locator('#platform-main');
const region = (page: Page, name: string) => main(page).getByRole('region', { name, exact: true });

test.describe('S10a · compositions', () => {
  test('the header and the New menu lead to the compositions of the organization', async ({ page }) => {
    const mock = await installMockApi(page, 'admin');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/app/isa-demo');

    const header = page.getByRole('banner');
    await header.getByRole('link', { name: 'Compositions', exact: true }).click();
    await expect(page).toHaveURL(LIST);
    await expect(main(page).getByRole('heading', { level: 1, name: 'Compositions' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Compositions', exact: true })).toHaveAttribute('aria-current', 'page');

    await header.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('#app-new-menu').getByRole('link', { name: 'Composition', exact: true }).click();
    await expect(page).toHaveURL(`${LIST}?create=composition`);
    await expect(page.getByRole('dialog', { name: 'New composition' })).toBeVisible();
    expect(mock.unmocked).toEqual([]);
  });

  test('the list shows the active compositions, newest change first, and filters them by kind and state', async ({ page }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(LIST);

    const table = main(page).getByRole('table');
    const names = table.locator('tbody th a');
    await expect(names).toHaveText(['Fleet routing', 'Order desk']);
    const fleet = table.getByRole('row', { name: /Fleet routing/ });
    await expect(fleet).toContainText('Workflow');
    await expect(fleet).toContainText('1.2.0');
    await expect(fleet).toContainText('Linked to a problem');
    const order = table.getByRole('row', { name: /Order desk/ });
    await expect(order).toContainText('Declared');
    await expect(order).toContainText('Public');

    await main(page).getByRole('group', { name: 'Kind' }).getByRole('button', { name: 'Application' }).click();
    await expect(page).toHaveURL(`${LIST}?kind=application`);
    await expect(names).toHaveText(['Order desk']);

    await main(page).getByRole('group', { name: 'Kind' }).getByRole('button', { name: 'All kinds' }).click();
    await main(page).getByRole('group', { name: 'State' }).getByRole('button', { name: 'Archived' }).click();
    await expect(page).toHaveURL(`${LIST}?archived=true`);
    await expect(names).toHaveText(['Legacy intake']);
    await expect(table.getByRole('row', { name: /Legacy intake/ })).toContainText('No version yet');

    await main(page).getByRole('group', { name: 'State' }).getByRole('button', { name: 'Active' }).click();
    await main(page).getByRole('searchbox', { name: 'Search compositions' }).fill('desk');
    await expect(page).toHaveURL(`${LIST}?q=desk`);
    await expect(names).toHaveText(['Order desk']);
    expect(mock.unmocked).toEqual([]);
  });

  test('a new composition opens on its Overview, with no version yet', async ({ page }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(LIST);

    await main(page).getByRole('button', { name: 'New composition' }).click();
    const dialog = page.getByRole('dialog', { name: 'New composition' });
    await dialog.getByLabel('Name').fill('Order desk');
    await dialog.getByRole('button', { name: 'Create composition' }).click();
    await expect(dialog.getByText('order-desk is in use in ISA Demo Group. Choose another address.')).toBeVisible();

    await dialog.getByLabel('Name').fill('Order intake');
    await expect(dialog.getByLabel('Address')).toHaveValue('order-intake');
    await dialog.getByLabel('Kind').selectOption('pipeline');
    await dialog.getByRole('button', { name: 'Create composition' }).click();

    await expect(page).toHaveURL(`${LIST}/order-intake`);
    await expect(main(page).getByRole('heading', { level: 1, name: 'Order intake' })).toBeVisible();
    await expect(main(page).getByText('Composition “Order intake” created. It has no version yet.')).toBeVisible();
    await expect(main(page).getByText('Pipeline', { exact: true })).toBeVisible();
    await expect(main(page).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(main(page).getByText(/No version yet/)).toBeVisible();

    await main(page).getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Compositions' }).click();
    await expect(main(page).getByRole('table').locator('tbody th a')).toHaveText(['Order intake', 'Fleet routing', 'Order desk']);
    expect(mock.unmocked).toEqual([]);
  });

  test('the Overview of a linked composition shows its verified values, binding, evidence and problem, version by version', async ({ page }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(`${LIST}/fleet-routing`);

    await expect(main(page).getByRole('heading', { level: 1, name: 'Fleet routing' })).toBeVisible();
    const version = main(page).getByRole('combobox', { name: 'Version' });
    await expect(version.locator('option:checked')).toHaveText('1.2.0 · latest');
    await expect(main(page).getByRole('list', { name: 'Lineage' })).toContainText('Derived from run 00000000, point 3.');

    await expect(region(page, 'Value status')).toContainText('Verified');
    await expect(region(page, 'Values')).toContainText('2,980 USD/month');
    await expect(region(page, 'Binding')).toContainText('In-house');
    await expect(region(page, 'Evidence')).toContainText('Evaluated by the gateway with bim-core 0.2.0.');
    await expect(region(page, 'Problem').getByRole('link', { name: 'isa-demo/checkout-flow@2' })).toHaveAttribute('href', '/app/isa-demo/problems/checkout-flow?version=2');
    await expect(region(page, 'Evaluation findings')).toContainText('No issues');

    await version.selectOption({ label: '1.1.0' });
    await expect(page).toHaveURL(`${LIST}/fleet-routing?version=1.1.0`);
    await expect(region(page, 'Value status')).toContainText('Unverified');
    await expect(region(page, 'Value status')).toContainText('changed meaning');
    await expect(region(page, 'Values')).toContainText('3,120 USD/month');
    expect(mock.unmocked).toEqual([]);
  });

  test('the Overview of a declared composition shows the author’s values and its offering as a reference', async ({ page }) => {
    const mock = await installMockApi(page, 'admin');
    await page.goto(`${LIST}/order-desk?version=1`);

    await expect(main(page).getByRole('combobox', { name: 'Version' }).locator('option:checked')).toHaveText('1.0.0');
    await expect(region(page, 'Value status')).toContainText('Declared');
    await expect(region(page, 'Values')).toContainText('48 EUR/month');
    await expect(region(page, 'Binding')).toContainText('From brevo/brevo · plan STARTER · version 665f1c2e9b1d4a0012ab34cd');
    await expect(region(page, 'Offering').getByRole('link')).toHaveAttribute('href', 'https://pricings.example.org/order-desk/pricing.yml');
    await expect(region(page, 'Problem')).toHaveCount(0);
    expect(mock.unmocked).toEqual([]);
  });

  test('a composition that is not there reads the same as one that is not shared', async ({ page }) => {
    await installMockApi(page, 'admin');
    await page.goto(`${LIST}/no-such-composition`);

    await expect(main(page).getByRole('heading', { name: 'No composition here, or you cannot see it' })).toBeVisible();
    await expect(main(page)).not.toContainText(/private/i);
    await main(page).getByRole('link', { name: 'All compositions' }).click();
    await expect(page).toHaveURL(LIST);
  });

  test('a tab the composition page does not have is a page that does not exist', async ({ page }) => {
    await installMockApi(page, 'admin');
    await page.goto(`${LIST}/order-desk/nonsense`);

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });
});
