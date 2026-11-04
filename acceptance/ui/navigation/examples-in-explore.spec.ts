import { expect, test } from '@playwright/test';
import { EXAMPLES, mockApi, pathAndSearch } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

// [utest->req~frontend-nav-examples-in-explore~1]
test('the examples section of Explore lists the examples with links to the workbench', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/explore/examples');
  await expect(page.getByRole('heading', { name: 'BIM examples' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'BIM examples', exact: true }).and(page.locator('[aria-current="page"]')).first()).toBeVisible();
  for (const example of EXAMPLES) {
    const link = page.locator(`a[href="/workbench?example=${encodeURIComponent(example)}"], a[href="/workbench?example=${example}"]`);
    await expect(link.first()).toBeVisible();
  }
});

// [utest->req~frontend-nav-examples-in-explore~1]
test('/examples moves to /explore/examples and keeps its query', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/examples?profile=placement');
  await expect.poll(() => pathAndSearch(page)).toBe('/explore/examples?profile=placement');
});

// [utest->req~frontend-nav-examples-in-explore~1]
test('an unknown Explore section shows Page not found', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/explore/everything');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
