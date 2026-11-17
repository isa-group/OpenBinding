import { expect, test } from '@playwright/test';
import { mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

test('/forgot-password shows the request form', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('/reset-password with a token shows the new-password form and submits the token', async ({ page }) => {
  const requests = await mockApi(page, { role: null });
  await page.goto('/reset-password?token=abc123');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Confirm password', { exact: true })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('Correct-horse-9');
  await page.getByLabel('Confirm password', { exact: true }).fill('Correct-horse-9');
  await page.getByRole('main').getByRole('button', { name: /reset|set|save|change|submit/i }).first().click();
  await expect.poll(() => requests.some((request) => request.method === 'POST'
    && request.body.includes('abc123') && request.body.includes('Correct-horse-9'))).toBe(true);
});

test('a reset link opens /reset-password with its token, ready for the new password', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/reset-password?token=abc123');
  await expect.poll(() => pathAndSearch(page)).toBe('/reset-password?token=abc123');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Confirm password', { exact: true })).toBeVisible();
});

test('an empty token explains the link and offers a new one', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/reset-password?token=');
  await expect(page.getByRole('heading', { name: 'This reset link can’t be used' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
    'href',
    '/forgot-password'
  );
});
