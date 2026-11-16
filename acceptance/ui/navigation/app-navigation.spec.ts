import { expect, test, type Page } from '@playwright/test';
import { COMPOSITIONS, PROBLEMS, RUN_NEW, entry, expectInOrder, menuScope, mockApi, type Role } from './helpers';

// SPHERE's header (F2c PR-A): Tools and Explore open menus, Pricing and About are links; signed in, New, the palette, the bell and
// the account menu follow. The entries point at today's screens until each domain moves into SPHERE's pages.

test.use({ viewport: { width: 1280, height: 800 } });

const banner = (page: Page) => page.getByRole('banner');
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary navigation' });
const main = (page: Page) => page.getByRole('navigation', { name: 'Main' });

async function signedIn(page: Page, path: string, role: Role = 'user') {
  await mockApi(page, { role });
  await page.goto(path);
  await expect(banner(page)).toBeVisible();
}

test('public header lists Tools, Explore, Pricing and About in order, then Log in and Sign up', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/pricing');
  await expectInOrder([
    primary(page).getByRole('button', { name: 'Tools' }),
    primary(page).getByRole('button', { name: 'Explore' }),
    entry(primary(page), 'Pricing'),
    entry(primary(page), 'About'),
    entry(banner(page), 'Log in'),
    entry(banner(page), 'Sign up'),
  ]);
  await expect(entry(primary(page), 'Pricing')).toHaveAttribute('aria-current', 'page');
  await expect(entry(banner(page), 'Log in')).toHaveAttribute('href', '/login');
  await expect(entry(banner(page), 'Sign up')).toHaveAttribute('href', '/register');
});

test('public menus lead to the language, the workbench, the compositions and the engines', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/');
  await primary(page).getByRole('button', { name: 'Tools' }).click();
  await expect(entry(primary(page), 'Composition2Yaml')).toHaveAttribute('href', '/language');
  await expect(entry(primary(page), 'Problem workbench')).toHaveAttribute('href', '/workbench');
  await primary(page).getByRole('button', { name: 'Explore' }).click();
  await expect(entry(primary(page), 'Organizations')).toHaveAttribute('href', '/organizations');
  await expect(entry(primary(page), 'Compositions')).toHaveAttribute('href', '/compositions');
  await expect(entry(primary(page), 'Engines')).toHaveAttribute('href', '/engines');
});

test('phone menu lists the same entries in the same order', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await banner(page).getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expectInOrder([
    menu.getByRole('button', { name: 'Tools' }),
    menu.getByRole('button', { name: 'Explore' }),
    entry(menu, 'Pricing'),
    entry(menu, 'About'),
    entry(menu, 'Log in'),
    entry(menu, 'Sign up'),
  ]);
});

test('public header has no link or menu of the former header', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/');
  await expect(entry(primary(page), 'Pricing')).toBeVisible();
  for (const name of ['Home', 'Language', 'Profiles & dialects', 'Schemas', 'Examples', 'Workbench']) {
    await expect(primary(page).getByRole('link', { name, exact: true })).toHaveCount(0);
  }
});

test('application header keeps SPHERE\'s order and marks no site entry on a workspace screen', async ({ page }) => {
  await signedIn(page, PROBLEMS, 'admin');
  await expectInOrder([
    main(page).getByRole('button', { name: 'Tools' }),
    main(page).getByRole('button', { name: 'Explore' }),
    entry(main(page), 'Pricing'),
    entry(main(page), 'About'),
    banner(page).getByRole('button', { name: 'New', exact: true }),
    banner(page).getByRole('button', { name: 'Account menu' }),
  ]);
  await expect(main(page).locator('[aria-current="page"]')).toHaveCount(0);
  for (const name of ['Home', 'Problems', 'Runs', 'Studies', 'Jobs', 'Lab', 'Projects'])
    await expect(main(page).getByRole('link', { name, exact: true })).toHaveCount(0);
});

test('New creates in the organization the address names', async ({ page }) => {
  await signedIn(page, '/app/acme');
  await banner(page).getByRole('button', { name: 'New', exact: true }).click();
  const items: Array<[string, string]> = [
    ['Composition', `${COMPOSITIONS}?create=composition`],
    ['Problem', '/app/acme/problem-editor'],
    ['Run', RUN_NEW],
    ['Study', '/app/acme/studies/new'],
    ['Organization', '/orgs/new'],
    ['Engine', '/app/engines/new'],
  ];
  await expectInOrder(items.map(([name]) => entry(menuScope(page), name)));
  for (const [name, href] of items) await expect(entry(menuScope(page), name)).toHaveAttribute('href', href);
});

test('the problem dialog opens from the address over the Problems screen', async ({ page }) => {
  await signedIn(page, `${PROBLEMS}?create=problem`);
  await expect(page.getByRole('dialog', { name: 'Upload a BIM package' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Problems' })).toBeVisible();
});

test('account menu lists the person\'s places then Sign out, with Administration for administrators only', async ({ page }) => {
  await signedIn(page, '/');
  await banner(page).getByRole('button', { name: 'Account menu' }).click();
  const items: Array<[string, string]> = [
    ['Organizations', '/me/orgs'],
    ['Inbox', '/notifications'],
    ['Engines', '/app/engines/registrations'],
    ['API keys', '/app/account/keys'],
    ['Account', '/app/account'],
  ];
  const scope = menuScope(page);
  await expectInOrder([...items.map(([name]) => entry(scope, name)), scope.getByRole('button', { name: 'Sign out' })]);
  for (const [name, href] of items) await expect(entry(scope, name)).toHaveAttribute('href', href);
  await expect(entry(scope, 'Administration')).toHaveCount(0);
});

test('an administrator\'s account menu leads to the administration', async ({ page }) => {
  await signedIn(page, '/', 'admin');
  await banner(page).getByRole('button', { name: 'Account menu' }).click();
  await expect(entry(menuScope(page), 'Administration')).toHaveAttribute('href', '/app/admin');
});
