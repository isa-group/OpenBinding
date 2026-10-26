import { expect, test } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// S5b · the library screens are retired (M2.4 slice 3, ADR-0020): an old link still lands somewhere useful.
// There is no backend: the API origin is answered by the shared mock.

test.setTimeout(60_000);

test.describe('retired library addresses', () => {
  test('/app/:org/library redirects to the organization overview', async ({ page }) => {
    await installMockApi(page, 'admin');
    await page.goto('/app/isa-demo/library');
    await expect(page).toHaveURL(/\/app\/isa-demo\/?$/);
  });

  test('/app/:org/:project/resources redirects to the collections of the project', async ({ page }) => {
    await installMockApi(page, 'admin');
    await page.goto('/app/isa-demo/qos-benchmarks/resources');
    await expect(page).toHaveURL(/\/app\/isa-demo\/qos-benchmarks\/collections\/?$/);
  });
});
