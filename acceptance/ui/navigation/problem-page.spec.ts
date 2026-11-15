import { expect, test } from '@playwright/test';
import { PROBLEMS, pathAndSearch } from './helpers';
import {
  PROBLEM_SLUG, choose, mockProblems, selectedTab, selectorOf, shownBy, tabGroup, tabLabels, versionMarker,
} from './helpers-problems';

test.use({ viewport: { width: 1280, height: 800 } });

const PROBLEM = `${PROBLEMS}/${PROBLEM_SLUG}`;
const TABS = ['Overview', 'Runs', 'Versions', 'Source', 'Settings'];

test('a member sees the tabs Overview, Runs, Versions, Source, Settings with Overview selected and version 3', async ({ page }) => {
  await mockProblems(page);
  await page.goto(PROBLEM);
  const group = tabGroup(page, TABS);
  await expect.poll(() => tabLabels(group)).toEqual(TABS);
  await expect(selectedTab(group, 'Overview')).toBeVisible();
  const version = selectorOf(page, /version/i);
  await expect(version).toBeVisible();
  await expect.poll(() => shownBy(version)).toMatch(/\b3\b/);
});

test('choosing version 2 in the header sets ?version=2 and the Source tab shows that version in a SourceView region', async ({ page }) => {
  await mockProblems(page);
  await page.goto(`${PROBLEM}/source`);
  const version = selectorOf(page, /version/i);
  await expect(version).toBeVisible();
  await choose(page, version, '2');
  await expect.poll(() => pathAndSearch(page)).toBe(`${PROBLEM}/source?version=2`);
  const region = page.getByRole('region').filter({ hasText: versionMarker(2) }).first();
  await expect(region).toBeVisible();
  await expect(page.getByText(versionMarker(3))).toHaveCount(0);
});

test('the Versions tab compares the pair in its address, 1 with 3', async ({ page }) => {
  await mockProblems(page);
  await page.goto(`${PROBLEM}/versions?from=1&to=3`);
  await expect(selectedTab(tabGroup(page, TABS), 'Versions')).toBeVisible();
  await expect(page.getByText(versionMarker(1)).first()).toBeVisible();
  await expect(page.getByText(versionMarker(3)).first()).toBeVisible();
  await expect(page.getByText(versionMarker(2))).toHaveCount(0);
});

test('a VIEWER of the organization sees the same tabs and reads the latest version', async ({ page }) => {
  await mockProblems(page, { viewer: true });
  await page.goto(PROBLEM);
  const group = tabGroup(page, TABS);
  await expect.poll(() => tabLabels(group)).toEqual(TABS);
  await expect.poll(() => shownBy(selectorOf(page, /version/i))).toMatch(/\b3\b/);
});

test('an unknown problem tab shows Page not found', async ({ page }) => {
  await mockProblems(page);
  await page.goto(`${PROBLEM}/history`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
