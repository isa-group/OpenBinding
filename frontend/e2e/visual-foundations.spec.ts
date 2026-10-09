import { expect, test, type Page } from '@playwright/test';

// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be inspected after a run.

const API = 'http://localhost:8000';

// Element screenshots of a scrolled page are stitched, so fixed/sticky layers would be painted over the footer.
const HIDE_FLOATING = '.site-header, .skip-link { visibility: hidden !important; }';

const researchUser = {
  id: 'research-user-id',
  username: 'ana',
  email: 'ana@example.org',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-09-01T00:00:00Z',
};

/** Answers the two calls AuthContext makes on load; everything else on the API origin gets an empty 404. */
async function signInAsResearchAccount(page: Page) {
  await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 'visual-foundations-token'));
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/v1/users/me`, (route) => route.fulfill({ json: researchUser }));
  await page.route(`${API}/v1/users/me/pricing-token`, (route) => route.fulfill({ json: { pricing_token: 'visual-token' } }));
}

async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  test.describe(`${name} visual foundations`, () => {
    test.use({ viewport, isMobile, deviceScaleFactor });

    test('visitor header and footer', async ({ page }, testInfo) => {
      await openHome(page);

      const header = page.locator('header.site-header');
      const footer = page.locator('footer.site-footer');
      await expect(header.getByRole('link', { name: 'OpenBinding home' })).toBeVisible();
      await expect(page.getByRole('button', { name: /theme|dark|light mode/i })).toHaveCount(0);
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
      await expect(header.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveCount(0);

      if (isMobile) {
        await expect(header.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
        await header.getByRole('button', { name: 'Open menu' }).click();
        const menu = header.getByRole('navigation', { name: 'Mobile navigation' });
        for (const label of ['Explore', 'Engines', 'Pricing', 'About', 'Log in', 'Sign up']) {
          await expect(menu.getByRole('link', { name: label, exact: true })).toBeVisible();
        }
        await expect(menu.getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', '/workbench');
        await page.screenshot({ path: testInfo.outputPath(`header-${name}-visitor-menu-open.png`), animations: 'disabled' });
        await header.getByRole('button', { name: 'Close menu' }).click();
      } else {
        const nav = header.getByRole('navigation', { name: 'Primary navigation' });
        await expect(nav.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
        await expect(nav.getByRole('link', { name: 'Engines' })).toHaveAttribute('href', '/engines');
        await expect(nav.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
        await expect(nav.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
        await expect(header.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
        await expect(header.getByRole('link', { name: /Sign up/ })).toHaveAttribute('href', '/register');

        const language = nav.getByRole('button', { name: 'Language' });
        await language.focus();
        await page.keyboard.press('Enter');
        await expect(language).toHaveAttribute('aria-expanded', 'true');
        await expect(header.getByRole('link', { name: /Schemas/ })).toHaveAttribute('href', '/language/schemas/application');
        await page.screenshot({ path: testInfo.outputPath(`header-${name}-visitor-language-menu.png`), animations: 'disabled', clip: { x: 0, y: 0, width: viewport.width, height: 360 } });
        await page.keyboard.press('Escape');
        await expect(language).toHaveAttribute('aria-expanded', 'false');
      }

      await header.screenshot({ path: testInfo.outputPath(`header-${name}-visitor.png`), animations: 'disabled' });

      await footer.scrollIntoViewIfNeeded();
      const footerNav = footer.getByRole('navigation', { name: 'Footer navigation' });
      await expect(footerNav.getByRole('link', { name: 'Status' })).toHaveAttribute('href', '/status');
      await expect(footerNav.getByRole('link', { name: 'Changelog' })).toHaveAttribute('href', '/about?tab=changelog');
      await expect(footer.getByRole('link', { name: 'SCORE Lab' })).toBeVisible();
      await expect(footer.getByRole('link', { name: 'Universidad de Sevilla' })).toBeVisible();
      await expect(footer.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveCount(0);
      const band = await page.locator('.site-footer-band').boundingBox();
      expect(band?.height).toBe(8);

      await footer.screenshot({ path: testInfo.outputPath(`footer-${name}-visitor.png`), animations: 'disabled', style: HIDE_FLOATING });

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test('research account shows the institutional co-brand', async ({ page }, testInfo) => {
      await signInAsResearchAccount(page);
      await openHome(page);

      const header = page.locator('header.site-header');
      const footer = page.locator('footer.site-footer');
      const headerMark = header.getByRole('img', { name: 'Universidad de Sevilla' });
      await expect(headerMark).toBeVisible();
      await expect(headerMark).toHaveAttribute('src', '/brands/us-fama.png');
      const box = await headerMark.boundingBox();
      expect(box?.height).toBeLessThanOrEqual(40);
      expect(box?.height).toBeGreaterThanOrEqual(24);
      await header.screenshot({ path: testInfo.outputPath(`header-${name}-research.png`), animations: 'disabled' });

      if (isMobile) {
        await header.getByRole('button', { name: 'Open menu' }).click();
        const menu = header.getByRole('navigation', { name: 'Mobile navigation' });
        await expect(menu.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
        await page.screenshot({ path: testInfo.outputPath(`header-${name}-research-menu-open.png`), animations: 'disabled' });
        await header.getByRole('button', { name: 'Close menu' }).click();
      } else {
        await header.getByRole('button', { name: 'Account menu' }).click();
        await expect(header.getByText('Universidad de Sevilla · Institutional account')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`header-${name}-research-account-menu.png`), animations: 'disabled', clip: { x: 0, y: 0, width: viewport.width, height: 360 } });
      }

      await footer.scrollIntoViewIfNeeded();
      await expect(footer.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
      await footer.screenshot({ path: testInfo.outputPath(`footer-${name}-research.png`), animations: 'disabled', style: HIDE_FLOATING });
    });
  });
}
