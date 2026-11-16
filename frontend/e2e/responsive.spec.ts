import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from './helpers/mockApi';

// Public routes of the redesigned site. About holds the service-status note; there is no /status page.
const PUBLIC_ROUTES = ['/', '/workbench', '/engines', '/pricing', '/about', '/login', '/register'];

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
]) {
  for (const route of PUBLIC_ROUTES) {
    test(`${viewport.name} ${route} stays inside the viewport`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('h1').first(), `${route} should expose a page heading`).toBeVisible(
        { timeout: 30_000 }
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow, `${route} should not create horizontal page overflow`).toBeLessThanOrEqual(
        1
      );
    });
  }
}

test('mobile navigation exposes the complete journey and closes after navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const header = page.locator('header.site-header');
  await expect(header.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
  await header.getByRole('button', { name: 'Open menu' }).click();

  const menu = header.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(header.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  for (const label of [
    'Home',
    'Compositions',
    'Language',
    'Engines',
    'Pricing',
    'About',
    'Log in',
    'Sign up',
  ]) {
    await expect(menu.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  await menu.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(header.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
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

test('the eight public entries stay in the header row before the mobile breakpoint', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const header = page.locator('header.site-header');
  for (const label of [
    'Home',
    'Compositions',
    'Language',
    'Engines',
    'Pricing',
    'About',
    'Log in',
    'Sign up',
  ]) {
    await expect(header.getByRole('link', { name: label, exact: true }), label).toBeInViewport({
      ratio: 1,
    });
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(1);
  const row = await header.locator('.public-header').boundingBox();
  const last = await header.getByRole('link', { name: 'Sign up', exact: true }).boundingBox();
  expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(
    (row?.x ?? 0) + (row?.width ?? 0)
  );
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
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found', {
      timeout: 30_000,
    });
  });
}

/** A signed-in account with one organization, at the members section of its settings; anything else on the API origin answers 404. */
async function openOrganizationSettings(page: Page) {
  const API = 'http://localhost:8000';
  const organization = {
    id: 'org-1',
    slug: 'isa-demo',
    name: 'ISA Demo Group',
    parent_id: null,
    effective_role: 'OWNER',
    created_at: '2026-09-01T00:00:00Z',
  };
  const account = {
    id: 'resp-user-id',
    username: 'lucia',
    email: 'lucia@example.org',
    role: 'user',
    is_active: true,
    plan: 'FREE',
    created_at: '2026-09-01T00:00:00Z',
  };
  await page.addInitScript(() =>
    localStorage.setItem('openbinding-access-token', 'responsive-token')
  );
  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await page.route(`${API}/v1/users/me`, route => route.fulfill({ json: account }));
  await page.route(`${API}/v1/users/me/pricing-token`, route =>
    route.fulfill({ json: { pricing_token: 'responsive-token' } })
  );
  await page.route(`${API}/v1/organizations`, route => route.fulfill({ json: [organization] }));
  await page.route(`${API}/v1/organizations/isa-demo/members`, route =>
    route.fulfill({ json: [] })
  );
  await page.route(`${API}/v1/notifications**`, route => route.fulfill({ json: [] }));
  await page.goto('/app/isa-demo/settings/members');
  return page.getByRole('navigation', { name: 'Organization settings' });
}

test('on a phone the organization settings keep the open section in view without scrolling the page sideways', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const sections = await openOrganizationSettings(page);

  const members = sections.getByRole('link', { name: 'Members', exact: true });
  await expect(members).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(members).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ).toBeLessThanOrEqual(1);
});

test('the settings of an organization mark Home, and only Home, in the application header', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const sections = await openOrganizationSettings(page);

  await expect(sections.getByRole('link', { name: 'Members', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
    { timeout: 30_000 }
  );
  const main = page.locator('header.app-header').getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await expect(main.locator('[aria-current="page"]')).toHaveCount(1);
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

test('mobile problem editor: the panes, the engines and the problems are tabs, inside the viewport', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockApi(page, 'admin');
  await page.goto('/app/isa-demo/problem-editor');

  const main = page.locator('#platform-main');
  await expect(main.getByRole('heading', { level: 1, name: 'Problem editor' })).toBeVisible({
    timeout: 30_000,
  });
  const panes = main.getByRole('tablist', { name: 'Editor panes' });
  await expect(panes.getByRole('tab')).toHaveText([
    'Workflow',
    'Candidates',
    'Rules',
    'Files',
    'Forms',
    'BPMN',
    'Engines',
    'Problems',
  ]);
  await expect(main.getByTestId('pe-check-status')).toHaveText('Valid package', {
    timeout: 15_000,
  });
  await panes.getByRole('tab', { name: 'Engines' }).click();
  await expect(main.getByRole('heading', { name: 'Engines' })).toBeVisible();
  await panes.getByRole('tab', { name: 'Files' }).click();
  await expect(main.getByRole('navigation', { name: 'Files of the package' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(
    overflow,
    'the problem editor should not create horizontal page overflow'
  ).toBeLessThanOrEqual(1);
});
