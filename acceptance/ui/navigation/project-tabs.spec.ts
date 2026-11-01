import { expect, test } from '@playwright/test';
import { PROBLEMS, RUNS_SEGMENT } from './helpers';
import {
  MEMBER_NAMES, PROJECT_TABS, VISITOR_TABS, exportZip, expectAddress, importZip, isCurrent, mockProject, navEntry, packageCalls,
  projectTabs, sectionNav,
} from './helpers-hub';

test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = '/app/acme/demo';
// Problems and Runs use the interim segments of helpers.ts until the vocabulary slices rename them.
const TAB_HREFS = [PROJECT, PROBLEMS, `${PROJECT}/collections`, `${PROJECT}/${RUNS_SEGMENT}`, `${PROJECT}/studies`, `${PROJECT}/published`, `${PROJECT}/settings`];

// ---- frontend-nav-project-tabs ----------------------------------------------------------------------------------

// [utest->req~frontend-nav-project-tabs~1]
test('the project tabs of a member read Overview, Problems, Collections, Runs, Studies, Published, Settings', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/studies`);
  await expect(projectTabs(page).getByRole('link')).toHaveText(PROJECT_TABS);
});

// [utest->req~frontend-nav-project-tabs~1]
test('the project tabs link to the project, its areas and its settings', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/studies`);
  const tabs = projectTabs(page);
  for (const [index, label] of PROJECT_TABS.entries()) {
    await expect(tabs.getByRole('link', { name: label, exact: true }), `href of ${label}`).toHaveAttribute('href', TAB_HREFS[index]!);
  }
});

// [utest->req~frontend-nav-project-tabs~1]
test('the tab of the current area carries aria-current page', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/studies`);
  const tabs = projectTabs(page);
  await expect(tabs.getByRole('link', { name: 'Studies', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('link', { name: 'Overview', exact: true })).not.toHaveAttribute('aria-current', 'page');
});

// [utest->req~frontend-nav-project-tabs~1]
test('the project tabs of a public visitor read Overview, Problems, Collections, Studies, Published', async ({ page }) => {
  await mockProject(page, { visitor: true });
  await page.goto(`${PROJECT}/studies`);
  await expect(projectTabs(page, VISITOR_TABS).getByRole('link')).toHaveText(VISITOR_TABS);
});

// [utest->req~frontend-nav-project-tabs~1]
test('the settings section General is marked at /settings', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/settings`);
  const nav = sectionNav(page, ['General', 'Members']);
  await expect(isCurrent(nav, 'General')).toBeVisible();
  await expect(isCurrent(nav, 'Members')).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/acme\/demo\/settings$/);
});

// [utest->req~frontend-nav-project-tabs~1]
test('the settings section Members lists the members of acme and links to manage them', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/settings/members`);
  const nav = sectionNav(page, ['General', 'Members']);
  await expect(isCurrent(nav, 'Members')).toBeVisible();
  await expect(isCurrent(nav, 'General')).toHaveCount(0);
  for (const name of MEMBER_NAMES) await expect(page.getByText(name).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage members', exact: true })).toHaveAttribute('href', '/app/acme/settings/members');
});

// [utest->req~frontend-nav-project-tabs~1]
test('the old publications address becomes /published and marks the Published tab', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/publications`);
  await expectAddress(page, `${PROJECT}/published`);
  await expect(projectTabs(page).getByRole('link', { name: 'Published', exact: true })).toHaveAttribute('aria-current', 'page');
});

// [utest->req~frontend-nav-project-tabs~1]
test('the former tabs Cases, Jobs, Publications, Files and Package are gone', async ({ page }) => {
  await mockProject(page);
  await page.goto(PROJECT);
  const tabs = projectTabs(page, ['Overview', 'Settings']);
  await expect(navEntry(tabs, 'Overview')).toBeVisible();
  await expect(tabs.getByRole('link')).toHaveText(PROJECT_TABS);
  for (const former of ['Cases', 'Jobs', 'Publications', 'Files', 'Package']) {
    await expect(navEntry(tabs, former), `tab ${former}`).toHaveCount(0);
  }
});

// ---- frontend-nav-files-retired ---------------------------------------------------------------------------------

// [utest->req~frontend-nav-files-retired~1]
test('the General section of the settings holds Export package and Import package', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/settings`);
  await expect(page.getByRole('heading', { name: 'Export package' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Import package' })).toBeVisible();
});

// [utest->req~frontend-nav-files-retired~1]
test('exporting as ZIP from the settings requests the package with format zip', async ({ page }) => {
  const calls = await mockProject(page);
  await page.goto(`${PROJECT}/settings`);
  await expect(page.getByRole('heading', { name: 'Export package' })).toBeVisible();
  await exportZip(page);
  await expect.poll(() => packageCalls(calls).filter((call) => call.method === 'GET').map((call) => call.search)).toContain('?format=zip');
});

// [utest->req~frontend-nav-files-retired~1]
test('importing a ZIP from the settings posts the package', async ({ page }) => {
  const calls = await mockProject(page);
  await page.goto(`${PROJECT}/settings`);
  await expect(page.getByRole('heading', { name: 'Import package' })).toBeVisible();
  await importZip(page);
  await expect.poll(() => packageCalls(calls).filter((call) => call.method === 'POST').length).toBeGreaterThan(0);
});

// [utest->req~frontend-nav-files-retired~1]
test('the old files and package addresses become the overview and the settings', async ({ page }) => {
  await mockProject(page);
  await page.goto(`${PROJECT}/files`);
  await expectAddress(page, PROJECT);
  await page.goto(`${PROJECT}/package`);
  await expectAddress(page, `${PROJECT}/settings`);
});
