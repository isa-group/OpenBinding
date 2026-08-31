import { expect, test } from '@playwright/test';

const PUBLIC_ROUTES = [
  '/',
  '/profiles',
  '/examples',
  '/playground',
  '/engines',
  '/schemas',
  '/pricing',
  '/login',
  '/register',
];

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
]) {
  test(`${viewport.name} journey stays inside the viewport`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const route of PUBLIC_ROUTES) {
      await page.goto(route);
      await expect(page.locator('h1').first(), `${route} should expose a page heading`).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${route} should not create horizontal page overflow`).toBeLessThanOrEqual(1);
    }
  });
}

test('mobile navigation exposes the complete journey and closes after navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const menu = page.locator('details.mobile-navigation');
  await menu.locator('summary').click();
  await expect(menu).toHaveAttribute('open', '');
  await expect(menu.getByRole('link', { name: 'Pricing' })).toBeVisible();
  await menu.getByRole('link', { name: '03 Examples' }).click();
  await expect(page).toHaveURL(/\/examples$/);
  await expect(menu).not.toHaveAttribute('open', '');
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

test('reduced motion removes entry and continuous status animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/profiles');
  await expect(page.locator('.role-detail')).toBeVisible();
  await expect(page.locator('.role-detail')).toHaveCSS('animation-name', 'none');
  const namedTransitionAnimation = await page.evaluate(() => (
    getComputedStyle(document.documentElement, '::view-transition-group(site-navigation)').animationName
  ));
  expect(namedTransitionAnimation).toBe('none');

  await page.goto('/playground');
  await expect(page.locator('.feedback-state .status-dot')).toBeAttached();
  const statusAnimation = await page.evaluate(() => {
    const dot = document.querySelector('.feedback-state .status-dot');
    const state = dot?.closest('.feedback-state');
    state?.classList.add('state-queued');
    return dot ? getComputedStyle(dot, '::after').animationName : null;
  });
  expect(statusAnimation).toBe('none');
});
