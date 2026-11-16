import { expect, test } from '@playwright/test';
import { mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const opener = (page: import('@playwright/test').Page, name: string) => page.getByRole('button', { name, exact: true })
  .or(page.getByRole('link', { name, exact: true })).first();

test('New organization opens a dialog on /app and creating lab-two opens the new organization', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app');
  await opener(page, 'New organization').click();
  await expect.poll(() => pathAndSearch(page)).toBe('/app?create=organization');
  const dialog = page.getByRole('dialog', { name: 'New organization' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/name/i).first().fill('lab-two');
  const slug = dialog.getByLabel(/slug/i);
  if (await slug.count()) await slug.first().fill('lab-two');
  await dialog.getByRole('button', { name: /create/i }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pathAndSearch(page)).toBe('/app/lab-two');
});

test('cancelling the organization dialog returns to /app, restores focus and creates nothing', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/app?create=organization');
  const dialog = page.getByRole('dialog', { name: 'New organization' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pathAndSearch(page)).toBe('/app');
  await expect(opener(page, 'New organization')).toBeFocused();
  expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
});

test('the organization overview offers no New project, and its upload opens the problem dialog', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/acme');
  await expect(page.getByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
  await expect(opener(page, 'New project')).toHaveCount(0);
  await page.locator('main').getByRole('link', { name: 'Upload BIM package' }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme/problems?create=problem');
  await expect(page.getByRole('dialog', { name: 'Upload a BIM package' })).toBeVisible();
});

test('New composition opens a dialog over the Compositions list, and creating lab-flow opens its Editor with no version yet', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/app/acme/compositions');
  await page.locator('main').getByRole('button', { name: 'New composition', exact: true }).first().click();
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme/compositions?create=composition');
  const dialog = page.getByRole('dialog', { name: 'New composition' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Lab flow');
  await expect(dialog.getByLabel('Address')).toHaveValue('lab-flow');
  await dialog.getByRole('button', { name: 'Create composition' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme/compositions/lab-flow/editor');
  await expect(page.getByRole('heading', { level: 1, name: 'Lab flow' })).toBeVisible();
  await expect(page.locator('main').getByText(/No version yet/).first()).toBeVisible();
  // The Editor lints the starter document through the stateless language services; what is created is only the composition.
  expect(requests.filter((request) => request.method === 'POST' && request.path.startsWith('/v1/organizations/')).map((request) => [request.path, JSON.parse(request.body)])).toEqual([
    ['/v1/organizations/acme/compositions', { slug: 'lab-flow', name: 'Lab flow', kind: 'application', description: '' }],
  ]);
});

test('cancelling the composition dialog returns to the list, restores focus and creates nothing', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/app/acme/compositions?create=composition');
  const dialog = page.getByRole('dialog', { name: 'New composition' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme/compositions');
  await expect(page.locator('main').getByRole('button', { name: 'New composition', exact: true }).first()).toBeFocused();
  expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
});
