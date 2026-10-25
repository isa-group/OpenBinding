import { expect, test, type Page } from '@playwright/test';

// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be inspected after a run.

const API = 'http://localhost:8000';

const personas = {
  user: { id: 'shell-user-id', username: 'lucia', email: 'lucia@example.org', role: 'user', is_active: true, plan: 'BASIC', created_at: '2026-09-01T00:00:00Z' },
  research: { id: 'shell-research-id', username: 'ana', email: 'ana@example.org', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-09-01T00:00:00Z' },
} as const;

const organization = {
  id: 'org-1', slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null,
  billing_sponsor_user_id: 'shell-user-id', effective_role: 'OWNER', created_at: '2026-09-01T00:00:00Z',
};

const project = {
  id: 'project-1', organization_id: 'org-1', slug: 'qos-benchmarks', name: 'QoS Benchmarks', description: 'Checkout flow benchmarks',
  visibility: 'private', created_by_id: 'shell-user-id', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  access: 'member', effective_role: 'OWNER',
};

const notifications = [
  {
    id: 'n1', kind: 'agreement', subject: 'Your OpenBinding agreement changed', body: 'Plan: BASIC → RESEARCH. Reason: institutional_agreement.',
    payload: {}, read_at: null, created_at: new Date().toISOString(),
  },
  {
    id: 'n2', kind: 'job', subject: 'Job completed', body: 'Job 0000…f1 finished with FEASIBLE.',
    payload: {}, read_at: new Date().toISOString(), created_at: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

/** Answers what the application shell loads; everything else on the API origin gets an empty 404. */
async function signIn(page: Page, persona: keyof typeof personas) {
  await page.addInitScript(() => localStorage.setItem('openbinding-access-token', 'visual-shell-token'));
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 404, json: { detail: 'not mocked' } }));
  await page.route(`${API}/v1/users/me`, (route) => route.fulfill({ json: personas[persona] }));
  await page.route(`${API}/v1/users/me/pricing-token`, (route) => route.fulfill({ json: { pricing_token: 'visual-token' } }));
  await page.route(`${API}/v1/organizations`, (route) => route.fulfill({ json: [organization] }));
  await page.route(`${API}/v1/organizations/isa-demo/projects`, (route) => route.fulfill({ json: [project] }));
  await page.route(`${API}/v1/notifications**`, (route) => route.fulfill({ json: notifications }));
}

async function openWorkspace(page: Page) {
  // A project screen whose data is not mocked (the API answers 404) keeps the page behind the header independent of any API data.
  await page.goto('/app/isa-demo/qos-benchmarks/files');
  await expect(page.locator('header.app-header')).toBeVisible();
  await expect(page.getByRole('button', { name: '1 unread notifications' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

// Each test opens every menu of the header in turn while the development server compiles on demand.
test.setTimeout(90_000);

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, deviceScaleFactor: 1 },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 },
] as const;

for (const { name, viewport, isMobile, deviceScaleFactor } of viewports) {
  for (const persona of ['user', 'research'] as const) {
    test.describe(`${name} application header · ${persona}`, () => {
      test.use({ viewport, isMobile, deviceScaleFactor });

      test('header and its menus', async ({ page }, testInfo) => {
        await signIn(page, persona);
        await openWorkspace(page);

        const header = page.locator('header.app-header');
        const shot = (label: string) => page.screenshot({ path: testInfo.outputPath(`${label}-${name}-${persona}.png`), animations: 'disabled' });

        // Brand, co-brand and no horizontal overflow.
        await expect(header.getByRole('link', { name: 'OpenBinding home' })).toHaveAttribute('href', '/app');
        const mark = header.getByRole('img', { name: 'Universidad de Sevilla' });
        if (persona === 'research') {
          await expect(mark).toBeVisible();
          await expect(mark).toHaveAttribute('src', '/brands/us-fama.png');
          const box = await mark.boundingBox();
          expect(box?.height).toBeLessThanOrEqual(40);
          expect(box?.height).toBeGreaterThanOrEqual(24);
        } else {
          await expect(mark).toHaveCount(0);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        await header.screenshot({ path: testInfo.outputPath(`header-${name}-${persona}.png`), animations: 'disabled' });

        if (isMobile) {
          await expect(header.getByRole('navigation', { name: 'Main' })).toBeHidden();
          await expect(header.getByRole('button', { name: /^New/ })).toBeHidden();

          const toggle = header.getByRole('button', { name: 'Open menu' });
          await toggle.click();
          const menu = header.getByRole('navigation', { name: 'Mobile navigation' });
          for (const label of ['Home', 'Jobs', 'Explore', 'Verifier', 'Engine catalog', 'My engines', 'Language extensions', 'Generator lab', 'Language docs', 'Organization', 'API key', 'Engine']) {
            await expect(menu.getByRole('link', { name: label }).first(), label).toBeVisible();
          }
          await expect(menu.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
          await expect(menu.getByRole('link', { name: 'Analysis', exact: true })).toHaveCount(0);
          if (persona === 'research') await expect(menu.getByRole('img', { name: 'Universidad de Sevilla' })).toHaveAttribute('src', '/brands/universidad-sevilla.svg');
          await shot('menu-open');
          // Scrolled to the end so the lower groups are on record too.
          await menu.evaluate((element) => element.scrollTo(0, element.scrollHeight));
          await shot('menu-open-end');

          await page.keyboard.press('Escape');
          await expect(menu).toBeHidden();
          await expect(toggle).toBeFocused();

          await toggle.click();
          await menu.getByRole('button', { name: 'Search' }).click();
          await expect(menu).toBeHidden();
        } else {
          const nav = header.getByRole('navigation', { name: 'Main' });
          await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/app');
          // A project screen is not the workspace home: its own tabs say where you are, and Home is not marked.
          await expect(nav.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page');
          await expect(nav.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/app/jobs');
          await expect(nav.getByRole('link', { name: 'Analysis' })).toHaveCount(0);
          await expect(nav.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
          await expect(nav.getByRole('link', { name: 'Admin' })).toHaveCount(0);
          await expect(header.getByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' })).toHaveAttribute('href', '/app');
          await expect(header.getByRole('button', { name: 'Open menu' })).toBeHidden();

          // Tools, opened and closed with the keyboard.
          const tools = nav.getByRole('button', { name: /Tools/ });
          await tools.focus();
          await page.keyboard.press('Enter');
          await expect(tools).toHaveAttribute('aria-expanded', 'true');
          for (const label of ['Verifier', 'Engine catalog', 'My engines', 'Language extensions', 'Generator lab', 'Language docs']) {
            await expect(header.getByRole('link', { name: label })).toBeVisible();
          }
          await shot('menu-tools');
          await page.keyboard.press('Escape');
          await expect(tools).toHaveAttribute('aria-expanded', 'false');
          await expect(tools).toBeFocused();

          // New.
          const create = header.getByRole('button', { name: /^New/ });
          await create.focus();
          await page.keyboard.press('Enter');
          await expect(create).toHaveAttribute('aria-expanded', 'true');
          for (const label of ['Organization', 'Project', 'Case', 'Job', 'Study', 'API key', 'Engine']) {
            await expect(header.locator('#app-new-menu').getByRole('link', { name: new RegExp(`^${label}`) }), label).toBeVisible();
          }
          await shot('menu-new');
          await page.keyboard.press('Escape');
          await expect(create).toHaveAttribute('aria-expanded', 'false');

          // Account.
          const account = header.getByRole('button', { name: 'Account menu' });
          await account.click();
          const accountMenu = header.locator('#app-account-menu');
          await expect(accountMenu.getByRole('link', { name: 'Plan & permissions' })).toHaveAttribute('href', '/app/account/usage');
          await expect(accountMenu.getByRole('link', { name: 'Administration' })).toHaveCount(0);
          if (persona === 'research') await expect(accountMenu.getByText('Universidad de Sevilla · Institutional account')).toBeVisible();
          else await expect(accountMenu.getByText(/Institutional account/)).toHaveCount(0);
          await shot('menu-account');
          await page.keyboard.press('Escape');
          await expect(accountMenu).toBeHidden();
          await expect(account).toBeFocused();

          // Command palette, opened with the shortcut.
          await page.keyboard.press('Control+K');
        }

        // Opened by the shortcut on desktop and by the mobile menu's Search button on mobile.
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
        const search = page.getByRole('textbox', { name: 'Search commands and loaded items' });
        await expect(search).toBeFocused();
        await shot('palette');
        await search.fill('qos');
        await expect(page.getByRole('dialog').getByRole('link', { name: /^QoS Benchmarks/ })).toBeVisible();
        await shot('palette-filtered');
        await search.fill('zzzz-nothing');
        await expect(page.getByText('Search only covers data already loaded on this device.')).toBeVisible();
        await shot('palette-empty');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();

        // Notifications.
        const bell = header.getByRole('button', { name: '1 unread notifications' });
        await bell.click();
        const panel = page.getByRole('dialog', { name: 'Notifications panel' });
        await expect(panel).toBeVisible();
        await expect(panel.getByText('Your OpenBinding agreement changed')).toBeVisible();
        await expect(panel.getByRole('link', { name: 'View all notifications' })).toHaveAttribute('href', '/app/account/notifications');
        const panelBox = await panel.boundingBox();
        expect(panelBox?.x).toBeGreaterThanOrEqual(0);
        expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
        await shot('notifications');

        if (isMobile) {
          // Account menu on a narrow screen.
          await page.keyboard.press('Escape');
          await header.getByRole('button', { name: 'Account menu' }).click();
          const accountMenu = header.locator('#app-account-menu');
          await expect(accountMenu).toBeVisible();
          const box = await accountMenu.boundingBox();
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
          await shot('menu-account');
        }
      });
    });
  }
}
