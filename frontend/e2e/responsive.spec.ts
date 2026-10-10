import { expect, test, type Page } from '@playwright/test';

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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Engine catalog');
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

/** A signed-in account with one organization and one project; anything else on the API origin answers 404. */
async function openProjectFiles(page: Page) {
  const API = 'http://localhost:8000';
  const organization = {
    id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null,
    billing_sponsor_user_id: 'resp-user-id', effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z',
  };
  const project = {
    id: 'project-1', organization_id: 'org-1', slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: '',
    visibility: 'private', created_by_id: 'resp-user-id', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    access: 'member', effective_role: 'OWNER',
  };
  const account = { id: 'resp-user-id', username: 'lucia', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'BASIC', created_at: '2026-09-01T00:00:00Z' };
  await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 'responsive-token'));
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/v1/users/me`, (route) => route.fulfill({ json: account }));
  await page.route(`${API}/v1/users/me/pricing-token`, (route) => route.fulfill({ json: { pricing_token: 'responsive-token' } }));
  await page.route(`${API}/v1/organizations`, (route) => route.fulfill({ json: [organization] }));
  await page.route(`${API}/v1/organizations/isa-demo/projects`, (route) => route.fulfill({ json: [project] }));
  await page.route(`${API}/v1/organizations/isa-demo/projects/qos-benchmarks`, (route) => route.fulfill({ json: project }));
  await page.route(`${API}/v1/notifications**`, (route) => route.fulfill({ json: [] }));
  await page.goto('/app/isa-demo/qos-benchmarks/files');
  return page.getByRole('navigation', { name: 'Project sections' });
}

test('on a phone the project tabs scroll sideways and keep the open tab in view', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = await openProjectFiles(page);

  const files = tabs.getByRole('link', { name: 'Files', exact: true });
  await expect(files).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(files).toBeInViewport();
  // Jobs, Studies, Reports and Files do not fit beside the other tabs: the row has moved to show the open one.
  await expect.poll(() => tabs.evaluate((row) => row.scrollLeft)).toBeGreaterThan(0);
  expect(await tabs.evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true);
});

test('a project screen does not mark Home in the application header', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const tabs = await openProjectFiles(page);

  await expect(tabs.getByRole('link', { name: 'Files', exact: true })).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  const main = page.locator('header.app-header').getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page');
  await expect(main.locator('[aria-current="page"]')).toHaveCount(0);
});

test('reduced motion removes entry animations', async ({ page }) => {
  // The cards of the home page rise in; asking for reduced motion takes the animation away, and only that preference does.
  await page.goto('/');
  const card = page.locator('.home-card').first();
  await expect(card).toBeVisible();
  await expect(card).toHaveCSS('animation-name', 'home-in');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(card).toHaveCSS('animation-name', 'none');
});
