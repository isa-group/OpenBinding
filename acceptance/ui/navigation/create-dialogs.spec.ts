import { expect, test } from '@playwright/test';
import { mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const opener = (page: import('@playwright/test').Page, name: string) => page.getByRole('button', { name, exact: true })
  .or(page.getByRole('link', { name, exact: true })).first();

// [utest->req~frontend-nav-create-dialogs~1]
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

// [utest->req~frontend-nav-create-dialogs~1]
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

// [utest->req~frontend-nav-create-dialogs~1]
test('New project opens a dialog on the organization overview and creating demo-two opens the project', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/acme');
  await opener(page, 'New project').click();
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme?create=project');
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/name/i).first().fill('demo-two');
  const slug = dialog.getByLabel(/slug/i);
  if (await slug.count()) await slug.first().fill('demo-two');
  await dialog.getByRole('button', { name: /create/i }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme/demo-two');
});

// [utest->req~frontend-nav-create-dialogs~1]
test('old creation addresses land on the open dialogs', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/organizations/new');
  await expect.poll(() => pathAndSearch(page)).toBe('/app?create=organization');
  await expect(page.getByRole('dialog', { name: 'New organization' })).toBeVisible();
  await page.goto('/app/acme/new-project');
  await expect.poll(() => pathAndSearch(page)).toBe('/app/acme?create=project');
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
});
