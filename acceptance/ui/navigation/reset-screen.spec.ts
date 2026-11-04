import { expect, test } from '@playwright/test';
import { mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

// [utest->req~frontend-nav-reset-single-screen~1]
test('/password-reset shows the request form', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/password-reset');
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

// [utest->req~frontend-nav-reset-single-screen~1]
test('/password-reset with a token shows the new-password form and submits the token', async ({ page }) => {
  const requests = await mockApi(page, { role: null });
  await page.goto('/password-reset?token=abc123');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Confirm password', { exact: true })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('Correct-horse-9');
  await page.getByLabel('Confirm password', { exact: true }).fill('Correct-horse-9');
  await page.getByRole('main').getByRole('button', { name: /reset|set|save|change|submit/i }).first().click();
  await expect.poll(() => requests.some((request) => request.method === 'POST'
    && request.body.includes('abc123') && request.body.includes('Correct-horse-9'))).toBe(true);
});

// [utest->req~frontend-nav-reset-single-screen~1]
test('the link of a reset e-mail lands on /password-reset with its token', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/password-reset/complete?token=abc123');
  await expect.poll(() => pathAndSearch(page)).toBe('/password-reset?token=abc123');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Confirm password', { exact: true })).toBeVisible();
});

// [utest->req~frontend-nav-reset-single-screen~1]
test('an empty token shows the request form', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/password-reset?token=');
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
});
