import { expect, test } from '@playwright/test';

// Public routes of the redesigned site. About and Status are still placeholders but must already fit the viewport.
const PUBLIC_ROUTES = [
  '/',
  '/language',
  '/language/schemas/application',
  '/examples',
  '/workbench',
  '/engines',
  '/pricing',
  '/about',
  '/status',
  '/login',
  '/register',
];

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
]) {
  for (const route of PUBLIC_ROUTES) {
    test(`${viewport.name} ${route} stays inside the viewport`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('h1').first(), `${route} should expose a page heading`).toBeVisible({ timeout: 30_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${route} should not create horizontal page overflow`).toBeLessThanOrEqual(1);
    });
  }
}

test('mobile navigation exposes the complete journey and closes after navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const header = page.locator('header.site-header');
  await expect(header.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
  await header.getByRole('button', { name: 'Open menu' }).click();

  const menu = header.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(header.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
  for (const label of ['Explore', 'Engines', 'Pricing', 'About', 'Log in', 'Sign up']) {
    await expect(menu.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole('link', { name: 'Schemas' })).toHaveAttribute('href', '/language/schemas/application');

  await menu.getByRole('link', { name: 'Examples' }).click();
  await expect(page).toHaveURL(/\/examples$/);
  await expect(header.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();
});

test('mobile menu closes with Escape and gives focus back to its button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const header = page.locator('header.site-header');
  await header.getByRole('button', { name: 'Open menu' }).click();
  await expect(header.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(header.getByRole('navigation', { name: 'Mobile navigation' })).toBeHidden();
  await expect(header.getByRole('button', { name: 'Open menu' })).toBeFocused();
});

test('engine catalogue and pricing stay visible before the mobile breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const engines = primaryNavigation.getByRole('link', { name: 'Engines' });
  const pricing = primaryNavigation.getByRole('link', { name: 'Pricing' });
  await expect(engines).toBeVisible();
  await expect(pricing).toBeVisible();
  await engines.click();
  await expect(page).toHaveURL(/\/engines$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Engines');
  await page.goto('/');
  await pricing.click();
  await expect(page).toHaveURL(/\/pricing$/);
});

for (const route of ['/profiles', '/schemas', '/playground', '/team', '/changelog']) {
  test(`the retired route ${route} no longer serves its old page`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found', { timeout: 30_000 });
  });
}

test('reduced motion removes entry animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/language');
  await expect(page.locator('.role-detail')).toBeVisible();
  await expect(page.locator('.role-detail')).toHaveCSS('animation-name', 'none');
});
