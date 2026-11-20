import { expect, test, type Page, type Route } from '@playwright/test';
import { API, current, mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

// The settings page keeps its section in the address (`/me/settings?section=`); API keys are a page of their own.
const SECTIONS: Array<[string, string, string]> = [
  ['/me/settings', 'Account', 'Account Details'],
  ['/me/settings?section=notifications', 'Notifications', 'Notifications'],
  ['/me/settings?section=plan', 'Plan', 'Plan & permissions'],
  ['/me/settings?section=appearance', 'Appearance', 'Appearance'],
  ['/me/settings?section=beta', 'Beta features', 'Beta features'],
  ['/me/settings?section=danger', 'Danger Zone', 'Danger Zone'],
];

/** The account's own reads the settings and API key pages make, answered empty. */
async function mockAccount(page: Page) {
  const json = (body: unknown) => (route: Route) => route.fulfill({ json: body });
  await page.route(`${API}/v1/users/me/usage`, json({ plan: 'FREE', contract_pending: false, features: {}, capabilities: { maxApiKeys: 2 } }));
  await page.route(`${API}/v1/users/me/settings/beta-features`, json({ enabled: false }));
  await page.route(`${API}/v1/notifications/preferences`, json({ inbox: true, email_contract_changes: true, email_invitations: true, email_job_failures: false, kinds: {} }));
  await page.route(`${API}/v1/users/me/api-keys`, json({ api_keys: [] }));
}

for (const [path, name, heading] of SECTIONS) {
  test(`settings section ${name} at ${path} is marked in the settings navigation`, async ({ page }) => {
    await mockApi(page);
    await mockAccount(page);
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(current(page, name)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    expect(pathAndSearch(page)).toBe(path);
    // The other sections are links of the same navigation, none of them current.
    for (const [, other] of SECTIONS.filter(([, label]) => label !== name)) {
      await expect(nav.getByRole('link', { name: other, exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: other, exact: true })).not.toHaveAttribute('aria-current', 'page');
    }
  });
}

test('an unknown settings section opens Account', async ({ page }) => {
  await mockApi(page);
  await mockAccount(page);
  await page.goto('/me/settings?section=billing');
  await expect(current(page, 'Account')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Account Details' })).toBeVisible();
});

test('a new API key opens as a dialog over the API keys page', async ({ page }) => {
  test.slow(); // two full page loads in one test
  await mockApi(page);
  await mockAccount(page);
  await page.goto('/me/api-keys');
  await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
  await page.getByRole('link', { name: 'Create new API key' }).click();
  await expect.poll(() => pathAndSearch(page)).toBe('/me/api-keys?create=key');
  const dialog = page.getByRole('dialog', { name: 'Create new API key' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pathAndSearch(page)).toBe('/me/api-keys');
  await page.goto('/me/api-keys?create=key');
  await expect(page.getByRole('dialog', { name: 'Create new API key' })).toBeVisible();
});

test('the old account addresses show Page not found', async ({ page }) => {
  await mockApi(page);
  await page.goto('/app/account/keys');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
