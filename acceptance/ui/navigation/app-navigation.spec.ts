import { expect, test, type Page } from '@playwright/test';
import { COMPOSITIONS, PROBLEMS, RUNS, RUN_NEW, current, entry, expectInOrder, menuScope, mockApi, type Role } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const PUBLIC_LINKS: Array<[string, string]> = [
  ['Home', '/'], ['Compositions', '/compositions'], ['Engines', '/engines'], ['Pricing', '/pricing'],
  ['About', '/about'], ['Log in', '/login'], ['Sign up', '/register'],
];

const banner = (page: Page) => page.getByRole('banner');

async function signedIn(page: Page, path: string, role: Role = 'user') {
  await mockApi(page, { role });
  await page.goto(path);
  await expect(banner(page)).toBeVisible();
}

test('public header lists the seven links in order with their addresses and marks the current one', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/pricing');
  const links = PUBLIC_LINKS.map(([name]) => entry(banner(page), name));
  await expectInOrder(links);
  for (const [index, [, href]] of PUBLIC_LINKS.entries()) await expect(links[index]).toHaveAttribute('href', href);
  await expect(links[3]).toHaveAttribute('aria-current', 'page');
});

test('phone menu lists the same seven links in the same order', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await banner(page).getByRole('button', { name: /menu/i }).click();
  await expectInOrder(PUBLIC_LINKS.map(([name]) => entry(menuScope(page), name)));
});

test('public header has no link or menu of the former header', async ({ page }) => {
  await mockApi(page, { role: null });
  await page.goto('/');
  await expect(entry(banner(page), 'Engines')).toBeVisible();
  for (const name of ['Explore', 'Language', 'Profiles & dialects', 'Schemas', 'Examples', 'Workbench']) {
    await expect(banner(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(banner(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('application header lists Home, Compositions, Problems, Runs, Studies, Engines and Admin, with the organization\'s sections', async ({ page }) => {
  await signedIn(page, PROBLEMS, 'admin');
  const header = banner(page);
  await expectInOrder([
    entry(header, 'Home'), entry(header, 'Compositions'), entry(header, 'Problems'), entry(header, 'Runs'), entry(header, 'Studies'),
    entry(header, 'Engines'), entry(header, 'Admin'),
  ]);
  await expect(entry(header, 'Compositions')).toHaveAttribute('href', COMPOSITIONS);
  await expect(entry(header, 'Problems')).toHaveAttribute('href', PROBLEMS);
  await expect(entry(header, 'Problems')).toHaveAttribute('aria-current', 'page');
  await expect(entry(header, 'Runs')).toHaveAttribute('href', RUNS);
  await expect(entry(header, 'Studies')).toHaveAttribute('href', '/app/acme/studies');
  await expect(header.getByRole('button', { name: 'Lab' })).toHaveCount(0);
});

test('Runs and Studies mark themselves when their screens are open', async ({ page }) => {
  await signedIn(page, RUNS);
  await expect(current(page, 'Runs')).toBeVisible();
  await expect(entry(banner(page), 'Problems')).not.toHaveAttribute('aria-current', 'page');
});

test('Compositions marks itself when the composition list is open', async ({ page }) => {
  await signedIn(page, COMPOSITIONS);
  await expect(current(page, 'Compositions')).toBeVisible();
  await expect(entry(banner(page), 'Problems')).not.toHaveAttribute('aria-current', 'page');
});

test('a person whose role is user sees no Admin entry', async ({ page }) => {
  await signedIn(page, PROBLEMS, 'user');
  await expect(entry(banner(page), 'Problems')).toBeVisible();
  await expect(banner(page).getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
});

test('application header has none of the former entries', async ({ page }) => {
  await signedIn(page, '/app', 'admin');
  await expect(entry(banner(page), 'Home')).toBeVisible();
  for (const name of ['Jobs', 'Explore', 'Tools', 'Verifier', 'Engine catalog', 'Language', 'Lab', 'Projects']) {
    await expect(banner(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(banner(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('New menu offers a Composition, a Problem, a Study and a Run of the organization', async ({ page }) => {
  await signedIn(page, '/app/acme');
  await banner(page).getByRole('button', { name: 'New', exact: true }).click();
  const items: Array<[string, string]> = [
    ['Composition', `${COMPOSITIONS}?create=composition`], ['Problem', `${PROBLEMS}?create=problem`], ['Study', '/app/acme/studies/new'], ['Run', RUN_NEW],
  ];
  await expectInOrder(items.map(([name]) => entry(menuScope(page), name)));
  for (const [name, href] of items) await expect(entry(menuScope(page), name)).toHaveAttribute('href', href);
});

test('every New menu item stays with the organization from Home', async ({ page }) => {
  await signedIn(page, '/app', 'user');
  await banner(page).getByRole('button', { name: 'New', exact: true }).click();
  await expect(entry(menuScope(page), 'Composition')).toHaveAttribute('href', `${COMPOSITIONS}?create=composition`);
  await expect(entry(menuScope(page), 'Problem')).toHaveAttribute('href', `${PROBLEMS}?create=problem`);
  await expect(entry(menuScope(page), 'Study')).toHaveAttribute('href', '/app/acme/studies/new');
  await expect(entry(menuScope(page), 'Run')).toHaveAttribute('href', RUN_NEW);
});

test('the problem dialog opens from the address over the Problems screen', async ({ page }) => {
  await signedIn(page, `${PROBLEMS}?create=problem`);
  await expect(page.getByRole('dialog', { name: 'Upload a BIM package' })).toBeVisible();
  await expect(current(page, 'Problems')).toBeVisible();
});

test('New menu has none of the former items', async ({ page }) => {
  await signedIn(page, '/app/acme');
  await banner(page).getByRole('button', { name: 'New', exact: true }).click();
  await expect(entry(menuScope(page), 'Problem')).toBeVisible();
  for (const name of ['Organization', 'Project', 'Case', 'Job', 'API key', 'Engine']) await expect(entry(menuScope(page), name)).toHaveCount(0);
});

test('account menu lists the five sections then Sign out', async ({ page }) => {
  await signedIn(page, '/app');
  await banner(page).getByRole('button', { name: /account|lucia/i }).first().click();
  const items: Array<[string, string]> = [
    ['Profile', '/app/account'], ['Plan', '/app/account/usage'], ['API keys', '/app/account/keys'],
    ['Identities', '/app/account/identities'], ['Notifications', '/app/account/notifications'],
  ];
  const scope = menuScope(page);
  const signOut = scope.getByRole('menuitem', { name: 'Sign out' }).or(scope.getByRole('button', { name: 'Sign out' })).first();
  await expectInOrder([...items.map(([name]) => entry(scope, name)), signOut]);
  for (const [name, href] of items) await expect(entry(scope, name)).toHaveAttribute('href', href);
});

test('account menu has no entry named Account or Plan & permissions', async ({ page }) => {
  await signedIn(page, '/app');
  await banner(page).getByRole('button', { name: /account|lucia/i }).first().click();
  await expect(entry(menuScope(page), 'Profile')).toBeVisible();
  for (const name of ['Account', 'Plan & permissions']) await expect(entry(menuScope(page), name)).toHaveCount(0);
});
