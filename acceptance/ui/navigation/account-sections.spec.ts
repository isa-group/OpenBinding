import { expect, test } from '@playwright/test';
import { current, mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const SECTIONS: Array<[string, string]> = [
  ['/app/account', 'Profile'], ['/app/account/usage', 'Plan'], ['/app/account/keys', 'API keys'],
  ['/app/account/identities', 'Identities'], ['/app/account/notifications', 'Notifications'],
];

// [utest->req~frontend-nav-account-sections~1]
for (const [path, name] of SECTIONS) {
  test(`account section ${name} at ${path} is marked in the account navigation`, async ({ page }) => {
    await mockApi(page);
    await page.goto(path);
    await expect(current(page, name)).toBeVisible();
    expect(pathAndSearch(page)).toBe(path);
    // The other four sections are links of the same navigation, none of them current.
    for (const [, other] of SECTIONS.filter(([, label]) => label !== name)) {
      await expect(page.getByRole('link', { name: other, exact: true }).first()).toBeVisible();
      await expect(current(page, other)).toHaveCount(0);
    }
  });
}

// [utest->req~frontend-nav-account-sections~1]
test('new API key opens as a dialog over the API keys section', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/account/keys');
  await expect(current(page, 'API keys')).toBeVisible();
  await page.goto('/app/account/keys/new');
  await expect.poll(() => pathAndSearch(page)).toBe('/app/account/keys?create=key');
  const dialog = page.getByRole('dialog', { name: 'New API key' });
  await expect(dialog).toBeVisible();
  await expect(current(page, 'API keys')).toBeVisible();
  await dialog.getByRole('button', { name: /^(cancel|close)$/i }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pathAndSearch(page)).toBe('/app/account/keys');
});

// [utest->req~frontend-nav-account-sections~1]
test('an unknown account section shows Page not found', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/account/billing');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
