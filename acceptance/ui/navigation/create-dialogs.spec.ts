import { expect, test } from '@playwright/test';
import { mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const opener = (page: import('@playwright/test').Page, name: string) => page.getByRole('button', { name, exact: true })
  .or(page.getByRole('link', { name, exact: true })).first();

test('New organization opens the creation page, and creating lab-two opens the new organization', async ({ page }) => {
  await mockApi(page);
  await page.goto('/me/orgs');
  await opener(page, 'New organization').click();
  await expect.poll(() => pathAndSearch(page)).toBe('/orgs/new');
  await page.getByLabel(/^Name/).fill('lab-two');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/orgs/lab-two');
});

test('cancelling the creation page goes back and creates nothing', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/me/orgs');
  await opener(page, 'New organization').click();
  await expect.poll(() => pathAndSearch(page)).toBe('/orgs/new');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/me/orgs');
  expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
});

test('the organization page offers no New project, and its New problem opens the problem dialog', async ({ page }) => {
  await mockApi(page);
  await page.goto('/orgs/acme/problems');
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(opener(page, 'New project')).toHaveCount(0);
  await page.locator('main').getByRole('link', { name: 'New problem' }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme/problems?create=problem');
  await expect(page.getByRole('dialog', { name: 'Upload a BIM package' })).toBeVisible();
});

test('New composition opens the creation page, whose editor link publishes lab-flow with its first version', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/orgs/acme/compositions');
  await page.locator('main').getByRole('link', { name: 'New composition', exact: true }).first().click();
  await expect.poll(() => pathAndSearch(page)).toBe('/compositions/new?org=acme');
  await page.locator('main').getByRole('link', { name: 'Write it in the editor' }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/editor?org=acme');
  await expect(page.getByRole('region', { name: 'Problems' })).toContainText('No issues');
  await page.getByRole('button', { name: 'Publish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to OpenBinding' });
  await expect(dialog.getByText('Acme')).toBeVisible();
  await dialog.getByLabel('Composition name').fill('Lab flow');
  await expect(dialog.getByText('Its address: lab-flow')).toBeVisible();
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/compositions/acme/lab-flow/versions?version=1.0.0');
  // The editor lints through the stateless language services; what is written is the composition and its first version.
  expect(requests.filter((request) => request.method === 'POST' && request.path.startsWith('/v1/organizations/')).map((request) => request.path)).toEqual([
    '/v1/organizations/acme/compositions',
    '/v1/organizations/acme/compositions/lab-flow/versions',
  ]);
  expect(JSON.parse(requests.find((request) => request.path === '/v1/organizations/acme/compositions')!.body)).toEqual({
    slug: 'lab-flow', name: 'Lab flow', kind: 'application', description: '',
  });
});

test('leaving the creation page returns to the Compositions tab and creates nothing', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/compositions/new?org=acme');
  await page.locator('main').getByRole('link', { name: 'Back to organization' }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/orgs/acme/compositions');
  expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
});
