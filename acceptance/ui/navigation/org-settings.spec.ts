import { expect, test } from '@playwright/test';
import { current, mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const SECTIONS: Array<[string, string]> = [
  ['/app/acme/settings', 'General'], ['/app/acme/settings/members', 'Members'], ['/app/acme/settings/presets', 'Run presets'],
  ['/app/acme/settings/audit', 'Audit'],
];

for (const [path, name] of SECTIONS) {
  test(`organization settings section ${name} at ${path} is marked in the settings navigation`, async ({ page }) => {
    await mockApi(page);
    await page.goto(path);
    await expect(current(page, name)).toBeVisible();
    expect(pathAndSearch(page)).toBe(path);
    for (const [, other] of SECTIONS.filter(([, label]) => label !== name)) {
      await expect(page.getByRole('link', { name: other, exact: true }).first()).toBeVisible();
      await expect(current(page, other)).toHaveCount(0);
    }
  });
}

test('the run presets section is part of the organization settings, not a screen of its own', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/acme/settings/presets');
  await expect(page.getByRole('heading', { level: 1, name: 'Run presets' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Organization settings' })).toBeVisible();
  await expect(page.getByText('No run presets yet')).toBeVisible();
});

test('an unknown organization settings section shows Page not found', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/acme/settings/billing');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
