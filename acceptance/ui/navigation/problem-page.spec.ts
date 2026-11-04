import { expect, test } from '@playwright/test';
import { PROBLEMS, pathAndSearch } from './helpers';
import {
  PROBLEM_SLUG, choose, mockProblems, selectedTab, selectorOf, shownBy, tabGroup, tabLabels, versionMarker,
} from './helpers-problems';

test.use({ viewport: { width: 1280, height: 800 } });

const PROBLEM = `${PROBLEMS}/${PROBLEM_SLUG}`;
const TABS = ['Overview', 'Runs', 'Versions', 'Source', 'Settings'];
// The old address keeps its literal `cases` segment: it is a redirect input.
const OLD_PROBLEM = `/app/acme/demo/cases/${PROBLEM_SLUG}`;

// [utest->req~frontend-nav-problem-page~1]
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

// [utest->req~frontend-nav-problem-page~1]
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

// [utest->req~frontend-nav-problem-page~1]
test('the old version and compare addresses redirect into the problem page and Versions compares 1 with 3', async ({ page }) => {
  test.slow(); // several full page loads in one test
  await mockProblems(page);
  await page.goto(`${OLD_PROBLEM}/revisions/2`);
  await expect.poll(() => pathAndSearch(page)).toBe(`${PROBLEM}?version=2`);
  await page.goto(`${OLD_PROBLEM}/compare?from=1&to=3`);
  await expect.poll(() => pathAndSearch(page)).toBe(`${PROBLEM}/versions?from=1&to=3`);
  await expect(selectedTab(tabGroup(page, TABS), 'Versions')).toBeVisible();
  await expect(page.getByText(versionMarker(1)).first()).toBeVisible();
  await expect(page.getByText(versionMarker(3)).first()).toBeVisible();
  await expect(page.getByText(versionMarker(2))).toHaveCount(0);
});

// [utest->req~frontend-nav-problem-page~1]
test('the old snapshot address redirects to the Problems tab of the project', async ({ page }) => {
  await mockProblems(page);
  await page.goto('/app/acme/demo/snapshots/0b6c2f');
  await expect.poll(() => pathAndSearch(page)).toBe(PROBLEMS);
});

// [utest->req~frontend-nav-problem-page~1]
test('a public visitor sees only the tabs Overview, Versions and Source', async ({ page }) => {
  await mockProblems(page, { visitor: true });
  await page.goto(PROBLEM);
  const group = tabGroup(page, ['Overview', 'Versions', 'Source']);
  await expect.poll(() => tabLabels(group)).toEqual(['Overview', 'Versions', 'Source']);
});

// [utest->req~frontend-nav-problem-page~1]
test('an unknown problem tab shows Page not found', async ({ page }) => {
  await mockProblems(page);
  await page.goto(`${PROBLEM}/history`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
