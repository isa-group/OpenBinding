import { expect, test } from '@playwright/test';
import { mockApi, pathOf } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

// [utest->req~frontend-nav-status-retired~1]
test('/status is replaced by /about', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/status');
  await expect.poll(() => pathOf(page)).toBe('/about');
});

// [utest->req~frontend-nav-status-retired~1]
test('About shows the service status when every dependency is up', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/about');
  await expect(page.getByText('Service status: All systems operational')).toBeVisible();
});

// [utest->req~frontend-nav-status-retired~1]
test('no footer or header link points to /status', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/');
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await expect(page.locator('footer a[href="/status"], header a[href="/status"]')).toHaveCount(0);
});

// [utest->req~frontend-nav-status-retired~1]
test('About still renders when the gateway does not answer', async ({ page }) => {
  await mockApi(page, { role: null, gateway: 'down' });
  await page.goto('/about');
  await expect(page.getByText('Service status: not available right now')).toBeVisible();
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
});
