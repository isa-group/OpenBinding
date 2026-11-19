import { expect, test, type Page } from '@playwright/test';
import { authConfig, signedIn } from './helpers/session';

// Screenshots go to testInfo.outputPath() (test-results/, ignored by git) so they can be inspected after a run.

const API = 'http://localhost:8000';

const personas = {
  user: {
    id: 'shell-user-id',
    username: 'lucia',
    email: 'lucia@example.org',
    role: 'user',
    is_active: true,
    plan: 'FREE',
    created_at: '2026-09-01T00:00:00Z',
  },
  research: {
    id: 'shell-research-id',
    username: 'ana',
    email: 'ana@example.org',
    role: 'user',
    is_active: true,
    plan: 'RESEARCH',
    created_at: '2026-09-01T00:00:00Z',
  },
} as const;

const organization = {
  id: 'org-1',
  slug: 'isa-demo',
  name: 'ISA Demo Group',
  parent_id: null,
  effective_role: 'OWNER',
  created_at: '2026-09-01T00:00:00Z',
};

const notifications = [
  {
    id: 'n1',
    kind: 'agreement',
    subject: 'Your OpenBinding agreement changed',
    body: 'Plan: FREE → RESEARCH. Reason: institutional_agreement.',
    payload: {},
    read_at: null,
    created_at: new Date().toISOString(),
  },
  {
    id: 'n2',
    kind: 'job',
    subject: 'Job completed',
    body: 'Job 0000…f1 finished with FEASIBLE.',
    payload: {},
    read_at: new Date().toISOString(),
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

/** Answers what the application shell loads; everything else on the API origin gets an empty 404. */
async function signIn(page: Page, persona: keyof typeof personas) {
  await page.route(`${API}/**`, route =>
    route.fulfill({ status: 404, json: { detail: 'not mocked' } })
  );
  await authConfig(page);
  await signedIn(page, 'visual-shell-token');
  await page.route(`${API}/v1/users/me`, route => route.fulfill({ json: personas[persona] }));
  await page.route(`${API}/v1/users/me/pricing-token`, route =>
    route.fulfill({ json: { pricing_token: 'visual-token' } })
  );
  await page.route(
    url => url.origin + url.pathname === `${API}/v1/organizations`,
    route => route.fulfill({ json: [organization] })
  );
  await page.route(`${API}/v1/notifications**`, route => route.fulfill({ json: notifications }));
  await page.route(`${API}/v1/notifications/unread-count`, route =>
    route.fulfill({ json: { count: 1 } })
  );
}

async function openWorkspace(page: Page) {
  // A screen whose data is not mocked (the API answers 404) keeps the page behind the header independent of any API data.
  await page.goto('/studies/new');
  await expect(page.locator('header.app-header')).toBeVisible();
  await expect(page.locator('header.app-header button[aria-label="Account menu"]')).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}

// Each test opens every menu of the header in turn while the development server compiles on demand.
test.setTimeout(90_000);

const viewports = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    deviceScaleFactor: 1,
  },
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
        const shot = (label: string) =>
          page.screenshot({
            path: testInfo.outputPath(`${label}-${name}-${persona}.png`),
            animations: 'disabled',
          });

        // Brand, co-brand and no horizontal overflow.
        await expect(header.getByRole('link', { name: 'OpenBinding home' })).toHaveAttribute(
          'href',
          '/'
        );
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
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        ).toBeLessThanOrEqual(1);
        await header.screenshot({
          path: testInfo.outputPath(`header-${name}-${persona}.png`),
          animations: 'disabled',
        });

        if (isMobile) {
          // SPHERE's narrow header: the logo and a drawer; New, the palette, the bell and the account move into the drawer.
          await expect(header.getByRole('navigation', { name: 'Main' })).toBeHidden();
          await expect(header.getByRole('button', { name: /^New/ })).toBeHidden();

          const toggle = header.getByRole('button', { name: 'Open menu' });
          await toggle.click();
          const menu = page.getByRole('navigation', { name: 'Mobile navigation' });
          for (const label of [
            'Pricing',
            'Team',
            'Research',
            'Changelog',
            'Organizations',
            'Inbox',
            'API keys',
            'Settings',
          ])
            await expect(menu.getByRole('link', { name: label, exact: true }), label).toBeVisible();
          for (const label of ['Tools', 'Explore', 'Search'])
            await expect(menu.getByRole('button', { name: label }), label).toBeVisible();
          for (const label of ['Composition', 'Problem', 'Run', 'Study', 'Organization', 'Engine'])
            await expect(page.getByRole('link', { name: label, exact: true }), label).toBeVisible();
          await expect(menu.getByRole('link', { name: 'Administration' })).toHaveCount(0);
          await shot('menu-open');

          await page.keyboard.press('Escape');
          await expect(menu).toBeHidden();
          await expect(toggle).toBeFocused();

          await toggle.click();
          await menu.getByRole('button', { name: 'Search' }).click();
          await expect(menu).toBeHidden();
        } else {
          const nav = header.getByRole('navigation', { name: 'Main' });
          // Tools before Explore, as in SPHERE; a workspace screen marks none of the site's entries.
          await expect(nav.getByRole('button')).toHaveText(['Tools', 'Explore']);
          await expect(nav.getByRole('link', { name: 'Pricing' })).toHaveAttribute(
            'href',
            '/pricing'
          );
          for (const [label, address] of [
            ['Team', '/team'],
            ['Research', '/research'],
            ['Changelog', '/changelog'],
          ])
            await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute(
              'href',
              address
            );
          await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
          await nav.getByRole('button', { name: 'Explore' }).click();
          await expect(nav.getByRole('link', { name: 'Organizations' })).toHaveAttribute(
            'href',
            '/organizations'
          );
          await expect(nav.getByRole('link', { name: 'Compositions' })).toHaveAttribute(
            'href',
            '/compositions'
          );
          await expect(nav.getByRole('link', { name: 'Engines' })).toHaveAttribute(
            'href',
            '/engines'
          );
          await shot('menu-explore');
          await page.keyboard.press('Escape');
          await expect(nav.getByRole('button', { name: 'Explore' })).toHaveAttribute(
            'aria-expanded',
            'false'
          );
          await expect(header.getByRole('button', { name: 'Open menu' })).toBeHidden();

          // New creates in the organization the address names.
          const create = header.getByRole('button', { name: /^New/ });
          await create.focus();
          await page.keyboard.press('Enter');
          await expect(create).toHaveAttribute('aria-expanded', 'true');
          await expect(
            header.getByRole('link', { name: 'Composition', exact: true })
          ).toHaveAttribute('href', '/compositions/new?org=isa-demo');
          for (const label of ['Problem', 'Run', 'Study', 'Organization', 'Engine'])
            await expect(
              header.getByRole('link', { name: label, exact: true }),
              label
            ).toBeVisible();
          await shot('menu-new');
          await page.keyboard.press('Escape');
          await expect(create).toHaveAttribute('aria-expanded', 'false');

          // Account.
          const account = header.getByRole('button', { name: 'Account menu' });
          await account.click();
          await expect(
            header.getByRole('link', { name: 'Organizations', exact: true })
          ).toHaveAttribute('href', '/me/orgs');
          await expect(header.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
            'href',
            '/me/settings'
          );
          await expect(header.getByRole('button', { name: 'Sign out' })).toBeVisible();
          await expect(header.getByRole('link', { name: 'Administration' })).toHaveCount(0);
          await shot('menu-account');
          await page.keyboard.press('Escape');
          await expect(header.getByRole('button', { name: 'Sign out' })).toBeHidden();
          await expect(account).toBeFocused();

          // Command palette, opened with the shortcut.
          await page.keyboard.press('Control+K');
        }

        // Opened by the shortcut on desktop and by the drawer's Search on mobile.
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
        const search = page.getByRole('combobox', { name: 'Search commands' });
        await expect(search).toBeFocused();
        await shot('palette');
        await search.fill('isa');
        await expect(
          page
            .getByRole('dialog')
            .getByRole('option', { name: /ISA Demo Group/ })
            .first()
        ).toBeVisible();
        await shot('palette-filtered');
        await search.fill('zzzz-nothing');
        await expect(page.getByText('No commands found')).toBeVisible();
        await shot('palette-empty');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();

        if (!isMobile) {
          // Notifications.
          const bell = header.getByRole('button', { name: 'Notifications, 1 unread' });
          await bell.click();
          const panel = page.getByRole('dialog', { name: 'Notifications' });
          await expect(panel).toBeVisible();
          await expect(panel.getByText('Your OpenBinding agreement changed')).toBeVisible();
          await expect(panel.getByRole('link', { name: 'View all notifications' })).toHaveAttribute(
            'href',
            '/notifications'
          );
          const panelBox = await panel.boundingBox();
          expect(panelBox?.x).toBeGreaterThanOrEqual(0);
          expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(
            viewport.width + 1
          );
          await shot('notifications');
        }
      });
    });
  }
}
