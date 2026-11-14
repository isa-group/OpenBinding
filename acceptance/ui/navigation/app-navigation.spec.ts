import { expect, test, type Page } from '@playwright/test';
import { PROBLEMS, RUNS_ALL, RUN_NEW, current, entry, expectInOrder, menuScope, mockApi, type Role } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

const PUBLIC_LINKS: Array<[string, string]> = [
  ['Home', '/'], ['Engines', '/engines'], ['Language', '/language'], ['Pricing', '/pricing'],
  ['About', '/about'], ['Log in', '/login'], ['Sign up', '/register'],
];

const banner = (page: Page) => page.getByRole('banner');

async function signedIn(page: Page, path: string, role: Role = 'user', projects?: unknown[]) {
  await mockApi(page, { role, projects });
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
  for (const name of ['Explore', 'Profiles & dialects', 'Schemas', 'Examples', 'Workbench']) {
    await expect(banner(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(banner(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('application header lists its entries with a current project and a Lab menu', async ({ page }) => {
  await signedIn(page, PROBLEMS, 'admin');
  const header = banner(page);
  await expectInOrder([
    entry(header, 'Home'), entry(header, 'Problems'), header.getByRole('button', { name: 'Lab' }),
    entry(header, 'Engines'), entry(header, 'Language'), entry(header, 'Admin'),
  ]);
  await expect(entry(header, 'Problems')).toHaveAttribute('href', PROBLEMS);
  await expect(entry(header, 'Problems')).toHaveAttribute('aria-current', 'page');
  await header.getByRole('button', { name: 'Lab' }).click();
  await expect(entry(menuScope(page), 'Runs')).toHaveAttribute('href', RUNS_ALL);
  await expect(entry(menuScope(page), 'Studies')).toHaveAttribute('href', '/app/acme/demo/studies');
  await expect(entry(menuScope(page), 'Generator')).toHaveAttribute('href', '/app/generator');
});

test('Problems and Studies are disabled with a hint without a current project', async ({ page }) => {
  await signedIn(page, '/app', 'user', []);
  const header = banner(page);
  const problems = header.getByText('Problems', { exact: true }).first();
  await expect(problems).toHaveAttribute('aria-disabled', 'true');
  await expect(problems).not.toHaveAttribute('href', /.*/);
  await expect(problems).toHaveAccessibleDescription(/Needs a project/);
  await header.getByRole('button', { name: 'Lab' }).click();
  const studies = menuScope(page).getByText('Studies', { exact: true }).first();
  await expect(studies).toHaveAttribute('aria-disabled', 'true');
  await expect(studies).not.toHaveAttribute('href', /.*/);
  await expect(studies).toHaveAccessibleDescription(/Needs a project/);
  await expect(entry(menuScope(page), 'Runs')).toHaveAttribute('href', RUNS_ALL);
  await expect(entry(menuScope(page), 'Generator')).toHaveAttribute('href', '/app/generator');
});

test('a person whose role is user sees no Admin entry', async ({ page }) => {
  await signedIn(page, PROBLEMS, 'user');
  await expect(entry(banner(page), 'Problems')).toBeVisible();
  await expect(banner(page).getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
});

test('application header has none of the former entries', async ({ page }) => {
  await signedIn(page, '/app', 'admin');
  await expect(entry(banner(page), 'Home')).toBeVisible();
  for (const name of ['Jobs', 'Explore', 'Tools', 'Verifier', 'Engine catalog']) {
    await expect(banner(page).getByRole('link', { name, exact: true })).toHaveCount(0);
    await expect(banner(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('New menu offers Problem, Collection, Study and Run in the current project', async ({ page }) => {
  await signedIn(page, '/app/acme/demo');
  await banner(page).getByRole('button', { name: 'New', exact: true }).click();
  const items: Array<[string, string]> = [
    ['Problem', `${PROBLEMS}?create=problem`], ['Collection', '/app/acme/demo/collections?create=collection'],
    ['Study', '/app/acme/demo/studies/new'], ['Run', RUN_NEW],
  ];
  await expectInOrder(items.map(([name]) => entry(menuScope(page), name)));
  for (const [name, href] of items) await expect(entry(menuScope(page), name)).toHaveAttribute('href', href);
});

test('New menu items are disabled with a hint without a current project', async ({ page }) => {
  await signedIn(page, '/app', 'user', []);
  await banner(page).getByRole('button', { name: 'New', exact: true }).click();
  for (const name of ['Problem', 'Collection', 'Study', 'Run']) {
    const item = menuScope(page).getByText(name, { exact: true }).last();
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAccessibleDescription(/Needs a project/);
  }
});

test('the problem dialog opens from the address over the Problems tab', async ({ page }) => {
  await signedIn(page, `${PROBLEMS}?create=problem`);
  await expect(page.getByRole('dialog', { name: 'New problem' })).toBeVisible();
  await expect(current(page, 'Problems')).toBeVisible();
});

test('New menu has none of the former items', async ({ page }) => {
  await signedIn(page, '/app/acme/demo');
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
