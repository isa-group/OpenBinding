import { expect, test } from '@playwright/test';
import { address, expectAddress, isCurrent, mockLanguage, navEntry, resourceCalls, sectionNav } from './helpers-hub';

test.use({ viewport: { width: 1280, height: 800 } });

const SECTIONS: Array<[string, string]> = [
  ['/language', 'Profiles and dialects'], ['/language/schemas/Application', 'Schemas'], ['/language/extensions', 'Extensions'],
];
const LABELS = SECTIONS.map(([, label]) => label);

// [utest->req~frontend-nav-language-hub~1]
for (const [path, name] of SECTIONS) {
  test(`language hub section ${name} at ${path} is marked in the hub navigation`, async ({ page }) => {
    await mockLanguage(page);
    await page.goto(path);
    const nav = sectionNav(page, LABELS);
    await expect(isCurrent(nav, name)).toBeVisible();
    expect(address(page)).toBe(path);
    for (const other of LABELS.filter((label) => label !== name)) {
      await expect(navEntry(nav, other)).toBeVisible();
      await expect(isCurrent(nav, other)).toHaveCount(0);
    }
  });
}

// [utest->req~frontend-nav-language-hub~1]
test('the Schemas section shows the schema named by the address', async ({ page }) => {
  await mockLanguage(page);
  await page.goto('/language/schemas/Application');
  await expect(page.getByRole('heading', { name: 'Application', exact: true }).first()).toBeVisible();
});

// [utest->req~frontend-nav-language-hub~1]
test('the Extensions section while signed out asks to log in and requests no registered resources', async ({ page }) => {
  const calls = await mockLanguage(page, { role: null });
  await page.goto('/language/extensions');
  await expect(page.getByText('Log in to see and manage language extensions').first()).toBeVisible();
  await expect(page.locator('main a[href="/login"]').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(resourceCalls(calls)).toEqual([]);
});

// [utest->req~frontend-nav-language-hub~1]
test('the old extensions address in the application redirects to /language/extensions', async ({ page }) => {
  await mockLanguage(page);
  await page.goto('/app/language/extensions');
  await expectAddress(page, '/language/extensions');
});

// [utest->req~frontend-nav-language-hub~1]
test('the language hub links to the editor', async ({ page }) => {
  await mockLanguage(page, { role: null });
  await page.goto('/language');
  await expect(page.locator('main a[href="/workbench"]').first()).toBeVisible();
});
