import { expect, test } from '@playwright/test';
import { LAB_USERS, capture, labPassword, signInThroughForm, watchPageErrors, type LabRole } from './support';

// Written, not executed in the environment that produced it (no browser there). Runs against the lab: see playwright.config.ts.

test.describe('live · login', () => {
  for (const role of Object.keys(LAB_USERS) as LabRole[]) {
    test(`${LAB_USERS[role]} signs in through the form and lands in the workspace`, async ({ page }, testInfo) => {
      const errors = watchPageErrors(page);
      await signInThroughForm(page, LAB_USERS[role], labPassword());

      await expect(page).toHaveURL(/\/app\/?$/);
      await expect(page.getByRole('heading', { level: 1, name: `Hello, ${LAB_USERS[role]}` })).toBeVisible();
      // The session is in the browser: a reload keeps it.
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: `Hello, ${LAB_USERS[role]}` })).toBeVisible();
      if (role === 'owner') await capture(page, testInfo, 'login-owner-home');
      expect(errors).toEqual([]);
    });
  }

  test('a wrong password is refused in the same words as an unknown account, and nobody is signed in', async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    // An account that does not exist, with a password that is not the lab's: it spends no attempt of a real user.
    await signInThroughForm(page, 'lab-login-probe', `${labPassword()}-not-it`);

    await expect(page.getByText('That username or email and password don’t match an active account.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await capture(page, testInfo, 'login-refused');
    expect(errors).toEqual([]);
  });

  test('a visitor who is not signed in is sent to the login page from the workspace', async ({ page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });
});
