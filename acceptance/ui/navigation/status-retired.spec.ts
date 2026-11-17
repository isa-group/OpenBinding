import { expect, test } from '@playwright/test';
import { mockApi } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

test('the footer shows the service status when every dependency is up', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/team');
  await expect(
    page.getByRole('contentinfo').getByText('Service status: All systems operational')
  ).toBeVisible();
});

test('no footer or header link points to /status', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/');
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await expect(page.locator('footer a[href="/status"], header a[href="/status"]')).toHaveCount(0);
});

test('the about pages still render when the gateway does not answer', async ({ page }) => {
  await mockApi(page, { role: null, gateway: 'down' });
  await page.goto('/team');
  await expect(
    page.getByRole('contentinfo').getByText('Service status: not available right now')
  ).toBeVisible();
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
});
