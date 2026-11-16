import { expect, test } from '@playwright/test';
import { mockApi, pathAndSearch } from './helpers';

// SPHERE's organization page (F2c PR-B): one hero with its tabs in the address, `/orgs/:org/:tab?`. The settings screens of the old
// workspace (`/app/:org/settings/...`) are gone, with no redirect.

test.use({ viewport: { width: 1280, height: 800 } });

const TABS: Array<[string, string]> = [
  ['/orgs/acme', 'Overview'], ['/orgs/acme/members', 'Members'], ['/orgs/acme/presets', 'Presets'],
  ['/orgs/acme/audit', 'Audit'],
];

for (const [path, name] of TABS) {
  test(`organization tab ${name} at ${path} is marked in the tab bar`, async ({ page }) => {
    await mockApi(page);
    await page.goto(path);
    const tabs = page.getByRole('navigation', { name: 'Organization sections' });
    await expect(tabs.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
    expect(pathAndSearch(page)).toBe(path);
    for (const [, other] of TABS.filter(([, label]) => label !== name))
      await expect(tabs.getByRole('link', { name: other, exact: true })).not.toHaveAttribute('aria-current', 'page');
  });
}

test('the run presets are a tab of the organization page', async ({ page }) => {
  await mockApi(page);
  await page.goto('/orgs/acme/presets');
  await expect(page.getByRole('heading', { level: 2, name: 'Run presets' })).toBeVisible();
  await expect(page.getByText('No run presets yet')).toBeVisible();
});

test('an unknown tab and the old settings addresses show Page not found', async ({ page }) => {
  await mockApi(page);
  for (const path of ['/orgs/acme/billing', '/app/acme/settings', '/app/acme/settings/members']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  }
});
