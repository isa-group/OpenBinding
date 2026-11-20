import { expect as baseExpect, test } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// J6 · calculator demand and margins: on TomatoMeter's Configuration tab, a number of users has the gateway answer the margin
// per plan of a what-if binding (Mailgun FOUNDATION), and the Demand select evaluates the binding against another revision of
// the linked problem (a demand variant), with that revision's demand and margins; nothing is saved, and "New demand variant"
// leads to the problem's SPHERE update. There is no backend: e2e/helpers/mockApi.ts answers with the gateway's what-if
// fixtures (src/test/fixtures/core/tomatometer.evaluate.*.json).

const expect = baseExpect.configure({ timeout: 15_000 });
test.setTimeout(90_000);

test.describe('J6 · calculator demand and margins', () => {
  test('a member asks for margins under a number of users and under a demand variant, saving nothing', async ({
    page,
  }) => {
    const handle = await installMockApi(page, 'admin', { tomatometer: true });
    await page.goto('/compositions/isa-demo/tomatometer/configuration');

    const demand = page.getByRole('region', { name: 'Demand and margins' });
    await expect(demand.getByRole('combobox', { name: 'Demand' })).toHaveValue('');
    await expect(demand.getByRole('combobox', { name: 'Demand' })).toContainText(
      'Problem version 2, as sealed'
    );
    await expect(demand.getByRole('link', { name: 'New demand variant' })).toHaveAttribute(
      'href',
      '/problems/isa-demo/tomatometer-email?sphereStep=pricing&sphereUpdate=1'
    );

    await demand.getByRole('spinbutton', { name: 'Users' }).fill('1000');
    await page
      .locator('main')
      .getByRole('radio', { name: /email\.mailgun\.foundation for dailySummary/ })
      .check();
    const result = page.locator('main').getByRole('region', { name: 'This binding' });
    const margins = result.getByRole('region', { name: 'Margin per plan' });
    await expect(margins.getByRole('row')).toHaveCount(8);
    await expect(margins).toContainText('−0.04');
    await expect(margins.locator('caption')).toContainText('1,000 users');
    expect(handle.operation?.evaluated.at(-1)).toMatchObject({
      users: 1000,
      binding: { dailySummary: expect.stringContaining('email.mailgun.foundation') },
    });

    await demand
      .getByRole('combobox', { name: 'Demand' })
      .selectOption({ label: 'Problem version 1' });
    await expect(result.getByRole('list', { name: 'Demand evaluated' })).toContainText(
      'monthlyEmails: 60000 email/month'
    );
    await expect(result).toContainText('Demand of problem version 1');
    expect(handle.operation?.evaluated.at(-1)).toMatchObject({ users: 1000, revision: 1 });
    expect(handle.operation?.adopted).toEqual([]);
    expect(handle.unmocked).toEqual([]);
  });
});
